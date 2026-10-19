/**
 * Reads a document that holds several items into one proposed record per item
 * (006 US1-3). The model only copies what is printed: which lines are items,
 * and each line's wording and amount. Everything worked out from those figures
 * is done here in code, in whole cents: the kind of each item, the direction of
 * the stated total, and the control total. The model's own arithmetic is never
 * used, because the research on real documents found it wrong (design.md,
 * "S0.5 research results").
 *
 * The reading is all or nothing (FR-011): the document is read in one call on
 * one provider, and when that fails the next provider reads the whole document
 * again. Nothing is ever cut to fit (FR-010): a document over a limit fails
 * with the limit named.
 *
 * What it returns is not saved here. The import worker turns each item into
 * review fields (contact match, exchange rate, duplicate check).
 */

import { DocumentType, type DocumentTypeCode } from "$lib/enums.js";
import { feeTypeName } from "$lib/import-profile-schema.js";
import {
  DOCUMENT_ITEMS_MAX,
  DOCUMENT_TEXT_MAX_CHARS,
  capIgnored,
  controlTotal,
  type ExtractionNotes,
} from "$lib/import-reading.js";
import { fromMinor, toMinor } from "../ledger/money.js";
import type { Minor } from "../ledger/types.js";
import type { LLMProviderConfig } from "../llm/model-factory.js";
import {
  CallTimedOutError,
  OutputTruncatedError,
  SchemaRejectedError,
  callStructured,
  withProviderFailover,
  type StructuredSpec,
} from "../llm/structured-call.js";
import { createLogger } from "../logger.js";
import {
  compileProfile,
  type CompiledProfile,
  type ReadEnvelope,
  type ReadItem,
  type ReadingProfile,
  type SectionSpec,
} from "./profile-compiler.js";
import {
  DOCUMENT_IS_DATA,
  JSON_ONLY,
  MAX_LABEL_LENGTH,
  PROMPT_ROLE,
  accountChoicesJson,
  customInstructionsBlock,
  parseCurrency,
  parseDate,
  truncate,
  wrapDocument,
  type ImportAccountChoice,
} from "./providers/shared.js";

const log = createLogger("import:document-reader");

/** Which limit a document went over. */
export type DocumentLimit = "characters" | "items" | "output" | "time";

/**
 * The longest one request to the model may take while reading a document. It
 * is kept well under Bun's own 300 s fetch timeout, whose error names no limit,
 * so a slow reading fails with this limit named instead (FR-010). The research
 * model wrote about 10 to 20 tokens a second (design.md, "S0.5 research
 * results").
 */
export const DOCUMENT_READ_TIMEOUT_MS = 240_000;

/**
 * The most tokens the model may write in one reading. It is kept at 8,192, an
 * output length most models accept: a provider may refuse a figure above its
 * model's own limit with HTTP 400, and then every reading on it would fail. At
 * the research model's speed, the time limit above is reached first anyway. A
 * document whose answer needs more fails with the output limit named.
 */
export const DOCUMENT_READ_MAX_OUTPUT_TOKENS = 8_192;

/** The limits of one reading. Tests pass smaller ones. */
export interface DocumentReadLimits {
  timeoutMs: number;
  maxOutputTokens: number;
}

const DEFAULT_READ_LIMITS: DocumentReadLimits = {
  timeoutMs: DOCUMENT_READ_TIMEOUT_MS,
  maxOutputTokens: DOCUMENT_READ_MAX_OUTPUT_TOKENS,
};

/**
 * A document that cannot be read in full. Its message names the limit, so the
 * failed upload tells the user why (FR-010).
 */
export class DocumentLimitError extends Error {
  constructor(
    readonly limit: DocumentLimit,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DocumentLimitError";
  }
}

export interface DocumentReadingParams {
  /** The document's numbered text (`extractNumberedText`). */
  text: string;
  /**
   * What to read: `SEVERAL_ITEMS_PROFILE`, or a saved import profile compiled
   * by `savedReadingProfile`.
   */
  profile: ReadingProfile;
  expenseAccounts: ImportAccountChoice[];
  incomeAccounts: ImportAccountChoice[];
  mainCurrency: string;
  /**
   * The user's own notes about their documents, from Settings. A profile with
   * guidance of its own is read with that instead (FR-036).
   */
  customInstructions?: string;
  /** YYYY-MM-DD; the date used when the document's own is unclear. */
  today?: string;
}

/** One proposed record. */
export interface DocumentItem {
  sectionKey: string;
  kind: DocumentTypeCode;
  description: string;
  /** Positive whole cents in the document's own currency. */
  amountMinor: Minor;
  /** The same figure as a decimal, as a review field stores it. */
  amount: number;
  /** The item's own date when its line prints one, else the document's. */
  date: string;
  /**
   * The item's own reference when its line prints one, else the document's;
   * in Every transaction mode only its own (FR-062).
   */
  reference: string;
  /** The document line the amount is printed on, when the model said. */
  sourceLine: number | null;
  /** The line type's key, as the model or the table's rows gave it. */
  feeType: string | null;
  /**
   * The line type's name, which is also the item's description. Null with
   * no line type;
   * absent in an item built by hand, which shows the key read as words.
   */
  feeTypeName?: string | null;
  /**
   * The category to propose: the first of `categoryCandidates`. The worker
   * still checks it against the user's list.
   */
  categoryAccountId: number | null;
  /**
   * Every category the item could take, best first (FR-034, US6 AS7): its fee
   * type's tied category, then the model's pick, then its section's fixed
   * category for a line with no fee type. The worker uses the first that is
   * still a category of the item's kind, and Uncategorised when none is.
   */
  categoryCandidates: number[];
  /**
   * A transfer's other account, from its section (FR-058). Null for an
   * income or an expense.
   */
  counterAccountId: number | null;
  /**
   * The category the item's fee type is tied to, when it is tied to one. The
   * worker says on the item when it could not be used (FR-034), for example an
   * income category on a line a by-sign section reads as an expense.
   */
  tiedCategoryAccountId: number | null;
  extras: Record<string, unknown> | null;
  /**
   * What the reviewer is to check on this item, from its section's flag rule
   * (FR-061), or null. Only a reading from columns sets one.
   */
  reviewNote: string | null;
}

/** What reading a document found. */
export interface DocumentReading {
  schemaId: string;
  /** The other party, never shortened: it is matched against contacts. */
  counterparty: string;
  date: string;
  reference: string;
  currency: string;
  items: DocumentItem[];
  /** The stated total, the items added up, and the lines left out. */
  notes: ExtractionNotes;
  /** The items against the stated total; null when none is printed. */
  controlTotal: { matches: boolean; differenceMinor: number } | null;
}

/** A count as a limit's message writes it, such as "200,000". */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** "4 minutes", "1 minute" or "0.05 seconds", for a limit's message. */
export function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = ms / 1000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * Throws when the document has more text than one reading sends the model
 * (FR-010). The text is counted as the model receives it, with its line
 * numbers.
 */
export function checkDocumentLength(text: string): void {
  if (text.length > DOCUMENT_TEXT_MAX_CHARS) {
    throw new DocumentLimitError(
      "characters",
      `This document is too long to read in full: it has ${formatCount(text.length)} characters of text, and the limit is ${formatCount(DOCUMENT_TEXT_MAX_CHARS)}.`,
    );
  }
}

/**
 * Throws when an answer lists more lines than one document may yield
 * (FR-010). Every line counts, including those the reading later leaves out.
 */
export function checkItemCount(
  envelope: Pick<ReadEnvelope, "sections">,
  profile: ReadingProfile,
): void {
  const lineCount = profile.sections.reduce(
    (sum, section) => sum + (envelope.sections[section.key]?.length ?? 0),
    0,
  );
  if (lineCount > DOCUMENT_ITEMS_MAX) throw tooManyItems(lineCount);
}

/** The error for a document that yields more items than the limit. */
export function tooManyItems(count: number): DocumentLimitError {
  return new DocumentLimitError(
    "items",
    `This document has too many items to import: ${formatCount(count)} were read, and the limit is ${formatCount(DOCUMENT_ITEMS_MAX)}.`,
  );
}

/** The instructions sent with the document. */
export function buildItemsSystemPrompt(
  compiled: Pick<CompiledProfile, "wire">,
  params: Omit<DocumentReadingParams, "text">,
): string {
  const asksForCategory = params.profile.sections.some(
    (section) => section.categoryFromModel,
  );
  // A saved profile's line can be either kind, by its section or its sign.
  const kindOfLine =
    params.profile.guidance === undefined
      ? "document's kind"
      : "line's kind (income or expense)";
  const categoryLines = asksForCategory
    ? `
- category_account_id = the id of the best matching account for that line, from the list for the
  ${kindOfLine}. Null when the line does not say enough to choose one. Never invent an id.
  Expense and asset-purchase accounts: ${accountChoicesJson(params.expenseAccounts)}
  Income accounts: ${accountChoicesJson(params.incomeAccounts)}`
    : "";
  // A saved profile's own instructions replace the general ones, even when
  // it has none (FR-036). The rules above them stay either way.
  const guidance =
    params.profile.guidance === undefined
      ? params.customInstructions
      : params.profile.guidance;
  return `${PROMPT_ROLE}

${DOCUMENT_IS_DATA}
The system starts each line of the document with its number, such as L0001│, and each page with a
line such as --- page 2 ---. These marks are not printed on the document.

Instructions:
${params.profile.instructions}${categoryLines}
${customInstructionsBlock(guidance)}
The JSON must match this JSON Schema, and its descriptions say what each field holds:
${JSON.stringify(compiled.wire)}

${JSON_ONLY}`;
}

/**
 * Reads the document with the profile and returns its items, or throws. A
 * document over a limit throws `DocumentLimitError`.
 */
export async function readDocumentItems(
  params: DocumentReadingParams,
  providers: LLMProviderConfig[],
  intervalMs = 0,
  limits: Partial<DocumentReadLimits> = {},
): Promise<DocumentReading> {
  const today = params.today ?? new Date().toISOString().slice(0, 10);
  const { envelope, schemaId } = await readDocumentEnvelope(
    params,
    providers,
    intervalMs,
    limits,
  );
  const reading = readingFromEnvelope(envelope, params.profile, {
    today,
    mainCurrency: params.mainCurrency,
    schemaId,
  });
  log.debug(
    {
      schemaId: reading.schemaId,
      items: reading.items.length,
      ignored: reading.notes.ignored.length,
      controlTotal: reading.controlTotal,
    },
    "Document read",
  );
  return reading;
}

/**
 * Reads the document with the profile in one call and returns the model's
 * answer as it is, or throws as `readDocumentItems` does. The part of a
 * spreadsheet the AI reads beside its table is read this way, and joined with
 * the table's rows before the items are made (FR-057).
 */
export async function readDocumentEnvelope(
  params: DocumentReadingParams,
  providers: LLMProviderConfig[],
  intervalMs = 0,
  limits: Partial<DocumentReadLimits> = {},
): Promise<{ envelope: ReadEnvelope; schemaId: string }> {
  const { timeoutMs, maxOutputTokens } = { ...DEFAULT_READ_LIMITS, ...limits };
  checkDocumentLength(params.text);

  const compiled = compileProfile(params.profile);
  const spec: StructuredSpec<ReadEnvelope> = {
    schemaId: compiled.schemaId,
    schema: compiled.schema,
    parse: compiled.parse,
    instructions: buildItemsSystemPrompt(compiled, params),
    prompt: wrapDocument(params.text),
    maxOutputTokens,
    timeoutMs,
    schemaRequired: params.profile.schemaRequired ?? false,
  };

  // Which limits any provider ran into. The failover keeps only the last
  // provider's error, so a first provider that was cut off would otherwise be
  // hidden behind a second that failed some other way.
  let truncated = false;
  let timedOut = false;
  let rejected: SchemaRejectedError | null = null;
  let envelope: ReadEnvelope;
  try {
    envelope = await withProviderFailover(
      providers,
      async (model, provider) => {
        try {
          return await callStructured(model, provider, spec, intervalMs);
        } catch (error) {
          if (error instanceof OutputTruncatedError) truncated = true;
          if (error instanceof CallTimedOutError) timedOut = true;
          if (error instanceof SchemaRejectedError) rejected ??= error;
          throw error;
        }
      },
      log,
    );
  } catch (error) {
    // The last provider's error, which the failover keeps as its cause.
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    if (truncated) {
      throw new DocumentLimitError(
        "output",
        `This document is too long to read in full: the AI model's answer reached its output length limit of ${formatCount(maxOutputTokens)} tokens before every line was read.`,
        { cause },
      );
    }
    if (timedOut) {
      throw new DocumentLimitError(
        "time",
        `This document took longer to read than the limit of ${formatDuration(timeoutMs)} for one reading, so it was not read in full.`,
        { cause },
      );
    }
    // A provider refused a schema that must be used (FR-037). Said even when
    // a later provider failed some other way, because it is the reason the
    // user can act on.
    if (rejected) throw rejected;
    throw error;
  }

  checkItemCount(envelope, params.profile);
  return { envelope, schemaId: compiled.schemaId };
}

/**
 * Which sign a section's charges carry on this document, for a section whose
 * kind is the document's (the built-in reading). Most documents print
 * charges as plain figures, but some print every fee with a minus. The charges
 * are the larger part of the money, so the sign of the lines' sum is theirs,
 * and a line with the other sign is a credit, discount or refund. Counting
 * lines instead would let two small credits outvote one large charge.
 *
 * The sum decides before the printed total does: a summary box can print a
 * total without the minus its lines carry. Only a sum of zero falls back to
 * the printed total's sign, and then to plus.
 */
function chargeSign(
  amounts: readonly Minor[],
  statedTotal: Minor | null,
): 1 | -1 {
  const sum = amounts.reduce((total, minor) => total + minor, 0);
  if (sum !== 0) return sum < 0 ? -1 : 1;
  return statedTotal != null && statedTotal < 0 ? -1 : 1;
}

/**
 * The share of a fixed Expense section's money that one sign must hold before
 * that sign is taken as how the document prints its charges. Below it, the
 * section's lines cannot be told apart (see `fixedSectionSign`).
 */
const CLEAR_SHARE = 0.8;

/**
 * Which sign the lines of a fixed Income or Expense section must carry to be
 * imported as that kind, or null when the document does not say.
 *
 * - Income: plus. Money received is printed as a plain figure, so a line with
 *   a minus among sales is a deduction or refund, never more income.
 * - Expense: a document prints its charges either way (Shopee prints every fee
 *   with a minus, an invoice prints plain figures), so the sign is the one the
 *   section's own lines carry: all of them, or a clear share of the money
 *   (`CLEAR_SHARE`), as with one discount on an invoice. When both signs hold
 *   real money, such as a commission of -100 beside a rebate of +300, either
 *   reading would turn one of them into an expense it is not, so null: none of
 *   the section's lines is imported, and the reviewer is told to read it by
 *   sign instead.
 *
 * A section's total, as the built-in reading uses (`chargeSign`), is not
 * enough here: one large line of the other direction would flip it, and every
 * real charge would be left out while the credit became one.
 */
function fixedSectionSign(
  kind: "income" | "expense",
  amounts: readonly Minor[],
): 1 | -1 | null {
  if (kind === "income") return 1;
  let plus = 0;
  let minus = 0;
  for (const minor of amounts) {
    if (minor > 0) plus += minor;
    else minus -= minor;
  }
  const money = plus + minus;
  if (money === 0 || plus >= money * CLEAR_SHARE) return 1;
  if (minus >= money * CLEAR_SHARE) return -1;
  return null;
}

/** A left-out line as the reviewer sees it, e.g. "Discount -5.00". */
function ignoredLine(line: ReadItem, minor: Minor): string {
  return `${line.description.trim()} ${fromMinor(minor).toFixed(2)}`.trim();
}

/**
 * The one kind every section of the profile shares, or null when they differ
 * or a section's kind depends on each line's sign.
 */
function sharedKind(
  sections: readonly SectionSpec[],
  documentKind: DocumentTypeCode,
): DocumentTypeCode | null {
  const kinds = new Set(
    sections.map((section) =>
      section.kind === "document"
        ? documentKind
        : section.kind === "income"
          ? DocumentType.Income
          : section.kind === "expense"
            ? DocumentType.Expense
            : // By sign and transfer: each line's own sign says.
              null,
    ),
  );
  if (kinds.size !== 1 || kinds.has(null)) return null;
  return [...kinds][0];
}

/**
 * The categories a line could take, best first (FR-034, US6 AS7):
 *
 * 1. its fee type's tied category, which wins over any other;
 * 2. the model's pick, when the section asked for one;
 * 3. its section's fixed category, for a line with no fee type.
 *
 * None of them may be valid by the time it is used (a category archived since
 * the profile was saved), so the worker takes the first one that still is, and
 * Uncategorised when none is.
 */
function categoriesFor(section: SectionSpec, line: ReadItem): number[] {
  const out: number[] = [];
  const add = (id: number | null | undefined) => {
    if (id != null && id > 0 && !out.includes(id)) out.push(id);
  };
  add(tiedCategoryFor(section, line));
  if (section.categoryFromModel) add(line.category_account_id);
  if (!line.fee_type) add(section.fixedCategoryAccountId);
  return out;
}

/** The category the line's fee type is tied to, or null. */
function tiedCategoryFor(section: SectionSpec, line: ReadItem): number | null {
  if (!line.fee_type) return null;
  const id = section.feeTypes?.find(
    (entry) => entry.key === line.fee_type,
  )?.categoryAccountId;
  return id != null && id > 0 ? id : null;
}

/** What the reviewer is told when no date was found and today was used. */
export const NO_DATE_NOTE =
  "No date was found on the document, so today's date was used. Check it before confirming.";

/**
 * Turns the model's answer into proposed records, in code. Exported for the
 * tests; `readDocumentItems` is the way in.
 */
export function readingFromEnvelope(
  envelope: ReadEnvelope,
  profile: ReadingProfile,
  context: { today: string; mainCurrency: string; schemaId: string },
): DocumentReading {
  const { header } = envelope;
  const currency = parseCurrency(header.currency, context.mainCurrency);
  // The model decides which printed date is the document's. When it gives
  // none we read, the records are filed under today and each says so.
  const headerDate = parseDate(header.date ?? "", "");
  const date = headerDate || context.today;
  const reference = (header.reference ?? "").trim();
  const documentKind: DocumentTypeCode =
    header.document_type === "income"
      ? DocumentType.Income
      : DocumentType.Expense;

  // Lines code left out, ahead of the model's own list: these carry money the
  // reviewer should know about.
  const leftOut: string[] = [];
  const items: DocumentItem[] = [];
  // A profile that names no stated total compares against none, whatever
  // the model put in the field.
  const printedTotal =
    profile.statedTotalDescription === null
      ? null
      : envelope.stated_total_minor != null
        ? envelope.stated_total_minor
        : envelope.stated_total != null
          ? toMinor(envelope.stated_total, 1)
          : null;

  for (const section of profile.sections) {
    const lines = envelope.sections[section.key] ?? [];
    const amounts = lines.map((line) =>
      line.amount_minor != null ? line.amount_minor : toMinor(line.amount, 1),
    );
    // A section with fee types keeps only lines of a known type (FR-034).
    const typed = (line: ReadItem) =>
      !section.feeTypes?.length || line.fee_type != null;
    // Which sign the section's own lines carry, from the lines it can keep.
    // Only a section of one kind has one; a by-sign section takes both.
    const keptAmounts = amounts.filter((_, index) => typed(lines[index]));
    // A by-sign or transfer section takes both signs: the sign is the kind.
    const charges =
      section.kind === "by_sign" || section.kind === "transfer"
        ? 1
        : section.kind === "document"
          ? chargeSign(keptAmounts, printedTotal)
          : fixedSectionSign(section.kind, keptAmounts);
    if (charges === null) {
      leftOut.push(
        `${section.name ?? section.key}: lines printed with both signs, so none was imported. Read it by sign.`,
      );
    }

    lines.forEach((line, index) => {
      const minor = amounts[index];
      if (minor === 0 || !typed(line) || charges === null) {
        leftOut.push(ignoredLine(line, minor));
        return;
      }

      let kind: DocumentTypeCode;
      if (section.kind === "by_sign") {
        kind = minor > 0 ? DocumentType.Income : DocumentType.Expense;
      } else if (section.kind === "transfer") {
        // A minus left the document's account; anything else came into it
        // (FR-058). The amount is kept without its sign, as for the others.
        kind = minor < 0 ? DocumentType.TransferOut : DocumentType.TransferIn;
      } else {
        // Against the sign of the section's lines: a credit, discount or
        // refund among charges, or a deduction among sales. It is not
        // imported as the section's kind, and never turned into it by
        // dropping its sign (FR-005, FR-008); a by-sign section is the way
        // to import both.
        if (Math.sign(minor) !== charges) {
          leftOut.push(ignoredLine(line, minor));
          return;
        }
        kind =
          section.kind === "document"
            ? documentKind
            : section.kind === "income"
              ? DocumentType.Income
              : DocumentType.Expense;
      }

      // A record keeps its amount without a sign, as a receipt does; the
      // kind says which way the money went.
      const amountMinor = Math.abs(minor);
      const ownDate = line.date ? parseDate(line.date, "") : "";
      const sourceLine =
        line.source_line != null && line.source_line > 0
          ? line.source_line
          : null;
      const categoryCandidates = categoriesFor(section, line);
      items.push({
        sectionKey: section.key,
        kind,
        // A line of a listed type is called by the type's name: the type is
        // a rule the user set, so its name wins over the printed wording.
        description: truncate(
          line.fee_type
            ? feeTypeName(section.feeTypes, line.fee_type)
            : line.description,
          MAX_LABEL_LENGTH,
        ),
        amountMinor,
        amount: fromMinor(amountMinor),
        date: ownDate || date,
        reference:
          line.reference?.trim() ||
          (profile.ownReferencesOnly || section.fromTable ? "" : reference),
        sourceLine,
        feeType: line.fee_type ?? null,
        feeTypeName: line.fee_type
          ? feeTypeName(section.feeTypes, line.fee_type)
          : null,
        categoryAccountId: categoryCandidates[0] ?? null,
        categoryCandidates,
        counterAccountId:
          section.kind === "transfer"
            ? (section.counterAccountId ?? null)
            : null,
        tiedCategoryAccountId: tiedCategoryFor(section, line),
        extras: line.extras ?? null,
        reviewNote:
          [
            line.review_note?.trim(),
            ownDate || headerDate ? null : NO_DATE_NOTE,
          ]
            .filter(Boolean)
            .join(" ") || null,
      });
    });
  }

  // Income and money transferred in count as plus, expenses and money
  // transferred out as minus (FR-013).
  const itemsTotalMinor = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === DocumentType.Income ||
      item.kind === DocumentType.TransferIn
        ? item.amountMinor
        : -item.amountMinor),
    0,
  );

  // The printed total is given the direction of what it totals, so it can be
  // compared with the items as they are (see `ExtractionNotes.statedTotal`).
  // When the sections differ in kind the total is a net figure, and its
  // printed sign already says which way the money went.
  let statedTotal: ExtractionNotes["statedTotal"] = null;
  if (printedTotal != null) {
    const printed = printedTotal;
    const kind = sharedKind(profile.sections, documentKind);
    const minor =
      kind === null || printed === 0
        ? printed
        : kind === DocumentType.Income
          ? Math.abs(printed)
          : -Math.abs(printed);
    statedTotal = { minor, currency };
  }

  const notes: ExtractionNotes = {
    statedTotal,
    itemsTotalMinor,
    ignored: capIgnored([...leftOut, ...envelope.ignored]),
  };

  return {
    schemaId: context.schemaId,
    counterparty: (header.counterparty ?? "").trim(),
    date,
    reference,
    currency,
    items,
    notes,
    controlTotal: controlTotal(notes),
  };
}
