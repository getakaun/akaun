/**
 * Import profiles: a saved way of reading one kind of document (006 US6-7,
 * FR-030 to FR-038).
 *
 * A user fills in a form: the profile's name, how to recognise it, its
 * instructions, and its sections. Each section has a kind (income, expense or
 * by sign), an optional fixed category, and an optional closed list of fee
 * types, each optionally pinned to a category. The server turns this into the
 * JSON Schema sent to the model; the user never edits that schema. The one
 * place raw JSON is allowed is "Advanced: extra fields", a small JSON Schema
 * fragment of plain values per section (FR-035).
 *
 * This file is the one check of a profile. The editor runs it as the user
 * types and the server runs it again before anything is saved, so the two can
 * never disagree about what is allowed (the `sequence-template.ts` pattern).
 * It has no imports from `$lib/server` and does not use zod, because client
 * files do not load zod.
 *
 * A profile may also carry a table layout, and its sections row rules, for
 * reading a spreadsheet from its columns with no AI (FR-053 to FR-055). Every
 * column they name is one of the layout's headings, checked here too.
 *
 * Every problem is reported with the path of the value it is about, such as
 * `sections[1].feeTypes[3].key`, so the editor can show it next to the field,
 * and with a plain sentence saying what is wrong.
 */

import {
  ImportMode,
  importModeLabel,
  isImportMode,
  type ImportModeValue,
} from "./import-reading.js";

// ── Limits ──────────────────────────────────────────────────────────────────

/** Most sections in one profile. */
export const PROFILE_SECTIONS_MAX = 20;
/** Most line types in one section. */
export const PROFILE_FEE_TYPES_MAX = 50;
/**
 * Most listed values in a whole profile: every line type, plus every choice of
 * every extra field. Each one is an `enum` entry in the schema sent, and
 * providers refuse very large enums.
 */
export const PROFILE_ENUM_VALUES_MAX = 200;
/** Most extra fields in one section. */
export const PROFILE_EXTRAS_MAX = 20;
/** Most recognition phrases in one profile. */
export const PROFILE_PHRASES_MAX = 10;
/** Most other profiles one section can name as the same money (FR-066). */
export const PROFILE_SAME_MONEY_MAX = 10;

const NAME_MAX = 80;
const RECOGNITION_MAX = 1000;
const PHRASE_MAX = 100;
const INSTRUCTIONS_MAX = 4000;
const SECTION_NAME_MAX = 80;
const SECTION_DESCRIPTION_MAX = 1000;
const SHORT_DESCRIPTION_MAX = 300;
const ENUM_VALUE_MAX = 100;

/**
 * A key the schema uses: a section, a line type or an extra field. Lower-case
 * letters, digits and "_", starting with a letter, at most 32 characters. The
 * key is what the model writes back, so it must be plain.
 */
export const PROFILE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Names the books already use for an item or for the document as a whole. An
 * extra field may not take one: the item already has that value, and two
 * fields with one name would be read and shown ambiguously (FR-035).
 */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  // What every item has.
  "description",
  "amount",
  "date",
  "reference",
  "source_line",
  "fee_type",
  "category_account_id",
  "category",
  "extras",
  // What the document has once.
  "counterparty",
  "supplier",
  "currency",
  "exchange_rate",
  "document_type",
  "kind",
  // The answer's own parts.
  "header",
  "sections",
  "ignored",
  "stated_total",
  // What the record is given.
  "item_name",
  "remark",
  "account_id",
  "contact",
  "id",
]);

/**
 * What the model writes for "none of these" in a list of choices that may be
 * empty: a line type (a line that is none of the section's types) or an extra
 * field with an enum that a line does not print. It is sent as one more value
 * of the list, not as null: a strict provider (OpenAI, Groq) reads `enum` as
 * the only values allowed, null included, so a list without it would give the
 * model no way to say "none" and it would put a stray line under the closest
 * type (FR-034). The reading turns it back into null, so no line type key and
 * no choice of an extra field may be this word.
 */
export const NONE_VALUE = "none";

/**
 * Names every plain JavaScript object already has, such as "constructor".
 * The reading code looks keys up in plain objects, where one of these names
 * finds the built-in value instead of a field, so a section, field or line type
 * keyed with one would save but could never be read. They are refused like a
 * reserved name.
 */
const OBJECT_BUILTIN_NAMES: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/** The message for a key that is a built-in object name. */
function builtinNameMessage(key: string, what: string): string {
  return `"${key}" cannot be used as ${what}. Choose another name.`;
}

// ── The profile ─────────────────────────────────────────────────────────────

/**
 * What a section's lines become (FR-031). `by_sign` reads a positive amount
 * as income and a negative one as an expense, and both are stored without
 * their sign (FR-008). `transfer` reads each line as money moved between the
 * profile's own account and the section's other account: a negative amount
 * out of the profile's account, a positive one into it (FR-058).
 */
export type ProfileSectionKind = "income" | "expense" | "by_sign" | "transfer";
export const PROFILE_SECTION_KINDS: readonly ProfileSectionKind[] = [
  "income",
  "expense",
  "by_sign",
  "transfer",
];

/** A plain value an extra field can hold. */
export type ExtraScalarType = "string" | "number" | "integer" | "boolean";
const SCALAR_TYPES: readonly ExtraScalarType[] = [
  "string",
  "number",
  "integer",
  "boolean",
];

/**
 * One extra field, written as JSON Schema. `type` is a plain type, or a plain
 * type and "null" in a list, for a value that may be missing.
 */
export interface ExtraFieldSchema {
  type: ExtraScalarType | (ExtraScalarType | "null")[];
  description?: string;
  /** Only for text: the closed list of values the field can take. */
  enum?: string[];
}

/** A section's "Advanced: extra fields": a flat JSON Schema object. */
export interface ExtrasFragment {
  type: "object";
  properties: Record<string, ExtraFieldSchema>;
  /** The fields the document always prints. The rest may be null. */
  required?: string[];
}

/**
 * One kind of line a section lists, such as "Commission fee" (FR-034). The
 * screens call it a "line type"; it is stored as `feeTypes`, its name from
 * before income sections used it too.
 */
export interface ProfileFeeType {
  /**
   * What the model answers with and what an item stores. The editor makes it
   * from the name and never shows it; a saved line type keeps its key when it
   * is renamed, so items already read still name it.
   */
  key: string;
  /**
   * What a person sees: in the editor and the previews, and the description
   * of each item of this type.
   * One saved before line types had names takes it from its key
   * (`nameFromKey`).
   */
  name: string;
  /** Tells the model which lines are this type. May be empty. */
  description: string;
  /** The category every line of this type gets. Wins over any other. */
  categoryAccountId: number | null;
  /**
   * The cell values that mean this line type, in the section's line type column
   * (FR-054), for a section read from columns. Absent, or never set, for a
   * section the AI reads: the model picks the type from its description.
   */
  values?: string[];
}

/**
 * The name a key reads as, for a line type saved before line types had names:
 * "commission_fee" gives "Commission fee".
 */
export function nameFromKey(key: string): string {
  const words = key.replace(/_+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/**
 * What a person sees for a line type key: its name in the section's list, or
 * the key read as words when the list no longer has it.
 */
export function feeTypeName(
  feeTypes: readonly { key: string; name?: string }[] | undefined,
  key: string,
): string {
  return (
    feeTypes?.find((feeType) => feeType.key === key)?.name || nameFromKey(key)
  );
}

// ── Reading from columns (FR-053 to FR-055) ─────────────────────────────────

/** How a row rule compares a cell (FR-054). */
export type RowConditionOp =
  | "is"
  | "is_not"
  | "is_one_of"
  | "contains"
  | "empty"
  | "not_empty";
export const ROW_CONDITION_OPS: readonly RowConditionOp[] = [
  "is",
  "is_not",
  "is_one_of",
  "contains",
  "empty",
  "not_empty",
];

/**
 * One condition on a row: the cell under `column` (a heading of the table)
 * compared with `value`, or with any of `values` for "is one of". "Empty" and
 * "not empty" compare with nothing. Cells are compared as `foldTableText`
 * gives them, so case and spacing do not matter.
 */
export interface RowCondition {
  column: string;
  op: RowConditionOp;
  /** For is, is not and contains. */
  value?: string;
  /** For is one of. */
  values?: string[];
}

/**
 * Which rows of the table a section takes, and what to do with them (FR-054).
 * A row belongs to the section when every condition of `where` holds; an
 * empty `where` takes every row. Every additional `filter` condition must
 * also hold for the row to be imported. `feeTypeColumn` names the column whose value
 * says the row's fee type, matched against each line type's `values`.
 */
export interface SectionRows {
  where: RowCondition[];
  /** Additional keep-matching conditions, independent of section assignment. */
  filter?: RowCondition[];
  feeTypeColumn: string | null;
}

/** How a table writes its dates, for a date cell that is text (FR-053). */
export type TableDateFormat =
  | "YYYY-MM-DD"
  | "YYYY/MM/DD"
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "DD-MM-YYYY"
  | "MM-DD-YYYY"
  | "DD.MM.YYYY";
export const TABLE_DATE_FORMATS: readonly TableDateFormat[] = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
];

/** The separators a `.csv` file's cells may be split by. */
export type TableCsvDelimiter = "," | ";" | "\t" | "|";
export const TABLE_CSV_DELIMITERS: readonly TableCsvDelimiter[] = [
  ",",
  ";",
  "\t",
  "|",
];

/**
 * Where a spreadsheet's table is and what each of its columns holds (FR-053).
 * It belongs to the profile, not a section, because one document has one
 * table. Every column is named by its heading, which must be one of
 * `headers`: the headings that, all in one row, are how the table is found.
 */
export interface TableLayout {
  headers: string[];
  columns: {
    date: string;
    description: string;
    /** The amount, with its sign unless `direction` gives the sign. */
    amount: string;
    reference: string | null;
  };
  /** How a date written as text is laid out. A real date cell needs none. */
  dateFormat: TableDateFormat;
  /**
   * A column that says which way the money went, and the values that mean in
   * and out. When set, it gives each amount its sign.
   */
  direction: { column: string; in: string[]; out: string[] } | null;
  /** The decimal separator of amounts written as text. */
  decimalSeparator: "." | ",";
  /** The separator of a `.csv` file. Null: worked out from the file. */
  csvDelimiter: TableCsvDelimiter | null;
  /** The other party every item shares (FR-006), or null for none. */
  counterparty: string | null;
  /** The ISO-4217 code of every amount. Null: the main currency. */
  currency: string | null;
  /** The label the document's date is printed beside, or null. */
  documentDateLabel: string | null;
  /**
   * The labels the stated total is printed beside, such as "Total Money In"
   * and "Total Money Out". The figures beside them are added up in code. The
   * list is kept under the profile's import mode, the only key allowed, so a
   * layout saved when each mode had its own list still reads. None means no
   * control total.
   */
  statedTotalLabels: Partial<Record<ImportModeValue, string[]>>;
  /**
   * A column that holds the balance after each row, such as "Balance After
   * Transactions". When set, the reading checks that each row's balance
   * follows from the row before it and its amount, and says so in a note: a
   * row missing from the export shows up as a break. Absent when the layout
   * names none, as on every layout saved before the check existed.
   */
  balanceColumn?: string | null;
}

/** Most headings a layout names. */
export const LAYOUT_HEADERS_MAX = 50;
/** Most conditions in one rule. */
export const ROW_CONDITIONS_MAX = 10;
/** Most values one list (is one of, a line type, a direction) holds. */
export const ROW_VALUES_MAX = 50;
/** Most stated-total labels. */
const LAYOUT_LIST_MAX = 10;
const CELL_VALUE_MAX = 100;
/** Excel's own limit on a sheet's name. */
export const SHEET_NAME_MAX = 31;

/**
 * A cell or heading as row rules and headings compare it: Unicode-normalised,
 * in lower case, with its spaces trimmed and runs of spaces made one. "Money
 * In" and " money  in " are the same value. The reader on the server uses
 * this too, so the editor's check and the reading never disagree.
 */
export function foldTableText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The sections a profile reads (FR-032): all of them, except a section saved
 * when each section had its own import mode and that mode is not the
 * profile's. Such a section is only on a profile that had sections in both
 * modes; it is left out until the profile is fixed in the editor.
 */
export function profileSections<
  S extends Pick<ProfileSection, "mode">,
>(profile: { mode: ImportModeValue; sections: readonly S[] }): S[] {
  return profile.sections.filter(
    (section) => section.mode === undefined || section.mode === profile.mode,
  );
}

/**
 * The import mode of a profile saved before the mode was set on the profile,
 * worked out from its sections (FR-032). Every section in one mode gives that
 * mode. A section with none was a Summary section, so none at all gives
 * Summary. Sections in both modes also give Summary; the editor then shows a
 * problem on the Every transaction ones, and the profile cannot be saved
 * until they are moved or the profile is changed.
 */
export function legacyProfileMode(
  sections: readonly Pick<ProfileSection, "mode">[],
): ImportModeValue {
  const modes = new Set(
    sections.map((section) => section.mode ?? ImportMode.Summary),
  );
  return modes.size === 1 && modes.has(ImportMode.EveryTransaction)
    ? ImportMode.EveryTransaction
    : ImportMode.Summary;
}

/**
 * What a profile imports, and so how it reads a document (FR-002, FR-032,
 * FR-055, FR-057). The one choice the editor asks for; the import mode, the
 * table layout and which sections read the table all follow from it.
 *
 * - "table": every row of a spreadsheet's table, read by code. No AI.
 * - "summary": the summary lines of a document, read by the AI in one call.
 * - "transactions": every transaction line of a document, read by the AI in
 *   pieces (FR-043).
 * - "mixed": a spreadsheet's table rows by code, and the summary lines
 *   beside the table by the AI.
 */
export type ProfileKind = "table" | "summary" | "transactions" | "mixed";
export const PROFILE_KINDS: readonly ProfileKind[] = [
  "table",
  "summary",
  "transactions",
  "mixed",
];

export function isProfileKind(value: unknown): value is ProfileKind {
  return (PROFILE_KINDS as readonly unknown[]).includes(value);
}

/** The import mode a kind reads in. */
export function modeOf(kind: ProfileKind): ImportModeValue {
  return kind === "table" || kind === "transactions"
    ? ImportMode.EveryTransaction
    : ImportMode.Summary;
}

/** Whether a kind reads a spreadsheet's table by code, and so only a spreadsheet. */
export function kindReadsTable(kind: ProfileKind): boolean {
  return kind === "table" || kind === "mixed";
}

/** Whether the AI reads any part of a document of this kind. */
export function kindUsesAi(kind: ProfileKind): boolean {
  return kind !== "table";
}

/**
 * The kind of a profile saved before the kind was stored, worked out from
 * its shape: no table layout is read by the AI, in its mode; a layout with
 * row rules on every section it reads is a table; any other layout is mixed.
 */
export function legacyKind(
  profile: Pick<ImportProfileDraft, "layout" | "sections" | "mode">,
): ProfileKind {
  if (!profile.layout) {
    return profile.mode === ImportMode.EveryTransaction
      ? "transactions"
      : "summary";
  }
  const sections = profileSections(profile);
  return sections.length > 0 && sections.every((section) => section.rows)
    ? "table"
    : "mixed";
}

/** A profile's kind: the one it was saved with, else its shape's. */
export function profileKind(
  profile: Pick<ImportProfileDraft, "kind" | "layout" | "sections" | "mode">,
): ProfileKind {
  return profile.kind ?? legacyKind(profile);
}

/**
 * The files a profile reads (FR-070): PDF files and photos, spreadsheets, or
 * both. Excel and CSV are one group, so one profile reads both exports of a
 * report; a CSV file is one sheet.
 */
export type ProfileFileType = "document" | "spreadsheet";
export const PROFILE_FILE_TYPES: readonly ProfileFileType[] = [
  "document",
  "spreadsheet",
];

export function isProfileFileType(value: unknown): value is ProfileFileType {
  return (PROFILE_FILE_TYPES as readonly unknown[]).includes(value);
}

/** How the editor and the "Read as" list name each group. */
export const PROFILE_FILE_TYPE_LABELS: Record<
  ProfileFileType,
  { label: string; hint: string; only: string }
> = {
  document: {
    label: "PDF files and photos",
    hint: "PDF, JPG or PNG.",
    only: "PDFs and photos only",
  },
  spreadsheet: {
    label: "Spreadsheets",
    hint: "Excel (.xlsx) and CSV, so one profile reads both exports of a report.",
    only: "spreadsheets only",
  },
};

/**
 * The files a kind reads, given what a profile of it stored. The one rule: a
 * kind that reads a table reads only a spreadsheet, whatever was stored; a
 * kind the AI reads takes what was ticked, and every file when nothing was,
 * as a profile saved before the choice existed.
 */
export function fileTypesOf(
  kind: ProfileKind,
  stored?: readonly ProfileFileType[] | null,
): readonly ProfileFileType[] {
  if (kindReadsTable(kind)) return ["spreadsheet"];
  const picked = PROFILE_FILE_TYPES.filter((type) => stored?.includes(type));
  return picked.length > 0 ? picked : PROFILE_FILE_TYPES;
}

/** The files a profile reads (FR-070). See `fileTypesOf`. */
export function profileFileTypes(
  profile: Pick<
    ImportProfileDraft,
    "kind" | "layout" | "sections" | "mode" | "fileTypes"
  >,
): readonly ProfileFileType[] {
  return fileTypesOf(profileKind(profile), profile.fileTypes);
}

/**
 * Whether a profile reads documents from their columns, with no AI (FR-055):
 * a "table" profile. Only a spreadsheet can be read this way.
 */
export function readsFromColumns(
  profile: Pick<ImportProfileDraft, "kind" | "layout" | "sections" | "mode">,
): boolean {
  return profileKind(profile) === "table";
}

/**
 * Whether a profile reads a spreadsheet's table by code (FR-055, FR-057).
 * Such a profile reads only a spreadsheet; a PDF or a photo has no cells,
 * and is refused rather than read without those sections.
 */
export function readsTable(
  profile: Pick<ImportProfileDraft, "kind" | "layout" | "sections" | "mode">,
): boolean {
  return kindReadsTable(profileKind(profile));
}

/** Whether the AI reads any part of a document read with this profile. */
export function readsWithAi(
  profile: Pick<ImportProfileDraft, "kind" | "layout" | "sections" | "mode">,
): boolean {
  return kindUsesAi(profileKind(profile));
}

/** One part of the document to read (FR-031). */
export interface ProfileSection {
  /** The section's key in the answer. See `PROFILE_KEY_PATTERN`. */
  key: string;
  /** The name the screens show. */
  name: string;
  /** What the section is and where to find it on the document. */
  description: string;
  /**
   * The import mode a section was saved with when each section had its own,
   * before the mode moved to the profile. Never written now. Kept only so a
   * profile saved then still reads: a section whose mode is not the
   * profile's is left out (`profileSections`), and the editor shows it as a
   * problem.
   */
  mode?: ImportModeValue;
  kind: ProfileSectionKind;
  /** The category of a line with no line type. */
  fixedCategoryAccountId: number | null;
  /**
   * The closed list of line types. Empty means the section takes any line
   * its description fits. When it is not empty, a line of no listed type is
   * not proposed (FR-034).
   */
  feeTypes: ProfileFeeType[];
  /** "Advanced: extra fields". Null when there are none. */
  extras: ExtrasFragment | null;
  /**
   * A transfer section's other account: where the money went from the
   * profile's account, or came from (FR-058). Null, or absent on a section
   * saved before transfers existed, for every other kind.
   */
  counterAccountId?: number | null;
  /**
   * Which rows of the profile's table the section takes (FR-054). Absent for
   * a section the AI reads.
   */
  rows?: SectionRows;
  /**
   * Other profiles whose records describe the same money, such as the income
   * statement whose summary already holds the sales a wallet report lists one
   * by one (FR-066). When records made with one of them already cover an
   * item's month, the item gets a review note. Absent, never empty, when the
   * section names none; a transfer section names none.
   */
  sameMoneyAs?: number[];
}

/** A profile as the editor fills it in and the server saves it. */
export interface ImportProfileDraft {
  name: string;
  /** How to recognise the document, in plain words (FR-030). */
  description: string;
  /** Text that the document always prints, for recognising it without AI. */
  phrases: string[];
  /**
   * The profile's own guidance to the model. It replaces the general import
   * instructions for documents read with this profile (FR-036).
   */
  instructions: string;
  /**
   * What the profile imports, which sets how it reads (`ProfileKind`). Absent
   * on a profile saved before it was stored: `profileKind` then works it out.
   */
  kind?: ProfileKind;
  /**
   * What the profile imports (FR-002, FR-032): the summary lines of a
   * statement, or every row of its transaction table. Follows the kind. Every document read
   * with the profile is read this way, and there is no other choice at
   * upload. To read one kind of document both ways, make two profiles.
   */
  mode: ImportModeValue;
  /**
   * The printed total the reading compares against, such as "Total payout
   * released". It is kept under the profile's mode, the only key allowed, so
   * a profile saved when each mode had its own total still reads. Empty
   * means no control total is shown.
   */
  statedTotalLabels: Partial<Record<ImportModeValue, string>>;
  /**
   * The account the document is about, such as the marketplace wallet a
   * wallet report lists (FR-008, FR-058). Its income and expense items start
   * on it instead of on Accounts payable or Accounts receivable, and it is one
   * side of every transfer. Null, or absent on a profile saved before it
   * existed, when the profile names none.
   */
  accountId?: number | null;
  /**
   * The files the profile reads (FR-070), in `PROFILE_FILE_TYPES` order. Only
   * a kind the AI reads stores it, and only when one group is ticked: absent
   * means both, and a kind that reads a table reads only spreadsheets. Read
   * it through `profileFileTypes`.
   */
  fileTypes?: ProfileFileType[];
  /**
   * The one sheet of a workbook the profile reads (FR-069), by name, matched
   * as `foldTableText` folds it. Absent when it names none: a profile that
   * reads a table then reads the sheet its headings are on, and one the AI
   * reads takes the first visible sheet. Every reading of the profile, by
   * code and by the AI alike, sees that sheet and no other.
   */
  sheet?: string | null;
  /**
   * Where a spreadsheet's table is and what its columns hold (FR-053). Absent
   * when the profile has none: a document is then read by the AI.
   */
  layout?: TableLayout | null;
  sections: ProfileSection[];
}

/** One problem with a profile, at the path of the value it is about. */
export interface ProfileError {
  path: string;
  message: string;
}

/** An extra field in the form the reading uses. */
export interface ExtraField {
  key: string;
  type: ExtraScalarType;
  /** True when the field may be missing on a line. */
  nullable: boolean;
  description: string | null;
  enum: string[] | null;
}

// ── Small checks ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

const KEY_RULE =
  "must start with a lower-case letter and use only a-z, 0-9 and _ (at most 32 characters)";

/**
 * Reads a text field: trimmed, within `max` characters, and present when
 * `required`. Returns the trimmed text, or "" after reporting a problem.
 */
function text(
  value: unknown,
  path: string,
  label: string,
  errors: ProfileError[],
  { max, required }: { max: number; required: boolean },
): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") {
    errors.push({ path, message: `${label} must be text.` });
    return "";
  }
  const trimmed = value.trim();
  if (required && !trimmed) {
    errors.push({ path, message: `Fill in ${label.toLowerCase()}.` });
  } else if (trimmed.length > max) {
    errors.push({
      path,
      message: `${label} can be at most ${max} characters; this has ${trimmed.length}.`,
    });
  }
  return trimmed;
}

/** Reads an optional account: null, or a whole account id. */
function accountRef(
  value: unknown,
  path: string,
  errors: ProfileError[],
  message: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  errors.push({ path, message });
  return null;
}

/** Reads an optional category: null, or a whole account id. */
function categoryId(
  value: unknown,
  path: string,
  errors: ProfileError[],
): number | null {
  return accountRef(
    value,
    path,
    errors,
    "Choose a category from the list, or none.",
  );
}

// ── The table layout and row rules ──────────────────────────────────────────

/** Reads one cell value or heading: text, not empty, within the cell limit. */
function cellValue(
  value: unknown,
  path: string,
  label: string,
  errors: ProfileError[],
): string {
  return text(value, path, label, errors, {
    max: CELL_VALUE_MAX,
    required: true,
  });
}

/**
 * Reads a list of cell values: `min` to `max` of them, none twice once
 * folded (see `foldTableText`).
 */
function valueList(
  raw: unknown,
  path: string,
  label: string,
  errors: ProfileError[],
  { min, max }: { min: number; max: number },
): string[] {
  if (raw === undefined || raw === null) raw = [];
  if (!Array.isArray(raw)) {
    errors.push({ path, message: `${label} must be a list.` });
    return [];
  }
  if (raw.length < min) {
    errors.push({
      path,
      message: `List at least ${min === 1 ? "one value" : `${min} values`} for ${label.toLowerCase()}.`,
    });
  }
  if (raw.length > max) {
    errors.push({
      path,
      message: `${label} can list at most ${max} values; this has ${raw.length}.`,
    });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  raw.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    const value = cellValue(entry, at, "A value", errors);
    if (!value) return;
    const folded = foldTableText(value);
    if (seen.has(folded)) {
      errors.push({ path: at, message: `"${value}" is listed twice.` });
      return;
    }
    seen.add(folded);
    out.push(value);
  });
  return out;
}

/**
 * Reads a column, named by its heading, which must be one of the layout's
 * headings. Null when it is optional and not given.
 */
function columnRef(
  value: unknown,
  path: string,
  headings: ReadonlySet<string>,
  errors: ProfileError[],
  { required, label }: { required: boolean; label: string },
): string | null {
  if (!required && (value === undefined || value === null || value === "")) {
    return null;
  }
  const column = cellValue(value, path, label, errors);
  if (!column) return null;
  if (!headings.has(foldTableText(column))) {
    errors.push({
      path,
      message: `"${column}" is not one of the table's headings. Add it to the headings, or choose one of them.`,
    });
  }
  return column;
}

/** An optional piece of text: null when empty. */
function optionalText(
  value: unknown,
  path: string,
  label: string,
  errors: ProfileError[],
  max: number,
): string | null {
  const cleaned = text(value, path, label, errors, { max, required: false });
  return cleaned || null;
}

/**
 * Checks a profile's table layout (FR-053). Null when the profile has none.
 * The headings are what the rest of the layout, and every section's row
 * rules, name columns by.
 */
function tableLayout(
  raw: unknown,
  path: string,
  mode: ImportModeValue,
  errors: ProfileError[],
): TableLayout | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    errors.push({ path, message: "The table layout must be an object." });
    return null;
  }
  const at = (key: string) => join(path, key);

  // A layout saved before the sheet moved to the profile (FR-069) still
  // names it here; `readProfile` reads it from there.
  const headers = valueList(raw.headers, at("headers"), "Headings", errors, {
    min: 1,
    max: LAYOUT_HEADERS_MAX,
  });
  const headings = new Set(headers.map(foldTableText));

  const rawColumns = isRecord(raw.columns) ? raw.columns : {};
  if (!isRecord(raw.columns)) {
    errors.push({
      path: at("columns"),
      message:
        "Say which column holds the date, the description and the amount.",
    });
  }
  const column = (key: string, label: string, required: boolean) =>
    columnRef(rawColumns[key], `${at("columns")}.${key}`, headings, errors, {
      required,
      label,
    });
  const columns = {
    date: column("date", "The date column", true) ?? "",
    description: column("description", "The description column", true) ?? "",
    amount: column("amount", "The amount column", true) ?? "",
    reference: column("reference", "The reference column", false),
  };

  const dateFormat = raw.dateFormat ?? "YYYY-MM-DD";
  if (!(TABLE_DATE_FORMATS as readonly unknown[]).includes(dateFormat)) {
    errors.push({
      path: at("dateFormat"),
      message: `Choose how dates are written: ${TABLE_DATE_FORMATS.join(", ")}.`,
    });
  }

  let direction: TableLayout["direction"] = null;
  if (raw.direction !== undefined && raw.direction !== null) {
    const dirPath = at("direction");
    const value = isRecord(raw.direction) ? raw.direction : {};
    if (!isRecord(raw.direction)) {
      errors.push({
        path: dirPath,
        message: "The direction must name its column and its values.",
      });
    }
    const dirColumn =
      columnRef(value.column, join(dirPath, "column"), headings, errors, {
        required: true,
        label: "The direction column",
      }) ?? "";
    const valuesIn = valueList(
      value.in,
      join(dirPath, "in"),
      "Inflow values",
      errors,
      { min: 1, max: ROW_VALUES_MAX },
    );
    const valuesOut = valueList(
      value.out,
      join(dirPath, "out"),
      "Outflow values",
      errors,
      { min: 1, max: ROW_VALUES_MAX },
    );
    const ins = new Set(valuesIn.map(foldTableText));
    valuesOut.forEach((entry, index) => {
      if (ins.has(foldTableText(entry))) {
        errors.push({
          path: `${join(dirPath, "out")}[${index}]`,
          message: `"${entry}" cannot be both an inflow value and an outflow value.`,
        });
      }
    });
    direction = { column: dirColumn, in: valuesIn, out: valuesOut };
  }

  const decimalSeparator = raw.decimalSeparator ?? ".";
  if (decimalSeparator !== "." && decimalSeparator !== ",") {
    errors.push({
      path: at("decimalSeparator"),
      message: 'The decimal separator is "." or ",".',
    });
  }
  const csvDelimiter = raw.csvDelimiter ?? null;
  if (
    csvDelimiter !== null &&
    !(TABLE_CSV_DELIMITERS as readonly unknown[]).includes(csvDelimiter)
  ) {
    errors.push({
      path: at("csvDelimiter"),
      message:
        "The CSV separator is a comma, a semicolon, a tab or a vertical bar, or none to work it out from the file.",
    });
  }

  const counterparty = optionalText(
    raw.counterparty,
    at("counterparty"),
    "The other party",
    errors,
    SHORT_DESCRIPTION_MAX,
  );
  let currency = optionalText(
    raw.currency,
    at("currency"),
    "The currency",
    errors,
    3,
  );
  if (currency !== null) {
    currency = currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push({
        path: at("currency"),
        message:
          "The currency is a three-letter ISO code, such as MYR or USD, or none for the main currency.",
      });
    }
  }
  const documentDateLabel = optionalText(
    raw.documentDateLabel,
    at("documentDateLabel"),
    "The document date label",
    errors,
    CELL_VALUE_MAX,
  );

  // A layout saved when a column could be added to the remark may still
  // name some (`remarkColumns`). An import no longer fills the remark, so they
  // are left out here, and the next save drops them.

  // One list of labels, kept under the profile's mode (see the type).
  const statedTotalLabels: TableLayout["statedTotalLabels"] = {};
  const rawTotals = raw.statedTotalLabels ?? {};
  if (!isRecord(rawTotals)) {
    errors.push({
      path: at("statedTotalLabels"),
      message: "The stated total labels must be given under the import mode.",
    });
  } else {
    for (const [key, labels] of Object.entries(rawTotals)) {
      const totalPath = `${at("statedTotalLabels")}.${key}`;
      if (key !== mode) {
        errors.push({
          path: totalPath,
          message: `This profile imports ${importModeLabel(mode)}, so its stated total is given for that only.`,
        });
        continue;
      }
      const list = valueList(labels, totalPath, "Stated total labels", errors, {
        min: 0,
        max: LAYOUT_LIST_MAX,
      });
      if (list.length > 0) statedTotalLabels[mode] = list;
    }
  }

  const balanceColumn = columnRef(
    raw.balanceColumn,
    at("balanceColumn"),
    headings,
    errors,
    { required: false, label: "The balance column" },
  );
  if (
    balanceColumn !== null &&
    foldTableText(balanceColumn) === foldTableText(columns.amount)
  ) {
    errors.push({
      path: at("balanceColumn"),
      message:
        "The balance column is the balance after each row, not its amount. Choose another column, or none.",
    });
  }

  return {
    headers,
    columns,
    dateFormat: dateFormat as TableDateFormat,
    direction,
    decimalSeparator: decimalSeparator as "." | ",",
    csvDelimiter: csvDelimiter as TableCsvDelimiter | null,
    counterparty,
    currency,
    documentDateLabel,
    statedTotalLabels,
    // Only a layout that names one carries the key, as one saved before the
    // check existed does not.
    ...(balanceColumn !== null ? { balanceColumn } : {}),
  };
}

/** Reads a list of row conditions (FR-054). */
function rowConditions(
  raw: unknown,
  path: string,
  headings: ReadonlySet<string>,
  errors: ProfileError[],
): RowCondition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path, message: "The conditions must be a list." });
    return [];
  }
  if (raw.length > ROW_CONDITIONS_MAX) {
    errors.push({
      path,
      message: `A rule can have at most ${ROW_CONDITIONS_MAX} conditions; this has ${raw.length}.`,
    });
  }
  return raw.map((entry, index) => {
    const at = `${path}[${index}]`;
    const value = isRecord(entry) ? entry : {};
    if (!isRecord(entry)) {
      errors.push({ path: at, message: "Each condition must be an object." });
    }
    const column =
      columnRef(value.column, `${at}.column`, headings, errors, {
        required: true,
        label: "The column",
      }) ?? "";
    const op = value.op;
    const condition: RowCondition = { column, op: op as RowConditionOp };
    if (!(ROW_CONDITION_OPS as readonly unknown[]).includes(op)) {
      errors.push({
        path: `${at}.op`,
        message:
          "Choose how the cell is compared: is, is not, is one of, contains, is empty or is not empty.",
      });
    } else if (op === "is" || op === "is_not" || op === "contains") {
      condition.value = cellValue(
        value.value,
        `${at}.value`,
        "The value",
        errors,
      );
    } else if (op === "is_one_of") {
      condition.values = valueList(
        value.values,
        `${at}.values`,
        "The values",
        errors,
        { min: 1, max: ROW_VALUES_MAX },
      );
    }
    return condition;
  });
}

/**
 * Checks a section's row rules (FR-054). Undefined when the section has none.
 * `headings` is null when the profile has no table layout, and then row rules
 * have nothing to read.
 */
function sectionRows(
  raw: unknown,
  path: string,
  headings: ReadonlySet<string> | null,
  errors: ProfileError[],
): SectionRows | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (headings === null) {
    errors.push({
      path,
      message:
        "Row rules read the profile's table, and this profile has no table layout. Add one, or remove the row rules.",
    });
    return undefined;
  }
  if (!isRecord(raw)) {
    errors.push({ path, message: "The row rules must be an object." });
    return undefined;
  }
  const where = rowConditions(raw.where, join(path, "where"), headings, errors);
  const filter = rowConditions(
    raw.filter,
    join(path, "filter"),
    headings,
    errors,
  );
  const feeTypeColumn = columnRef(
    raw.feeTypeColumn,
    join(path, "feeTypeColumn"),
    headings,
    errors,
    { required: false, label: "The line type column" },
  );
  return {
    where,
    ...(filter.length ? { filter } : {}),
    feeTypeColumn,
  };
}

/**
 * What a section's line types and its row rules must agree on: a section read
 * from columns with line types reads each row's type from its line type column,
 * by the values each type lists, and no value may mean two types. A section
 * the AI reads has no values to list.
 */
function checkFeeTypeValues(
  fees: readonly ProfileFeeType[],
  rows: SectionRows | undefined,
  path: string,
  errors: ProfileError[],
) {
  const column = rows?.feeTypeColumn ?? null;
  if (rows && fees.length > 0 && column === null) {
    errors.push({
      path: `${path}.rows.feeTypeColumn`,
      message:
        "Name the column that holds each row's line type, or remove the line types.",
    });
  }
  if (column !== null && fees.length === 0) {
    errors.push({
      path: `${path}.rows.feeTypeColumn`,
      message:
        "A line type column needs the line types it holds. Add them, or remove the column.",
    });
  }
  const meaning = new Map<string, string>();
  fees.forEach((fee, index) => {
    const at = `${path}.feeTypes[${index}].values`;
    const values = fee.values ?? [];
    if (column === null) {
      if (values.length > 0) {
        errors.push({
          path: at,
          message:
            "Cell values are read only from the section's line type column. Name that column under the row rules, or remove the values.",
        });
      }
      return;
    }
    if (values.length === 0) {
      errors.push({
        path: at,
        message: `List the values of "${column}" that mean this line type.`,
      });
    }
    values.forEach((value, valueIndex) => {
      const folded = foldTableText(value);
      const other = meaning.get(folded);
      if (other !== undefined && other !== fee.key) {
        errors.push({
          path: `${at}[${valueIndex}]`,
          message: `"${value}" already means the line type "${other}".`,
        });
      }
      meaning.set(folded, fee.key);
    });
  });
}

// ── Extra fields ────────────────────────────────────────────────────────────

const FRAGMENT_KEYWORDS = new Set(["type", "properties", "required"]);
const FIELD_KEYWORDS = new Set(["type", "description", "enum"]);

function describeKeyword(keyword: string, path: string): ProfileError {
  return {
    path: join(path, keyword),
    message: `"${keyword}" is not supported here. Extra fields may use only type, description and enum, and the list itself only type, properties and required.`,
  };
}

/** Reads one extra field. Returns the cleaned field, or null on a problem. */
function extraField(
  key: string,
  raw: unknown,
  path: string,
  errors: ProfileError[],
): ExtraFieldSchema | null {
  const before = errors.length;
  if (!PROFILE_KEY_PATTERN.test(key)) {
    errors.push({ path, message: `The field name "${key}" ${KEY_RULE}.` });
  } else if (RESERVED_FIELD_NAMES.has(key)) {
    errors.push({
      path,
      message: `"${key}" is a name the books already use for every item. Choose another name.`,
    });
  } else if (OBJECT_BUILTIN_NAMES.has(key)) {
    errors.push({ path, message: builtinNameMessage(key, "a field name") });
  }
  if (!isRecord(raw)) {
    errors.push({
      path,
      message: "Each extra field must be an object with a type.",
    });
    return null;
  }
  for (const keyword of Object.keys(raw)) {
    if (!FIELD_KEYWORDS.has(keyword)) {
      errors.push(
        keyword === "properties" || keyword === "items"
          ? {
              path: join(path, keyword),
              message:
                "Extra fields hold plain values only: text, a number or true/false. Nested objects and lists are not supported.",
            }
          : describeKeyword(keyword, path),
      );
    }
  }

  // The type: one plain type, or a plain type and "null" in a list.
  const typePath = join(path, "type");
  const types = Array.isArray(raw.type) ? raw.type : [raw.type];
  let scalar: ExtraScalarType | null = null;
  let nullable = false;
  let typeOk = types.length >= 1 && types.length <= 2;
  for (const entry of types) {
    if (entry === "null" && !nullable) {
      nullable = true;
    } else if (
      typeof entry === "string" &&
      (SCALAR_TYPES as readonly string[]).includes(entry) &&
      scalar === null
    ) {
      scalar = entry as ExtraScalarType;
    } else if (entry === "object" || entry === "array") {
      errors.push({
        path: typePath,
        message:
          "Extra fields hold plain values only: text, a number or true/false. Nested objects and lists are not supported.",
      });
      return null;
    } else {
      typeOk = false;
    }
  }
  if (!typeOk || scalar === null) {
    errors.push({
      path: typePath,
      message:
        'The type must be "string", "number", "integer" or "boolean", or one of them and "null" in a list, such as ["string", "null"].',
    });
    return null;
  }

  const field: ExtraFieldSchema = {
    type: nullable ? [scalar, "null"] : scalar,
  };

  if (raw.description !== undefined) {
    const description = text(
      raw.description,
      join(path, "description"),
      "The description",
      errors,
      { max: SHORT_DESCRIPTION_MAX, required: false },
    );
    if (description) field.description = description;
  }

  if (raw.enum !== undefined) {
    const enumPath = join(path, "enum");
    if (scalar !== "string") {
      errors.push({
        path: enumPath,
        message: "A list of choices (enum) is allowed only on a text field.",
      });
    } else if (!Array.isArray(raw.enum) || raw.enum.length === 0) {
      errors.push({
        path: enumPath,
        message: "The list of choices (enum) must be a list of text values.",
      });
    } else {
      const seen = new Set<string>();
      raw.enum.forEach((value, index) => {
        const valuePath = `${enumPath}[${index}]`;
        if (typeof value !== "string" || !value.trim()) {
          errors.push({
            path: valuePath,
            message: "Each choice must be text and not empty.",
          });
        } else if (value.length > ENUM_VALUE_MAX) {
          errors.push({
            path: valuePath,
            message: `Each choice can be at most ${ENUM_VALUE_MAX} characters.`,
          });
        } else if (value === NONE_VALUE) {
          errors.push({
            path: valuePath,
            message: `"${NONE_VALUE}" is how the reading marks a line that has none of these choices. Leave it out; a line with no choice is read as empty.`,
          });
        } else if (seen.has(value)) {
          errors.push({
            path: valuePath,
            message: `"${value}" is listed twice.`,
          });
        } else {
          seen.add(value);
        }
      });
      field.enum = [...seen];
    }
  }

  return errors.length === before ? field : null;
}

/**
 * Checks a section's "Advanced: extra fields" (FR-035): a JSON Schema object
 * of plain values, written as JSON text or already parsed. Empty text, null
 * or an object with no properties all mean "no extra fields".
 *
 * Only `type`, `properties` and `required` are allowed on the object, and only
 * `type`, `description` and `enum` (text values only) on each field; a value
 * that may be missing is written as a type list with "null". Anything else is
 * refused with its path, never silently dropped, so what the user wrote is
 * exactly what is sent.
 *
 * `path` is where the fragment sits, for the messages: `sections[0].extras`
 * inside a profile.
 */
export function validateExtrasFragment(
  input: unknown,
  path = "extras",
):
  | { ok: true; fragment: ExtrasFragment | null; enumCount: number }
  | { ok: false; errors: ProfileError[] } {
  let raw = input;
  if (typeof raw === "string") {
    if (!raw.trim()) return { ok: true, fragment: null, enumCount: 0 };
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errors: [{ path, message: `This is not valid JSON: ${reason}` }],
      };
    }
  }
  if (raw === undefined || raw === null) {
    return { ok: true, fragment: null, enumCount: 0 };
  }

  const errors: ProfileError[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [
        {
          path,
          message:
            'Extra fields must be a JSON Schema object, such as {"type": "object", "properties": {...}}.',
        },
      ],
    };
  }
  for (const keyword of Object.keys(raw)) {
    if (!FRAGMENT_KEYWORDS.has(keyword)) {
      errors.push(describeKeyword(keyword, path));
    }
  }
  if (raw.type !== "object") {
    errors.push({
      path: join(path, "type"),
      message: 'The type of the extra fields must be "object".',
    });
  }

  const propertiesPath = join(path, "properties");
  const properties = raw.properties ?? {};
  if (!isRecord(properties)) {
    errors.push({
      path: propertiesPath,
      message: "properties must be an object naming each extra field.",
    });
    return { ok: false, errors };
  }
  const keys = Object.keys(properties);
  if (keys.length > PROFILE_EXTRAS_MAX) {
    errors.push({
      path: propertiesPath,
      message: `A section can have at most ${PROFILE_EXTRAS_MAX} extra fields; this has ${keys.length}.`,
    });
  }

  const requiredPath = join(path, "required");
  let required: string[] = [];
  if (raw.required !== undefined) {
    if (
      !Array.isArray(raw.required) ||
      raw.required.some((entry) => typeof entry !== "string")
    ) {
      errors.push({
        path: requiredPath,
        message: "required must be a list of field names.",
      });
    } else {
      required = raw.required as string[];
      const seen = new Set<string>();
      required.forEach((name, index) => {
        if (!Object.hasOwn(properties, name)) {
          errors.push({
            path: `${requiredPath}[${index}]`,
            message: `"${name}" is not one of the extra fields.`,
          });
        } else if (seen.has(name)) {
          errors.push({
            path: `${requiredPath}[${index}]`,
            message: `"${name}" is listed twice.`,
          });
        }
        seen.add(name);
      });
    }
  }

  const cleaned: Record<string, ExtraFieldSchema> = {};
  let enumCount = 0;
  for (const key of keys) {
    const field = extraField(
      key,
      properties[key],
      join(propertiesPath, key),
      errors,
    );
    if (field) {
      cleaned[key] = field;
      enumCount += field.enum?.length ?? 0;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (keys.length === 0) return { ok: true, fragment: null, enumCount: 0 };
  const fragment: ExtrasFragment = { type: "object", properties: cleaned };
  const keptRequired = [...new Set(required)];
  if (keptRequired.length > 0) fragment.required = keptRequired;
  return { ok: true, fragment, enumCount };
}

/**
 * The extra fields of a checked fragment, in the form the reading uses. A
 * field may be missing on a line (`nullable`) when its type lists "null" or
 * when it is not in `required`: the answer always has every field, and a
 * missing value is sent back as null.
 */
export function extraFieldsOf(fragment: ExtrasFragment | null): ExtraField[] {
  if (!fragment) return [];
  const required = new Set(fragment.required ?? []);
  return Object.entries(fragment.properties).map(([key, field]) => {
    const types = Array.isArray(field.type) ? field.type : [field.type];
    const scalar = types.find((entry) => entry !== "null") as ExtraScalarType;
    return {
      key,
      type: scalar,
      nullable: types.includes("null") || !required.has(key),
      description: field.description ?? null,
      enum: field.enum ? [...field.enum] : null,
    };
  });
}

// ── The whole profile ───────────────────────────────────────────────────────

function feeTypes(
  raw: unknown,
  path: string,
  errors: ProfileError[],
): ProfileFeeType[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path, message: "Line types must be a list." });
    return [];
  }
  if (raw.length > PROFILE_FEE_TYPES_MAX) {
    errors.push({
      path,
      message: `A section can list at most ${PROFILE_FEE_TYPES_MAX} line types; this has ${raw.length}.`,
    });
  }
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  return raw.map((entry, index) => {
    const at = `${path}[${index}]`;
    const value = isRecord(entry) ? entry : {};
    if (!isRecord(entry)) {
      errors.push({ path: at, message: "Each line type must be an object." });
    }
    const key = typeof value.key === "string" ? value.key.trim() : "";
    if (!PROFILE_KEY_PATTERN.test(key)) {
      errors.push({
        path: `${at}.key`,
        message: key
          ? `The line type key "${key}" ${KEY_RULE}.`
          : "The line type key is required.",
      });
    } else if (OBJECT_BUILTIN_NAMES.has(key)) {
      errors.push({
        path: `${at}.key`,
        message: builtinNameMessage(key, "a line type key"),
      });
    } else if (key === NONE_VALUE) {
      errors.push({
        path: `${at}.key`,
        message: `"${NONE_VALUE}" is how the reading marks a line that is none of the line types. Choose another key.`,
      });
    } else if (seen.has(key)) {
      errors.push({
        path: `${at}.key`,
        message: `The line type "${key}" is listed twice in this section.`,
      });
    }
    seen.add(key);
    // A line type saved before names were added reads its key as words.
    const name =
      text(value.name, `${at}.name`, "The line type name", errors, {
        max: SECTION_NAME_MAX,
        required: false,
      }) || nameFromKey(key);
    const folded = name.toLowerCase();
    if (name && seenNames.has(folded)) {
      errors.push({
        path: `${at}.name`,
        message: `The line type "${name}" is listed twice in this section.`,
      });
    }
    seenNames.add(folded);
    const fee: ProfileFeeType = {
      key,
      name,
      description: text(
        value.description,
        `${at}.description`,
        "The “How to identify” text",
        errors,
        { max: SHORT_DESCRIPTION_MAX, required: false },
      ),
      categoryAccountId: categoryId(
        value.categoryAccountId,
        `${at}.categoryAccountId`,
        errors,
      ),
    };
    // The values that mean it in a line type column. Whether the section has
    // one is checked with its row rules (`checkFeeTypeValues`).
    const values = valueList(
      value.values,
      `${at}.values`,
      "The line type's values",
      errors,
      { min: 0, max: ROW_VALUES_MAX },
    );
    if (values.length > 0) fee.values = values;
    return fee;
  });
}

/**
 * Reads the other profiles a section names as the same money (FR-066): whole
 * profile ids, none twice. Whether each still exists is the server's check.
 */
function sameMoneyList(
  raw: unknown,
  path: string,
  errors: ProfileError[],
): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path, message: "The profiles must be a list." });
    return [];
  }
  if (raw.length > PROFILE_SAME_MONEY_MAX) {
    errors.push({
      path,
      message: `A section can name at most ${PROFILE_SAME_MONEY_MAX} other profiles; this has ${raw.length}.`,
    });
  }
  const out: number[] = [];
  raw.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry <= 0
    ) {
      errors.push({ path: at, message: "Choose a profile from the list." });
    } else if (out.includes(entry)) {
      errors.push({ path: at, message: "This profile is named twice." });
    } else {
      out.push(entry);
    }
  });
  return out;
}

function section(
  raw: unknown,
  path: string,
  seenKeys: Set<string>,
  headings: ReadonlySet<string> | null,
  profileMode: ImportModeValue,
  errors: ProfileError[],
): { section: ProfileSection; enumCount: number } {
  const value = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    errors.push({ path, message: "Each section must be an object." });
  }

  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!PROFILE_KEY_PATTERN.test(key)) {
    errors.push({
      path: `${path}.key`,
      message: key
        ? `The section key "${key}" ${KEY_RULE}.`
        : "The section key is required.",
    });
  } else if (OBJECT_BUILTIN_NAMES.has(key)) {
    errors.push({
      path: `${path}.key`,
      message: builtinNameMessage(key, "a section key"),
    });
  } else if (seenKeys.has(key)) {
    errors.push({
      path: `${path}.key`,
      message: `Two sections use the key "${key}". Each section needs its own key.`,
    });
  }
  seenKeys.add(key);

  // Read in the order the editor shows the fields, so the problems are
  // listed in that order too.
  const name = text(value.name, `${path}.name`, "The section name", errors, {
    max: SECTION_NAME_MAX,
    required: true,
  });
  // The AI finds a section's lines by its description. A section read from
  // the table's rows by code needs none: its row rules say which rows it
  // takes, and it is never sent to the AI (FR-057).
  const description = text(
    value.description,
    `${path}.description`,
    "The section description",
    errors,
    {
      max: SECTION_DESCRIPTION_MAX,
      required: value.rows === undefined || value.rows === null,
    },
  );

  // A section no longer has a mode of its own: the profile's decides. One
  // still sent with the other mode was saved when each section had its own,
  // on a profile with sections in both modes, and saving it now would quietly
  // read it the other way. It is refused until it is moved or kept on purpose.
  if (isImportMode(value.mode) && value.mode !== profileMode) {
    errors.push({
      path: `${path}.mode`,
      message: `This profile now reads one way: ${importModeLabel(profileMode)}. This section was read as ${importModeLabel(value.mode)}: move it to a new profile, or change the profile to ${importModeLabel(value.mode)}.`,
    });
  }

  const kind = value.kind;
  if (!(PROFILE_SECTION_KINDS as readonly unknown[]).includes(kind)) {
    errors.push({
      path: `${path}.kind`,
      message:
        "Choose whether the section is Income, Expense, By sign or Transfer.",
    });
  }

  const fixedCategoryAccountId = categoryId(
    value.fixedCategoryAccountId,
    `${path}.fixedCategoryAccountId`,
    errors,
  );
  const fees = feeTypes(value.feeTypes, `${path}.feeTypes`, errors);
  const extras = validateExtrasFragment(value.extras, `${path}.extras`);
  if (!extras.ok) errors.push(...extras.errors);
  const rows = sectionRows(value.rows, `${path}.rows`, headings, errors);
  checkFeeTypeValues(fees, rows, path, errors);

  // A transfer is neither income nor an expense, so it has no category, and
  // it names the other account instead (FR-031, FR-058). Whether that account
  // holds money is the server's check, against the chart of accounts.
  let counterAccountId: number | null = null;
  if (kind === "transfer") {
    counterAccountId = accountRef(
      value.counterAccountId,
      `${path}.counterAccountId`,
      errors,
      "Choose the other account from the list.",
    );
    if (
      counterAccountId === null &&
      !errors.some((error) => error.path === `${path}.counterAccountId`)
    ) {
      errors.push({
        path: `${path}.counterAccountId`,
        message:
          "Choose the other account of these transfers, such as the bank account a withdrawal goes to.",
      });
    }
    if (fixedCategoryAccountId !== null) {
      errors.push({
        path: `${path}.fixedCategoryAccountId`,
        message:
          "A transfer has no category: it moves money between two of your own accounts. Remove the category.",
      });
    }
    if (fees.length > 0) {
      errors.push({
        path: `${path}.feeTypes`,
        message:
          "A transfer section has no line types. Remove them, or make the section Income, Expense or By sign.",
      });
    }
  }

  const sameMoneyAs = sameMoneyList(
    value.sameMoneyAs,
    `${path}.sameMoneyAs`,
    errors,
  );
  if (kind === "transfer" && sameMoneyAs.length > 0) {
    errors.push({
      path: `${path}.sameMoneyAs`,
      message:
        "A transfer moves money between two of your own accounts, so it cannot count another document's sales twice. Remove the profiles named here.",
    });
  }

  return {
    section: {
      key,
      name,
      description,
      kind: kind as ProfileSectionKind,
      fixedCategoryAccountId,
      feeTypes: fees,
      extras: extras.ok ? extras.fragment : null,
      // Only a transfer names one, so no other section carries the key.
      ...(kind === "transfer" ? { counterAccountId } : {}),
      // Only a section read from columns has row rules.
      ...(rows ? { rows } : {}),
      // Only a section that names another profile carries the list.
      ...(sameMoneyAs.length > 0 ? { sameMoneyAs } : {}),
    },
    enumCount: fees.length + (extras.ok ? extras.enumCount : 0),
  };
}

/**
 * Checks a profile and returns a cleaned copy: text trimmed, keys the profile
 * does not have dropped, the extra fields parsed. A profile with any problem
 * gives every problem found instead, and must not be saved (FR-035 AS8).
 *
 * What this cannot check is whether a chosen category still exists and fits
 * the section; the server checks that against the chart of accounts.
 */
export function checkProfile(
  input: unknown,
):
  | { ok: true; profile: ImportProfileDraft }
  | { ok: false; errors: ProfileError[] } {
  const { profile, errors } = readProfile(input);
  if (profile === null || errors.length > 0) return { ok: false, errors };
  return { ok: true, profile };
}

/**
 * Reads a profile as far as it can: the cleaned copy, even when some of it is
 * wrong, and every problem found. Null for a value that is not an object.
 */
function readProfile(input: unknown): {
  profile: ImportProfileDraft | null;
  errors: ProfileError[];
} {
  const errors: ProfileError[] = [];
  if (!isRecord(input)) {
    return {
      profile: null,
      errors: [{ path: "", message: "The profile must be an object." }],
    };
  }

  const name = text(input.name, "name", "The name", errors, {
    max: NAME_MAX,
    required: true,
  });
  // Required only of a profile the AI picks by it; one that reads a table is
  // found by the table's headings (FR-039). Checked once the kind is known.
  const description = text(
    input.description,
    "description",
    "The recognition description",
    errors,
    { max: RECOGNITION_MAX, required: false },
  );
  const instructions = text(
    input.instructions,
    "instructions",
    "The instructions",
    errors,
    { max: INSTRUCTIONS_MAX, required: false },
  );

  // Recognition phrases: optional, each one plain text, none twice.
  const phrases: string[] = [];
  const rawPhrases = input.phrases ?? [];
  if (!Array.isArray(rawPhrases)) {
    errors.push({ path: "phrases", message: "Phrases must be a list." });
  } else {
    if (rawPhrases.length > PROFILE_PHRASES_MAX) {
      errors.push({
        path: "phrases",
        message: `A profile can have at most ${PROFILE_PHRASES_MAX} recognition phrases; this has ${rawPhrases.length}.`,
      });
    }
    const seen = new Set<string>();
    rawPhrases.forEach((raw, index) => {
      const phrase = text(raw, `phrases[${index}]`, "A phrase", errors, {
        max: PHRASE_MAX,
        required: true,
      });
      const folded = phrase.toLowerCase();
      if (phrase && seen.has(folded)) {
        errors.push({
          path: `phrases[${index}]`,
          message: `The phrase "${phrase}" is listed twice.`,
        });
      }
      seen.add(folded);
      if (phrase) phrases.push(phrase);
    });
  }

  // What the profile imports (`ProfileKind`). Sent, it sets the mode. A
  // profile sent without one, as an older editor sends it, keeps the mode it
  // sends, and its kind is worked out from its shape below.
  let sentKind: ProfileKind | null = null;
  if (isProfileKind(input.kind)) {
    sentKind = input.kind;
  } else if (input.kind !== undefined && input.kind !== null) {
    errors.push({
      path: "kind",
      message:
        "Choose what the profile imports: Table rows, Summary lines, Transaction lines, or Table rows and summary lines.",
    });
  }

  // The files it reads (FR-070). Absent means what the kind allows; an empty
  // list is refused below, once the kind is known.
  let fileTypes: ProfileFileType[] | null = null;
  if (input.fileTypes !== undefined && input.fileTypes !== null) {
    if (
      Array.isArray(input.fileTypes) &&
      input.fileTypes.every(isProfileFileType)
    ) {
      const sent: unknown[] = input.fileTypes;
      fileTypes = PROFILE_FILE_TYPES.filter((type) => sent.includes(type));
    } else {
      errors.push({
        path: "fileTypes",
        message:
          "Choose the files the profile reads: PDF files and photos, spreadsheets, or both.",
      });
    }
  }

  // What the profile imports (FR-002, FR-032). A profile sent without one,
  // as an editor opened before the mode was on the profile sends it, gets the
  // mode its sections were saved in.
  let mode: ImportModeValue;
  if (sentKind) {
    mode = modeOf(sentKind);
  } else if (input.mode === undefined || input.mode === null) {
    mode = legacyProfileMode(
      Array.isArray(input.sections)
        ? input.sections.map((raw) => ({
            mode:
              isRecord(raw) && isImportMode(raw.mode) ? raw.mode : undefined,
          }))
        : [],
    );
  } else if (isImportMode(input.mode)) {
    mode = input.mode;
  } else {
    mode = ImportMode.Summary;
    errors.push({
      path: "mode",
      message:
        "Choose what the profile imports: Summary lines or Every transaction.",
    });
  }

  // The stated total, kept under the profile's mode (see the type).
  const statedTotalLabels: ImportProfileDraft["statedTotalLabels"] = {};
  const rawLabels = input.statedTotalLabels ?? {};
  if (!isRecord(rawLabels)) {
    errors.push({
      path: "statedTotalLabels",
      message: "The stated total must be given under the import mode.",
    });
  } else {
    for (const [key, label] of Object.entries(rawLabels)) {
      const at = `statedTotalLabels.${key}`;
      if (key !== mode) {
        errors.push({
          path: at,
          message: `This profile imports ${importModeLabel(mode)}, so its stated total is given for that only.`,
        });
        continue;
      }
      const cleaned = text(label, at, "The stated total", errors, {
        max: SHORT_DESCRIPTION_MAX,
        required: false,
      });
      if (cleaned) statedTotalLabels[mode] = cleaned;
    }
  }

  // The account the document is about (FR-058). Optional, except that a
  // transfer needs it: it is the transfer's other side.
  const accountId = accountRef(
    input.accountId,
    "accountId",
    errors,
    "Choose the account from the list, or none.",
  );

  // The one sheet the profile reads (FR-069). A profile saved before it was
  // on the profile names it on its table layout, and is read from there.
  const legacySheet =
    input.sheet === undefined && isRecord(input.layout)
      ? input.layout.sheet
      : undefined;
  // Either way, a problem with it is the Sheet field's, where it is edited.
  // A profile that reads no spreadsheet has no sheet: what an editor kept of
  // one, hidden, is not read (FR-070).
  const readsSheets =
    sentKind === null ||
    fileTypesOf(sentKind, fileTypes).includes("spreadsheet");
  let sheet = readsSheets
    ? optionalText(
        legacySheet === undefined ? input.sheet : legacySheet,
        "sheet",
        "The sheet name",
        errors,
        SHEET_NAME_MAX,
      )
    : null;

  // The table layout, read before the sections: their row rules name its
  // columns (FR-053, FR-054).
  // A kind the AI reads has no table: what an editor kept of one is not read.
  const readsCells = sentKind === null || kindReadsTable(sentKind);
  const layout = readsCells
    ? tableLayout(input.layout, "layout", mode, errors)
    : null;
  const headings = layout ? new Set(layout.headers.map(foldTableText)) : null;

  // The sections, and the listed values they add up to.
  const sections: ProfileSection[] = [];
  let enumCount = 0;
  let enumReported = false;
  const rawSections = input.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    errors.push({
      path: "sections",
      message: "A profile needs at least one section.",
    });
  } else {
    if (rawSections.length > PROFILE_SECTIONS_MAX) {
      errors.push({
        path: "sections",
        message: `A profile can have at most ${PROFILE_SECTIONS_MAX} sections; this has ${rawSections.length}.`,
      });
    }
    const seenKeys = new Set<string>();
    rawSections.forEach((raw, index) => {
      const path = `sections[${index}]`;
      // Likewise its sections' row rules.
      const sent =
        !readsCells && isRecord(raw) ? { ...raw, rows: undefined } : raw;
      const read = section(sent, path, seenKeys, headings, mode, errors);
      sections.push(read.section);
      enumCount += read.enumCount;
      if (enumCount > PROFILE_ENUM_VALUES_MAX && !enumReported) {
        enumReported = true;
        errors.push({
          path,
          message: `A profile can list at most ${PROFILE_ENUM_VALUES_MAX} values in all (line types and the choices of extra fields); it reaches ${enumCount} at this section.`,
        });
      }
    });
  }

  sections.forEach((section, index) => {
    if (section.kind !== "transfer") return;
    const at = `sections[${index}].counterAccountId`;
    if (accountId === null) {
      if (!errors.some((error) => error.path === "accountId")) {
        errors.push({
          path: "accountId",
          message:
            "A transfer section needs the account this document is about, such as the marketplace wallet. Choose it.",
        });
      }
    } else if (section.counterAccountId === accountId) {
      errors.push({
        path: at,
        message:
          "The other account must be a different account from the one this document is about.",
      });
    }
  });

  const kind = sentKind ?? legacyKind({ layout, sections, mode });
  if (sentKind) checkKind(sentKind, layout, sections, mode, errors);
  // A kind that reads a table reads only spreadsheets, so a choice sent with
  // one is dropped, as a layout sent with a kind the AI reads is.
  if (kindReadsTable(kind)) {
    fileTypes = null;
  } else if (fileTypes?.length === 0) {
    errors.push({
      path: "fileTypes",
      message: "Choose at least one kind of file the profile reads.",
    });
  }
  if (!fileTypesOf(kind, fileTypes).includes("spreadsheet")) sheet = null;
  if (!kindReadsTable(kind) && !description) {
    errors.push({
      path: "description",
      message: "Fill in the recognition description.",
    });
  }

  return {
    errors,
    profile: {
      name,
      description,
      phrases,
      instructions,
      kind,
      mode,
      statedTotalLabels,
      // A profile that names no account carries no key for it, as one saved
      // before the account existed does.
      ...(accountId !== null ? { accountId } : {}),
      // Likewise one that reads both kinds of file, or what its kind allows.
      ...(fileTypes?.length === 1 ? { fileTypes } : {}),
      // Likewise one that names no sheet.
      ...(sheet !== null ? { sheet } : {}),
      // Likewise a profile with no table layout carries no key for it.
      ...(layout ? { layout } : {}),
      sections,
    },
  };
}

/**
 * What a kind needs of the layout and the sections (FR-055, FR-057): a table
 * kind needs a table, a "table" profile reads every section from it, and a
 * mixed one has sections of both ways.
 */
function checkKind(
  kind: ProfileKind,
  layout: TableLayout | null,
  sections: readonly ProfileSection[],
  mode: ImportModeValue,
  errors: ProfileError[],
): void {
  if (!kindReadsTable(kind)) return;
  if (!layout && !errors.some((error) => error.path.startsWith("layout"))) {
    errors.push({
      path: "layout",
      message:
        "Set the table: load a sample, or type the headings and choose the columns.",
    });
  }
  const read = profileSections({ mode, sections });
  if (kind === "table") {
    sections.forEach((section, index) => {
      if (read.includes(section) && !section.rows) {
        errors.push({
          path: `sections[${index}].rows`,
          message: "Set the rows that this section gets from the table.",
        });
      }
    });
    return;
  }
  if (!read.some((section) => section.rows)) {
    errors.push({
      path: "sections",
      message:
        "Add a section that gets rows from the table, or choose Summary lines.",
    });
  }
  if (!read.some((section) => !section.rows)) {
    errors.push({
      path: "sections",
      message:
        "Add a section for the lines outside the table, or choose Table rows.",
    });
  }
}

/**
 * Whether a problem stops a table from being read: one about the profile's
 * mode or layout, or about a section's key, mode, row rules or line types,
 * which say which rows it takes. A missing name, description or account does
 * not.
 */
function stopsTableReading(path: string): boolean {
  if (
    path === "mode" ||
    path === "sections" ||
    path === "sheet" ||
    path === "layout" ||
    path.startsWith("layout.")
  )
    return true;
  return /^sections\[\d+\](?:$|\.(?:key|mode|kind|rows|feeTypes)(?:$|[.[]))/.test(
    path,
  );
}

/**
 * Checks a profile only as far as a preview of its table needs (FR-053,
 * FR-054): the layout, and which rows each section takes. A profile still
 * being filled in can be previewed before it can be saved, so a missing name
 * or account is left for the save to report, in `unsaved`.
 */
export function checkTablePreview(input: unknown):
  | {
      ok: true;
      profile: ImportProfileDraft & { layout: TableLayout };
      unsaved: ProfileError[];
    }
  | { ok: false; errors: ProfileError[] } {
  const { profile, errors } = readProfile(input);
  if (profile === null) return { ok: false, errors };
  const stopping = errors.filter((error) => stopsTableReading(error.path));
  if (!profile.layout && stopping.length === 0) {
    stopping.push({
      path: "layout",
      message:
        "Add the table layout first: the preview reads the spreadsheet by its columns.",
    });
  }
  if (
    profile.layout &&
    !profile.sections.some((section) => section.rows) &&
    stopping.length === 0
  ) {
    stopping.push({
      path: "sections",
      message:
        "Give at least one section row rules: they say which rows it takes.",
    });
  }
  if (stopping.length > 0 || !profile.layout) {
    return { ok: false, errors: stopping };
  }
  return {
    ok: true,
    profile: profile as ImportProfileDraft & { layout: TableLayout },
    unsaved: errors.filter((error) => !stopsTableReading(error.path)),
  };
}

/** Every problem with a profile. An empty list means it can be saved. */
export function validateProfile(input: unknown): ProfileError[] {
  const result = checkProfile(input);
  return result.ok ? [] : result.errors;
}

/** The problems as one sentence list, for a refusal's reason. */
export function formatProfileErrors(
  errors: readonly ProfileError[],
  shown = 5,
): string {
  const lines = errors
    .slice(0, shown)
    .map((error) =>
      error.path ? `${error.path}: ${error.message}` : error.message,
    );
  if (errors.length > shown) {
    lines.push(`and ${errors.length - shown} more.`);
  }
  return lines.join(" ");
}
