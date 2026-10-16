/**
 * Building an import profile's table from a sample spreadsheet, and sorting
 * the table's rows into sections by one column's values (006 FR-053, FR-054).
 *
 * The editor sends a sample to `/api/import/profiles/sample`, which reads it
 * and stores nothing (`server/import/sample-inspect.ts`), and gets back a
 * `SampleInspection`: where the table is, its first rows, each column's
 * values, and a guess at what each column holds. The helpers here turn that
 * into the form's layout, and let the editor:
 *
 * - give a column a role (Date, Amount, ...) by its heading, a role being
 *   held by one column at a time (`setColumnRole`);
 * - sort rows into sections by the values of one column, the shape nearly
 *   every row rule takes ("Transaction Type is Withdrawal"), rather than
 *   building conditions (`sortingOf`, `applySorting`).
 *
 * Pure TypeScript with no server imports, so the editor and the specs read
 * the same rules. Nothing here changes what a profile saves: the layout and
 * the row rules are the ones the shared check reads.
 */

import type {
  TableCsvDelimiter,
  TableDateFormat,
} from "./import-profile-schema.js";
import {
  linesOf,
  newCondition,
  newLayout,
  newRows,
  newSection,
  readsFromTable,
  type ConditionForm,
  type LayoutForm,
  type ProfileForm,
  type SectionForm,
} from "./import-profile-form.js";

// ── What a look at a sample finds ───────────────────────────────────────────

/** One value of a column, and how many of the table's rows hold it. */
export interface SampleValue {
  value: string;
  count: number;
}

/** One column of the sample's table, by its heading. */
export interface SampleColumn {
  heading: string;
  /**
   * Every value the column holds in the table's rows, most rows first, or
   * null when it holds more than `SAMPLE_DISTINCT_MAX` (a description, an
   * amount): such a column is not one to sort rows by.
   */
  distinct: SampleValue[] | null;
  /** The share of non-empty cells that read as a date, 0 to 1. */
  dateShare: number;
  /** The share of non-empty cells that read as an amount, 0 to 1. */
  numberShare: number;
}

/** A label printed outside the table with a value beside it, such as "To". */
export interface SampleLabel {
  label: string;
  value: string;
  /** The row's number, as Excel shows it. */
  row: number;
}

/** What the sample's columns look like they hold. Null: no column fits. */
export interface SampleGuess {
  date: string | null;
  description: string | null;
  amount: string | null;
  reference: string | null;
  direction: { column: string; in: string[]; out: string[] } | null;
  balance: string | null;
  dateFormat: TableDateFormat;
  decimalSeparator: "." | ",";
  csvDelimiter: TableCsvDelimiter | null;
  /** The column whose values best sort the rows into sections. */
  sortBy: string | null;
}

export interface SampleInspection {
  format: "xlsx" | "csv";
  sheets: { name: string; hidden: boolean }[];
  /** The sheet the table is on. */
  sheet: string;
  /** The heading row's number, as Excel shows it. */
  headerRow: number;
  /** How many rows the table has, below the headings to the first blank. */
  rowCount: number;
  /** The headings, one per column that has one, left to right. */
  headers: string[];
  /** The first rows of the table, each cell's text by `headers`. */
  rows: string[][];
  columns: SampleColumn[];
  labels: SampleLabel[];
  guess: SampleGuess;
}

/** Most values a column may hold and still be offered for sorting. */
export const SAMPLE_DISTINCT_MAX = 30;
/** How many of the table's rows a look at a sample sends back. */
export const SAMPLE_ROWS = 10;

// ── Column roles ────────────────────────────────────────────────────────────

/**
 * What a column is used for. A column holds at most one role, and each role
 * at most one column. No role fills the remark: it is the reviewer's to write.
 */
export type ColumnRole =
  | "date"
  | "description"
  | "amount"
  | "reference"
  | "direction"
  | "balance"
  | "none";

export const COLUMN_ROLES: { value: ColumnRole; label: string }[] = [
  { value: "none", label: "Not used" },
  { value: "date", label: "Date" },
  { value: "description", label: "Description" },
  { value: "amount", label: "Amount" },
  { value: "reference", label: "Reference" },
  { value: "direction", label: "Direction (inflow or outflow)" },
  { value: "balance", label: "Running balance" },
];

/** The roles one column at most may hold, and where the layout keeps each. */
const SINGLE_ROLES = {
  date: "date",
  description: "description",
  amount: "amount",
  reference: "reference",
  direction: "directionColumn",
  balance: "balanceColumn",
} as const satisfies Partial<Record<ColumnRole, keyof LayoutForm>>;

/** The role a heading holds in the layout. */
export function columnRole(layout: LayoutForm, heading: string): ColumnRole {
  for (const [role, field] of Object.entries(SINGLE_ROLES)) {
    if (layout[field] === heading) return role as ColumnRole;
  }
  return "none";
}

/**
 * Gives a heading a role. The column that held the role before loses it, and
 * the heading loses any other role it had. A direction column that changes
 * clears the in and out values, which belonged to the old column.
 */
export function setColumnRole(
  layout: LayoutForm,
  heading: string,
  role: ColumnRole,
): void {
  for (const [held, field] of Object.entries(SINGLE_ROLES)) {
    if (layout[field] === heading && held !== role) {
      layout[field] = "";
      if (held === "direction") {
        layout.directionInText = "";
        layout.directionOutText = "";
      }
    }
  }
  if (role === "none") return;
  const field = SINGLE_ROLES[role];
  if (role === "direction" && layout.directionColumn !== heading) {
    layout.directionInText = "";
    layout.directionOutText = "";
  }
  layout[field] = heading;
}

/** Which way a direction column's value says the money went, if any. */
export function directionOf(
  layout: LayoutForm,
  value: string,
): "in" | "out" | null {
  if (linesOf(layout.directionInText).includes(value)) return "in";
  if (linesOf(layout.directionOutText).includes(value)) return "out";
  return null;
}

/** Marks a direction column's value as money in, out, or neither. */
export function setDirection(
  layout: LayoutForm,
  value: string,
  way: "in" | "out" | null,
): void {
  const without = (text: string) =>
    linesOf(text)
      .filter((entry) => entry !== value)
      .join("\n");
  layout.directionInText = without(layout.directionInText);
  layout.directionOutText = without(layout.directionOutText);
  if (way === "in") {
    layout.directionInText = [...linesOf(layout.directionInText), value].join(
      "\n",
    );
  } else if (way === "out") {
    layout.directionOutText = [...linesOf(layout.directionOutText), value].join(
      "\n",
    );
  }
}

/**
 * The layout a sample gives: its headings, and the columns, date
 * format and separators it looks like it has. What the sample cannot say
 * (the other party, the currency, the labels outside the table) is kept from
 * `keep`, the layout the user had, so loading a sample never loses them.
 */
export function layoutFromSample(
  sample: SampleInspection,
  keep: LayoutForm | null = null,
): LayoutForm {
  const { guess } = sample;
  const base = keep ? { ...keep } : newLayout();
  return {
    ...base,
    headersText: sample.headers.join("\n"),
    date: guess.date ?? "",
    description: guess.description ?? "",
    amount: guess.amount ?? "",
    reference: guess.reference ?? "",
    dateFormat: guess.dateFormat,
    directionColumn: guess.direction?.column ?? "",
    directionInText: (guess.direction?.in ?? []).join("\n"),
    directionOutText: (guess.direction?.out ?? []).join("\n"),
    decimalSeparator: guess.decimalSeparator,
    csvDelimiter: guess.csvDelimiter ?? "",
    balanceColumn: guess.balance ?? "",
  };
}

// ── Sorting rows into sections ──────────────────────────────────────────────

/**
 * How the table's sections take their rows, when every one of them does it
 * by the values of one column: which column, and for each value, the uid of
 * the section that takes it. A value no section takes is left out.
 */
export interface Sorting {
  column: string;
  assignments: Map<string, string>;
}

/** A section's one condition as values of a column, or null when it is not. */
function valuesOf(
  where: readonly ConditionForm[],
): { column: string; values: string[] } | null {
  if (where.length !== 1) return null;
  const [condition] = where;
  if (condition.op === "is") {
    return condition.value.trim()
      ? { column: condition.column, values: [condition.value.trim()] }
      : null;
  }
  if (condition.op === "is_one_of") {
    const values = linesOf(condition.valuesText);
    return values.length ? { column: condition.column, values } : null;
  }
  return null;
}

/**
 * How the form's table sections sort rows, when every one does it by values
 * of one shared column (or has no condition yet); null when any section has
 * rules of another shape, which the editor then shows as they are. With no
 * table section, or none with a condition yet, the column is "".
 */
export function sortingOf(form: ProfileForm): Sorting | null {
  const assignments = new Map<string, string>();
  let column = "";
  for (const section of form.sections) {
    if (!readsFromTable(form, section)) continue;
    const where = section.rows?.where ?? [];
    if (where.length === 0) continue;
    const taken = valuesOf(where);
    if (!taken) return null;
    if (column && taken.column !== column) return null;
    column = taken.column;
    for (const value of taken.values) {
      // A value two sections take is the shared check's to report.
      if (!assignments.has(value)) assignments.set(value, section.uid);
    }
  }
  return { column, assignments };
}

/**
 * Writes the sorting into the table sections' row rules: each section takes
 * the values assigned to it, as "is" for one value and "is one of" for more.
 * A table section with none assigned gets no condition, and so takes every
 * row: the editor says so, as a section left with nothing to take would
 * otherwise read the whole table.
 */
export function applySorting(form: ProfileForm, sorting: Sorting): void {
  for (const section of form.sections) {
    if (!readsFromTable(form, section)) continue;
    const values = [...sorting.assignments]
      .filter(([, uid]) => uid === section.uid)
      .map(([value]) => value);
    const rows = section.rows ?? newRows();
    if (values.length === 0 || !sorting.column) {
      rows.where = [];
    } else {
      const condition = rows.where[0] ?? newCondition(sorting.column);
      condition.column = sorting.column;
      if (values.length === 1) {
        condition.op = "is";
        condition.value = values[0];
      } else {
        condition.op = "is_one_of";
        condition.valuesText = values.join("\n");
      }
      rows.where = [condition];
    }
    section.rows = rows;
  }
}

/**
 * A new section read from the table, named after the value it is made for,
 * such as "Withdrawal". Expense, the commonest kind; the user changes it.
 */
export function sectionForValue(value: string): SectionForm {
  const section = newSection();
  section.name = value;
  section.readBy = "table";
  section.rows = newRows();
  return section;
}

/**
 * The column to sort rows by when none is chosen yet: one with a role of
 * none, holding between 2 and `SAMPLE_DISTINCT_MAX` values, the sample's own
 * guess first.
 */
export function sortColumnFor(
  sample: SampleInspection,
  layout: LayoutForm,
): string | null {
  const usable = (heading: string) => {
    const column = sample.columns.find((c) => c.heading === heading);
    return (
      column?.distinct != null &&
      column.distinct.length >= 2 &&
      columnRole(layout, heading) === "none"
    );
  };
  if (sample.guess.sortBy && usable(sample.guess.sortBy)) {
    return sample.guess.sortBy;
  }
  return sample.headers.find(usable) ?? null;
}
