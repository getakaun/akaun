/**
 * Reads one queued document and leaves it ready for review, or failed with a
 * reason.
 *
 * A document is read one of two ways, by what the uploader chose under "Read
 * as" (006 FR-001):
 *
 * - **As a receipt or invoice** (the standard reading, and Auto-detect while
 *   no profile exists): one record, on the queue row itself, exactly as every
 *   document was read before 006 (FR-003, FR-004).
 * - **As a document with several items**: one proposed record per item. One
 *   item is reviewed as a receipt, on the queue row (FR-009). Several become a
 *   group: the items go into `import_items` and the queue row is marked
 *   Grouped. No item is saved unless all of them are (FR-011).
 * - **With an import profile** the user saved (006 US6-7): read the same way
 *   as several items, with the profile's sections, fee types and instructions
 *   in place of the built-in ones. A copy of the profile is kept on the row,
 *   so a later edit or delete never changes what was read (FR-038).
 * - **Auto-detect** (006 US9): with no enabled profile, the receipt reading
 *   above, unchanged. Otherwise `profile-detect.ts` decides first, and the
 *   document is read with the profile it found or as a receipt (FR-039,
 *   FR-040). The row keeps "auto" as what the uploader chose; `read_how`,
 *   `profile_id` and the copy of the profile say how it was read.
 * - **In the profile's mode** (006 FR-002, FR-032): a profile is read in its
 *   own import mode, Summary lines or Every transaction, whether it was
 *   chosen or detected, and the row stores that mode.
 * - **From its columns** (006 FR-055, FR-057): a spreadsheet read with a
 *   profile whose sections have row rules has its table read by code
 *   (`table-reader.ts`). When every section has them there is no AI call and
 *   no provider is needed, so the check for one is made only where the AI is
 *   asked. Otherwise the AI reads the other sections from the rest of the
 *   sheet, with the table's rows left out of its text. A PDF or a photo read
 *   with such a profile fails: it has no cells.
 * - **In pieces** (006 FR-043): a profile reading in Every transaction mode
 *   that the AI reads, from a PDF or the part of a spreadsheet beside its
 *   table, is read a run of lines at a time (`piece-reader.ts`). The queue row counts the
 *   pieces in `progress_done` / `progress_total` while it is read.
 *
 * The worker calls this with the app's database and storage folder; the tests
 * call it with their own, so nothing here reaches for either.
 */

import { randomUUID } from "crypto";
import { and, eq, ne } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DocumentType,
  ImportState,
  documentTypeEnum,
  isTransferType,
  type ImportStateCode,
} from "$lib/enums.js";
import {
  foldTableText,
  nameFromKey,
  profileFileTypes,
  readsFromColumns,
  readsTable,
} from "$lib/import-profile-schema.js";
import {
  ImportMode,
  ImportReadAs,
  ImportReadHow,
  serializeExtractionNotes,
} from "$lib/import-reading.js";
import { importItems, importQueue, users } from "../db/schema.js";
import {
  CSV_MIME_TYPE,
  extractDocumentSource,
  extractNumberedText,
  extractPlainAndNumberedText,
  extractText,
  inferMimeType,
  isEmptyWorkbook,
  isSpreadsheetMimeType,
  keepsReadText,
  numberDocumentLines,
  spreadsheetText,
  stripLineNumbers,
  type DocumentSource,
} from "../extraction/document-text.js";
import { readCsv } from "../extraction/spreadsheet/csv.js";
import { detectionText } from "../extraction/spreadsheet/render.js";
import type { Workbook } from "../extraction/spreadsheet/types.js";
import type { LedgerDb } from "../ledger/types.js";
import { getEnabledProviders, insertProvider } from "../llmProviders.js";
import { createLogger } from "../logger.js";
import {
  listImportProfiles,
  savedProfileIdOf,
  type ImportProfileView,
} from "../services/import-profiles.js";
import { SchemaRejectedError } from "../llm/structured-call.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import {
  buildReviewFields,
  createReviewContext,
  type ReviewContext,
} from "./build-review-fields.js";
import {
  DocumentLimitError,
  readDocumentEnvelope,
  type DocumentItem,
  type DocumentReading,
} from "./document-reader.js";
import { emitItemUpdates, emitJobUpdate } from "./group-state.js";
import { callLLMWithProviders } from "./llm.js";
import {
  DETECT_HEAD_CHARS,
  detectProfile,
  phraseMatch,
} from "./profile-detect.js";
import {
  hasProfileTable,
  headingLines,
  missingSheet,
  profileSheet,
  sheetsHead,
} from "./profile-sheet.js";
import { RECEIPT_TEXT_LIMIT } from "./providers/shared.js";
import { alreadyImported } from "./repeat-file.js";
import { sameMoneyNotes } from "./same-money.js";
import {
  detectTransferDuplicates,
  type TransferProbe,
} from "./transfer-duplicates.js";
import type { LLMCallParams } from "./providers/types.js";
import {
  ReadingStoppedError,
  readEnvelopeInPieces,
  type PieceProgress,
} from "./piece-reader.js";
import { joinParts, type ReadParts } from "./join-reading.js";
import {
  RECEIPT_PLAN,
  builtinItemsPlan,
  needsAi,
  isSpreadsheetJob,
  jobFileType,
  needsCells,
  planForProfile,
  readsCells,
  type ItemsPlan,
  type ReadingPlan,
} from "./reading-plan.js";
import type { ReviewFields } from "./review-fields.js";
import {
  TableReadError,
  readTable,
  withoutTableRows,
  type AiPart,
} from "./table-reader.js";

const log = createLogger("import:worker");

type ImportJob = typeof importQueue.$inferSelect;
type ImportItemInsert = typeof importItems.$inferInsert;

export interface ProcessJobOptions {
  /** The folder the job's `temp_file_path` is relative to. */
  storageRoot: string;
}

/** The message a document with nothing to import fails with (FR-009). */
export const NO_ITEMS_FOUND = "No items found";

/** The message a reading that needs the AI fails with when none is set up. */
export const NO_PROVIDERS =
  "No LLM providers configured. Go to Settings → Intelligence to add one.";

/**
 * Items are inserted this many at a time, so a document of a thousand items
 * stays well inside SQLite's limit on values in one statement. All of them are
 * still in one transaction.
 */
const ITEM_INSERT_CHUNK = 100;

type ReadingPath = "receipt" | "items" | "profile" | "auto";

/**
 * How this job is read. The several-items choice and a saved profile read
 * items; Auto-detect decides once the text is read; a row from before 006 has
 * no choice stored and is a receipt, as it was when uploaded.
 */
function readingPath(job: ImportJob): ReadingPath {
  if (job.readAs === ImportReadAs.SeveralItems) return "items";
  if (job.readAs === ImportReadAs.Profile) return "profile";
  if (job.readAs === ImportReadAs.Auto) return "auto";
  return "receipt";
}

/**
 * A reading's progress, cleared once it ends either way, so a later reading
 * of the same job never starts out showing the last one's count.
 */
const NO_PROGRESS = { progressDone: null, progressTotal: null } as const;

function markFailed(
  db: LedgerDb,
  jobId: string,
  userId: number,
  error: string,
) {
  log.error({ jobId, error }, "Job failed");
  db.update(importQueue)
    .set({ state: ImportState.Failed, error, ...NO_PROGRESS })
    .where(eq(importQueue.id, jobId))
    .run();
  emitJobUpdate(db, jobId, userId);
}

function setState(
  db: LedgerDb,
  jobId: string,
  userId: number,
  state: ImportStateCode,
) {
  // A job starting a stage has read no parts yet, whatever an earlier
  // reading of it left behind.
  db.update(importQueue)
    .set({ state, ...NO_PROGRESS })
    .where(eq(importQueue.id, jobId))
    .run();
  emitJobUpdate(db, jobId, userId);
}

/** Enabled providers; moves the old single OpenRouter setting over on first use. */
function loadProviders(db: LedgerDb) {
  let providers = getEnabledProviders(db);
  if (!providers.length) {
    const legacyKey = getSetting(db, SETTING_KEYS.autoImportApiKey);
    if (legacyKey) {
      const legacyModel =
        getSetting(db, SETTING_KEYS.autoImportModel) ??
        "anthropic/claude-3.5-sonnet";
      insertProvider(db, {
        type: "openrouter",
        name: "OpenRouter",
        apiKey: legacyKey,
        model: legacyModel,
      });
      providers = getEnabledProviders(db);
      log.info("Migrated legacy OpenRouter settings to llm_providers table");
    }
  }
  return providers;
}

// Stopped before reading when the same file already made a record (FR-026).
// The rule lives with the confirm's own check of it (FR-064).
export { alreadyImported };

/**
 * One form of a document's text, and how to get it: from the text a caller
 * gave with the upload, or from the file.
 */
interface TextForm<T> {
  /** Requires workbook cells when the file is a spreadsheet. */
  needsWorkbook?: boolean;
  given: (text: string) => T;
  /** From a PDF or a photo. */
  extract: (absPath: string, mimeType: string) => Promise<T>;
  /** From a spreadsheet, whose text comes in every form at once (FR-051). */
  fromSource: (source: DocumentSource) => T;
  /** What the document itself prints, to check there is enough of it. */
  printed: (text: T) => string;
}

/** One run of text, as the receipt reading has always sent it (FR-004). */
const PLAIN_TEXT: TextForm<string> = {
  given: (text) => text,
  extract: extractText,
  fromSource: (source) => source.plain,
  printed: (text) => text,
};

/**
 * Numbered lines, for a reading of items. Numbered text always has its page
 * markers, so what counts is what the document itself prints.
 */
const NUMBERED_TEXT: TextForm<string> = {
  given: (text) => numberDocumentLines([text]),
  extract: extractNumberedText,
  fromSource: (source) => source.numbered,
  printed: (text) => stripLineNumbers(text).trim(),
};

/**
 * Every form at once: both texts, and a spreadsheet's cells. For Auto-detect,
 * which knows which one it needs only after detection, and for a reading from
 * columns, which needs the cells and the numbered text both. Taken in one
 * pass, so an image is read by OCR once and a workbook unpacked once.
 */
const SOURCE_TEXTS: TextForm<DocumentSource> = {
  needsWorkbook: true,
  given: (text) => ({ plain: text, numbered: numberDocumentLines([text]) }),
  extract: extractPlainAndNumberedText,
  fromSource: (source) => source,
  printed: (texts) => texts.plain,
};

/** The message a spreadsheet with nothing in its cells fails with. */
export const EMPTY_SPREADSHEET =
  "This spreadsheet is empty: none of its sheets has anything in its cells.";

/**
 * The document's text, in the form the reading needs. Null when the job has
 * already been failed.
 */
async function documentText<T>(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  form: TextForm<T>,
  storageRoot: string,
): Promise<T | null> {
  let text: T;
  let extracted = false;
  const kept = keptText(job);
  // A source read needs the actual spreadsheet cells for sheet selection and
  // detection; caller-provided text cannot establish which sheet it came from.
  const needsWorkbook = form.needsWorkbook && isSpreadsheetJob(job);
  if (
    !needsWorkbook &&
    job.preExtractedText &&
    job.preExtractedText.trim().length > 0
  ) {
    // Caller already ran its own OCR/extraction — skip server-side extraction entirely.
    text = form.given(job.preExtractedText.trim());
    log.debug(
      { jobId: job.id, textLength: form.printed(text).length },
      "Using caller-provided text (OCR bypassed)",
    );
  } else if (kept !== null) {
    // OCR already read this image, for an earlier reading of this job: it is
    // being read again, or the server restarted while it was read.
    text = form.given(kept);
    log.debug(
      { jobId: job.id, textLength: form.printed(text).length },
      "Using the text read from this image before (OCR not repeated)",
    );
  } else {
    extracted = true;
    setState(db, job.id, userId, ImportState.Extracting);

    const absPath = join(storageRoot, job.tempFilePath);
    const mimeType = inferMimeType(job.originalFilename);
    try {
      if (isSpreadsheetMimeType(mimeType)) {
        // Read cell by cell and turned into text (FR-051). A workbook that
        // cannot be read fails here with its reason, such as a password.
        const source = await extractDocumentSource(absPath, mimeType);
        if (source.workbook && isEmptyWorkbook(source.workbook)) {
          markFailed(db, job.id, userId, EMPTY_SPREADSHEET);
          return null;
        }
        text = form.fromSource(source);
      } else {
        text = await form.extract(absPath, mimeType);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ jobId: job.id, err }, "Text extraction failed");
      markFailed(db, job.id, userId, msg);
      return null;
    }
  }

  const printed = form.printed(text);
  if (!printed || printed.length < 10) {
    log.warn(
      { jobId: job.id, textLength: printed?.length ?? 0 },
      "Insufficient text extracted",
    );
    markFailed(
      db,
      job.id,
      userId,
      "Couldn't read enough text from this file. Try a clearer image or a text PDF.",
    );
    return null;
  }

  // An image's text is kept as soon as OCR has read it, so a reading that
  // fails after this, or is read again, never runs OCR on it twice.
  if (extracted && keepsReadText(job.originalFilename)) {
    db.update(importQueue)
      .set({ extractedText: printed })
      .where(eq(importQueue.id, job.id))
      .run();
  }

  log.debug(
    {
      jobId: job.id,
      textLength: printed.length,
      preview: printed.slice(0, 200),
    },
    "Text extracted",
  );
  return text;
}

/**
 * The text OCR read from this job's image at an earlier reading, or null.
 * Only an image's is used again; see `keepsReadText`.
 */
function keptText(job: ImportJob): string | null {
  if (!keepsReadText(job.originalFilename)) return null;
  const text = job.extractedText?.trim();
  return text ? text : null;
}

/** Reads a job and leaves it for review, grouped, or failed. */
export async function processImportJob(
  db: LedgerDb,
  job: ImportJob,
  options: ProcessJobOptions,
): Promise<void> {
  // The uploader (for event routing / audit). Settings are global.
  const ownerUser = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, job.createdBy))
    .get();
  const userId = ownerUser?.id ?? job.createdBy;
  let path = readingPath(job);

  // Auto-detect with no enabled profile is the receipt reading, with no
  // detection step and no extra AI call (FR-003, US9 AS3).
  let candidates: ImportProfileView[] = [];
  if (path === "auto") {
    candidates = listImportProfiles(db, { enabledOnly: true });
    if (candidates.length === 0) {
      clearDetectedProfile(db, job);
      path = "receipt";
    }
  }

  // How the document is read, when the upload said (FR-001). Auto-detect
  // works it out once the text is read.
  let plan: ReadingPlan | null = null;
  if (path === "receipt") plan = RECEIPT_PLAN;
  else if (path === "items") plan = builtinItemsPlan();
  else if (path === "profile") {
    const planned = planForProfile(db, job, savedProfileIdOf(job), "chosen");
    if (!planned.ok) {
      markFailed(db, job.id, userId, planned.reason);
      return;
    }
    plan = planned.plan;
  }

  const providers = loadProviders(db);
  if (plan) {
    // Stopped here, before the file is read, as it always has been.
    const stop = stopReason(db, reloaded(db, job), plan, providers, null);
    if (stop) {
      markFailed(db, job.id, userId, stop);
      return;
    }
  } else if (
    !providers.length &&
    !(
      readsCells(job) && candidates.some((profile) => readsFromColumns(profile))
    )
  ) {
    // Auto-detect with nothing it could read without the AI.
    markFailed(db, job.id, userId, NO_PROVIDERS);
    return;
  }

  const ctx = createReviewContext(db);
  const rateLimitMs = parseInt(
    getSetting(db, SETTING_KEYS.autoImportRateLimitMs) ?? "0",
    10,
  );
  const customInstructions =
    getSetting(db, SETTING_KEYS.autoImportCustomInstructions) ?? "";

  log.info(
    {
      jobId: job.id,
      filename: job.originalFilename,
      providerCount: providers.length,
      reading: path,
    },
    "Processing job",
  );

  const accountLists = {
    expenseAccounts: ctx.expenseChoices.map(({ id, code, path }) => ({
      id,
      code,
      path,
    })),
    incomeAccounts: ctx.incomeChoices.map(({ id, code, path }) => ({
      id,
      code,
      path,
    })),
    mainCurrency: ctx.mainCurrency,
    customInstructions,
  };
  const calls = { providers, rateLimitMs, accountLists };

  if (plan === null) {
    await readAutoDetected(db, job, userId, ctx, candidates, calls, options);
    return;
  }

  if (plan.kind === "receipt") {
    const text = await documentText(
      db,
      job,
      userId,
      PLAIN_TEXT,
      options.storageRoot,
    );
    if (text === null) return;
    setState(db, job.id, userId, ImportState.Processing);
    await readReceipt(db, job, userId, ctx, { text, ...calls });
    return;
  }

  // The cells and the numbered text for a table, or for a profile that reads
  // one sheet of a workbook (FR-069); the numbered text alone for the AI.
  let source: DocumentSource | null;
  if (needsCells(plan) || (plan.kind === "profile" && isSpreadsheetJob(job))) {
    source = await documentText(
      db,
      job,
      userId,
      SOURCE_TEXTS,
      options.storageRoot,
    );
  } else {
    const numbered = await documentText(
      db,
      job,
      userId,
      NUMBERED_TEXT,
      options.storageRoot,
    );
    source = numbered === null ? null : { plain: "", numbered };
  }
  if (source === null) return;
  setState(db, job.id, userId, ImportState.Processing);
  await readPlanned(db, job, userId, ctx, plan, source, calls, options);
}

/**
 * Why a planned reading stops before it is read, or null: a file already
 * imported (FR-026), which a receipt never is; a spreadsheet too long for the
 * receipt reading (FR-052), once its text is known; or a reading that asks
 * the AI with no provider set up. The one place each is decided.
 */
function stopReason(
  db: LedgerDb,
  job: ImportJob,
  plan: ReadingPlan,
  providers: readonly unknown[],
  text: string | null,
): string | null {
  if (plan.kind !== "receipt") {
    const stop = alreadyImported(db, job);
    if (stop) return stop;
  } else if (text !== null) {
    const tooLong = receiptTextRefusal(job, text);
    if (tooLong) return tooLong;
  }
  if (needsAi(plan) && providers.length === 0) return NO_PROVIDERS;
  return null;
}

/** The row as it is now: a plan writes the profile it reads with onto it. */
function reloaded(db: LedgerDb, job: ImportJob): ImportJob {
  return (
    db.select().from(importQueue).where(eq(importQueue.id, job.id)).get() ?? job
  );
}

/**
 * Reads a planned reading of items from its source: the cells, read again
 * for a CSV whose layout names its separator, and the numbered text.
 */
async function readPlanned(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  ctx: ReviewContext,
  plan: ItemsPlan,
  source: DocumentSource,
  calls: Omit<ReadingInput, "text">,
  options: ProcessJobOptions,
) {
  const cells = cellsForColumns(job, source, plan, options);
  if (typeof cells === "string") {
    markFailed(db, job.id, userId, cells);
    return;
  }
  await readItems(db, job, userId, ctx, { ...cells, ...calls }, plan);
}

/**
 * Auto-detect with at least one enabled profile (FR-039): the text is read,
 * `detectProfile` decides, and the document is then read the way it decided.
 *
 * - **A profile was found:** the row records it as detected, with a copy of
 *   the profile as it is now (FR-038, FR-041), and is read with it exactly as
 *   if it had been chosen. A file already imported is stopped here, before
 *   the reading (FR-026).
 * - **No profile fits**, or detection failed: the receipt reading, with the
 *   same text and the same call as a receipt chosen at upload (FR-040).
 */
async function readAutoDetected(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  ctx: ReviewContext,
  profiles: ImportProfileView[],
  calls: Omit<ReadingInput, "text">,
  options: ProcessJobOptions,
) {
  const texts = await documentText(
    db,
    job,
    userId,
    SOURCE_TEXTS,
    options.storageRoot,
  );
  if (texts === null) return;

  setState(db, job.id, userId, ImportState.Processing);

  const detection = texts.workbook
    ? await detectSpreadsheet(job, texts.workbook, profiles, calls)
    : await detectDocument(job, texts.plain, profiles, calls);
  if (typeof detection === "string") {
    markFailed(db, job.id, userId, detection);
    return;
  }

  if (detection.route === "standard") {
    clearDetectedProfile(db, job);
    const stop = stopReason(
      db,
      job,
      RECEIPT_PLAN,
      calls.providers,
      texts.plain,
    );
    if (stop) {
      markFailed(db, job.id, userId, stop);
      return;
    }
    await readReceipt(db, job, userId, ctx, { text: texts.plain, ...calls });
    return;
  }

  // The found profile is read in its own mode (FR-002), as if it had been
  // chosen; the plan stores it on the row as detected.
  const planned = planForProfile(db, job, detection.route, "detected");
  if (!planned.ok) {
    markFailed(db, job.id, userId, planned.reason);
    return;
  }
  // Every screen now says which profile reads the document, and that it was
  // detected (FR-041), while the reading runs.
  emitJobUpdate(db, job.id, userId);
  const detected = reloaded(db, job);
  const stop = stopReason(db, detected, planned.plan, calls.providers, null);
  if (stop) {
    markFailed(db, job.id, userId, stop);
    return;
  }
  await readPlanned(
    db,
    detected,
    userId,
    ctx,
    planned.plan,
    texts,
    calls,
    options,
  );
}

/**
 * The cells and numbered text a reading goes by. A CSV file read from its
 * columns with a layout that names the file's separator is read again with
 * that separator, rather than the one worked out from the file: a file of
 * amounts with decimal commas can look as if it were split by commas. The
 * numbered text is made from the same cells, so each item's line is the
 * line its row has. Returns the reason when the file cannot be read again.
 */
function cellsForColumns(
  job: ImportJob,
  source: DocumentSource,
  plan: ItemsPlan,
  options: ProcessJobOptions,
): Cells | string {
  const delimiter = plan.table?.layout.csvDelimiter ?? null;
  const isCsv = inferMimeType(job.originalFilename) === CSV_MIME_TYPE;
  if (!plan.table || delimiter === null || !isCsv) {
    return oneSheetOf(plan, {
      text: source.numbered,
      workbook: source.workbook,
    });
  }
  try {
    const bytes = readFileSync(join(options.storageRoot, job.tempFilePath));
    const workbook = readCsv(bytes, { delimiter });
    return oneSheetOf(plan, {
      text: spreadsheetText(workbook).numbered,
      workbook,
    });
  } catch (err) {
    log.error({ jobId: job.id, err }, "Reading the CSV file again failed");
    return err instanceof Error ? err.message : String(err);
  }
}

/** A workbook's cells and numbered text, and the one sheet they hold. */
type Cells = {
  text: string;
  workbook?: Workbook;
  /** The sheet a profile reads, when the file has more than one (FR-069). */
  sheet?: string;
};

/**
 * The cells and numbered text cut down to the one sheet a saved profile
 * reads (FR-069), or the reason it cannot be read: the sheet it names is not
 * in the file. The text is made again from that sheet alone, so the table
 * reader, the AI and every line number go by the same text. The built-in
 * reading, and a file with no cells, are left as they are.
 */
function oneSheetOf(plan: ItemsPlan, cells: Cells): Cells | string {
  if (plan.kind !== "profile" || !cells.workbook) return cells;
  const picked = profileSheet(
    cells.workbook,
    { name: plan.profileName ?? "", sheet: plan.sheet },
    plan.table?.layout.headers ?? null,
  );
  if ("refused" in picked) return picked.refused;
  if (picked.workbook === cells.workbook) return cells;
  return {
    text: spreadsheetText(picked.workbook).numbered,
    workbook: picked.workbook,
    ...(picked.of > 1 ? { sheet: picked.name } : {}),
  };
}

/**
 * Auto-detect for a PDF or a photo (FR-039): `detectProfile`, among the
 * profiles that could read it. A profile that reads a table by code is left
 * out: it is made for a spreadsheet's table, and a PDF has no cells. So is
 * one made for other files (FR-070). With no other profile, nothing is asked
 * and the document is read the standard way.
 */
async function detectDocument(
  job: ImportJob,
  text: string,
  profiles: ImportProfileView[],
  calls: Omit<ReadingInput, "text">,
): Promise<{ route: number | "standard" }> {
  // A spreadsheet given as text is read here too, as a spreadsheet.
  const fileType = jobFileType(job);
  const readable = profiles.filter(
    (profile) =>
      !readsTable(profile) && profileFileTypes(profile).includes(fileType),
  );
  if (readable.length === 0) return { route: "standard" };
  return detectProfile({
    text,
    profiles: readable,
    providers: calls.providers,
    intervalMs: calls.rateLimitMs,
    jobId: job.id,
  });
}

/**
 * Auto-detect for a spreadsheet (FR-039, US10 AS12), in priority order:
 *
 * 1. Fixed phrases across all enabled profiles that can read the file.
 *    Table profiles need their headings; file types and sheet restrictions
 *    are respected. One phrase match wins without AI.
 * 2. With no phrase matches, one matching table layout wins without AI.
 * 3. Otherwise AI resolves matching phrases, matching layouts, or the
 *    remaining readable profiles, in that order. Ambiguous matches without
 *    a provider fail with an explanation rather than reading as a receipt.
 *
 * Returns the detection, or the reason the job fails.
 */
async function detectSpreadsheet(
  job: ImportJob,
  workbook: Workbook,
  profiles: ImportProfileView[],
  calls: Omit<ReadingInput, "text">,
): Promise<{ route: number | "standard" } | string> {
  // A profile made for PDF files and photos does not read it (FR-070), nor
  // one whose sheet is not in the file (FR-069).
  const readable = profiles.filter(
    (profile) =>
      profileFileTypes(profile).includes("spreadsheet") &&
      missingSheet(workbook, profile) === null,
  );
  const byHeadings = readable.filter(
    (profile) =>
      profile.layout &&
      hasProfileTable(workbook, profile, profile.layout.headers),
  );
  // Fixed phrases are checked across every profile that can read this file,
  // including AI-read profiles beside a matching table layout. A table
  // profile without its required headings cannot read the file.
  const eligible = readable.filter(
    (profile) => !readsTable(profile) || byHeadings.includes(profile),
  );
  // A profile that names its sheet is recognised by that sheet's words, and
  // any other by the whole workbook's. Each text is made once, however many
  // profiles look in it.
  const texts = new Map<string, string>();
  const words = (profile: ImportProfileView) => {
    const picked = profile.sheet ? profileSheet(workbook, profile, null) : null;
    const scope = picked && "workbook" in picked ? picked : null;
    const key = scope ? `sheet:${foldTableText(scope.name)}` : "workbook";
    let text = texts.get(key);
    if (text === undefined) {
      text = detectionText(scope ? scope.workbook : workbook);
      texts.set(key, text);
    }
    return text;
  };
  const byPhrases = phraseMatch(words, eligible);
  if (byPhrases.length === 1) {
    log.info(
      { jobId: job.id, route: byPhrases[0].id, via: "phrases" },
      "Auto-detect decided",
    );
    return { route: byPhrases[0].id };
  }

  if (byPhrases.length === 0 && byHeadings.length === 1) {
    log.info(
      { jobId: job.id, route: byHeadings[0].id, via: "layout" },
      "Auto-detect decided",
    );
    return { route: byHeadings[0].id };
  }

  const among =
    byPhrases.length > 1
      ? byPhrases
      : byHeadings.length > 0
        ? byHeadings
        : eligible;

  if (calls.providers.length === 0 && byPhrases.length > 1) {
    const names = byPhrases.map((profile) => `"${profile.name}"`).join(", ");
    return `This spreadsheet matches the fixed phrases of several import profiles (${names}), and no AI provider is set up to choose. Give each profile phrases unique to its documents, or choose a profile under Read as.`;
  }
  if (calls.providers.length === 0 && byHeadings.length > 1) {
    return severalLayoutsFit(byHeadings);
  }
  if (among.length === 0 || calls.providers.length === 0) {
    return { route: "standard" };
  }

  return detectProfile({
    // The start of each sheet, not only of the first, and of a hidden sheet
    // a profile names (FR-069).
    text: sheetsHead(
      workbook,
      DETECT_HEAD_CHARS,
      among.flatMap((profile) => (profile.sheet ? [profile.sheet] : [])),
    ),
    // Already looked for above; neither one decided.
    phraseMatched: byPhrases,
    profiles: among,
    providers: calls.providers,
    intervalMs: calls.rateLimitMs,
    jobId: job.id,
  });
}

/**
 * Why Auto-detect cannot choose among the profiles whose headings a
 * spreadsheet has, with no AI provider to ask: two profiles made for the same
 * report, say, neither with recognition phrases of its own.
 */
export function severalLayoutsFit(
  profiles: readonly Pick<ImportProfileView, "name">[],
): string {
  const names = profiles.map((profile) => `"${profile.name}"`).join(", ");
  return `This spreadsheet has the column headings of ${profiles.length} import profiles (${names}), their recognition phrases do not tell them apart, and no AI provider is set up to choose. Give each of them recognition phrases only its own documents have, or turn off the ones you do not use; or read it again with one of them chosen.`;
}

/**
 * Marks an auto-detect row as read the standard way, and removes any profile
 * left on it. A reading stopped part-way by a restart may have left a detected
 * profile on the row; the receipt reading that follows does not use it, so the
 * card, the group page and a later repeat-file stop must not name it (FR-003,
 * FR-041). A fresh row has nothing to clear, so it gets no extra write.
 *
 * The import mode goes with them: it is the mode of the profile that read the
 * document (FR-002), and a receipt has none.
 */
function clearDetectedProfile(db: LedgerDb, job: ImportJob) {
  const leftOver =
    job.readHow !== ImportReadHow.Standard ||
    job.profileId !== null ||
    job.profileSnapshot !== null ||
    job.importMode !== null;
  if (!leftOver) return;
  db.update(importQueue)
    .set({
      readHow: ImportReadHow.Standard,
      profileId: null,
      profileSnapshot: null,
      importMode: null,
    })
    .where(eq(importQueue.id, job.id))
    .run();
}

type ReadingInput = {
  text: string;
  /** A spreadsheet's cells, for a reading from its columns. */
  workbook?: Workbook;
  /** The one sheet a profile read, when the file has more (FR-069). */
  sheet?: string;
  providers: ReturnType<typeof getEnabledProviders>;
  rateLimitMs: number;
  accountLists: Omit<LLMCallParams, "text">;
};

/** Writes one set of review fields onto the queue row: a receipt's card. */
function writeReviewCard(
  db: LedgerDb,
  jobId: string,
  userId: number,
  fields: ReviewFields,
  extra: Partial<typeof importQueue.$inferInsert>,
) {
  db.update(importQueue)
    .set({
      state: ImportState.PendingReview,
      ...fields,
      ...extra,
      ...NO_PROGRESS,
      processedAt: new Date().toISOString(),
    })
    .where(eq(importQueue.id, jobId))
    .run();
  emitJobUpdate(db, jobId, userId);
}

/**
 * Why a spreadsheet cannot be read the standard way, or null (FR-052). The
 * receipt reading sends only the start of a document; a spreadsheet longer
 * than that would be read from a shortened text, with the rows past the cut
 * never seen, so it is refused and the limit named. A PDF or a photo is cut as
 * it always has been (FR-004).
 */
export function receiptTextRefusal(
  job: Pick<ImportJob, "originalFilename">,
  text: string,
): string | null {
  if (!isSpreadsheetJob(job) || text.length <= RECEIPT_TEXT_LIMIT) return null;
  const limit = RECEIPT_TEXT_LIMIT.toLocaleString("en");
  const length = text.length.toLocaleString("en");
  return `This spreadsheet is too long to be read as a receipt or invoice: its text is ${length} characters, and that reading takes at most ${limit}. Read it again as a document with several items, or with an import profile.`;
}

async function readReceipt(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  ctx: ReviewContext,
  input: ReadingInput,
) {
  const tooLong = receiptTextRefusal(job, input.text);
  if (tooLong) {
    markFailed(db, job.id, userId, tooLong);
    return;
  }
  let result;
  try {
    result = await callLLMWithProviders(
      { text: input.text, ...input.accountLists },
      input.providers,
      input.rateLimitMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ jobId: job.id, msg }, "LLM extraction failed");
    markFailed(db, job.id, userId, `AI extraction failed: ${msg}`);
    return;
  }

  log.info(
    {
      jobId: job.id,
      documentType: result.document_type,
      amount: result.amount,
      date: result.date,
    },
    "LLM result",
  );

  const fields = await buildReviewFields(
    db,
    {
      // A receipt is an expense or an income, never a transfer (FR-059):
      // only a profile's transfer section reads one.
      documentType:
        documentTypeEnum.fromLabel(result.document_type) === DocumentType.Income
          ? DocumentType.Income
          : DocumentType.Expense,
      itemName: result.item_name,
      supplier: result.supplier,
      amount: result.amount,
      date: result.date,
      reference: result.reference,
      currency: result.currency,
      categoryAccountId: result.category_account_id,
      remark: null,
      duplicateEvidence: {
        originalFilename: job.originalFilename,
        fileHash: job.fileHash,
        extractedText: input.text,
      },
    },
    ctx,
  );

  writeReviewCard(db, job.id, userId, fields, { extractedText: input.text });
  log.info({ jobId: job.id }, "Job completed — pending review");
}

/**
 * What to tell the reviewer when the category the item's fee type is tied to
 * could not be used because it is for the other kind of record, or null.
 *
 * A by-sign section reads each line's kind from its printed sign, so a fee
 * type tied to an income category can still give a line printed negative,
 * which is an expense. The tied category is then not used (it would file an
 * expense under income), the item keeps what it would have had without it,
 * and this says so, on the item, rather than dropping the tie silently.
 */
export function tiedCategoryNote(
  item: Pick<
    DocumentItem,
    "kind" | "feeType" | "feeTypeName" | "tiedCategoryAccountId"
  >,
  sectionKind: string | undefined,
  filedUnder: Pick<ReviewFields, "categoryAccountId" | "category">,
  ctx: Pick<ReviewContext, "incomeChoices" | "expenseChoices">,
): string | null {
  const tied = item.tiedCategoryAccountId;
  if (tied == null || filedUnder.categoryAccountId === tied) return null;
  const isIncome = item.kind === DocumentType.Income;
  const otherKind = (isIncome ? ctx.expenseChoices : ctx.incomeChoices).find(
    (choice) => choice.id === tied,
  );
  // Archived since the profile was saved, or one of this kind after all:
  // either way nothing contradicts the line, so there is nothing to say.
  if (!otherKind) return null;
  const tiedKind = isIncome ? "an expense category" : "an income category";
  const lineKind = isIncome ? "an income" : "an expense";
  const why =
    sectionKind === "by_sign"
      ? `this line is printed ${isIncome ? "positive" : "negative"}, so it is ${lineKind}`
      : `this line is ${lineKind}`;
  const instead = filedUnder.category
    ? `It is filed under “${filedUnder.category}” instead`
    : "It has no category instead";
  return `The category “${otherKind.name}” tied to the line type “${item.feeTypeName || nameFromKey(item.feeType ?? "")}” is ${tiedKind}, but ${why}. ${instead}: choose its category.`;
}

async function itemFields(
  db: LedgerDb,
  jobId: string,
  reading: DocumentReading,
  ctx: ReviewContext,
  plan: ItemsPlan,
): Promise<ReviewFields[]> {
  const profile = plan.reading;
  const sectionKinds = new Map(
    profile.sections.map((section) => [section.key, section.kind]),
  );
  // Income and expenses another profile's records may already hold (FR-066).
  const overlaps = sameMoneyNotes(
    db,
    reading.items.map((item) => ({
      sectionKey: item.sectionKey,
      kind: item.kind,
      date: item.date,
    })),
    profile.sections,
    jobId,
  );
  // A row read from a table, or any item read in Every transaction mode,
  // carries its own reference, and a record with a different one is a
  // different transaction (FR-063). A summary line, and an item of the
  // built-in reading, keeps the check of FR-024 unchanged.
  const fromTable = new Set(
    profile.sections
      .filter((section) => section.fromTable)
      .map((section) => section.key),
  );
  const ownReferenceOf = (item: DocumentItem) =>
    fromTable.has(item.sectionKey) || plan.mode === ImportMode.EveryTransaction;
  const out: ReviewFields[] = [];
  for (const [index, item] of reading.items.entries()) {
    // The first category the item could take that is still one of its kind
    // (FR-034): a tied category archived since the profile was saved is
    // passed over. None leaves Uncategorised to `buildReviewFields`.
    const choices =
      item.kind === DocumentType.Income
        ? ctx.incomeChoices
        : ctx.expenseChoices;
    const categoryAccountId =
      item.categoryCandidates.find((id) =>
        choices.some((choice) => choice.id === id),
      ) ?? null;
    const fields = await buildReviewFields(
      db,
      {
        documentType: item.kind,
        itemName: item.description,
        // The other party and currency are the document's; the date and
        // reference are the item's own when its line prints one (FR-006).
        supplier: reading.counterparty,
        amount: item.amount,
        date: item.date,
        reference: item.reference,
        currency: reading.currency,
        categoryAccountId,
        // The remark is the reviewer's to write: an import never fills it.
        remark: null,
        // No file name, hash or text: shared by every item of the document
        // and by last month's, so none of them says an item is a duplicate.
        // The file hash was checked for the whole document before reading.
        duplicateEvidence: {
          originalFilename: null,
          fileHash: null,
          extractedText: null,
          referenceVeto: ownReferenceOf(item),
        },
        // The profile's own account, and a transfer's other one (FR-058).
        documentAccountId: profile.documentAccountId ?? null,
        counterAccountId: item.counterAccountId,
      },
      ctx,
    );
    // What the reading says to check. Any of it holds the item back from
    // "Confirm all" until the reviewer has looked. A tied category it could
    // not use (FR-034) is answered by choosing a category, so it is kept
    // apart from its section's flag rule (FR-061) and money another
    // profile's records may already hold (FR-066), which no category choice
    // answers: a bulk "Set category" must not clear a double-count warning.
    fields.reviewNote = tiedCategoryNote(
      item,
      sectionKinds.get(item.sectionKey),
      fields,
      ctx,
    );
    const checks = [item.reviewNote, overlaps[index]].filter(
      (note): note is string => Boolean(note),
    );
    fields.checkNote = checks.length ? checks.join(" ") : null;
    out.push(fields);
  }
  flagTransferDuplicates(db, reading, out, ctx);
  return out;
}

/**
 * Flags each transfer item that repeats a transfer already in the books
 * (FR-060), such as one made in Reconciliation. Asked for the whole reading at
 * once, so one existing transfer flags one item only. A transfer in another
 * currency is not looked for: it cannot be imported as it is (FR-059), and
 * its amount is not in the books' cents.
 */
function flagTransferDuplicates(
  db: LedgerDb,
  reading: DocumentReading,
  fields: ReviewFields[],
  ctx: ReviewContext,
) {
  const probed: number[] = [];
  const probes: TransferProbe[] = [];
  for (const [index, item] of reading.items.entries()) {
    const row = fields[index];
    if (!isTransferType(item.kind)) continue;
    if (row.accountId == null || row.counterAccountId == null) continue;
    if (row.currency !== ctx.mainCurrency) continue;
    probed.push(index);
    probes.push({
      documentType: item.kind,
      accountId: row.accountId,
      counterAccountId: row.counterAccountId,
      amountMinor: item.amountMinor,
      date: item.date,
    });
  }
  if (probes.length === 0) return;
  for (const [at, found] of detectTransferDuplicates(db, probes)) {
    const row = fields[probed[at]];
    row.duplicateOf = found.duplicateOf;
    row.duplicateConfidence = found.confidence;
    row.duplicateReasons = JSON.stringify(found.reasons);
  }
}

/**
 * Shows how far a reading in pieces has got, on the queue row and every open
 * screen: "Reading part 3 of 25" (FR-043, US8 AS2).
 */
function showProgress(
  db: LedgerDb,
  jobId: string,
  userId: number,
  progress: PieceProgress,
) {
  db.update(importQueue)
    .set({ progressDone: progress.done, progressTotal: progress.total })
    .where(eq(importQueue.id, jobId))
    .run();
  emitJobUpdate(db, jobId, userId);
}

/**
 * Whether the job is still being read: it exists, and nothing else has moved
 * it on. A reading in pieces asks between pieces, so a document discarded
 * while it is read makes no more AI calls (FR-011).
 */
function isStillReading(db: LedgerDb, jobId: string): boolean {
  const current = db
    .select({ state: importQueue.state })
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  return current?.state === ImportState.Processing;
}

/**
 * Reads each part of the plan and joins them (`joinParts`). The table is read
 * by code first, so a row it cannot read fails the document before the AI is
 * asked. The AI then reads its sections: beside a table, from the text with
 * the table's rows left out (FR-057); in Every transaction mode, in pieces,
 * each sized to finish in time (FR-043).
 */
async function readParts(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  input: ReadingInput,
  plan: ItemsPlan,
): Promise<DocumentReading> {
  const context = {
    today: new Date().toISOString().slice(0, 10),
    mainCurrency: input.accountLists.mainCurrency,
    schemaId: plan.reading.schemaId,
  };
  let table: ReadParts["table"] = null;
  if (plan.table) {
    if (!input.workbook) {
      throw new TableReadError(
        "This spreadsheet's cells could not be read, so it was not read from its columns.",
      );
    }
    table = {
      reading: readTable(input.workbook, plan.table, context.mainCurrency),
      profile: plan.table,
    };
  }
  let ai: AiPart | null = null;
  if (plan.ai) {
    const params = {
      text: table
        ? withoutTableRows(input.text, table.reading.dataLines)
        : input.text,
      profile: plan.ai.reading,
      ...input.accountLists,
    };
    const statedTotalDescription = plan.ai.reading.statedTotalDescription;
    if (plan.ai.pieces) {
      const read = await readEnvelopeInPieces(params, input.providers, {
        intervalMs: input.rateLimitMs,
        pinned: input.workbook
          ? headingLines(input.workbook, table?.reading.found.headerRow ?? null)
          : [],
        onProgress: (progress: PieceProgress) =>
          showProgress(db, job.id, userId, progress),
        stillWanted: () => isStillReading(db, job.id),
      });
      ai = { ...read, statedTotalDescription };
    } else {
      const read = await readDocumentEnvelope(
        params,
        input.providers,
        input.rateLimitMs,
      );
      ai = { envelope: read.envelope, method: "ai", statedTotalDescription };
    }
  }
  const reading = joinParts({ table, ai }, plan.reading, plan.mode, context);
  if (input.sheet) reading.notes.sheet = input.sheet;
  return reading;
}

async function readItems(
  db: LedgerDb,
  job: ImportJob,
  userId: number,
  ctx: ReviewContext,
  input: ReadingInput,
  plan: ItemsPlan,
) {
  const { profileId } = plan;
  let reading: DocumentReading;
  try {
    reading = await readParts(db, job, userId, input, plan);
  } catch (err) {
    if (err instanceof ReadingStoppedError) {
      // Deleted, or moved on by something else, between two pieces. A job
      // moved on keeps its new state, but not this reading's count.
      db.update(importQueue)
        .set(NO_PROGRESS)
        .where(
          and(
            eq(importQueue.id, job.id),
            ne(importQueue.state, ImportState.Processing),
          ),
        )
        .run();
      log.warn(
        { jobId: job.id },
        "Job changed during reading; reading stopped",
      );
      return;
    }
    if (err instanceof DocumentLimitError || err instanceof TableReadError) {
      markFailed(db, job.id, userId, err.message);
      return;
    }
    if (err instanceof SchemaRejectedError) {
      // Only this document fails, and with no reading without the schema
      // (FR-037). Nothing is remembered about the refusal, so no other
      // document is read differently.
      const whose = plan.profileName
        ? `the import profile "${plan.profileName}"`
        : "the chosen reading";
      markFailed(
        db,
        job.id,
        userId,
        `The AI provider refused the request to read this document with ${whose} (HTTP 400), so it was not read: ${err.providerMessage}`,
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ jobId: job.id, msg }, "LLM extraction failed");
    markFailed(db, job.id, userId, `AI extraction failed: ${msg}`);
    return;
  }

  log.info(
    {
      jobId: job.id,
      items: reading.items.length,
      ignored: reading.notes.ignored.length,
      controlTotal: reading.controlTotal,
    },
    "Document read",
  );

  if (reading.items.length === 0) {
    markFailed(db, job.id, userId, NO_ITEMS_FOUND);
    return;
  }

  // Every look-up that waits (exchange rates) is done here, before the write,
  // so the write below can be one transaction that never waits.
  const fields = await itemFields(db, job.id, reading, ctx, plan);
  const extractionNotes = serializeExtractionNotes(reading.notes);

  if (fields.length === 1) {
    // One item is a receipt: one card, no group (FR-009). It keeps the text
    // for search as a receipt does, without the line numbers.
    writeReviewCard(db, job.id, userId, fields[0], {
      extractedText: stripLineNumbers(input.text),
      profileId,
      extractionNotes,
    });
    log.info({ jobId: job.id }, "Job completed — one item, pending review");
    return;
  }

  const rows: ImportItemInsert[] = reading.items.map((item, position) => ({
    id: randomUUID(),
    jobId: job.id,
    state: ImportState.PendingReview,
    position,
    sourceLine: item.sourceLine,
    sectionKey: item.sectionKey,
    feeType: item.feeType,
    extrasJson: item.extras ? JSON.stringify(item.extras) : null,
    ...fields[position],
  }));

  let grouped: boolean;
  try {
    grouped = saveGroup(db, job.id, rows, {
      profileId,
      extractionNotes,
      document: {
        date: reading.date,
        supplier: reading.counterparty,
        reference: reading.reference,
        currency: reading.currency,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ jobId: job.id, err }, "Saving the items failed");
    markFailed(
      db,
      job.id,
      userId,
      `Couldn't save the items read from this document: ${msg}`,
    );
    return;
  }
  if (!grouped) {
    // Deleted, or moved on by something else, while it was being read.
    log.warn({ jobId: job.id }, "Job changed during reading; items not saved");
    return;
  }

  // Announced only now that the group has committed.
  emitJobUpdate(db, job.id, userId);
  emitItemUpdates(
    db,
    job.id,
    rows.map((row) => row.id),
    userId,
  );
  log.info(
    { jobId: job.id, items: rows.length },
    "Job completed — grouped for review",
  );
}

/**
 * Saves every item and marks the queue row Grouped, all in one transaction, or
 * nothing at all. The row must still exist and still be reading: a document
 * discarded while it was read leaves no items behind. Returns whether the
 * group was saved. Throws, with nothing written, when a write fails.
 */
export function saveGroup(
  db: LedgerDb,
  jobId: string,
  rows: ImportItemInsert[],
  notes: {
    profileId: string;
    extractionNotes: string;
    /**
     * The document's own header. Kept on the group, whose review columns are
     * otherwise unused: the date is the month every record of the group files
     * the shared document under (see `confirmImportRow`).
     */
    document?: Pick<
      typeof importQueue.$inferInsert,
      "date" | "supplier" | "reference" | "currency"
    >;
  },
): boolean {
  return db.transaction((tx) => {
    const current = tx
      .select({ state: importQueue.state })
      .from(importQueue)
      .where(eq(importQueue.id, jobId))
      .get();
    if (!current || current.state !== ImportState.Processing) return false;

    for (let start = 0; start < rows.length; start += ITEM_INSERT_CHUNK) {
      tx.insert(importItems)
        .values(rows.slice(start, start + ITEM_INSERT_CHUNK))
        .run();
    }
    tx.update(importQueue)
      .set({
        state: ImportState.Grouped,
        ...notes.document,
        profileId: notes.profileId,
        extractionNotes: notes.extractionNotes,
        error: null,
        ...NO_PROGRESS,
        processedAt: new Date().toISOString(),
      })
      .where(eq(importQueue.id, jobId))
      .run();
    return true;
  });
}
