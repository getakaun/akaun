import { isContraRevenueAccount } from "$lib/account-classification.js";
import { and, eq, isNull } from "drizzle-orm";
import {
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
  Role,
  isTransferType,
} from "$lib/enums.js";
import { importItems, importQueue, recordAttachments } from "../db/schema.js";
import { STORAGE_PATH } from "../env.js";
import {
  displayName,
  fileExists,
  isImportTempPath,
  moveToRecordStorage,
  returnToTemp,
} from "../file-storage.js";
import {
  validateImportAccountPair,
  validateTransferPair,
} from "../import/account-policy.js";
import { alreadyImportedAtConfirm } from "../import/repeat-file.js";
import { rememberProfile } from "../import/same-money.js";
import {
  categoryAccountForImport,
  categoryChoices,
  matchCategoryAccount,
  resolvePaidFromAccountId,
} from "../import/category-accounts.js";
import {
  emitItemUpdates,
  emitJobUpdate,
  finishGroupIfDone,
} from "../import/group-state.js";
import type { ReviewFields } from "../import/review-fields.js";
import {
  settleReviewFields,
  transferAccountsOf,
  transferCurrencyReason,
  type ReviewOverrides,
  type SettleRefusal,
} from "../import/settle-review.js";
import { mainCurrencyCode } from "../currency/form.js";
import type {
  LedgerDb,
  RecordCreate,
  RecordView,
  Refusable,
} from "../ledger/types.js";
import { createLogger } from "../logger.js";
import { defaultAccountId, getAccount } from "../queries/accounts.js";
import { resolveOrCreateContact } from "../queries/contacts.js";
import { addAttachment } from "../queries/ledger.js";
import { requireAccountDefault } from "./account-defaults.js";
import { createRecord, type DeferredEmits } from "./ledger.js";

const log = createLogger("import:confirm");

/**
 * Turning a reviewed document into a record.
 *
 * A receipt's queue row and each item of a group hold the same review fields
 * (`ReviewFields`). `confirmReviewed` takes those fields and the reviewer's
 * corrections, settles what the record will say, and hands the result to
 * `confirmImportRow`, which does the writing. So a receipt and an item are
 * confirmed by the same code, with the same rules (006 FR-007, FR-044).
 */

/**
 * Why a receipt was not imported: the reading the reviewer confirmed is no
 * longer the one in review, because it was imported meanwhile or the document
 * was read again.
 */
export const RECEIPT_NOT_AS_SHOWN =
  "This document is no longer waiting for review as it was shown (it was imported, or read again), so nothing was imported.";

/**
 * What is being confirmed: the queue row that holds the file, and, for one
 * item of a group, which item.
 */
export type ImportJobSource = {
  jobId: string;
  /**
   * The item of the group being confirmed. Absent for a receipt, whose queue
   * row is itself the thing being confirmed.
   */
  itemId?: string;
  /** Who uploaded the file. The record and any new contact are theirs. */
  uploadedBy: number;
  /** Who is confirming it, for the audit trail. Set by `confirmImportRow`. */
  confirmedBy?: number;
  /**
   * Where the file is now. For an item this is only a hint: the confirm reads
   * the group's current path inside its transaction, because an earlier item
   * may have moved the file while this request waited.
   */
  tempFilePath: string;
  /**
   * Carried onto the record so it can be searched. An item always gives null,
   * whatever is passed: the document's text describes every item, so it would
   * make each record match a search for any other line (FR-029).
   */
  extractedText: string | null;
  /**
   * The date the stored file is filed under (`records/YYYY/MM/`). A receipt
   * uses its record's date, the default. Every item of a group must pass the
   * document's date: they share one file, and a later item looks for it in
   * that month (see `moveToRecordStorage`).
   */
  fileDate?: string;
  /**
   * A receipt only: when the reading the reviewer confirmed was made (the
   * row's `processedAt`). The claim matches only that reading. "Read again"
   * can put the same job back in review with a new reading while a confirm
   * waits on an exchange rate, and the confirm must then make no record from
   * the old reading (FR-023). Left out, any reading in review matches.
   */
  readAt?: string | null;
};

/** What the record will say, after the reviewer's corrections are applied. */
export type ImportReviewFields = {
  /** A DocumentType code. Two explicit accounts below can still change it. */
  documentType: number;
  description: string;
  /** The other party's name, for an expense or an income alike. */
  partyName: string;
  /** True when the reviewer typed the name, so an older match must not win. */
  partyEdited: boolean;
  /** `YYYY-MM-DD`. The record's date, and the month its file is filed under. */
  date: string;
  amount: number;
  currency: string;
  /** Already known here: the route looks it up before calling. */
  exchangeRate: number;
  reference: string;
  /** The category name, used when no category account was matched. */
  category: string;
  /** The category account the reader matched, if any. */
  categoryAccountId: number | null;
  remark: string;
  /**
   * The account that paid or received it. Null means use the default. On a
   * transfer, the account the document is about (FR-058).
   */
  accountId: number | null;
  /** A transfer's other account; null or absent for anything else. */
  counterAccountId?: number | null;
  /** Both accounts, when the reviewer chose them. */
  sides: { fromAccountId: number; toAccountId: number } | null;
  /** A contact the reviewer picked. */
  contactId?: number;
  /** A new contact name the reviewer typed. */
  newContactName?: string;
  /** The contact the reader matched, and the document type it matched for. */
  matchedContact: { id: number; documentType: number | null } | null;
};

export type ImportConfirmed = {
  record: RecordView;
  /** True when the record went to the Uncategorised account. */
  uncategorised: boolean;
};

/** Thrown inside the transaction to undo every write in it. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Confirms one reviewed document.
 *
 * Every write happens in one transaction, and the first write is a claim: the
 * job moves out of review only if it is still in review. So when two confirms
 * of the same job arrive together, only one makes a record, and the other is
 * refused. When a rule refuses the record, the transaction is undone as a
 * whole: no contact is left behind, and the job is still waiting for review.
 *
 * Nothing is announced to open tabs until the transaction has committed.
 */
export function confirmImportRow(
  db: LedgerDb,
  job: ImportJobSource,
  fields: ImportReviewFields,
  options: { actingUserId: number; storageRoot?: string },
): Refusable<ImportConfirmed> {
  const root = options.storageRoot ?? STORAGE_PATH;
  const emits: DeferredEmits = [];
  // The file move is not part of the transaction, so it is undone by hand.
  // It runs as the last step before the attachment row: after the claim and
  // after the record was accepted, so a refusal never touches the file. If
  // the transaction still fails after the move, the file goes back to its temp
  // path, and the job in review finds its file again. On success the file is
  // already where the attachment points. The move and the transaction are one
  // synchronous run, so no other request in this process can come between them.
  const file: { moved: { from: string; to: string } | null } = { moved: null };

  let confirmed: ImportConfirmed;
  try {
    confirmed = db.transaction(() => {
      const written = writeConfirmation(
        db,
        { ...job, confirmedBy: options.actingUserId },
        fields,
        root,
        emits,
        file,
      );
      if (!written.ok) throw new Refused(written.reason);
      return written.value;
    });
  } catch (err) {
    if (file.moved) returnToTemp(file.moved.to, file.moved.from, root);
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }

  for (const emit of emits) emit();
  if (job.itemId) {
    emitItemUpdates(db, job.jobId, [job.itemId], options.actingUserId);
  }
  emitJobUpdate(db, job.jobId, options.actingUserId);
  return { ok: true, value: confirmed };
}

/**
 * Confirms a receipt or an item from its stored review fields and the
 * reviewer's corrections: review fields in, record out.
 *
 * The fields are settled first (an exchange rate may be fetched, which waits),
 * and only then is everything written in one transaction by `confirmImportRow`.
 * A refusal says why. `kind: "rate"` means no exchange rate is known, which the
 * receipt route has always answered with a 400.
 */
export async function confirmReviewed(
  db: LedgerDb,
  job: ImportJobSource,
  row: ReviewFields,
  overrides: ReviewOverrides,
  options: { actingUserId: number; storageRoot?: string },
): Promise<{ ok: true; value: ImportConfirmed } | SettleRefusal> {
  const settled = await settleReviewFields(db, row, overrides);
  if (!settled.ok) return settled;
  const confirmed = confirmImportRow(db, job, settled.value, options);
  return confirmed.ok ? confirmed : { ...confirmed, kind: "rule" };
}

/** Every write of a confirm. Runs inside the caller's transaction. */
function writeConfirmation(
  db: LedgerDb,
  job: ImportJobSource,
  fields: ImportReviewFields,
  root: string,
  emits: DeferredEmits,
  file: { moved: { from: string; to: string } | null },
): Refusable<ImportConfirmed> {
  if (isTransferType(fields.documentType)) {
    return writeTransferConfirmation(db, job, fields, root, emits, file);
  }
  const resolved = resolveSides(db, fields);
  if (!resolved.ok) return resolved;
  const {
    docCode,
    isIncome,
    categoryAccountId,
    accountId,
    paidFromAccountId,
    uncategorised,
  } = resolved.value;

  // The claim. It only matches a job (or an item) that is still in review, so
  // a second confirm of the same one (a double click, a second tab, a
  // confirm-all run again) changes no row.
  const claimed = job.itemId
    ? claimItem(db, job.jobId, job.itemId, accountId, docCode)
    : claimReceipt(db, job, accountId, docCode);
  if (!claimed) {
    return {
      ok: false,
      reason: job.itemId
        ? "This item is no longer waiting for review, so it was not imported again."
        : RECEIPT_NOT_AS_SHOWN,
    };
  }

  // One file is imported one way only (FR-033). Another upload of the same
  // file may have made a record since this one was read, for example the
  // same statement read once as Summary and once as Every transaction.
  // Asked here, in the transaction that would write the record, so of two
  // confirms that arrive together only the first can pass (FR-064). A
  // receipt read the standard way is not asked (FR-004).
  const repeat = alreadyImportedAtConfirm(db, job.jobId);
  if (repeat) return { ok: false, reason: repeat };

  const contactId = resolveContact(db, job, fields, docCode, isIncome);

  const common = {
    categoryAccountId,
    date: fields.date,
    description: fields.description,
    amount: fields.amount,
    currency: fields.currency,
    exchangeRate: fields.exchangeRate,
    contactId,
    reference: fields.reference,
    remark: fields.remark,
    extractedText: job.itemId ? null : job.extractedText,
  };
  const sides: RecordCreate = isIncome
    ? { kind: "income", receivedIntoAccountId: accountId, ...common }
    : { kind: "expense", paidFromAccountId, ...common };

  const created = createRecord(
    db,
    job.uploadedBy,
    sides,
    emits,
    job.confirmedBy,
  );
  if (!created.ok) return created;

  finishConfirmation(db, job, fields, root, file, created.value.id, docCode);
  return { ok: true, value: { record: created.value, uncategorised } };
}

/**
 * Attaches the document to the new record and marks what was confirmed as
 * imported: the item, finishing its group when it was the last, or the
 * receipt. The same for every kind of record an import makes.
 */
function finishConfirmation(
  db: LedgerDb,
  job: ImportJobSource,
  fields: ImportReviewFields,
  root: string,
  file: { moved: { from: string; to: string } | null },
  recordId: number,
  docCode: number,
) {
  const attachmentPath = job.itemId
    ? sharedFileForItem(db, job, root, file)
    : movedReceiptFile(job, fields.date, root, file);
  addAttachment(
    db,
    recordId,
    attachmentPath,
    displayName(attachmentPath),
    // An item's file is the whole document, so it is never searched as this
    // record's own (FR-029).
    { groupDocument: Boolean(job.itemId) },
  );
  // The profile it was read with outlives the import history (FR-066).
  rememberProfile(db, job.jobId, recordId);

  if (job.itemId) {
    db.update(importItems)
      .set({
        state: ImportState.Imported,
        resultId: recordId,
        resultType: docCode,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importItems.id, job.itemId))
      .run();
    // The last waiting item finishes the group, in this same transaction.
    finishGroupIfDone(db, job.jobId);
  } else {
    db.update(importQueue)
      .set({
        state: ImportState.Imported,
        resultId: recordId,
        resultType: docCode,
        completedAt: new Date().toISOString(),
      })
      .where(eq(importQueue.id, job.jobId))
      .run();
  }
}

/**
 * Every write of confirming a transfer (FR-059): one Transfer record between
 * its two accounts, with no other party and no category, audited and with the
 * document attached as any imported record is. Runs inside the caller's
 * transaction, and claims what it confirms first, as `writeConfirmation` does.
 *
 * A transfer is in the main currency at rate 1, the only way the books record
 * one; a transfer read in another currency is refused here as well as at
 * review, so no route can get past it.
 */
function writeTransferConfirmation(
  db: LedgerDb,
  job: ImportJobSource,
  fields: ImportReviewFields,
  root: string,
  emits: DeferredEmits,
  file: { moved: { from: string; to: string } | null },
): Refusable<ImportConfirmed> {
  const docCode = fields.documentType;
  const main = mainCurrencyCode(db);
  if (fields.currency.toUpperCase() !== main) {
    return {
      ok: false,
      reason: transferCurrencyReason(fields.currency.toUpperCase(), main),
    };
  }
  if (!fields.sides) {
    return {
      ok: false,
      reason: "Choose both accounts of this transfer before importing it.",
    };
  }
  const from = getAccount(db, fields.sides.fromAccountId);
  const to = getAccount(db, fields.sides.toAccountId);
  if (!from || !to) {
    return { ok: false, reason: "Choose accounts that are still available." };
  }
  const pair = validateTransferPair(from, to);
  if (!pair.ok) return pair;
  const { accountId, counterAccountId } = transferAccountsOf(docCode, {
    fromAccountId: from.id,
    toAccountId: to.id,
  });

  const claimed = job.itemId
    ? claimItem(db, job.jobId, job.itemId, accountId, docCode)
    : claimReceipt(db, job, accountId, docCode);
  if (!claimed) {
    return {
      ok: false,
      reason: job.itemId
        ? "This item is no longer waiting for review, so it was not imported again."
        : RECEIPT_NOT_AS_SHOWN,
    };
  }
  const repeat = alreadyImportedAtConfirm(db, job.jobId);
  if (repeat) return { ok: false, reason: repeat };

  // The other account as it is confirmed, so the item says what was made.
  if (job.itemId) {
    db.update(importItems)
      .set({ counterAccountId })
      .where(eq(importItems.id, job.itemId))
      .run();
  } else {
    db.update(importQueue)
      .set({ counterAccountId })
      .where(eq(importQueue.id, job.jobId))
      .run();
  }

  const created = createRecord(
    db,
    job.uploadedBy,
    {
      kind: "transfer",
      fromAccountId: from.id,
      toAccountId: to.id,
      date: fields.date,
      description: fields.description,
      amount: fields.amount,
      currency: main,
      exchangeRate: 1,
      contactId: null,
      reference: fields.reference,
      remark: fields.remark,
      extractedText: job.itemId ? null : job.extractedText,
    },
    emits,
    job.confirmedBy,
  );
  if (!created.ok) return created;

  finishConfirmation(db, job, fields, root, file, created.value.id, docCode);
  return { ok: true, value: { record: created.value, uncategorised: false } };
}

/**
 * Claims a receipt's queue row: it moves out of review only if it is still in
 * review, and is still the reading the reviewer saw when that is given.
 */
function claimReceipt(
  db: LedgerDb,
  job: ImportJobSource,
  accountId: number,
  docCode: number,
): { id: string } | undefined {
  return db
    .update(importQueue)
    .set({
      state: ImportState.Confirmed,
      accountId,
      documentType: docCode,
      confirmedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(importQueue.id, job.jobId),
        eq(importQueue.state, ImportState.PendingReview),
        job.readAt === undefined
          ? undefined
          : job.readAt === null
            ? isNull(importQueue.processedAt)
            : eq(importQueue.processedAt, job.readAt),
      ),
    )
    .returning({ id: importQueue.id })
    .get();
}

/**
 * Claims one item of a group: it moves out of review only if it is still in
 * review and its group is still open. Returns null when either is not so.
 */
function claimItem(
  db: LedgerDb,
  jobId: string,
  itemId: string,
  accountId: number,
  docCode: number,
): { id: string } | undefined {
  const group = db
    .select({ state: importQueue.state })
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  if (group?.state !== ImportState.Grouped) return undefined;
  return db
    .update(importItems)
    .set({
      state: ImportState.Confirmed,
      accountId,
      documentType: docCode,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(importItems.id, itemId),
        eq(importItems.jobId, jobId),
        eq(importItems.state, ImportState.PendingReview),
      ),
    )
    .returning({ id: importItems.id })
    .get();
}

/**
 * Moves a receipt's file out of temp, and returns where to attach it. A failed
 * move leaves the temp file where it is and still attaches it, so nothing is
 * lost.
 */
function movedReceiptFile(
  job: ImportJobSource,
  recordDate: string,
  root: string,
  file: { moved: { from: string; to: string } | null },
): string {
  const date = job.fileDate ?? recordDate;
  try {
    const movedHere = fileExists(job.tempFilePath, root);
    const moved = moveToRecordStorage(job.tempFilePath, date, root);
    if (movedHere) file.moved = { from: job.tempFilePath, to: moved };
    return moved;
  } catch (err) {
    log.error(
      { err, jobId: job.jobId },
      "File move failed (temp file remains recoverable)",
    );
    return job.tempFilePath;
  }
}

/**
 * The one stored file every record of a group shares (FR-027), and where to
 * attach it.
 *
 * The first item to be confirmed moves the file out of temp, under the
 * document's date, and saves the new path on the group, so the group keeps
 * using it and every later item attaches that same path without moving
 * anything. The path is read here, inside the transaction, not from the
 * caller: another item may have moved it since the caller looked. A failed
 * move attaches the temp file where it lies, as for a receipt, and every later
 * item then attaches it there too, so the records always share one path.
 */
function sharedFileForItem(
  db: LedgerDb,
  job: ImportJobSource,
  root: string,
  file: { moved: { from: string; to: string } | null },
): string {
  const group = db
    .select({
      tempFilePath: importQueue.tempFilePath,
      date: importQueue.date,
      createdAt: importQueue.createdAt,
    })
    .from(importQueue)
    .where(eq(importQueue.id, job.jobId))
    .get();
  const current = group?.tempFilePath ?? job.tempFilePath;
  if (!isImportTempPath(current)) return current;
  // An earlier item whose move failed attached the temp file where it lay.
  // Moving it now would leave that record pointing at nothing, so it stays.
  const alreadyAttached = db
    .select({ id: recordAttachments.id })
    .from(recordAttachments)
    .where(eq(recordAttachments.filename, current))
    .limit(1)
    .get();
  if (alreadyAttached) return current;

  // The document's date, kept on the group when it was read. A group read
  // before that was kept falls back to the day it was uploaded.
  const documentDate =
    job.fileDate ?? group?.date ?? (group?.createdAt ?? "").slice(0, 10);
  try {
    const movedHere = fileExists(current, root);
    const moved = moveToRecordStorage(current, documentDate, root);
    if (movedHere) file.moved = { from: current, to: moved };
    db.update(importQueue)
      .set({ tempFilePath: moved })
      .where(eq(importQueue.id, job.jobId))
      .run();
    return moved;
  } catch (err) {
    log.error(
      { err, jobId: job.jobId, itemId: job.itemId },
      "File move failed (temp file remains recoverable)",
    );
    return current;
  }
}

type ResolvedSides = {
  docCode: number;
  isIncome: boolean;
  categoryAccountId: number;
  accountId: number;
  paidFromAccountId: number | null;
  uncategorised: boolean;
};

/**
 * Which accounts the record names. Only reads: a refusal here has written
 * nothing yet.
 */
function resolveSides(
  db: LedgerDb,
  fields: ImportReviewFields,
): Refusable<ResolvedSides> {
  let docCode = fields.documentType;
  let isIncome = docCode === DocumentType.Income;

  const payableDefault = requireAccountDefault(
    db,
    DefaultAccountPurpose.Payable,
  );
  const payableAccountId = payableDefault.ok ? payableDefault.value : null;

  // A category that could not be read lands on Uncategorised and is flagged, the
  // same way the upgrade treats a record it could not place: a document that was
  // paid for is still a document that was paid for (spec edge case, FR-019).
  const uncategorisedExpenseDefault = requireAccountDefault(
    db,
    DefaultAccountPurpose.UncategorisedExpense,
  );
  const uncategorisedIncomeDefault = requireAccountDefault(
    db,
    DefaultAccountPurpose.UncategorisedIncome,
  );
  let categoryAccountId: number;
  let uncategorised: boolean;
  if (fields.sides) {
    const from = getAccount(db, fields.sides.fromAccountId);
    const to = getAccount(db, fields.sides.toAccountId);
    if (!from || !to) {
      return { ok: false, reason: "Choose accounts that are still available." };
    }
    const receivableDefault = requireAccountDefault(
      db,
      DefaultAccountPurpose.Receivable,
    );
    const pair = validateImportAccountPair(
      from,
      to,
      payableAccountId,
      receivableDefault.ok ? receivableDefault.value : null,
    );
    if (!pair.ok) return pair;
    docCode =
      pair.kind === "income" ? DocumentType.Income : DocumentType.Expense;
    isIncome = docCode === DocumentType.Income;
    categoryAccountId = isIncome ? from.id : to.id;
    const categoryDefault = isIncome
      ? uncategorisedIncomeDefault
      : uncategorisedExpenseDefault;
    uncategorised =
      categoryDefault.ok && categoryAccountId === categoryDefault.value;
  } else {
    const kind = isIncome ? "income" : "expense";
    const choices = categoryChoices(db, kind);
    const categoryDefault = isIncome
      ? uncategorisedIncomeDefault
      : uncategorisedExpenseDefault;
    const selectedAccountId =
      fields.categoryAccountId ??
      matchCategoryAccount(choices, fields.category);
    const selectedAccount =
      selectedAccountId == null ? null : getAccount(db, selectedAccountId);
    if (
      isIncome &&
      selectedAccount &&
      isContraRevenueAccount(selectedAccount)
    ) {
      return {
        ok: false,
        reason: "Contra revenue cannot be used as an import source.",
      };
    }
    const selectedCategory = categoryAccountForImport(
      kind,
      choices,
      selectedAccountId,
      categoryDefault.ok ? categoryDefault.value : null,
    );
    if (!selectedCategory.ok) return selectedCategory;
    categoryAccountId = selectedCategory.value.accountId;
    uncategorised = selectedCategory.value.uncategorised;
  }

  const accountId = fields.sides
    ? isIncome
      ? fields.sides.toAccountId
      : fields.sides.fromAccountId
    : (fields.accountId ?? defaultAccountId(db));
  if (accountId == null) {
    return {
      ok: false,
      reason: isIncome
        ? "Say which account received this before importing it."
        : "Say which account paid for this before importing it.",
    };
  }

  if (!fields.sides) {
    const from = getAccount(db, isIncome ? categoryAccountId : accountId);
    const to = getAccount(db, isIncome ? accountId : categoryAccountId);
    if (!from || !to)
      return { ok: false, reason: "Choose accounts that are still available." };
    const receivable = requireAccountDefault(
      db,
      DefaultAccountPurpose.Receivable,
    );
    const pair = validateImportAccountPair(
      from,
      to,
      payableAccountId,
      receivable.ok ? receivable.value : null,
    );
    if (!pair.ok) return pair;
  }

  return {
    ok: true,
    value: {
      docCode,
      isIncome,
      categoryAccountId,
      accountId,
      paidFromAccountId: resolvePaidFromAccountId(
        accountId,
        isIncome,
        payableAccountId,
      ),
      uncategorised,
    },
  };
}

/**
 * The contact the record names. The uploader creates any new contact, not the
 * person confirming. Order: a contact the reviewer picked, then a name they
 * typed, then a confident match from reading, then the name as read. Which
 * contacts are searched (suppliers or customers) depends on the kind.
 */
function resolveContact(
  db: LedgerDb,
  job: ImportJobSource,
  fields: ImportReviewFields,
  docCode: number,
  isIncome: boolean,
): number | null {
  const role = isIncome ? Role.Customer : Role.Supplier;
  if (typeof fields.contactId === "number") return fields.contactId;
  if (
    typeof fields.newContactName === "string" &&
    fields.newContactName.trim()
  ) {
    return resolveOrCreateContact(
      db,
      fields.newContactName,
      role,
      job.uploadedBy,
    );
  }
  // A match made for the other kind searched the wrong contacts, and a name
  // the reviewer edited replaces whatever was matched.
  if (
    fields.matchedContact?.id &&
    !fields.partyEdited &&
    fields.matchedContact.documentType === docCode
  ) {
    return fields.matchedContact.id;
  }
  if (fields.partyName.trim()) {
    return resolveOrCreateContact(db, fields.partyName, role, job.uploadedBy);
  }
  return null;
}
