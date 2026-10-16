/**
 * Reviewing the items of a group: editing one, confirming, skipping, filling a
 * category or an account on many at once, and discarding the document.
 *
 * A group is a queue row read as several items (`ImportState.Grouped`). Each
 * item is confirmed by the same code as a receipt (`confirmReviewed`), so an
 * item becomes a record under exactly the rules a receipt does. What this file
 * adds is the group: many items at once, the one shared file, and the group
 * finishing when nothing waits any more (006 FR-016 to FR-020, FR-027, FR-028).
 *
 * Every write commits first and announces after: each changed item as an
 * `item-update` (or `item-deleted`), then the group once as a `job-update`
 * carrying its counts.
 */

import { isContraRevenueAccount } from "$lib/account-classification.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
  isTransferType,
} from "$lib/enums.js";
import { DOCUMENT_ITEMS_MAX } from "$lib/import-reading.js";
import { mainCurrencyCode } from "../currency/form.js";
import { normalizeDate } from "../date.js";
import { contacts, importItems, importQueue } from "../db/schema.js";
import { STORAGE_PATH } from "../env.js";
import { releaseIfUnreferenced } from "../file-storage.js";
import {
  isImportIncomeTarget,
  isImportPurchaseSource,
  isImportTransactionAsset,
  validateImportAccountPair,
  validateTransferPair,
} from "../import/account-policy.js";
import {
  categoryChoices,
  matchCategoryAccount,
  type CategoryChoice,
} from "../import/category-accounts.js";
import { importEvents } from "../import/events.js";
import { auditImportJob, itemChangesOf, itemField } from "../import/audit.js";
import type { FieldChange } from "../audit.js";
import {
  emitItemUpdates,
  emitJobUpdate,
  finishGroupIfDone,
  itemAttention,
  itemEvent,
} from "../import/group-state.js";
import type { ImportItemEvent } from "../import/job-event.js";
import {
  documentTypeOf,
  kindChangeRefusal,
  transferAccountsOf,
  transferSidesOf,
  type ReviewOverrides,
  type SettleRefusal,
} from "../import/settle-review.js";
import type { AccountView, LedgerDb, Refusable } from "../ledger/types.js";
import { getAccount } from "../queries/accounts.js";
import { requireAccountDefault } from "./account-defaults.js";
import { confirmReviewed, type ImportConfirmed } from "./import.js";

type ImportItemRow = typeof importItems.$inferSelect;
type ImportJobRow = typeof importQueue.$inferSelect;

/** Which items a request names: some by id, or every one still waiting. */
export type ItemSelection = string[] | "all";

/** What happened to one item of a request about many. */
export type ItemOutcome = {
  id: string;
  ok: boolean;
  /** Why it was not done, in words the screen shows as they are. */
  reason?: string;
  /** The record the item became, once it has one. */
  recordId?: number;
};

export type ServiceOptions = { actingUserId: number; storageRoot?: string };

const NOT_A_GROUP = "This document is not a group of items waiting for review.";
const ITEM_GONE = "That item is no longer part of this document.";
const NOT_WAITING = "This item is no longer waiting for review.";

/**
 * What an item becomes: an expense, an income, or a transfer between two of
 * the business's own accounts (FR-058). A transfer either way is one kind
 * here; its direction only says which of its two accounts the money left.
 */
function kindOf(
  item: Pick<ImportItemRow, "documentType">,
): "income" | "expense" | "transfer" {
  if (isTransferType(item.documentType)) return "transfer";
  return item.documentType === DocumentType.Income ? "income" : "expense";
}

const TRANSFER_HAS_NO_CATEGORY =
  "A transfer has no category: it moves money between two of your own accounts.";

function now() {
  return new Date().toISOString();
}

function loadGroup(db: LedgerDb, jobId: string): ImportJobRow | null {
  const row = db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  return row ?? null;
}

function loadItem(
  db: LedgerDb,
  jobId: string,
  itemId: string,
): ImportItemRow | null {
  const row = db
    .select()
    .from(importItems)
    .where(and(eq(importItems.id, itemId), eq(importItems.jobId, jobId)))
    .get();
  return row ?? null;
}

/** The items a selection names, in the order the group lists them. */
function selectedItems(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
): ImportItemRow[] {
  const where =
    selection === "all"
      ? and(
          eq(importItems.jobId, jobId),
          eq(importItems.state, ImportState.PendingReview),
        )
      : and(
          eq(importItems.jobId, jobId),
          inArray(importItems.id, selection.slice(0, DOCUMENT_ITEMS_MAX)),
        );
  return db
    .select()
    .from(importItems)
    .where(where)
    .orderBy(asc(importItems.position))
    .all();
}

function hasItems(db: LedgerDb, jobId: string): boolean {
  return !!db
    .select({ id: importItems.id })
    .from(importItems)
    .where(eq(importItems.jobId, jobId))
    .limit(1)
    .get();
}

/** Ids a selection named that are not items of this group. */
function missingIds(selection: ItemSelection, found: ImportItemRow[]) {
  if (selection === "all") return [];
  const seen = new Set(found.map((item) => item.id));
  return [...new Set(selection)].filter((id) => !seen.has(id));
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Every item of a group, in the document's order, as the group's page shows
 * them. A group holds at most `DOCUMENT_ITEMS_MAX` items, so this is the
 * whole group; the page pages and filters it itself (FR-017, SC-010).
 */
export function listGroupItems(db: LedgerDb, jobId: string): ImportItemEvent[] {
  const main = mainCurrencyCode(db);
  return db
    .select()
    .from(importItems)
    .where(eq(importItems.jobId, jobId))
    .orderBy(asc(importItems.position))
    .limit(DOCUMENT_ITEMS_MAX)
    .all()
    .map((item) => itemEvent(item, main));
}

// ── Confirming ──────────────────────────────────────────────────────────────

/** Category lists, looked up once per request and not once per item. */
type Lookups = {
  choices: (kind: "expense" | "income") => CategoryChoice[];
  uncategorised: (kind: "expense" | "income") => number | null;
};

function lookups(db: LedgerDb): Lookups {
  const choices = new Map<string, CategoryChoice[]>();
  const fallback = new Map<string, number | null>();
  return {
    choices(kind) {
      let found = choices.get(kind);
      if (!found) {
        found = categoryChoices(db, kind);
        choices.set(kind, found);
      }
      return found;
    },
    uncategorised(kind) {
      if (!fallback.has(kind)) {
        const result = requireAccountDefault(
          db,
          kind === "income"
            ? DefaultAccountPurpose.UncategorisedIncome
            : DefaultAccountPurpose.UncategorisedExpense,
        );
        fallback.set(kind, result.ok ? result.value : null);
      }
      return fallback.get(kind) ?? null;
    },
  };
}

/**
 * The corrections an item's own fields amount to. An item's edits are saved
 * on the item as they are made, so at confirm the stored fields are the
 * reviewer's word. They are turned into the same two accounts a receipt card
 * sends: the account that paid (or received) on one side and the category on
 * the other, so an item and a receipt pass the same account checks.
 */
function storedOverrides(
  item: ImportItemRow,
  look: Lookups,
): Refusable<ReviewOverrides> {
  const kind = kindOf(item);
  if (kind === "transfer") {
    // A transfer's two accounts, the way the money moved (FR-058).
    const sides = transferSidesOf(
      item.documentType ?? DocumentType.TransferOut,
      item.accountId,
      item.counterAccountId,
    );
    if (!sides) {
      return {
        ok: false,
        reason: "Choose both accounts of this transfer before importing it.",
      };
    }
    return { ok: true, value: { remark: item.remark ?? "", ...sides } };
  }
  if (item.accountId == null) {
    return {
      ok: false,
      reason:
        item.documentType === DocumentType.Income
          ? "Say which account received this before importing it."
          : "Say which account paid for this before importing it.",
    };
  }
  // The stored category counts only while it is still one this kind can be
  // filed under: it may be archived since, or be for the other kind. Then the
  // name is matched again, or the item goes to Uncategorised, as a receipt's
  // category does in `categoryAccountForImport`.
  const choices = look.choices(kind);
  const stored = choices.some((choice) => choice.id === item.categoryAccountId)
    ? item.categoryAccountId
    : null;
  const categoryId =
    stored ??
    matchCategoryAccount(choices, item.category) ??
    look.uncategorised(kind);
  // The remark is the item's own: it starts as its fee type, then the
  // reviewer's edits (FR-034). A receipt's comes from the request instead.
  const remark = item.remark ?? "";
  if (categoryId == null) return { ok: true, value: { remark } };
  return {
    ok: true,
    value:
      kind === "income"
        ? { remark, fromAccountId: categoryId, toAccountId: item.accountId }
        : { remark, fromAccountId: item.accountId, toAccountId: categoryId },
  };
}

/**
 * Confirms one item and makes its record. The whole of it happens in one
 * transaction, or nothing does (FR-044); see `confirmImportRow`. When this is
 * the first item of its group to be confirmed, the document's file moves to
 * the records folder, and every later item attaches that same file (FR-027).
 */
export async function confirmGroupItem(
  db: LedgerDb,
  jobId: string,
  itemId: string,
  options: ServiceOptions,
  look: Lookups = lookups(db),
): Promise<{ ok: true; value: ImportConfirmed } | SettleRefusal> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, kind: "rule", reason: NOT_A_GROUP };
  }
  const item = loadItem(db, jobId, itemId);
  if (!item) return { ok: false, kind: "rule", reason: ITEM_GONE };
  if (item.state !== ImportState.PendingReview) {
    return { ok: false, kind: "rule", reason: NOT_WAITING };
  }
  const overrides = storedOverrides(item, look);
  if (!overrides.ok) return { ...overrides, kind: "rule" };

  return confirmReviewed(
    db,
    {
      jobId,
      itemId,
      uploadedBy: group.createdBy,
      tempFilePath: group.tempFilePath,
      extractedText: null,
    },
    item,
    overrides.value,
    options,
  );
}

/**
 * Confirms many items, one after another (FR-019).
 *
 * An item that needs attention (a possible duplicate, a missing exchange rate
 * or account) is left behind with the reason, and so is one the books refuse;
 * neither stops the others. Each item is its own transaction, so a run that is
 * interrupted keeps what it confirmed. Running it again confirms only what is
 * still waiting: an item already imported is reported as done, with its
 * record, and is never imported twice (SC-011).
 */
export async function confirmGroupItems(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
  options: ServiceOptions,
): Promise<Refusable<ItemOutcome[]>> {
  const group = loadGroup(db, jobId);
  // A group that finished while an earlier run was cut short is still
  // answered, item by item, so sending the run again is always safe.
  const finished =
    group?.state === ImportState.Imported ||
    group?.state === ImportState.Skipped;
  if (!group || (group.state !== ImportState.Grouped && !finished)) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  const main = mainCurrencyCode(db);
  const look = lookups(db);
  const items = selectedItems(db, jobId, selection);
  if (finished && items.length === 0 && !hasItems(db, jobId)) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  const outcomes: ItemOutcome[] = missingIds(selection, items).map((id) => ({
    id,
    ok: false,
    reason: ITEM_GONE,
  }));

  for (const listed of items) {
    // Let other work run between items. A main-currency item waits on nothing,
    // so without this a run of hundreds would hold the process until it ends,
    // and open tabs would see no progress until then (FR-019, FR-047).
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Read again: an earlier item of this run, or another tab, may have
    // changed it since the list was taken.
    const item = loadItem(db, jobId, listed.id);
    if (!item) {
      outcomes.push({ id: listed.id, ok: false, reason: ITEM_GONE });
      continue;
    }
    if (item.state === ImportState.Imported) {
      outcomes.push({
        id: item.id,
        ok: true,
        recordId: item.resultId ?? undefined,
      });
      continue;
    }
    if (item.state !== ImportState.PendingReview) {
      outcomes.push({ id: item.id, ok: false, reason: NOT_WAITING });
      continue;
    }
    const attention = itemAttention(item, main);
    if (attention) {
      outcomes.push({ id: item.id, ok: false, reason: attention });
      continue;
    }
    const confirmed = await confirmGroupItem(db, jobId, item.id, options, look);
    outcomes.push(
      confirmed.ok
        ? { id: item.id, ok: true, recordId: confirmed.value.record.id }
        : { id: item.id, ok: false, reason: confirmed.reason },
    );
  }
  return { ok: true, value: outcomes };
}

// ── Skipping ────────────────────────────────────────────────────────────────

/**
 * Skips items. No record is made, and the other items are not touched. The
 * shared file stays while the group still waits on any item or a record uses
 * it; skipping the last waiting item of a group that made no record removes it
 * (FR-020, US4 scenarios 8 and 9).
 */
export function skipGroupItems(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
  options: ServiceOptions,
): Refusable<ItemOutcome[]> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  const items = selectedItems(db, jobId, selection);
  const waiting = items
    .filter((item) => item.state === ImportState.PendingReview)
    .map((item) => item.id);

  const { skipped, finished } = db.transaction(() => {
    const changed =
      waiting.length === 0
        ? []
        : db
            .update(importItems)
            .set({ state: ImportState.Skipped, updatedAt: now() })
            .where(
              and(
                eq(importItems.jobId, jobId),
                inArray(importItems.id, waiting),
                eq(importItems.state, ImportState.PendingReview),
              ),
            )
            .returning({ id: importItems.id })
            .all()
            .map((row) => row.id);
    const skippedNow = new Set(changed);
    auditImportJob(db, {
      jobId,
      userId: options.actingUserId,
      action: "update",
      changes: items
        .filter((item) => skippedNow.has(item.id))
        .map((item) => ({
          field: itemField(item),
          before: "waiting",
          after: "skipped",
        })),
    });
    return {
      skipped: skippedNow,
      finished: finishGroupIfDone(db, jobId),
    };
  });

  if (finished) releaseGroupFile(db, jobId, options.storageRoot);
  emitItemUpdates(db, jobId, [...skipped], options.actingUserId);
  emitJobUpdate(db, jobId, options.actingUserId);

  const outcomes: ItemOutcome[] = missingIds(selection, items).map((id) => ({
    id,
    ok: false,
    reason: ITEM_GONE,
  }));
  for (const item of items) {
    if (skipped.has(item.id) || item.state === ImportState.Skipped) {
      outcomes.push({ id: item.id, ok: true });
    } else {
      outcomes.push({ id: item.id, ok: false, reason: NOT_WAITING });
    }
  }
  return { ok: true, value: outcomes };
}

/**
 * Removes the group's file once nothing uses it. Called after the write that
 * made the group stop using it, so the group no longer counts.
 */
function releaseGroupFile(db: LedgerDb, jobId: string, root = STORAGE_PATH) {
  const row = db
    .select({ tempFilePath: importQueue.tempFilePath })
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  if (row) releaseIfUnreferenced(db, row.tempFilePath, root);
}

// ── Filling many at once ────────────────────────────────────────────────────

/**
 * Applies a change to every waiting item it fits, in one transaction, then
 * announces the items it changed and the group once. `fit` returns the columns
 * to write for one item, or why it does not fit that item.
 */
function updateEach(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
  options: ServiceOptions,
  fit: (item: ImportItemRow) => Refusable<Partial<ImportItemRow>>,
): Refusable<ItemOutcome[]> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  const items = selectedItems(db, jobId, selection);
  const outcomes: ItemOutcome[] = missingIds(selection, items).map((id) => ({
    id,
    ok: false,
    reason: ITEM_GONE,
  }));
  const changed: string[] = [];
  const audited: FieldChange[] = [];
  db.transaction(() => {
    for (const item of items) {
      if (item.state !== ImportState.PendingReview) {
        outcomes.push({ id: item.id, ok: false, reason: NOT_WAITING });
        continue;
      }
      const fitted = fit(item);
      if (!fitted.ok) {
        outcomes.push({ id: item.id, ok: false, reason: fitted.reason });
        continue;
      }
      const written = db
        .update(importItems)
        .set({ ...fitted.value, updatedAt: now() })
        .where(
          and(
            eq(importItems.id, item.id),
            eq(importItems.state, ImportState.PendingReview),
          ),
        )
        .returning({ id: importItems.id })
        .get();
      if (written) {
        changed.push(item.id);
        audited.push(...itemChangesOf(item, fitted.value));
        outcomes.push({ id: item.id, ok: true });
      } else {
        outcomes.push({ id: item.id, ok: false, reason: NOT_WAITING });
      }
    }
    auditImportJob(db, {
      jobId,
      userId: options.actingUserId,
      action: "update",
      changes: audited,
    });
  });
  emitItemUpdates(db, jobId, changed, options.actingUserId);
  emitJobUpdate(db, jobId, options.actingUserId);
  return { ok: true, value: outcomes };
}

/** Files the selected items under one category (FR-018). */
export function setGroupItemsCategory(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
  categoryAccountId: number,
  options: ServiceOptions,
): Refusable<ItemOutcome[]> {
  const look = lookups(db);
  return updateEach(db, jobId, selection, options, (item) => {
    const kind = kindOf(item);
    if (kind === "transfer") {
      return { ok: false, reason: TRANSFER_HAS_NO_CATEGORY };
    }
    const choice = look
      .choices(kind)
      .find((candidate) => candidate.id === categoryAccountId);
    if (!choice) {
      return {
        ok: false,
        reason:
          kind === "income"
            ? "That category is not one an income can be filed under."
            : "That category is not one an expense can be filed under.",
      };
    }
    const target = getAccount(db, choice.id);
    if (target && isContraRevenueAccount(target) && item.accountId != null) {
      const source = getAccount(db, item.accountId);
      if (!source || !isImportTransactionAsset(source)) {
        return {
          ok: false,
          reason:
            "Choose a clearing, bank or wallet account to fund this revenue deduction.",
        };
      }
    }
    // A category chosen by the reviewer answers the reading's note about it
    // (FR-034). The check note stays: a flag rule or a possible double count
    // is not answered by a category (FR-061, FR-066).
    return {
      ok: true,
      value: {
        categoryAccountId: choice.id,
        category: choice.name,
        reviewNote: null,
      },
    };
  });
}

type AccountFit = (
  item: Pick<ImportItemRow, "documentType" | "counterAccountId"> & {
    categoryAccountId?: number | null;
  },
) => boolean;

/**
 * Whether an account can be the side of an item that paid (an expense) or
 * received (an income): the same lists the receipt card offers. For a
 * transfer it is the account the document is about, and it must hold money
 * and differ from the transfer's other account (FR-058), so the group's one
 * account changes that side of every transfer too.
 */
function accountFits(db: LedgerDb, account: AccountView): AccountFit {
  const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
  const receivable = requireAccountDefault(
    db,
    DefaultAccountPurpose.Receivable,
  );
  const forExpense = isImportPurchaseSource(
    account,
    payable.ok ? payable.value : null,
  );
  const forIncome = isImportIncomeTarget(
    account,
    receivable.ok ? receivable.value : null,
  );
  const forTransfer = isImportTransactionAsset(account);
  return (item) => {
    const kind = kindOf(item);
    if (kind === "transfer") {
      return forTransfer && item.counterAccountId !== account.id;
    }
    const category =
      item.categoryAccountId == null
        ? null
        : getAccount(db, item.categoryAccountId);
    if (kind === "expense" && category && isContraRevenueAccount(category)) {
      return validateImportAccountPair(
        account,
        category,
        payable.ok ? payable.value : null,
        receivable.ok ? receivable.value : null,
      ).ok;
    }
    return kind === "income" ? forIncome : forExpense;
  };
}

function accountMisfit(item: Pick<ImportItemRow, "documentType">): string {
  const kind = kindOf(item);
  if (kind === "transfer") {
    return "That account cannot be this transfer's side: it must hold money and differ from the transfer's other account.";
  }
  return kind === "income"
    ? "That account cannot receive an income."
    : "That account cannot pay for an expense.";
}

/** Sets the account that paid (or received) on the selected items (FR-018). */
export function setGroupItemsAccount(
  db: LedgerDb,
  jobId: string,
  selection: ItemSelection,
  accountId: number,
  options: ServiceOptions,
): Refusable<ItemOutcome[]> {
  const account = getAccount(db, accountId);
  if (!account) {
    return { ok: false, reason: "Choose an account that is still available." };
  }
  const fits = accountFits(db, account);
  return updateEach(db, jobId, selection, options, (item) =>
    fits(item)
      ? { ok: true, value: { accountId: account.id } }
      : { ok: false, reason: accountMisfit(item) },
  );
}

/**
 * Chooses one Source account for the whole group: the account that paid for
 * its expenses, or received its income (FR-018, US4 scenario 4).
 *
 * The choice is kept on the group and written into each waiting item's own
 * account, so changing one item afterwards changes only that item. An item the
 * account cannot serve (for example Accounts Payable on an income) keeps its
 * own, and is reported. Null forgets the group's choice and leaves the items
 * as they are.
 */
export function setGroupSourceAccount(
  db: LedgerDb,
  jobId: string,
  accountId: number | null,
  options: ServiceOptions,
): Refusable<ItemOutcome[]> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  if (accountId === null) {
    db.transaction(() => {
      db.update(importQueue)
        .set({ groupAccountId: null })
        .where(eq(importQueue.id, jobId))
        .run();
      auditImportJob(db, {
        jobId,
        userId: options.actingUserId,
        action: "update",
        changes: [
          {
            field: "groupAccountId",
            before: group.groupAccountId ?? null,
            after: null,
          },
        ],
      });
    });
    emitJobUpdate(db, jobId, options.actingUserId);
    return { ok: true, value: [] };
  }
  const account = getAccount(db, accountId);
  if (!account) {
    return { ok: false, reason: "Choose an account that is still available." };
  }
  const fits = accountFits(db, account);
  const waiting = selectedItems(db, jobId, "all");
  if (waiting.length > 0 && !waiting.some(fits)) {
    return {
      ok: false,
      reason: "That account cannot pay or receive any item of this document.",
    };
  }

  // The group's choice and every item it fills commit together, so a
  // refreshed page never shows the group's account on some items only.
  let outcomes: ItemOutcome[] = [];
  const changed: string[] = [];
  db.transaction(() => {
    db.update(importQueue)
      .set({ groupAccountId: account.id })
      .where(eq(importQueue.id, jobId))
      .run();
    outcomes = waiting.map((item) => {
      if (!fits(item)) {
        return { id: item.id, ok: false, reason: accountMisfit(item) };
      }
      db.update(importItems)
        .set({ accountId: account.id, updatedAt: now() })
        .where(eq(importItems.id, item.id))
        .run();
      changed.push(item.id);
      return { id: item.id, ok: true };
    });
    auditImportJob(db, {
      jobId,
      userId: options.actingUserId,
      action: "update",
      changes: [
        {
          field: "groupAccountId",
          before: group.groupAccountId ?? null,
          after: account.id,
        },
        ...waiting
          .filter((item) => changed.includes(item.id))
          .flatMap((item) => itemChangesOf(item, { accountId: account.id })),
      ],
    });
  });
  emitItemUpdates(db, jobId, changed, options.actingUserId);
  emitJobUpdate(db, jobId, options.actingUserId);
  return { ok: true, value: outcomes };
}

// ── Editing one item ────────────────────────────────────────────────────────

/**
 * Saves a reviewer's corrections to one waiting item. The fields are the ones
 * a receipt card edits, and they mean the same; see `reviewOverridesSchema`.
 * Unlike a receipt, whose edits live in the browser until confirm, an item's
 * are kept on the server, so a group of hundreds can be worked through over
 * several visits and from several tabs.
 */
export function updateGroupItem(
  db: LedgerDb,
  jobId: string,
  itemId: string,
  overrides: ReviewOverrides,
  options: ServiceOptions,
): Refusable<ImportItemEvent> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, reason: NOT_A_GROUP };
  }
  const item = loadItem(db, jobId, itemId);
  if (!item) return { ok: false, reason: ITEM_GONE };
  if (item.state !== ImportState.PendingReview) {
    return { ok: false, reason: NOT_WAITING };
  }

  const changes = itemChanges(db, item, overrides);
  if (!changes.ok) return changes;

  const written = db.transaction(() => {
    const row = db
      .update(importItems)
      .set({ ...changes.value, updatedAt: now() })
      .where(
        and(
          eq(importItems.id, itemId),
          eq(importItems.state, ImportState.PendingReview),
        ),
      )
      .returning()
      .get();
    if (row)
      auditImportJob(db, {
        jobId,
        userId: options.actingUserId,
        action: "update",
        changes: itemChangesOf(item, changes.value),
      });
    return row;
  });
  if (!written) return { ok: false, reason: NOT_WAITING };

  emitItemUpdates(db, jobId, [itemId], options.actingUserId);
  emitJobUpdate(db, jobId, options.actingUserId);
  return { ok: true, value: itemEvent(written, mainCurrencyCode(db)) };
}

/** Whether a document type turns an item from an expense to an income, or back. */
function isFlip(
  item: Pick<ImportItemRow, "documentType">,
  documentType: number | null,
): boolean {
  return kindOf(item) !== kindOf({ documentType });
}

/** The columns a set of corrections writes on an item. Only reads. */
function itemChanges(
  db: LedgerDb,
  item: ImportItemRow,
  overrides: ReviewOverrides,
): Refusable<Partial<ImportItemRow>> {
  const out: Partial<ImportItemRow> = {};

  const docCode = documentTypeOf(overrides, item.documentType);
  if (
    docCode !== DocumentType.Expense &&
    docCode !== DocumentType.Income &&
    !isTransferType(docCode)
  ) {
    return {
      ok: false,
      reason: "Say whether this is an expense or an income.",
    };
  }
  const kindRefusal = kindChangeRefusal(item.documentType, docCode);
  if (kindRefusal) return { ok: false, reason: kindRefusal };
  if (overrides.document_type !== undefined) out.documentType = docCode;
  const transfer = isTransferType(docCode);
  if (
    transfer &&
    (overrides.category !== undefined ||
      overrides.supplier !== undefined ||
      overrides.contactId !== undefined ||
      overrides.newContactName !== undefined)
  ) {
    return {
      ok: false,
      reason:
        "A transfer has no other party and no category: it moves money between two of your own accounts.",
    };
  }
  if (!transfer && overrides.counterAccountId != null) {
    return { ok: false, reason: "Only a transfer has another account." };
  }

  if (overrides.item_name !== undefined) out.itemName = overrides.item_name;
  if (overrides.date !== undefined) {
    out.date = normalizeDate(overrides.date, item.date ?? undefined);
  }
  if (overrides.amount !== undefined) out.amount = overrides.amount;
  if (overrides.reference !== undefined) out.reference = overrides.reference;
  if (overrides.remark !== undefined) out.remark = overrides.remark;

  // The other party. A name typed by hand replaces whatever was matched, so a
  // stale match cannot win at confirm; a contact picked from the list is the
  // match itself.
  if (overrides.supplier !== undefined) {
    out.supplier = overrides.supplier;
    out.matchedContactId = null;
  }
  if (overrides.newContactName !== undefined) {
    out.supplier = overrides.newContactName;
    out.matchedContactId = null;
  }
  if (overrides.contactId !== undefined) {
    const contact = db
      .select({ id: contacts.id, legalName: contacts.legalName })
      .from(contacts)
      .where(eq(contacts.id, overrides.contactId))
      .get();
    if (!contact) {
      return { ok: false, reason: "Choose a contact that is still available." };
    }
    out.matchedContactId = contact.id;
    out.supplier = contact.legalName;
  }

  // Currency and rate. A new currency with no rate given drops the old rate:
  // it was for the other currency, and the item then asks for one.
  const main = mainCurrencyCode(db);
  if (overrides.currency !== undefined) {
    const currency = overrides.currency.toUpperCase();
    out.currency = currency;
    if (currency !== (item.currency ?? main).toUpperCase()) {
      out.exchangeRate = currency === main ? 1 : null;
    }
  }
  if (overrides.exchangeRate !== undefined) {
    const rate = Number(overrides.exchangeRate);
    out.exchangeRate = Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  if (transfer) return transferChanges(db, item, overrides, docCode, out);

  const kind = docCode === DocumentType.Income ? "income" : "expense";
  if (overrides.category !== undefined) {
    out.category = overrides.category;
    out.categoryAccountId = matchCategoryAccount(
      categoryChoices(db, kind),
      overrides.category,
    );
    // The reviewer has chosen the category, which answers the reading's
    // note about it (FR-034), and only that one: see `checkNote`.
    out.reviewNote = null;
  }

  // Both accounts, as the receipt card picks them: they settle the kind too.
  if (
    (overrides.fromAccountId === undefined) !==
    (overrides.toAccountId === undefined)
  ) {
    return {
      ok: false,
      reason: "Choose both the source and target account.",
    };
  }
  if (
    overrides.fromAccountId !== undefined &&
    overrides.toAccountId !== undefined
  ) {
    const from = getAccount(db, overrides.fromAccountId);
    const to = getAccount(db, overrides.toAccountId);
    if (!from || !to) {
      return { ok: false, reason: "Choose accounts that are still available." };
    }
    const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
    const receivable = requireAccountDefault(
      db,
      DefaultAccountPurpose.Receivable,
    );
    const pair = validateImportAccountPair(
      from,
      to,
      payable.ok ? payable.value : null,
      receivable.ok ? receivable.value : null,
    );
    if (!pair.ok) return pair;
    const category = pair.kind === "income" ? from : to;
    out.documentType =
      pair.kind === "income" ? DocumentType.Income : DocumentType.Expense;
    out.accountId = pair.kind === "income" ? to.id : from.id;
    out.categoryAccountId = category.id;
    out.category = category.name;
    // Both accounts are sent whenever either side changes, so only a new
    // category answers the reading's note; a new paying account does not.
    if (category.id !== item.categoryAccountId) out.reviewNote = null;
    // The matched contact was found for the kind as read; see below.
    if (isFlip(item, out.documentType) && overrides.contactId === undefined) {
      out.matchedContactId = null;
    }
    return { ok: true, value: out };
  }

  // One account, without the category. It must be one this kind can be paid
  // from (or received into), as the receipt card offers.
  const finalDoc = out.documentType ?? item.documentType;
  const flipped = isFlip(item, finalDoc);
  // An expense or an income here: a transfer returned above.
  const entryKind = {
    documentType: finalDoc,
    counterAccountId: null,
    categoryAccountId:
      out.categoryAccountId ?? (flipped ? null : item.categoryAccountId),
  };
  if (overrides.accountId != null) {
    const account = getAccount(db, overrides.accountId);
    if (!account) {
      return {
        ok: false,
        reason: "Choose an account that is still available.",
      };
    }
    if (!accountFits(db, account)(entryKind)) {
      return { ok: false, reason: accountMisfit(entryKind) };
    }
    out.accountId = account.id;
  } else if (overrides.accountId === null) {
    out.accountId = null;
  } else if (flipped && item.accountId != null) {
    // The account was chosen for the other kind. Keep it only if it still fits
    // (a bank account pays and receives); otherwise the item asks for one.
    const account = getAccount(db, item.accountId);
    if (!account || !accountFits(db, account)(entryKind)) {
      out.accountId = null;
    }
  }

  // An item that changed kind is read again as that kind, as a receipt is:
  // its category and its matched contact were found for the other kind, so
  // neither may carry over unless this same edit names them (FR-007).
  if (flipped) {
    if (overrides.category === undefined) out.categoryAccountId = null;
    if (overrides.contactId === undefined) out.matchedContactId = null;
  }

  return { ok: true, value: out };
}

/**
 * The accounts a set of corrections writes on a transfer item (FR-058), on
 * top of the plain fields `itemChanges` has already put in `out`. A transfer
 * has no other party and no category, which `itemChanges` refuses. Its two
 * accounts may change, both at once as the review card sends them, or one at
 * a time: the account the document is about (`accountId`) or the other one
 * (`counterAccountId`). Either way both must hold money and differ. An edit
 * that names no account checks none, so an account archived since the
 * reading does not stop a change to the description.
 */
function transferChanges(
  db: LedgerDb,
  item: ImportItemRow,
  overrides: ReviewOverrides,
  docCode: number,
  out: Partial<ImportItemRow>,
): Refusable<Partial<ImportItemRow>> {
  if (
    (overrides.fromAccountId === undefined) !==
    (overrides.toAccountId === undefined)
  ) {
    return { ok: false, reason: "Choose both accounts of the transfer." };
  }

  const namesAccount =
    overrides.fromAccountId !== undefined ||
    overrides.accountId !== undefined ||
    overrides.counterAccountId !== undefined;
  if (!namesAccount) return { ok: true, value: out };

  let accountId = item.accountId;
  let counterAccountId = item.counterAccountId;
  if (
    overrides.fromAccountId !== undefined &&
    overrides.toAccountId !== undefined
  ) {
    ({ accountId, counterAccountId } = transferAccountsOf(docCode, {
      fromAccountId: overrides.fromAccountId,
      toAccountId: overrides.toAccountId,
    }));
  } else {
    if (overrides.accountId !== undefined) accountId = overrides.accountId;
    if (overrides.counterAccountId !== undefined) {
      counterAccountId = overrides.counterAccountId;
    }
  }

  // Each side named in this edit is checked; a side left empty is allowed,
  // and the item then asks for it (`itemAttention`).
  if (accountId != null && counterAccountId != null) {
    const from = getAccount(db, accountId);
    const to = getAccount(db, counterAccountId);
    if (!from || !to) {
      return { ok: false, reason: "Choose accounts that are still available." };
    }
    const pair = validateTransferPair(from, to);
    if (!pair.ok) return pair;
  } else {
    for (const id of [accountId, counterAccountId]) {
      if (id == null) continue;
      const account = getAccount(db, id);
      if (!account || !isImportTransactionAsset(account)) {
        return {
          ok: false,
          reason:
            "Both sides of a transfer must be accounts that hold money, such as a bank account, cash, a card or a wallet.",
        };
      }
    }
  }
  if (accountId !== item.accountId) out.accountId = accountId;
  if (counterAccountId !== item.counterAccountId) {
    out.counterAccountId = counterAccountId;
  }
  return { ok: true, value: out };
}

// ── Discarding ──────────────────────────────────────────────────────────────

/**
 * Discards a group (FR-020, US4 scenario 14).
 *
 * Only the items still waiting for review go. Records already made from the
 * group stay, and so do their items, which now link to them from the history;
 * the group is then finished. A group that made no record goes as a whole, as
 * a discarded receipt does. The file is removed only when nothing uses it.
 */
export function discardGroup(
  db: LedgerDb,
  jobId: string,
  options: ServiceOptions,
): Refusable<{ deleted: boolean }> {
  const group = loadGroup(db, jobId);
  if (!group || group.state !== ImportState.Grouped) {
    return { ok: false, reason: NOT_A_GROUP };
  }

  const outcome = db.transaction(() => {
    const imported = db
      .select({ id: importItems.id })
      .from(importItems)
      .where(
        and(
          eq(importItems.jobId, jobId),
          inArray(importItems.state, [
            ImportState.Imported,
            ImportState.Confirmed,
          ]),
        ),
      )
      .limit(1)
      .get();
    if (!imported) {
      // Its items go with it. The foreign key would cascade them too; they
      // are deleted by name so nothing depends on that being switched on.
      db.delete(importItems).where(eq(importItems.jobId, jobId)).run();
      db.delete(importQueue).where(eq(importQueue.id, jobId)).run();
      auditImportJob(db, {
        jobId,
        userId: options.actingUserId,
        action: "delete",
        changes: [
          { field: "originalFilename", before: group.originalFilename, after: null },
        ],
        label: group.originalFilename,
      });
      return { deleted: true, removed: [] as string[] };
    }
    const removed = db
      .delete(importItems)
      .where(
        and(
          eq(importItems.jobId, jobId),
          eq(importItems.state, ImportState.PendingReview),
        ),
      )
      .returning({ id: importItems.id, position: importItems.position })
      .all();
    finishGroupIfDone(db, jobId);
    // The records already made stay; only the waiting items went.
    auditImportJob(db, {
      jobId,
      userId: options.actingUserId,
      action: "update",
      changes: removed.map((item) => ({
        field: itemField(item),
        before: "waiting",
        after: "discarded",
      })),
    });
    return { deleted: false, removed: removed.map((item) => item.id) };
  });

  // After the write, so the group no longer counts as using the file. A record
  // made from it still does, and keeps it.
  const path = outcome.deleted
    ? group.tempFilePath
    : (loadGroup(db, jobId)?.tempFilePath ?? group.tempFilePath);
  releaseIfUnreferenced(db, path, options.storageRoot);

  if (outcome.deleted) {
    importEvents.emit("job-deleted", { userId: options.actingUserId, jobId });
  } else {
    for (const itemId of outcome.removed) {
      importEvents.emit("item-deleted", {
        userId: options.actingUserId,
        jobId,
        itemId,
      });
    }
    emitJobUpdate(db, jobId, options.actingUserId);
  }
  return { ok: true, value: { deleted: outcome.deleted } };
}
