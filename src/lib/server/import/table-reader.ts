/**
 * Reads a spreadsheet's table from its columns, by code, with no AI (006
 * FR-053 to FR-056).
 *
 * A profile's table layout says where the table is (the headings that, all in
 * one row, start it) and which column holds what. Each section the profile
 * reads in its import mode says, with its row rules, which rows it takes. This file turns
 * the workbook into the same `ReadEnvelope` the AI's answer becomes, and the
 * rest is the AI reading's own code (`readingFromEnvelope`): the kinds, the
 * signs, the categories and the control total are worked out once, in one
 * place, whichever way a document was read.
 *
 * What the reading does, in order:
 *
 * 1. Finds the heading row: the first row that holds every heading. The
 *    workbook is cut to the profile's one sheet before it gets here
 *    (`profile-sheet.ts`, FR-069).
 * 2. Reads the rows below it, up to the first blank row (`isBlankRow`, the
 *    same rule the text rendering uses).
 * 3. Gives each row to the one section whose rules it meets. A row that meets
 *    two fails the reading, naming it: the profile is ambiguous. A row that
 *    meets none is left out and counted (FR-056).
 * 4. Reads each kept row's date and amount, and fails, naming the row and the
 *    column, when one cannot be read: no partial group (FR-011). Amounts are
 *    read from the cell's text as exact decimals, in whole cents.
 * 5. Leaves out a row whose fee type is not listed (FR-034), and gives a row
 *    that meets its section's flag rule a note for the reviewer (FR-061).
 * 6. Reads each stated total from the number beside its label, and adds them
 *    up in code.
 * 7. Gives each item the line its row has in the rendered text (FR-051), the
 *    `L0012` a reviewer sees.
 *
 * Nothing here reads the database or calls a provider, so it runs the same
 * with no AI provider configured.
 */

import { createHash } from "crypto";
import {
  foldTableText,
  type ImportProfileDraft,
  profileSections,
  type ProfileSection,
  type RowCondition,
  type TableDateFormat,
  type TableLayout,
} from "$lib/import-profile-schema.js";
import {
  DOCUMENT_ITEMS_MAX,
  IGNORED_LINES_MAX,
  type ImportModeValue,
} from "$lib/import-reading.js";
import { renderWorkbook } from "../extraction/spreadsheet/render.js";
import {
  brief,
  cellText,
  columnName,
  isBlankRow,
  type CellValue,
  type Sheet,
  type SheetRow,
  type Workbook,
} from "../extraction/spreadsheet/types.js";
import {
  DocumentLimitError,
  readingFromEnvelope,
  type DocumentReading,
} from "./document-reader.js";
import type {
  ReadEnvelope,
  ReadItem,
  ReadingProfile,
} from "./profile-compiler.js";

/**
 * A table that cannot be read as its profile describes. The message says
 * where and what, for the person who uploaded it.
 */
export class TableReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableReadError";
  }
}

// ── Finding the table ───────────────────────────────────────────────────────

/** Where a layout's table is in a workbook. */
export interface FoundTable {
  sheetIndex: number;
  sheet: Sheet;
  /** The heading row's position in `sheet.rows`. */
  headerAt: number;
  /** Each heading, folded, and its column (0 for A). */
  columns: Map<string, number>;
}

/**
 * The sheet with this name, matched as `foldTableText` folds it, or
 * undefined. The one place a sheet is found by its name: the reading, Auto-
 * detect and the editor's sample all go by it (FR-069).
 */
export function sheetNamed(
  workbook: Workbook,
  name: string,
): Sheet | undefined {
  const wanted = foldTableText(name);
  return workbook.sheets.find((sheet) => foldTableText(sheet.name) === wanted);
}

/**
 * The first row that holds every heading, on the first visible sheet that
 * has one, and only then on a hidden one. Null when there is none.
 * When a heading is in two columns of that row, the first one is used.
 */
export function findTable(
  workbook: Workbook,
  headers: readonly string[],
): FoundTable | null {
  const wanted = headers.map(foldTableText);
  // Visible sheets first: a hidden copy of the table (a pivot's source, an
  // old export) is read only when no visible sheet has it.
  const order = [...workbook.sheets.entries()].sort(
    ([, a], [, b]) => Number(a.hidden === true) - Number(b.hidden === true),
  );
  for (const [sheetIndex, sheet] of order) {
    for (const [headerAt, row] of sheet.rows.entries()) {
      const columns = new Map<string, number>();
      row.cells.forEach((cell, column) => {
        const heading = foldTableText(cellText(cell));
        if (heading && !columns.has(heading)) columns.set(heading, column);
      });
      if (wanted.every((heading) => columns.has(heading))) {
        return { sheetIndex, sheet, headerAt, columns };
      }
    }
  }
  return null;
}

/**
 * A table's data rows: below its heading row (`headerAt`, its position in
 * `sheet.rows`), up to the first blank row. A row the file does not list is
 * blank, so a gap in the numbers ends the table too. The reading and the
 * editor's look at a sample (`sample-inspect.ts`) both use this, so they
 * agree on where a table ends.
 */
export function tableDataRows(sheet: Sheet, headerAt: number): SheetRow[] {
  const dataRows: SheetRow[] = [];
  let previous = sheet.rows[headerAt].number;
  for (const row of sheet.rows.slice(headerAt + 1)) {
    if (row.number !== previous + 1 || isBlankRow(row)) break;
    dataRows.push(row);
    previous = row.number;
  }
  return dataRows;
}

// ── Reading one cell ────────────────────────────────────────────────────────

/** Spaces a number may be grouped with: plain, no-break and thin. */
const GROUP_SPACES = /[ \u00a0\u202f\u2009]/g;

/**
 * A currency written before or after a figure: a symbol (with up to two
 * capital letters before it, as in `US$` or `S$`), `RM`, or an upper-case
 * ISO-4217 code. Only capitals: "12.5k", "e5" and "x12" are not currencies.
 */
const CURRENCY_TOKEN = String.raw`[A-Z]{0,2}\p{Sc}|RM|[A-Z]{3}`;
const CURRENCY_BEFORE = new RegExp(`^(?:${CURRENCY_TOKEN})(?![A-Za-z])`, "u");
const CURRENCY_AFTER = new RegExp(`(?<![A-Za-z])(?:${CURRENCY_TOKEN})$`, "u");

/**
 * Why a currency written in a cell is not the one the amounts are in, or null
 * when it may be. A symbol, or `RM`, says too little to refuse. With no
 * currency known, any code is taken.
 */
function otherCurrency(token: string, currency: string | null): string | null {
  if (currency === null || !/^[A-Z]{3}$/.test(token)) return null;
  if (token === currency) return null;
  return `is in ${token}, not ${currency}`;
}

/**
 * An amount, as text, in whole cents, or why it cannot be read.
 *
 * - The decimal separator is the layout's for text; a number cell is always
 *   written with a point (see `cellText`).
 * - Thousands may be grouped with the other separator, an apostrophe or a
 *   space, but only in threes: "12,50" with a point for decimals is refused,
 *   not read as 1,250.
 * - Negative: a minus sign before or after the figure, the typographic `−`
 *   (U+2212), or brackets (FR-055).
 * - One currency before the figure and one after are allowed: a currency
 *   symbol (`$`, `€`, or `US$` and `S$` with a capital or two before the
 *   symbol), `RM`, or an upper-case three-letter code. A code that is not
 *   `currency` (when given) is refused, rather than read as an amount in the
 *   wrong currency. Any other letters
 *   fail the amount: "5.00 DR" and "5.00 CR" would lose their sign, and
 *   "12.5k" its multiplier.
 * - More than two decimal places fail, unless the extra places are zeros:
 *   such a figure cannot be imported to the cent without rounding.
 */
export function parseTableAmount(
  text: string,
  decimalSeparator: "." | ",",
  currency: string | null = null,
): { ok: true; minor: number } | { ok: false; reason: string } {
  const notAmount = { ok: false as const, reason: "is not an amount" };
  let rest = text
    .normalize("NFKC")
    .replace(/\u2212/g, "-")
    .trim();
  if (!rest) return { ok: false, reason: "is empty" };

  let negative = false;
  let signs = 0;
  if (rest.startsWith("(") && rest.endsWith(")")) {
    negative = true;
    signs++;
    rest = rest.slice(1, -1).trim();
  }
  // A currency and a sign may come in either order on either side, but only
  // one currency on each side, and only one that is plainly a currency (see
  // `CURRENCY_BEFORE`). Any other letters are refused: "5.00 DR", "12.5k" or
  // "x12" would otherwise lose a sign or a multiplier with no error.
  let currencyBefore = false;
  for (let pass = 0; pass < 2; pass++) {
    const sign = /^[-+]/.exec(rest);
    if (sign) {
      if (sign[0] === "-") negative = !negative;
      signs++;
      rest = rest.slice(1).trim();
    }
    const code = currencyBefore ? null : CURRENCY_BEFORE.exec(rest);
    if (code) {
      const refused = otherCurrency(code[0], currency);
      if (refused) return { ok: false, reason: refused };
      currencyBefore = true;
      rest = rest.slice(code[0].length).trim();
    }
  }
  let currencyAfter = false;
  for (let pass = 0; pass < 2; pass++) {
    const sign = /[-+]$/.exec(rest);
    if (sign) {
      if (sign[0] === "-") negative = !negative;
      signs++;
      rest = rest.slice(0, -1).trim();
    }
    const code = currencyAfter ? null : CURRENCY_AFTER.exec(rest);
    if (code) {
      const refused = otherCurrency(code[0], currency);
      if (refused) return { ok: false, reason: refused };
      currencyAfter = true;
      rest = rest.slice(0, -code[0].length).trim();
    }
  }
  if (signs > 1) return notAmount;

  const group = decimalSeparator === "." ? "," : ".";
  const parts = rest.split(decimalSeparator);
  if (parts.length > 2) return notAmount;
  const [whole, fraction = ""] = parts;
  if (parts.length === 2 && fraction === "") return notAmount;
  const grouped = whole.replace(GROUP_SPACES, " ");
  let digits: string;
  if (/^\d+$/.test(grouped)) {
    digits = grouped;
  } else {
    const groupChar = grouped.match(/[^\d]/)?.[0] ?? "";
    if (![group, "'", " "].includes(groupChar)) return notAmount;
    const escaped = groupChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(grouped)) {
      return notAmount;
    }
    digits = grouped.split(groupChar).join("");
  }
  if (!/^\d*$/.test(fraction)) return notAmount;
  const cents = fraction.replace(/0+$/, "");
  if (cents.length > 2) {
    return {
      ok: false,
      reason:
        "has more than two decimal places, so it cannot be imported to the cent",
    };
  }
  const minor = Number(digits) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return notAmount;
  return { ok: true, minor: negative && minor !== 0 ? -minor : minor };
}

/**
 * A cell's amount, by the cell's kind. `currency` is the one every amount is
 * in: the layout's, or else the main currency when the caller knows it.
 */
function cellAmount(
  cell: CellValue | null | undefined,
  layout: TableLayout,
  currency: string | null,
) {
  // A number cell is written with a point whatever the file's own locale.
  const separator = cell?.kind === "number" ? "." : layout.decimalSeparator;
  return parseTableAmount(cellText(cell), separator, currency);
}

/** Which part of a date each position of a format is. */
const DATE_ORDERS: Record<TableDateFormat, { sep: string; order: string }> = {
  "YYYY-MM-DD": { sep: "-", order: "ymd" },
  "YYYY/MM/DD": { sep: "/", order: "ymd" },
  "DD/MM/YYYY": { sep: "/", order: "dmy" },
  "MM/DD/YYYY": { sep: "/", order: "mdy" },
  "DD-MM-YYYY": { sep: "-", order: "dmy" },
  "MM-DD-YYYY": { sep: "-", order: "mdy" },
  "DD.MM.YYYY": { sep: ".", order: "dmy" },
};

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

/**
 * A date cell as `YYYY-MM-DD`, or null when it is not one. A real date cell is
 * already written that way (see `xlsx.ts`). Text is read by the layout's
 * format, and a time after the date (`2026-09-29 08:47:57`, `9:05 PM`) is
 * allowed and dropped. A bare number is refused: without a date format it
 * is only a number.
 */
export function parseTableDate(
  cell: CellValue | null | undefined,
  format: TableDateFormat,
): string | null {
  if (!cell) return null;
  if (cell.kind === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell.text);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    return isRealDate(year, month, day) ? match[0] : null;
  }
  if (cell.kind !== "string") return null;
  const text = cell.text.normalize("NFKC").trim();
  const split =
    /^(\S+?)(?:[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AaPp][Mm])?)?$/.exec(
      text,
    );
  if (!split) return null;
  const { sep, order } = DATE_ORDERS[format];
  const pieces = split[1].split(sep);
  if (pieces.length !== 3) return null;
  const at = (part: string) => pieces[order.indexOf(part)];
  const yearText = at("y");
  const monthText = at("m");
  const dayText = at("d");
  if (!/^\d{4}$/.test(yearText)) return null;
  if (!/^\d{1,2}$/.test(monthText) || !/^\d{1,2}$/.test(dayText)) return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!isRealDate(year, month, day)) return null;
  return `${yearText}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── Reading the table ───────────────────────────────────────────────────────

/** What a reading from columns found, before the AI reading's own code. */
export interface TableReading {
  envelope: ReadEnvelope;
  /** How many rows no section took, or whose fee type is not listed. */
  ignoredCount: number;
  /**
   * What the running-balance check found, when the layout names a balance
   * column and the table has two rows or more.
   */
  balance?: { matches: boolean; message: string };
  /** Where the table was found, for a preview. */
  found: { sheet: string; headerRow: number; rows: number };
  /**
   * The lines of the table's data rows in the rendered text (FR-051), every
   * one of them, those no section takes too: what the AI is not sent when it
   * reads the rest of the sheet (`withoutTableRows`).
   */
  dataLines: number[];
}

/** What the table reader needs from a profile. */
export interface TableProfile {
  name: string;
  /** The profile's import mode (FR-032). */
  mode: ImportModeValue;
  layout: TableLayout;
  /** The profile's sections. Only those it reads are read (`profileSections`). */
  sections: readonly ProfileSection[];
}

/** A row as a reviewer finds it in Excel, for the ignored lines. */
function rowSample(row: SheetRow): string {
  let end = row.cells.length;
  while (end > 0 && cellText(row.cells[end - 1]).trim() === "") end--;
  const cells = row.cells.slice(0, end).map((cell) => cellText(cell).trim());
  return `Row ${row.number}: ${cells.join(" | ")}`;
}

/**
 * Reads the table the layout describes into the shape an AI answer takes.
 * Throws `TableReadError`, naming the row and column, when the table is not
 * there or a row cannot be read. `mainCurrency` is the currency amounts are
 * taken to be in when the layout names none: a cell written in another
 * currency's code then fails, rather than being read as this one.
 */
export function readTable(
  workbook: Workbook,
  profile: TableProfile,
  mainCurrency: string | null = null,
): TableReading {
  const { layout, mode } = profile;
  const currency = layout.currency ?? mainCurrency;
  const table = findTable(workbook, layout.headers);
  if (!table) {
    // Cut to one sheet, the workbook names the sheet that was looked in.
    const where =
      workbook.sheets.length === 1
        ? `The sheet "${brief(workbook.sheets[0].name)}" has no`
        : "No sheet has";
    const headings = layout.headers.map((h) => `"${brief(h)}"`).join(", ");
    throw new TableReadError(
      `The table of the import profile "${profile.name}" was not found in this spreadsheet. ${where} a row with all of its headings: ${headings}.`,
    );
  }
  const { sheet } = table;

  // The line each row has in the rendered text, the one the reviewer sees.
  const lines = new Map<number, number>();
  for (const rendered of renderWorkbook(workbook).rows) {
    if (rendered.sheetIndex === table.sheetIndex) {
      lines.set(rendered.rowNumber, rendered.line);
    }
  }

  const columnOf = (heading: string): number => {
    const column = table.columns.get(foldTableText(heading));
    // The shared check makes every column one of the headings, and the table
    // was found by having every heading.
    if (column === undefined) {
      throw new TableReadError(
        `The column "${brief(heading)}" is not among the table's headings.`,
      );
    }
    return column;
  };
  const cellAt = (row: SheetRow, heading: string) =>
    row.cells[columnOf(heading)] ?? null;
  const where = (row: SheetRow, heading: string) =>
    `Row ${row.number}, column ${columnName(columnOf(heading))} ("${heading}")`;
  const holds = (row: SheetRow, condition: RowCondition): boolean => {
    const value = foldTableText(cellText(cellAt(row, condition.column)));
    switch (condition.op) {
      case "is":
        return value === foldTableText(condition.value ?? "");
      case "is_not":
        return value !== foldTableText(condition.value ?? "");
      case "is_one_of":
        return (condition.values ?? []).some(
          (entry) => foldTableText(entry) === value,
        );
      case "contains":
        return value.includes(foldTableText(condition.value ?? ""));
      case "empty":
        return value === "";
      case "not_empty":
        return value !== "";
    }
  };
  const meetsAll = (row: SheetRow, conditions: readonly RowCondition[]) =>
    conditions.every((condition) => holds(row, condition));

  /**
   * A row's amount in whole cents, with the sign its direction column gives
   * when the layout has one, or why it cannot be read, naming the row and the
   * column.
   */
  const signedAmount = (
    row: SheetRow,
  ): { ok: true; minor: number } | { ok: false; reason: string } => {
    const amountCell = cellAt(row, layout.columns.amount);
    const amount = cellAmount(amountCell, layout, currency);
    if (!amount.ok) {
      const shown = cellText(amountCell).trim();
      return {
        ok: false,
        reason: shown
          ? `${where(row, layout.columns.amount)}: "${brief(shown)}" ${amount.reason}.`
          : `${where(row, layout.columns.amount)} is empty: every row a section takes needs an amount.`,
      };
    }
    if (!layout.direction) return amount;
    const value = foldTableText(cellText(cellAt(row, layout.direction.column)));
    const isIn = layout.direction.in.some((v) => foldTableText(v) === value);
    const isOut = layout.direction.out.some((v) => foldTableText(v) === value);
    if (!isIn && !isOut) {
      const shown = cellText(cellAt(row, layout.direction.column)).trim();
      return {
        ok: false,
        reason: `${where(row, layout.direction.column)}: "${brief(shown)}" is neither an inflow value (${layout.direction.in.join(", ")}) nor an outflow value (${layout.direction.out.join(", ")}).`,
      };
    }
    return {
      ok: true,
      minor: isIn ? Math.abs(amount.minor) : -Math.abs(amount.minor),
    };
  };

  const sections = profileSections(profile).filter((section) => section.rows);
  const envelope: ReadEnvelope = {
    header: {
      counterparty: layout.counterparty,
      date: null,
      reference: null,
      currency: layout.currency,
    },
    stated_total: null,
    stated_total_minor: null,
    sections: Object.fromEntries(sections.map((section) => [section.key, []])),
    ignored: [],
  };
  let ignoredCount = 0;
  const ignore = (row: SheetRow) => {
    ignoredCount++;
    if (envelope.ignored.length < IGNORED_LINES_MAX) {
      envelope.ignored.push(rowSample(row));
    }
  };

  const dataRows = tableDataRows(sheet, table.headerAt);

  for (const row of dataRows) {
    const taking = sections.filter(
      (section) =>
        meetsAll(row, section.rows!.where) &&
        meetsAll(row, section.rows!.filter ?? []),
    );
    if (taking.length > 1) {
      const names = taking.map((section) => `"${section.name}"`).join(" and ");
      throw new TableReadError(
        `Row ${row.number} fits the row rules of more than one section: ${names}. Change the rules so that each row fits one section only.`,
      );
    }
    if (taking.length === 0) {
      ignore(row);
      continue;
    }
    const section = taking[0];
    const rules = section.rows!;

    // A section with fee types keeps only rows of a listed type (FR-034).
    let feeType: string | null = null;
    if (rules.feeTypeColumn !== null) {
      const value = foldTableText(cellText(cellAt(row, rules.feeTypeColumn)));
      feeType =
        section.feeTypes.find((fee) =>
          (fee.values ?? []).some((entry) => foldTableText(entry) === value),
        )?.key ?? null;
      if (feeType === null) {
        ignore(row);
        continue;
      }
    }

    const amount = signedAmount(row);
    if (!amount.ok) throw new TableReadError(amount.reason);
    const minor = amount.minor;

    const dateCell = cellAt(row, layout.columns.date);
    const date = parseTableDate(dateCell, layout.dateFormat);
    if (date === null) {
      const shown = cellText(dateCell).trim();
      throw new TableReadError(
        shown
          ? `${where(row, layout.columns.date)}: "${brief(shown)}" is not a date written as ${layout.dateFormat}.`
          : `${where(row, layout.columns.date)} is empty: every row a section takes needs a date.`,
      );
    }

    const description =
      cellText(cellAt(row, layout.columns.description)).trim() || section.name;
    const reference =
      layout.columns.reference === null
        ? ""
        : cellText(cellAt(row, layout.columns.reference)).trim();

    const item: ReadItem = {
      description,
      amount: minor / 100,
      amount_minor: minor,
      date,
      reference: reference || null,
      source_line: lines.get(row.number) ?? null,
    };
    if (section.feeTypes.length > 0) item.fee_type = feeType;
    envelope.sections[section.key].push(item);
  }

  // The figures beside the labels are outside the table's own rows.
  const firstData = table.headerAt;
  const afterData = table.headerAt + 1 + dataRows.length;
  const outside = [
    ...sheet.rows.slice(0, firstData),
    ...sheet.rows.slice(afterData),
  ];
  const beside = (label: string, what: string) => {
    const wanted = foldTableText(label);
    for (const row of outside) {
      const at = row.cells.findIndex(
        (cell) => foldTableText(cellText(cell)) === wanted,
      );
      if (at < 0) continue;
      const next = row.cells.findIndex(
        (cell, index) => index > at && cellText(cell).trim() !== "",
      );
      if (next < 0) {
        throw new TableReadError(
          `Row ${row.number}: nothing is printed beside "${brief(label)}", where the ${what} should be.`,
        );
      }
      return { row, cell: row.cells[next], column: next };
    }
    throw new TableReadError(
      `The label "${brief(label)}" of the ${what} was not found on the sheet "${brief(sheet.name)}".`,
    );
  };

  const labels = layout.statedTotalLabels[mode] ?? [];
  if (labels.length > 0) {
    let total = 0;
    for (const label of labels) {
      const found = beside(label, "stated total");
      const figure = cellAmount(found.cell, layout, currency);
      if (!figure.ok) {
        throw new TableReadError(
          `Row ${found.row.number}, column ${columnName(found.column)}: the stated total beside "${brief(label)}", "${brief(cellText(found.cell).trim())}", ${figure.reason}.`,
        );
      }
      total += figure.minor;
    }
    envelope.stated_total_minor = total;
    envelope.stated_total = total / 100;
  }

  if (layout.documentDateLabel !== null) {
    const found = beside(layout.documentDateLabel, "document's date");
    const date = parseTableDate(found.cell, layout.dateFormat);
    if (date === null) {
      throw new TableReadError(
        `Row ${found.row.number}, column ${columnName(found.column)}: the document's date beside "${brief(layout.documentDateLabel)}", "${brief(cellText(found.cell).trim())}", is not a date written as ${layout.dateFormat}.`,
      );
    }
    envelope.header.date = date;
  }

  const balance =
    layout.balanceColumn == null
      ? undefined
      : checkRunningBalance(dataRows, layout.balanceColumn, (row) => {
          // Any row may be empty here, the ones no section takes too.
          if (cellText(cellAt(row, layout.columns.amount)).trim() === "") {
            return {
              ok: false,
              reason: `${where(row, layout.columns.amount)} is empty.`,
            };
          }
          const amount = signedAmount(row);
          if (!amount.ok) return amount;
          const cell = cellAt(row, layout.balanceColumn!);
          const figure = cellAmount(cell, layout, currency);
          if (!figure.ok) {
            const shown = cellText(cell).trim();
            return {
              ok: false,
              reason: shown
                ? `${where(row, layout.balanceColumn!)}: "${brief(shown)}" ${figure.reason}.`
                : `${where(row, layout.balanceColumn!)} is empty.`,
            };
          }
          return { ok: true, minor: amount.minor, balance: figure.minor };
        });

  return {
    envelope,
    ignoredCount,
    ...(balance ? { balance } : {}),
    found: {
      sheet: sheet.name,
      headerRow: sheet.rows[table.headerAt].number,
      rows: dataRows.length,
    },
    dataLines: dataRows.flatMap((row) => {
      const line = lines.get(row.number);
      return line === undefined ? [] : [line];
    }),
  };
}

const NUMBERED_LINE = /^L(\d+)│/;

/**
 * The numbered text without the table's data rows, for the AI to read the
 * rest of a spreadsheet whose table code reads (FR-057). Every other line
 * keeps its number, so an item the AI reads still names the line the reviewer
 * finds, and one line in square brackets, unnumbered, stands where the rows
 * were. The heading row stays: it tells the AI what the table was.
 */
export function withoutTableRows(
  numbered: string,
  dataLines: readonly number[],
): string {
  if (dataLines.length === 0) return numbered;
  const cut = new Set(dataLines);
  const count = dataLines.length.toLocaleString("en-US");
  const mark = `[${count} row${dataLines.length === 1 ? "" : "s"} of the table, read by code, left out here]`;
  const out: string[] = [];
  let marked = false;
  for (const line of numbered.split("\n")) {
    const match = NUMBERED_LINE.exec(line);
    if (match && cut.has(Number(match[1]))) {
      if (!marked) out.push(mark);
      marked = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Whole cents as a figure with two decimals and its sign: "-1,234.50". */
function showMinor(minor: number): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${minor < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** One row as the running-balance check reads it. */
type BalanceRow =
  | { ok: true; minor: number; balance: number }
  | { ok: false; reason: string };

/**
 * Checks a table's running balance: that each row's balance is the balance of
 * the row before it plus its own amount. Every row of the table is checked,
 * those no section takes too, since a row missing from the export breaks the
 * balance wherever it was. A table may list its rows newest first or oldest
 * first, so both orders are tried and the one that fits more rows is used.
 *
 * A note only, never a reason to fail the reading: the amounts the items
 * have were read and checked on their own. Undefined when there are fewer
 * than two rows, and so nothing to compare.
 */
export function checkRunningBalance(
  rows: readonly SheetRow[],
  column: string,
  read: (row: SheetRow) => BalanceRow,
): { matches: boolean; message: string } | undefined {
  if (rows.length < 2) return undefined;
  const values: { row: SheetRow; minor: number; balance: number }[] = [];
  for (const row of rows) {
    const value = read(row);
    if (!value.ok) {
      return {
        matches: false,
        message: `The running balance in “${column}” could not be checked: ${value.reason}`,
      };
    }
    values.push({ row, ...value });
  }
  // Newest first: a row's balance is the next row's plus its own amount.
  // Oldest first: it is the row before's plus its own amount.
  const breaks = (newestFirst: boolean) => {
    const found: { at: number; moved: number; amount: number }[] = [];
    for (let i = 1; i < values.length; i++) {
      const [later, earlier] = newestFirst
        ? [values[i - 1], values[i]]
        : [values[i], values[i - 1]];
      const moved = later.balance - earlier.balance;
      if (moved !== later.minor) {
        found.push({
          at: newestFirst ? i - 1 : i,
          moved,
          amount: later.minor,
        });
      }
    }
    return found;
  };
  const newest = breaks(true);
  const oldest = breaks(false);
  const best = newest.length <= oldest.length ? newest : oldest;
  if (best.length === 0) {
    return {
      matches: true,
      message: `The running balance in “${column}” follows from row to row, so no row between the first and the last is missing.`,
    };
  }
  const first = best[0];
  const more =
    best.length > 1
      ? ` It does not follow at ${best.length.toLocaleString("en-US")} rows in all.`
      : "";
  return {
    matches: false,
    message: `The running balance in “${column}” does not follow at row ${values[first.at].row.number}: the balance moves by ${showMinor(first.moved)}, but the row's amount is ${showMinor(first.amount)}.${more} A row may be missing from the export or changed; compare the items with the spreadsheet.`,
  };
}

/**
 * Names what a reading from columns read, the way a saved profile's schema id
 * names what the AI was asked: the profile, then a hash of its layout and of
 * the sections it reads, so a later edit to either is a different id.
 */
export function columnsReadingId(
  saved: Pick<ImportProfileDraft, "sheet" | "layout" | "sections" | "mode"> & {
    id: number;
  },
): string {
  const sections = profileSections(saved);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        sheet: saved.sheet ?? null,
        layout: saved.layout,
        mode: saved.mode,
        sections,
      }),
    )
    .digest("hex");
  return `columns:${saved.id}:${hash}`;
}

/**
 * Reads a spreadsheet with a profile from its columns (FR-055): the table
 * reading above, then the AI reading's own `readingFromEnvelope`, so the
 * kinds, categories and control total are worked out as for any reading.
 *
 * `reading` is the profile compiled (`savedReadingProfile`): its sections
 * carry each kind, category and transfer account. The stated total compared
 * is the layout's labels, not the label the AI is told, and none when the
 * layout names none.
 *
 * The item limit counts what is left once rows that fit no section, or have
 * no listed fee type, are left out (FR-010). The notes say the reading was
 * from columns and how many rows it left out in all (FR-041, FR-056). The
 * items come in the order of the rows.
 */
export function readFromColumns(
  workbook: Workbook,
  profile: TableProfile,
  reading: ReadingProfile,
  context: { today: string; mainCurrency: string; schemaId: string },
): DocumentReading {
  return readingFromTable(
    readTable(workbook, profile, context.mainCurrency),
    profile,
    reading,
    context,
  );
}

/**
 * What the AI read of a spreadsheet beside its table (FR-057): its answer, as
 * `readDocumentEnvelope` or `readEnvelopeInPieces` gives it, and the
 * profile's `statedTotalDescription` it was read with.
 */
export interface AiPart {
  envelope: ReadEnvelope;
  method: "ai" | "ai_pieces";
  statedTotalDescription: string | null;
}

/**
 * The items of a table reading (`readTable`), and with `ai` those the AI read
 * from the rest of the sheet, made into one reading (FR-055, FR-057).
 *
 * The two answers are joined before any item is made, so the signs, the
 * categories and the control total are worked out once, over every section:
 *
 * - **Header:** what the layout gives (the other party, the currency, the
 *   date beside its label) is used; the AI's answer gives the rest.
 * - **Stated total:** the layout's labels, read by code, when it names any;
 *   else the figure the AI read beside the profile's own label.
 * - **Ignored lines:** the table's first, then the AI's.
 *
 * The item limit counts both parts together (FR-010).
 */
export function readingFromTable(
  table: TableReading,
  profile: TableProfile,
  reading: ReadingProfile,
  context: { today: string; mainCurrency: string; schemaId: string },
  ai: AiPart | null = null,
): DocumentReading {
  const { envelope, ignoredCount, balance } = table;
  const parts = ai ? [envelope, ai.envelope] : [envelope];
  const lineCount = parts.reduce(
    (sum, part) =>
      sum +
      Object.values(part.sections).reduce((n, lines) => n + lines.length, 0),
    0,
  );
  if (lineCount > DOCUMENT_ITEMS_MAX) {
    throw new DocumentLimitError(
      "items",
      `This document has too many items to import: ${lineCount.toLocaleString("en-US")} rows fit its sections, and the limit is ${DOCUMENT_ITEMS_MAX.toLocaleString("en-US")}.`,
    );
  }
  const labels = profile.layout.statedTotalLabels[profile.mode] ?? [];
  const byLayout = labels.length > 0 || ai === null;
  const joined: ReadEnvelope = ai
    ? {
        header: {
          ...ai.envelope.header,
          counterparty:
            envelope.header.counterparty ?? ai.envelope.header.counterparty,
          date: envelope.header.date ?? ai.envelope.header.date,
          currency: envelope.header.currency ?? ai.envelope.header.currency,
        },
        stated_total: byLayout
          ? envelope.stated_total
          : ai.envelope.stated_total,
        stated_total_minor: byLayout
          ? envelope.stated_total_minor
          : (ai.envelope.stated_total_minor ?? null),
        sections: { ...ai.envelope.sections, ...envelope.sections },
        ignored: [...envelope.ignored, ...ai.envelope.ignored],
      }
    : envelope;
  const result = readingFromEnvelope(
    joined,
    {
      ...reading,
      statedTotalDescription: byLayout
        ? labels.length > 0
          ? labels.join(" + ")
          : null
        : ai!.statedTotalDescription,
    },
    context,
  );
  // In the order of the sheet's lines, as the reviewer finds them in the
  // file, rather than section by section. Every row of the table has its
  // line; an item the AI gave none goes last.
  result.items.sort(
    (a, b) =>
      (a.sourceLine ?? Number.MAX_SAFE_INTEGER) -
      (b.sourceLine ?? Number.MAX_SAFE_INTEGER),
  );
  // Rows the reader left out, the lines the AI listed as left out, and lines
  // of a kept section that the reading's own rules left out (an amount of
  // zero, say).
  const aiIgnored = ai
    ? ai.envelope.ignored.filter((line) => line.trim() !== "").length
    : 0;
  result.notes.ignoredCount =
    ignoredCount + aiIgnored + lineCount - result.items.length;
  result.notes.method = ai ? "columns_ai" : "columns";
  if (balance) result.notes.balance = balance;
  return result;
}
