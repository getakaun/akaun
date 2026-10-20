/**
 * The import profile editor's form, and how it turns into a profile and back
 * (006 US6, FR-030, FR-031, FR-035).
 *
 * The editor stages the whole profile in this shape and sends it once, as the
 * Settings page does. It differs from a saved profile in four ways:
 *
 * - Each section and line type carries a `uid`, so a list that is reordered or
 *   shortened keeps each row's own inputs.
 * - A new section's or line type's key follows its name (`keyFromName`). A
 *   saved one keeps the key it was saved with, so renaming it changes only
 *   what the screens show. A line type's key is never shown.
 * - "Advanced: extra fields" is the JSON text the user typed, not the parsed
 *   fragment. The shared check (`import-profile-schema.ts`) reads text and
 *   reports a typing mistake with its path, so the editor never parses it on
 *   its own and the server sees exactly what was typed.
 * - The table layout and row rules (FR-053, FR-054) hold every list as text,
 *   one entry per line, and every optional value as "" for none, so each
 *   field binds to an input as it is. `payloadFromForm` turns them into the
 *   layout the shared check reads, and a saved layout comes back through the
 *   form unchanged.
 * - Each section says how it is read, from the table's rows or by the AI
 *   (`readBy`, FR-057), and keeps its row rules while it is read by the AI,
 *   so switching back loses nothing. Only what the chosen way uses is sent.
 *
 * Pure TypeScript with no server imports, so the editor and the server specs
 * read the same rules.
 */

import {
  NONE_VALUE,
  PROFILE_FILE_TYPES,
  PROFILE_KEY_PATTERN,
  kindReadsTable,
  modeOf,
  profileKind,
  type ImportProfileDraft,
  type ProfileError,
  type ProfileFileType,
  type ProfileKind,
  type ProfileSectionKind,
  type RowCondition,
  type RowConditionOp,
  type SectionRows,
  type TableCsvDelimiter,
  type TableDateFormat,
  type TableLayout,
} from "./import-profile-schema.js";
import { ImportMode, type ImportModeValue } from "./import-reading.js";

export interface FeeTypeForm {
  uid: string;
  /**
   * The key a saved line type has: what the model writes back and what an item
   * stores. Ignored while `keyFromName` is true. Never shown.
   */
  key: string;
  /** True for a line type not saved yet: its key is made from its name. */
  keyFromName: boolean;
  /** What the screens show, and each item of this type is called. */
  name: string;
  description: string;
  /** The pinned category, or null for "Auto". */
  categoryAccountId: number | null;
  /**
   * The cell values that mean this line type in its section's line type column
   * (FR-054), one per line as typed. Empty for a section the AI reads.
   */
  valuesText: string;
}

/** One condition of a row rule, as typed (FR-054). */
export interface ConditionForm {
  uid: string;
  /** A heading of the table. */
  column: string;
  op: RowConditionOp;
  /** For is, is not and contains. Kept while another op is chosen. */
  value: string;
  /** For is one of: one value per line. Kept likewise. */
  valuesText: string;
}

/** A section's row rules, as typed (FR-054). */
export interface RowsForm {
  where: ConditionForm[];
  filter: ConditionForm[];
  /** The heading of the line type column, or "" for none. */
  feeTypeColumn: string;
}

/**
 * A profile's table layout, as typed (FR-053). Text that is a list is one
 * entry per line, and text that may be empty is "" for none, so every field
 * binds to an input as it is; `payloadFromForm` makes the layout from it.
 */
export interface LayoutForm {
  /** The table's headings, one per line. */
  headersText: string;
  date: string;
  description: string;
  amount: string;
  /** "" for none. */
  reference: string;
  dateFormat: TableDateFormat;
  /** The direction column, or "" for none: the amount then has its sign. */
  directionColumn: string;
  directionInText: string;
  directionOutText: string;
  decimalSeparator: "." | ",";
  /** "" to work it out from the file. */
  csvDelimiter: TableCsvDelimiter | "";
  counterparty: string;
  currency: string;
  documentDateLabel: string;
  /** The stated-total labels, one per line. */
  totalsText: string;
  /** The running-balance column, or "" for none. */
  balanceColumn: string;
}

/** How a section is read: from the table's rows by code, or by the AI. */
export type SectionReadBy = "table" | "ai";

export interface SectionForm {
  uid: string;
  /** The key a saved section has. Ignored while `keyFromName` is true. */
  key: string;
  /** True for a section not saved yet: its key is made from its name. */
  keyFromName: boolean;
  name: string;
  description: string;
  /**
   * The other import mode, for a section saved when each section had its own
   * and the profile had sections in both (FR-032). It is sent back as it was,
   * so the save is refused until the section is moved, kept on purpose
   * (`null`), or the profile is changed to it. Null for every other section.
   */
  legacyMode: ImportModeValue | null;
  kind: ProfileSectionKind;
  fixedCategoryAccountId: number | null;
  feeTypes: FeeTypeForm[];
  /** "Advanced: extra fields" as typed. Empty means none. */
  extrasText: string;
  /** A transfer section's other account (FR-058); null for any other kind. */
  counterAccountId: number | null;
  /**
   * How the section is read when the profile has a table layout (FR-057):
   * from the table's rows by code, with `rows`, or by the AI, with its
   * description. Without a layout every section is read by the AI.
   */
  readBy: SectionReadBy;
  /**
   * The section's row rules for reading from columns (FR-054), or null.
   * Kept while the section is read by the AI, but not sent.
   */
  rows: RowsForm | null;
  /**
   * Other profiles whose records describe the same money (FR-066). Sent only
   * for a section that is not a transfer.
   */
  sameMoneyAs: number[];
}

export interface ProfileForm {
  name: string;
  description: string;
  phrases: string[];
  instructions: string;
  /** What the profile imports: Summary lines or Every transaction. */
  mode: ImportModeValue;
  /** The stated total, as typed. Empty means the profile names none. */
  statedTotal: string;
  /** The account the document is about (FR-058), or null for none. */
  accountId: number | null;
  /**
   * The files a kind the AI reads takes (FR-070), as ticked, in
   * `PROFILE_FILE_TYPES` order. Kept while the kind reads a table, which
   * reads only spreadsheets, for a switch back.
   */
  fileTypes: ProfileFileType[];
  /**
   * The one sheet of a workbook the profile reads (FR-069), or "" for the
   * default: the sheet with the table's headings, or the first visible one.
   * Kept, unsent, while the profile reads no spreadsheet.
   */
  sheet: string;
  /**
   * The table layout for reading a spreadsheet from its columns (FR-053), or
   * null when the profile has none.
   */
  layout: LayoutForm | null;
  sections: SectionForm[];
  /**
   * What the profile imports (`ProfileKind`), as the user chose it. The mode,
   * the layout and each section's way of reading are kept in line with it
   * (`setKind`).
   */
  kind: ProfileKind;
}

let uidCounter = 0;

/** A key for one row of the form, unique in this page. */
export function newUid(): string {
  uidCounter += 1;
  return `row-${uidCounter}`;
}

/**
 * A key made from a name: lower-case letters, digits and "_", starting with a
 * letter, at most 32 characters. "Ads & promotions" gives "ads_promotions".
 * A name with no usable letter gives "".
 */
export function slugifyKey(name: string): string {
  const plain = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return PROFILE_KEY_PATTERN.test(plain) ? plain : "";
}

/** An empty line type row. */
export function newFeeType(): FeeTypeForm {
  return {
    uid: newUid(),
    key: "",
    keyFromName: true,
    name: "",
    description: "",
    categoryAccountId: null,
    valuesText: "",
  };
}

/** Text typed one entry per line, as a list: trimmed, empty lines left out. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** An empty condition: the first heading, compared with "is". */
export function newCondition(column = ""): ConditionForm {
  return { uid: newUid(), column, op: "is", value: "", valuesText: "" };
}

/** Row rules that take every row. */
export function newRows(): RowsForm {
  return { where: [], filter: [], feeTypeColumn: "" };
}

/** An empty table layout. */
export function newLayout(): LayoutForm {
  return {
    headersText: "",
    date: "",
    description: "",
    amount: "",
    reference: "",
    dateFormat: "YYYY-MM-DD",
    directionColumn: "",
    directionInText: "",
    directionOutText: "",
    decimalSeparator: ".",
    csvDelimiter: "",
    counterparty: "",
    currency: "",
    documentDateLabel: "",
    totalsText: "",
    balanceColumn: "",
  };
}

function conditionForm(condition: RowCondition): ConditionForm {
  return {
    uid: newUid(),
    column: condition.column,
    op: condition.op,
    value: condition.value ?? "",
    valuesText: (condition.values ?? []).join("\n"),
  };
}

function rowsForm(rows: SectionRows): RowsForm {
  return {
    where: rows.where.map(conditionForm),
    filter: (rows.filter ?? []).map(conditionForm),
    feeTypeColumn: rows.feeTypeColumn ?? "",
  };
}

function layoutForm(layout: TableLayout, mode: ImportModeValue): LayoutForm {
  return {
    headersText: layout.headers.join("\n"),
    date: layout.columns.date,
    description: layout.columns.description,
    amount: layout.columns.amount,
    reference: layout.columns.reference ?? "",
    dateFormat: layout.dateFormat,
    directionColumn: layout.direction?.column ?? "",
    directionInText: (layout.direction?.in ?? []).join("\n"),
    directionOutText: (layout.direction?.out ?? []).join("\n"),
    decimalSeparator: layout.decimalSeparator,
    csvDelimiter: layout.csvDelimiter ?? "",
    counterparty: layout.counterparty ?? "",
    currency: layout.currency ?? "",
    documentDateLabel: layout.documentDateLabel ?? "",
    totalsText: (layout.statedTotalLabels[mode] ?? []).join("\n"),
    balanceColumn: layout.balanceColumn ?? "",
  };
}

/** The headings a layout form names, for the column choices. */
export function layoutHeadings(layout: LayoutForm | null): string[] {
  return layout ? linesOf(layout.headersText) : [];
}

function conditionPayload(condition: ConditionForm): Record<string, unknown> {
  const out: Record<string, unknown> = {
    column: condition.column,
    op: condition.op,
  };
  if (["is", "is_not", "contains"].includes(condition.op)) {
    out.value = condition.value;
  } else if (condition.op === "is_one_of") {
    out.values = linesOf(condition.valuesText);
  }
  return out;
}

function rowsPayload(rows: RowsForm): Record<string, unknown> {
  return {
    where: rows.where.map(conditionPayload),
    ...(rows.filter.length
      ? { filter: rows.filter.map(conditionPayload) }
      : {}),
    feeTypeColumn: rows.feeTypeColumn || null,
  };
}

function layoutPayload(
  layout: LayoutForm,
  mode: ImportModeValue,
): Record<string, unknown> {
  const labels = linesOf(layout.totalsText);
  const statedTotalLabels = labels.length ? { [mode]: labels } : {};
  const directionIn = linesOf(layout.directionInText);
  const directionOut = linesOf(layout.directionOutText);
  return {
    headers: linesOf(layout.headersText),
    columns: {
      date: layout.date,
      description: layout.description,
      amount: layout.amount,
      reference: layout.reference || null,
    },
    dateFormat: layout.dateFormat,
    // Sent when any part of it is filled in, so a direction with values but
    // no column is reported rather than dropped.
    direction:
      layout.directionColumn || directionIn.length || directionOut.length
        ? {
            column: layout.directionColumn,
            in: directionIn,
            out: directionOut,
          }
        : null,
    decimalSeparator: layout.decimalSeparator,
    csvDelimiter: layout.csvDelimiter || null,
    counterparty: layout.counterparty || null,
    currency: layout.currency || null,
    documentDateLabel: layout.documentDateLabel || null,
    statedTotalLabels,
    balanceColumn: layout.balanceColumn || null,
  };
}

/** An empty section. Expense is the commonest kind on a fee document. */
export function newSection(): SectionForm {
  return {
    uid: newUid(),
    key: "",
    keyFromName: true,
    name: "",
    description: "",
    legacyMode: null,
    kind: "expense",
    fixedCategoryAccountId: null,
    feeTypes: [],
    extrasText: "",
    counterAccountId: null,
    readBy: "ai",
    rows: null,
    sameMoneyAs: [],
  };
}

/**
 * Whether the section is read from the table's rows by code: the profile has
 * a table layout and the section is set to it (FR-057).
 */
export function readsFromTable(
  form: Pick<ProfileForm, "layout">,
  section: Pick<SectionForm, "readBy">,
): boolean {
  return form.layout !== null && section.readBy === "table";
}

/**
 * The section a table profile starts with: every row, its kind by the sign of
 * its amount. A profile that only imports a table's transactions needs no
 * other.
 */
export function transactionsSection(): SectionForm {
  const section = newSection();
  section.name = "Transactions";
  section.kind = "by_sign";
  section.readBy = "table";
  section.rows = newRows();
  return section;
}

/** Whether a section has nothing filled in yet. */
function isBlankSection(section: SectionForm): boolean {
  return (
    section.keyFromName &&
    !section.name.trim() &&
    !section.description.trim() &&
    section.feeTypes.length === 0 &&
    !section.extrasText.trim()
  );
}

/**
 * Chooses what the profile imports (FR-055, FR-057), and brings the mode,
 * the layout and every section into line with it:
 *
 * - "summary", "transactions": no table layout; every section is read by the
 *   AI. Each section's row rules stay in the form, unsent, for a switch back.
 * - "table": a layout, and every section read from the table's rows.
 * - "mixed": a layout, the table's sections and the AI's.
 *
 * A kind with a table and no table section yet starts with "Transactions"
 * (`transactionsSection`), in place of a blank section.
 */
export function setKind(form: ProfileForm, kind: ProfileKind): void {
  form.kind = kind;
  form.mode = modeOf(kind);
  if (!kindReadsTable(kind)) {
    form.layout = null;
    for (const section of form.sections) section.readBy = "ai";
    return;
  }
  form.layout ??= newLayout();
  if (kind === "table") {
    // A blank section, read from the table, would take every row beside
    // "Transactions": it is dropped rather than kept empty.
    form.sections = form.sections.filter((s) => !isBlankSection(s));
    for (const section of form.sections) {
      section.readBy = "table";
      section.rows ??= newRows();
    }
  }
  if (!form.sections.some((s) => s.readBy === "table")) {
    form.sections = [transactionsSection(), ...form.sections];
  }
}

/**
 * Ticks or unticks one kind of file the profile reads (FR-070). The list is
 * rebuilt in `PROFILE_FILE_TYPES` order, so ticking again what was unticked
 * leaves the form as it was.
 */
export function toggleFileType(form: ProfileForm, type: ProfileFileType): void {
  const on = !form.fileTypes.includes(type);
  form.fileTypes = PROFILE_FILE_TYPES.filter((t) =>
    t === type ? on : form.fileTypes.includes(t),
  );
}

/**
 * Whether the profile reads spreadsheets, and so has a sheet (FR-069). Read
 * from the ticks as they are, so a form with none ticked, which cannot be
 * saved, shows no sheet either.
 */
export function readsSpreadsheets(
  form: Pick<ProfileForm, "kind" | "fileTypes">,
): boolean {
  return kindReadsTable(form.kind) || form.fileTypes.includes("spreadsheet");
}

/**
 * A new section added under "Lines to import": read by the AI, except in a
 * "table" profile, which has no AI sections.
 */
export function newSectionFor(form: Pick<ProfileForm, "kind">): SectionForm {
  const section = newSection();
  if (form.kind === "table") {
    section.readBy = "table";
    section.rows = newRows();
  }
  return section;
}

/** A blank profile with one empty section, since a profile needs one. */
export function blankForm(): ProfileForm {
  return {
    name: "",
    description: "",
    phrases: [],
    instructions: "",
    mode: ImportMode.Summary,
    statedTotal: "",
    accountId: null,
    fileTypes: [...PROFILE_FILE_TYPES],
    sheet: "",
    layout: null,
    sections: [newSection()],
    kind: "summary",
  };
}

/**
 * The form for a profile, saved or read from a file. Its sections keep the
 * keys they have.
 */
export function formFromDraft(draft: ImportProfileDraft): ProfileForm {
  return {
    name: draft.name,
    description: draft.description,
    phrases: [...draft.phrases],
    instructions: draft.instructions,
    mode: draft.mode,
    statedTotal: draft.statedTotalLabels[draft.mode] ?? "",
    accountId: draft.accountId ?? null,
    fileTypes: [...(draft.fileTypes ?? PROFILE_FILE_TYPES)],
    sheet: draft.sheet ?? "",
    layout: draft.layout ? layoutForm(draft.layout, draft.mode) : null,
    sections: draft.sections.map((section) => ({
      uid: newUid(),
      key: section.key,
      keyFromName: false,
      name: section.name,
      description: section.description,
      // Only a section in the other mode keeps it; one in the profile's mode
      // needs none.
      legacyMode:
        section.mode !== undefined && section.mode !== draft.mode
          ? section.mode
          : null,
      kind: section.kind,
      fixedCategoryAccountId: section.fixedCategoryAccountId,
      feeTypes: section.feeTypes.map((feeType) => ({
        uid: newUid(),
        key: feeType.key,
        keyFromName: false,
        name: feeType.name,
        description: feeType.description,
        categoryAccountId: feeType.categoryAccountId,
        valuesText: (feeType.values ?? []).join("\n"),
      })),
      extrasText: section.extras ? JSON.stringify(section.extras, null, 2) : "",
      counterAccountId: section.counterAccountId ?? null,
      readBy: draft.layout && section.rows ? "table" : "ai",
      rows: section.rows ? rowsForm(section.rows) : null,
      sameMoneyAs: [...(section.sameMoneyAs ?? [])],
    })),
    kind: profileKind(draft),
  };
}

/**
 * The key each section is sent with, in order. A new section's key is made
 * from its name; when that is taken by an earlier section, a number is added
 * ("fees_2"), so two sections with one name do not stop the save. A name with
 * no usable letter gives "section_<n>".
 */
export function sectionKeys(sections: readonly SectionForm[]): string[] {
  return keysFromNames(sections, "section");
}

/**
 * The key each of a section's line types is sent with, in order, made the way
 * `sectionKeys` makes a section's. "none" is never made, as it means a line of
 * none of the types, and a name with no usable letter gives "line_type_<n>".
 */
export function feeTypeKeys(feeTypes: readonly FeeTypeForm[]): string[] {
  return keysFromNames(feeTypes, "line_type", [NONE_VALUE]);
}

/**
 * Saved rows keep their key. A new row's is made from its name, with a number
 * added when it is taken by another row or is one of `reserved`.
 */
function keysFromNames(
  rows: readonly { key: string; keyFromName: boolean; name: string }[],
  fallback: string,
  reserved: readonly string[] = [],
): string[] {
  const keys: string[] = [];
  const taken = new Set([
    ...reserved,
    ...rows.filter((row) => !row.keyFromName).map((row) => row.key),
  ]);
  rows.forEach((row, index) => {
    if (!row.keyFromName) {
      keys.push(row.key);
      return;
    }
    const base = slugifyKey(row.name) || `${fallback}_${index + 1}`;
    let key = base;
    for (let n = 2; taken.has(key); n++) {
      const suffix = `_${n}`;
      key = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    taken.add(key);
    keys.push(key);
  });
  return keys;
}

/**
 * What the editor sends: the profile's form in the shape the shared check
 * reads. The stated total goes under the profile's mode, and only when one is
 * typed. The extra fields go as the text typed.
 *
 * Row rules and the line types' cell values are sent only for a section read
 * from the table's rows (FR-057). What only the AI reads (descriptions,
 * extra fields, instructions) is sent as it is either way: the editor hides
 * it where the AI does not read, and it is there again when a section is
 * switched back to the AI.
 */
export function payloadFromForm(form: ProfileForm): Record<string, unknown> {
  const keys = sectionKeys(form.sections);
  const label = form.statedTotal.trim();
  return {
    name: form.name,
    description: form.description,
    phrases: form.phrases,
    instructions: form.instructions,
    kind: form.kind,
    mode: form.mode,
    statedTotalLabels: label ? { [form.mode]: label } : {},
    accountId: form.accountId,
    // A kind that reads a table reads only spreadsheets: nothing to send.
    ...(kindReadsTable(form.kind) ? {} : { fileTypes: form.fileTypes }),
    sheet: readsSpreadsheets(form) ? form.sheet.trim() || null : null,
    // Sent only when there is one, as a profile without one is saved.
    ...(form.layout ? { layout: layoutPayload(form.layout, form.mode) } : {}),
    sections: form.sections.map((section, index) => {
      const table = readsFromTable(form, section);
      // Set to the table with no rules yet: rules that take every row.
      const rows = table ? (section.rows ?? newRows()) : null;
      const feeKeys = feeTypeKeys(section.feeTypes);
      return {
        key: keys[index],
        name: section.name,
        description: section.description,
        // Only a section saved in the other mode sends one, for the check to
        // refuse (see `legacyMode`).
        ...(section.legacyMode ? { mode: section.legacyMode } : {}),
        kind: section.kind,
        fixedCategoryAccountId: section.fixedCategoryAccountId,
        feeTypes: section.feeTypes.map((feeType, feeIndex) => ({
          key: feeKeys[feeIndex],
          name: feeType.name,
          description: feeType.description,
          categoryAccountId: feeType.categoryAccountId,
          ...(table && linesOf(feeType.valuesText).length
            ? { values: linesOf(feeType.valuesText) }
            : {}),
        })),
        extras: section.extrasText,
        // Sent only for a transfer, the one kind that names it.
        ...(section.kind === "transfer"
          ? { counterAccountId: section.counterAccountId }
          : {}),
        ...(rows ? { rows: rowsPayload(rows) } : {}),
        // Never for a transfer, which the editor gives no such field (FR-066).
        ...(section.kind !== "transfer" && section.sameMoneyAs.length
          ? { sameMoneyAs: section.sameMoneyAs }
          : {}),
      };
    }),
  };
}

/**
 * One string that changes whenever anything the user can save changes, for
 * the unsaved-changes check. Row uids are left out: they are not saved.
 */
export function formFingerprint(form: ProfileForm): string {
  return JSON.stringify(payloadFromForm(form));
}

/** The problems about exactly this path. */
export function errorsAt(
  errors: readonly ProfileError[],
  path: string,
): string[] {
  return errors
    .filter((error) => error.path === path)
    .map((error) => error.message);
}

/**
 * The problems at this path or anywhere under it, with the rest of the path
 * kept, so a message about one property of an extra field still says which.
 */
export function errorsUnder(
  errors: readonly ProfileError[],
  prefix: string,
): string[] {
  return errors
    .filter(
      (error) =>
        error.path === prefix ||
        error.path.startsWith(`${prefix}.`) ||
        error.path.startsWith(`${prefix}[`),
    )
    .map((error) => {
      const rest = error.path.slice(prefix.length).replace(/^\./, "");
      return rest ? `${rest}: ${error.message}` : error.message;
    });
}

// ── Where a problem is ───────────────────────────────────────────────────────

/**
 * Where a problem is on the page, for the "Before you save" list: the place
 * in the editor's own words, and the elements to go to.
 *
 * `targets` are element ids, the field itself first and its card last; the
 * editor goes to the first one on the page, so a field with no id still lands
 * on its card. `sectionUid` is the section to unfold, and `inMore` the
 * expander the field is folded inside.
 */
export interface ProblemPlace {
  label: string;
  targets: string[];
  sectionUid?: string;
  inMore?: "section" | "table";
}

/** The fields under the table's "More options", by their key in the layout. */
const TABLE_MORE_LABELS: Record<string, string> = {
  headers: "Headings",
  dateFormat: "Date format",
  decimalSeparator: "Decimal separator",
  csvDelimiter: "CSV separator",
  counterparty: "Contact",
  currency: "Currency",
  documentDateLabel: "Label of the document date",
  statedTotalLabels: "Labels of the stated totals",
};

/** The fields of the table that are chosen above the sample's columns. */
const TABLE_COLUMN_KEYS = new Set(["columns", "balanceColumn"]);

/**
 * A line type's fields, by key. Its key is made from its name and never shown,
 * so a problem with the key is shown on the name.
 */
const FEE_TYPE_FIELDS: Record<string, string | undefined> = {
  key: "Name",
  name: "Name",
  description: "How to identify",
  values: "Values",
  categoryAccountId: "Category",
};

const PROFILE_PLACES: Record<string, { label: string; target: string }> = {
  name: { label: "Name", target: "pf-name" },
  kind: { label: "What to import", target: "pf-kind" },
  mode: { label: "What to import", target: "pf-kind" },
  accountId: { label: "Account", target: "pf-account" },
  fileTypes: { label: "Reads", target: "pf-file-types" },
  sheet: { label: "Sheet", target: "pf-sheet" },
  description: { label: "Document description", target: "pf-description" },
  phrases: { label: "Fixed phrases", target: "pf-phrases" },
  instructions: { label: "Instructions", target: "pf-instructions" },
  statedTotalLabels: { label: "Stated total", target: "pf-stated-total" },
  sections: { label: "Sections", target: "pf-sections" },
};

function tablePlace(rest: string): ProblemPlace {
  const key = rest.match(/^[a-zA-Z]+/)?.[0] ?? "";
  if (key === "direction") {
    const values = /^direction\.(in|out)/.test(rest);
    return values
      ? {
          label: "Table › Inflow and outflow values",
          targets: ["pf-l-direction", "pf-table"],
          inMore: "table",
        }
      : { label: "Table › Columns", targets: ["pf-table"] };
  }
  if (TABLE_COLUMN_KEYS.has(key)) {
    return { label: "Table › Columns", targets: ["pf-table"] };
  }
  const field = TABLE_MORE_LABELS[key];
  if (field) {
    return {
      label: `Table › More options › ${field}`,
      targets: [`pf-l-${key}`, "pf-table"],
      inMore: "table",
    };
  }
  return { label: "Table", targets: ["pf-table"] };
}

function sectionPlace(
  form: ProfileForm,
  index: number,
  rest: string,
): ProblemPlace {
  const section = form.sections[index];
  const name = section?.name.trim();
  const title = name ? `Section “${name}”` : `Section ${index + 1}`;
  if (!section) return { label: title, targets: ["pf-sections"] };
  const at = `pf-s-${section.uid}`;
  const place = (
    label: string | null,
    ids: string[],
    inMore?: "section",
  ): ProblemPlace => ({
    label: label ? `${title} › ${label}` : title,
    targets: [...ids, at],
    sectionUid: section.uid,
    ...(inMore ? { inMore } : {}),
  });

  const fee = rest.match(/^\.feeTypes\[(\d+)\](?:\.([a-zA-Z]+))?/);
  if (fee) {
    const feeIndex = Number(fee[1]);
    const feeType = section.feeTypes[feeIndex];
    const feeUid = feeType?.uid;
    const field = fee[2] ? FEE_TYPE_FIELDS[fee[2]] : undefined;
    const feeName = feeType?.name.trim();
    const label = `${feeName ? `Line type “${feeName}”` : `Line type ${feeIndex + 1}`}${field ? ` › ${field}` : ""}`;
    return place(label, [
      ...(feeUid ? [`${at}-fee-${feeUid}`] : []),
      `${at}-fees`,
    ]);
  }
  const key = rest.match(/^\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?/);
  switch (key?.[1]) {
    case undefined:
      return place(null, []);
    case "name":
    case "key":
      return place("Name", [`${at}-name`]);
    case "kind":
      return place("Kind", [`${at}-kind`]);
    case "mode":
      return place("What to import", []);
    case "description":
      return place("Description", [`${at}-description`]);
    case "fixedCategoryAccountId":
      return place("Category", [`${at}-category`]);
    case "counterAccountId":
      return place("Contra account", [`${at}-counter`]);
    case "feeTypes":
      return place("Line types", [`${at}-fees`]);
    case "sameMoneyAs":
      return place("More › Overlaps with", [`${at}-same`], "section");
    case "extras":
      return place("More › Extra fields", [`${at}-extras`], "section");
    case "rows":
      if (key[2] === "filter") {
        return place("Import rows only when", [`${at}-filter`]);
      }
      if (key[2] === "feeTypeColumn") {
        return place("Line type column", [`${at}-fees`]);
      }
      return place(
        "More › Rows for this section",
        [`${at}-where`, "pf-sorting"],
        "section",
      );
    default:
      return place(null, []);
  }
}

/**
 * Where the problem at `path` is, in the words the editor shows. The path is
 * one `checkProfile` gives, against the form as `payloadFromForm` sends it,
 * so section and line type indexes are the form's own.
 */
export function problemPlace(path: string, form: ProfileForm): ProblemPlace {
  const section = path.match(/^sections\[(\d+)\](.*)$/);
  if (section) return sectionPlace(form, Number(section[1]), section[2]);
  if (path === "layout" || path.startsWith("layout.")) {
    return tablePlace(path.slice("layout.".length));
  }
  const top = PROFILE_PLACES[path.match(/^[a-zA-Z]+/)?.[0] ?? ""];
  if (top) return { label: top.label, targets: [top.target] };
  return { label: "Profile", targets: [] };
}
