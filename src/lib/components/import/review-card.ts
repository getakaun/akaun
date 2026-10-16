import { isContraRevenueAccount } from "$lib/account-classification.js";
import { AccountType, documentTypeEnum } from "$lib/enums.js";
import {
  defaultTargetForImportSource,
  importSourceIsIncome,
  targetAccountsForImportSource,
} from "$lib/import-account-groups.js";
import {
  ImportReadAs,
  ImportReadHow,
  PROFILE_READ_AS_PREFIX,
  controlTotal,
  importModeLabel,
  isImportMode,
  parseExtractionNotes,
  profileReadAsValue,
} from "$lib/import-reading.js";
import { formatCurrency } from "$lib/currency.js";
import type { AccountView } from "$lib/server/ledger/types.js";

/**
 * What the import screens need to know about one proposed record: a receipt on
 * the queue, or one item of a document read as several items. Both have the
 * same review fields (`reviewColumns` on the server), so one review card shows
 * either, and the rules below are written once for both.
 */

/** A contact the other party's name may be, best first. */
export type Candidate = { id: number; legalName: string; score?: number };

/**
 * The reviewer's corrections that are not saved yet, by field name. The names
 * are the ones the confirm route and the item edit route take
 * (`reviewOverridesSchema` on the server).
 */
export type ReviewEdits = Record<string, string | number>;

/** The review fields of a receipt or an item, as the screen holds them. */
export type ReviewRow = {
  id: string;
  /**
   * "expense" or "income", as read, or "transfer_out" / "transfer_in" for an
   * item of a profile's transfer section (006 FR-058); null when the reading
   * did not say.
   */
  documentType: string | null;
  itemName: string | null;
  supplier: string | null;
  matchedContactId: number | null;
  matchCandidates: Candidate[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  exchangeRate: number | null;
  reference: string | null;
  category: string | null;
  categoryAccountId: number | null;
  remark: string | null;
  /** Which account paid for this, or received it. */
  accountId: number | null;
  duplicateOf: number | null;
  duplicateConfidence: number | null;
  duplicateReasons: string[];
  /**
   * Something the reading could not do as the profile asked, such as a fee
   * type's tied category that is for the other kind (006 FR-034). Null when
   * there is nothing to say.
   */
  reviewNote: string | null;
  /**
   * What to check before confirming that no category choice answers: a
   * section's flag rule (006 FR-061), or money another profile's records may
   * already hold (FR-066). Null when there is nothing to say.
   */
  checkNote: string | null;
  /**
   * A transfer's other account: where the money went from `accountId`, or
   * came from. Null for anything else.
   */
  counterAccountId: number | null;
};

/** The accounts and defaults a review card chooses from. */
export type ReviewOptions = {
  allAccounts: AccountView[];
  categoryAccounts: AccountView[];
  /** The accounts either side of a transfer can be: those that hold money. */
  transferAccounts: AccountView[];
  payableAccountId: number | null;
  receivableAccountId: number | null;
  uncategorisedAccountId: number | null;
  uncategorisedIncomeAccountId: number | null;
};

function parseList<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * The review fields of a row as the server sends it (codes, and lists stored
 * as JSON text), in the shape the card reads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reviewRowFrom(raw: any): ReviewRow {
  return {
    id: raw.id,
    documentType: documentTypeEnum.toLabel(raw.documentType),
    itemName: raw.itemName ?? null,
    supplier: raw.supplier ?? null,
    matchedContactId: raw.matchedContactId ?? null,
    matchCandidates: parseList<Candidate>(raw.matchCandidates),
    date: raw.date ?? null,
    amount: raw.amount ?? null,
    currency: raw.currency ?? null,
    exchangeRate: raw.exchangeRate ?? null,
    reference: raw.reference ?? null,
    category: raw.category ?? null,
    categoryAccountId: raw.categoryAccountId ?? null,
    remark: raw.remark ?? null,
    accountId: raw.accountId ?? null,
    duplicateOf: raw.duplicateOf ?? null,
    duplicateConfidence: raw.duplicateConfidence ?? null,
    duplicateReasons: parseList<string>(raw.duplicateReasons),
    reviewNote: raw.reviewNote ?? null,
    checkNote: raw.checkNote ?? null,
    counterAccountId: raw.counterAccountId ?? null,
  };
}

/**
 * An item's extra fields, as "name: value" (006 FR-035), in the order the
 * profile lists them. A field the line did not print is left out. They are
 * shown on the item only: an import never writes the record's remark.
 * Empty for a receipt, which has none.
 */
export function extraFieldsShown(extrasJson: unknown): string[] {
  if (typeof extrasJson !== "string" || !extrasJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(extrasJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    )
    .map(([name, value]) => `${name}: ${String(value)}`);
}

// ── Fields ──────────────────────────────────────────────────────────────────

/** A field's value: the reviewer's correction, else what was read. */
export function editedValue(
  row: ReviewRow,
  edits: ReviewEdits,
  key: string,
  mainCurrency: string,
): string | number {
  if (key in edits) return edits[key];
  if (key === "item_name") return row.itemName ?? "";
  if (key === "supplier") return row.supplier ?? "";
  if (key === "amount") return row.amount ?? 0;
  if (key === "currency") return (row.currency ?? mainCurrency).toUpperCase();
  if (key === "exchangeRate") return row.exchangeRate ?? "";
  if (key === "category") return row.category ?? "";
  if (key === "date") return row.date ?? "";
  if (key === "reference") return row.reference ?? "";
  if (key === "remark") return row.remark ?? "";
  return "";
}

/** The currency the record will be in. */
export function reviewCurrency(
  row: ReviewRow,
  edits: ReviewEdits,
  mainCurrency: string,
): string {
  return String(
    editedValue(row, edits, "currency", mainCurrency) || mainCurrency,
  ).toUpperCase();
}

export function reviewIsForeign(
  row: ReviewRow,
  edits: ReviewEdits,
  mainCurrency: string,
): boolean {
  return reviewCurrency(row, edits, mainCurrency) !== mainCurrency;
}

/** The exchange rate as text, or "" when there is none. */
export function reviewRateText(
  row: ReviewRow,
  edits: ReviewEdits,
  mainCurrency: string,
): string {
  const v = editedValue(row, edits, "exchangeRate", mainCurrency);
  return v === "" || v == null ? "" : String(v);
}

/** A foreign currency with no rate cannot be valued, so it cannot be imported. */
export function reviewRateMissing(
  row: ReviewRow,
  edits: ReviewEdits,
  mainCurrency: string,
): boolean {
  return (
    reviewIsForeign(row, edits, mainCurrency) &&
    !(parseFloat(reviewRateText(row, edits, mainCurrency)) > 0)
  );
}

/**
 * The amount in the main currency, for the read-only preview only. The record
 * itself is converted on the server, in whole cents.
 */
export function reviewConverted(
  row: ReviewRow,
  edits: ReviewEdits,
  mainCurrency: string,
): number | null {
  const a = parseFloat(String(editedValue(row, edits, "amount", mainCurrency)));
  const r = parseFloat(reviewRateText(row, edits, mainCurrency));
  if (
    !reviewIsForeign(row, edits, mainCurrency) ||
    isNaN(a) ||
    isNaN(r) ||
    r <= 0
  )
    return null;
  return a * r;
}

/** Two decimals with thousands separators, or a dash. For display only. */
export function formatMoney(n: number | null): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// ── Possible duplicates ─────────────────────────────────────────────────────

const DUP_REASON_LABELS: Record<string, string> = {
  file_hash: "identical file",
  reference: "reference",
  amount: "amount",
  date: "date",
  supplier: "supplier",
  filename: "filename",
  content: "content",
  accounts: "accounts",
};

export function dupReasonsLabel(row: ReviewRow): string {
  return row.duplicateReasons.map((r) => DUP_REASON_LABELS[r] ?? r).join(" · ");
}

export function dupMessage(row: ReviewRow): string {
  if (row.duplicateReasons.includes("file_hash"))
    return `This exact file was already imported.`;
  return `${row.duplicateConfidence}% match on ${dupReasonsLabel(row)} against an existing record.`;
}

// ── Accounts ────────────────────────────────────────────────────────────────

/** Whether a row is a transfer between two of the business's own accounts. */
export function isTransferRow(row: Pick<ReviewRow, "documentType">): boolean {
  return (
    row.documentType === "transfer_out" || row.documentType === "transfer_in"
  );
}

/**
 * A transfer's two accounts as the card shows them, the money moving from the
 * source to the target: out of the document's account (`accountId`) to the
 * other one, or into it from there.
 */
// Mirrors src/lib/server/import/settle-review.ts's transferSidesOf — the card
// sends the pair back as fromAccountId/toAccountId, which the server turns
// into the two columns again, so both must read the direction the same way.
export function transferSides(
  row: Pick<ReviewRow, "documentType" | "accountId" | "counterAccountId">,
): { source: number | null; target: number | null } {
  return row.documentType === "transfer_in"
    ? { source: row.counterAccountId, target: row.accountId }
    : { source: row.accountId, target: row.counterAccountId };
}

/** The accounts a transfer's side may be: any that holds money but the other side. */
export function transferChoices(
  options: ReviewOptions,
  otherSide: number | null,
): AccountView[] {
  return options.transferAccounts.filter((account) => account.id !== otherSide);
}

/**
 * The category account a row was read under: its own when that is still one of
 * the categories, else the category whose name it read, for its kind.
 */
export function initialCategoryAccountId(
  row: Pick<ReviewRow, "category" | "categoryAccountId" | "documentType">,
  options: ReviewOptions,
): number | null {
  const categories = options.categoryAccounts.filter((account) =>
    row.documentType === "income"
      ? account.type === AccountType.Revenue && !isContraRevenueAccount(account)
      : account.type !== AccountType.Revenue || isContraRevenueAccount(account),
  );
  if (
    row.categoryAccountId != null &&
    categories.some((account) => account.id === row.categoryAccountId)
  ) {
    return row.categoryAccountId;
  }
  const wanted = (row.category ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const candidates = categories.filter(
    (account) => account.name.trim().toLowerCase() === wanted,
  );
  return candidates[0]?.id ?? null;
}

/**
 * The category a card starts with, as both receiptSides and itemSides put it:
 * the one that was read, else Uncategorised for the row's kind.
 */
export function readCategoryAccountId(
  row: ReviewRow,
  options: ReviewOptions,
): number | null {
  return (
    initialCategoryAccountId(row, options) ??
    (row.documentType === "income"
      ? options.uncategorisedIncomeAccountId
      : options.uncategorisedAccountId)
  );
}

/**
 * The two accounts a receipt's card starts with. The source sets the
 * direction: an income starts from its category, an expense from Accounts
 * Payable (an imported document proves an amount is owed, not that it was
 * paid).
 *
 * `keepReadAccount` is for a document read with a profile that gave one item
 * (FR-009): the reading chose its account, which is the profile's own account
 * when it names one (FR-008), so the card starts there instead. A receipt read
 * the standard way starts as it always has (FR-004).
 */
export function receiptSides(
  row: ReviewRow,
  options: ReviewOptions,
  keepReadAccount = false,
): { source: number | null; target: number | null } {
  // A document read with a profile that gave one transfer (FR-009).
  if (isTransferRow(row)) return transferSides(row);
  const read = keepReadAccount ? row.accountId : null;
  if (row.documentType === "income") {
    return {
      source:
        initialCategoryAccountId(row, options) ??
        options.uncategorisedIncomeAccountId,
      target: read ?? options.receivableAccountId ?? row.accountId ?? null,
    };
  }
  return {
    source: read ?? options.payableAccountId ?? row.accountId ?? null,
    target:
      initialCategoryAccountId(row, options) ?? options.uncategorisedAccountId,
  };
}

/**
 * The two accounts an item's card shows. An item keeps its account and its
 * category on the server, so they are read from the item as it is: the account
 * that paid is the source of an expense, and the account that received is the
 * target of an income.
 */
export function itemSides(
  row: ReviewRow,
  options: ReviewOptions,
): { source: number | null; target: number | null } {
  if (isTransferRow(row)) return transferSides(row);
  if (row.documentType === "income") {
    return {
      source:
        initialCategoryAccountId(row, options) ??
        options.uncategorisedIncomeAccountId,
      target: row.accountId,
    };
  }
  return {
    source: row.accountId,
    target:
      initialCategoryAccountId(row, options) ?? options.uncategorisedAccountId,
  };
}

/** The accounts the target may be, once the source has set the direction. */
export function targetChoices(
  options: ReviewOptions,
  source: number | null,
): AccountView[] {
  return targetAccountsForImportSource(
    options.allAccounts,
    source,
    options.payableAccountId,
    options.receivableAccountId,
  );
}

/**
 * The target after the source changed: the one chosen, while it still fits the
 * new source, else the usual default for that direction, else none.
 */
export function targetAfterSourceChange(
  options: ReviewOptions,
  source: number,
  currentTarget: number | null,
): number | null {
  const targets = targetChoices(options, source);
  if (targets.some((account) => account.id === currentTarget))
    return currentTarget;
  const defaultTarget = defaultTargetForImportSource(
    options.allAccounts,
    source,
    options.receivableAccountId,
    options.uncategorisedAccountId,
  );
  return targets.some((account) => account.id === defaultTarget)
    ? defaultTarget
    : null;
}

/** Whether the chosen source makes this an income. */
export function sideIsIncome(
  row: Pick<ReviewRow, "documentType">,
  options: ReviewOptions,
  source: number | null,
): boolean {
  return source == null
    ? row.documentType === "income"
    : importSourceIsIncome(options.allAccounts, source);
}

// ── How a document is read ──────────────────────────────────────────────────

/** How a document is to be read, or was read: the columns the screens look at. */
export type ReadingOf = {
  readAs?: string | null;
  readHow?: string | null;
  /** The saved profile's id, for a document read with one. */
  profileId?: string | null;
  /**
   * The profile's name and import mode, from the copy the server kept when it
   * read it.
   */
  profile?: { name: string; mode?: string } | null;
  /**
   * What the reading noted, as the row stores it. Read here only for how the
   * items were read: a spreadsheet read from its columns says so (FR-041).
   */
  extractionNotes?: string | null;
};

/** What a reading was picked by, in brackets after it (FR-041). */
function pickedBy(readHow: string | null | undefined): string {
  if (readHow === ImportReadHow.Detected) return " (detected)";
  if (readHow === ImportReadHow.Chosen) return " (chosen)";
  // Auto-detect found no profile that fits, so it read the standard way.
  if (readHow === ImportReadHow.Standard) return " (auto-detect)";
  // A row from before 006 says nothing about how it was picked.
  return "";
}

/**
 * How a document was read, in the words every import screen uses (FR-041):
 * the profile by name and whether it was detected or chosen, the standard
 * reading, or several items.
 */
export function describeReading(job: ReadingOf): string {
  if (job.readAs === ImportReadAs.SeveralItems) {
    return `Multiple records${pickedBy(job.readHow)}`;
  }
  // A profile chosen at upload, or one Auto-detect found for it.
  if (
    job.readAs === ImportReadAs.Profile ||
    job.readHow === ImportReadHow.Detected
  ) {
    const name = job.profile ? `“${job.profile.name}”` : "an import profile";
    const how = job.readHow === ImportReadHow.Detected ? "detected" : "chosen";
    // The mode it was read in, always, from the copy of the profile kept with
    // the reading (FR-002, FR-038), so an older reading still says it.
    const readIn = job.profile?.mode;
    const mode = isImportMode(readIn) ? ` · ${importModeLabel(readIn)}` : "";
    const notes = parseExtractionNotes(job.extractionNotes);
    const method = notes?.method;
    // The one sheet of a workbook it read, when the file has more (FR-069).
    const sheet = notes?.sheet ? ` · sheet “${notes.sheet}”` : "";
    const read =
      method === "columns"
        ? " · read from columns"
        : method === "columns_ai"
          ? " · table read from columns, the rest by AI"
          : method === "ai_pieces"
            ? " · read in parts"
            : "";
    return `Read with ${name} (${how})${mode}${sheet}${read}`;
  }
  // The receipt or invoice reading: chosen, the Auto-detect fallback, or a
  // row from before 006 (FR-040, FR-048).
  return `Single record${pickedBy(job.readHow)}`;
}

/**
 * What the queue says while a long document is read in parts, such as
 * "Reading part 3 of 25" (FR-043, US8 AS2), or null when it is not being
 * read in parts. `done` parts are read, so the one being read is the next.
 * A document read in one call shows no count.
 */
export function readingProgressLabel(job: {
  progressDone?: number | null;
  progressTotal?: number | null;
}): string | null {
  const total = job.progressTotal ?? 0;
  if (!Number.isInteger(total) || total < 2) return null;
  const done = Math.max(0, job.progressDone ?? 0);
  const part = Math.min(done + 1, total);
  return `Reading part ${part.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

/**
 * Whether a one-item card keeps the account its reading chose: a document
 * read with a profile, which may name the account its items start on (FR-008).
 * See `receiptSides`.
 */
export function keepsReadAccount(job: ReadingOf): boolean {
  return (
    job.readAs === ImportReadAs.Profile ||
    job.readHow === ImportReadHow.Detected
  );
}

/** Whether a document is, or was, read the standard way (one record). */
function isStandardReading(job: ReadingOf): boolean {
  return (
    job.readAs !== ImportReadAs.SeveralItems &&
    job.readAs !== ImportReadAs.Profile &&
    job.readHow !== ImportReadHow.Detected
  );
}

/**
 * The line a document on the import queue shows about how it is read, or
 * null when there is nothing to say (FR-041).
 *
 * - `profilesEnabled`: whether any import profile is turned on. With none,
 *   the standard reading is the only reading Auto-detect can give, and the
 *   queue looks as it did before profiles existed (FR-003), so a standard
 *   reading is not labelled. A profile or several-items reading always is.
 * - `waiting`: the document has not been read yet, or its reading failed.
 *   An Auto-detect row says "standard" from the upload on and only changes
 *   once a profile is detected, so until then it is shown as "Auto-detect",
 *   which is what it is waiting for.
 */
export function readingLabel(
  job: ReadingOf,
  context: { profilesEnabled: boolean; waiting?: boolean },
): string | null {
  if (!isStandardReading(job)) return describeReading(job);
  if (!context.profilesEnabled) return null;
  if (context.waiting && job.readAs === ImportReadAs.Auto) return "Auto-detect";
  return describeReading(job);
}

/**
 * The "Read as" value that names how this document was asked to be read,
 * in the words an upload and "Read again" take. A row stores a profile as
 * "profile" plus its id, and the upload names it `profile:<id>`. A row from
 * before 006 was read as a receipt.
 */
export function readAsOfJob(
  job: Pick<ReadingOf, "readAs" | "profileId">,
): string {
  if (job.readAs === ImportReadAs.Profile && job.profileId) {
    return profileReadAsValue(job.profileId);
  }
  return job.readAs ?? ImportReadAs.Receipt;
}

/** Whether any of the "Read as" choices is a saved profile. */
export function hasProfileChoice(choices: { value: string }[]): boolean {
  return choices.some((choice) =>
    choice.value.startsWith(PROFILE_READ_AS_PREFIX),
  );
}

// ── A document read as several items ────────────────────────────────────────

/** The control total as the screens say it, or null when there is none. */
export function describeControlTotal(
  extractionNotes: string | null | undefined,
): { matches: boolean; text: string } | null {
  const notes = parseExtractionNotes(extractionNotes);
  if (!notes) return null;
  const total = controlTotal(notes);
  if (!total || !notes.statedTotal) return null;
  if (total.matches) {
    return { matches: true, text: "Control total matches" };
  }
  // Cents to a decimal for display only: the comparison above is in cents.
  const difference = formatCurrency(
    Math.abs(total.differenceMinor) / 100,
    notes.statedTotal.currency,
  );
  return { matches: false, text: `Control total differs by ${difference}` };
}
