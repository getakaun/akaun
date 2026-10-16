/**
 * Where a group stands: which of its items still wait, which of those would be
 * held back by a confirm-all and why, and when the group as a whole is done.
 *
 * A group is a queue row read as several items (`ImportState.Grouped`). It
 * stays in the review queue while any item waits for review. Once every item
 * is imported or skipped it is finished: Imported when at least one item made a
 * record, Skipped when none did, and it then shows in the history like a
 * receipt (spec edge case "Every item of a group is confirmed or skipped").
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { DocumentType, ImportState, isTransferType } from "$lib/enums.js";
import { mainCurrencyCode } from "../currency/form.js";
import { importItems, importQueue } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { importEvents } from "./events.js";
import { transferCurrencyReason } from "./settle-review.js";
import {
  itemForEvent,
  jobForEvent,
  type ImportGroupCounts,
  type ImportItemEvent,
  type ImportJobEvent,
} from "./job-event.js";

type ImportItemRow = typeof importItems.$inferSelect;
type ImportJobRow = typeof importQueue.$inferSelect;

/** An item's states that still need it reviewed. */
const WAITING: number[] = [ImportState.PendingReview, ImportState.Confirmed];

/**
 * Why a confirm-all would leave this item behind, or null when nothing does
 * (FR-019). Only an item still waiting for review can need attention.
 *
 * - A possible duplicate: the reviewer must look at it and confirm it on its
 *   own, which is the "Import anyway" a receipt card offers.
 * - A foreign currency with no exchange rate: the record cannot be valued.
 * - A transfer in another currency: the books record a transfer at one rate
 *   between the business's own accounts, so it cannot be imported as it is
 *   (FR-059).
 * - No account that paid or received it, or for a transfer either of its two
 *   accounts: the record cannot be built.
 * - A note from the reading. A fee type's tied category that is for the
 *   other kind (FR-034) makes the category it has instead a guess the
 *   reviewer should check, and choosing a category clears that note. A
 *   section's flag rule (FR-061) and money another profile's records may
 *   already hold (FR-066) are what to check before confirming, and no
 *   category choice clears them: the item is confirmed on its own.
 */
export function itemAttention(
  item: Pick<
    ImportItemRow,
    | "state"
    | "duplicateOf"
    | "currency"
    | "exchangeRate"
    | "accountId"
    | "documentType"
    | "reviewNote"
    | "checkNote"
    | "counterAccountId"
  >,
  mainCurrency: string,
): string | null {
  if (item.state !== ImportState.PendingReview) return null;
  if (item.duplicateOf != null) {
    return "It may already be recorded. Open it and choose Import anyway if it is a separate transaction.";
  }
  const currency = (item.currency ?? mainCurrency).toUpperCase();
  if (isTransferType(item.documentType)) {
    if (currency !== mainCurrency) {
      return transferCurrencyReason(currency, mainCurrency);
    }
    if (item.accountId == null || item.counterAccountId == null) {
      return "Choose both accounts of this transfer.";
    }
    return readingNotes(item);
  }
  if (
    currency !== mainCurrency &&
    !(item.exchangeRate != null && item.exchangeRate > 0)
  ) {
    return `It needs an exchange rate for ${currency}.`;
  }
  if (item.accountId == null) {
    return item.documentType === DocumentType.Income
      ? "Say which account received it."
      : "Say which account paid for it.";
  }
  return readingNotes(item);
}

/** What the reading says to check on an item, or null: see above. */
function readingNotes(
  item: Pick<ImportItemRow, "reviewNote" | "checkNote">,
): string | null {
  const notes = [item.checkNote, item.reviewNote].filter(Boolean);
  return notes.length ? notes.join(" ") : null;
}

/** An item as the screens receive it, with its attention worked out. */
export function itemEvent(
  item: ImportItemRow,
  mainCurrency: string,
): ImportItemEvent {
  return itemForEvent(item, itemAttention(item, mainCurrency));
}

const SQL_CHUNK = 500;

/**
 * The item counts of each of these jobs that has items. A job with none (a
 * receipt, or a reading that is not finished) is left out of the map.
 */
export function groupCounts(
  db: LedgerDb,
  jobIds: string[],
): Map<string, ImportGroupCounts> {
  const counts = new Map<string, ImportGroupCounts>();
  if (jobIds.length === 0) return counts;
  const main = mainCurrencyCode(db);
  const entry = (jobId: string) => {
    let found = counts.get(jobId);
    if (!found) {
      found = {
        ready: 0,
        needsAttention: 0,
        confirmed: 0,
        confirmedIncome: 0,
        confirmedTransfer: 0,
        skipped: 0,
      };
      counts.set(jobId, found);
    }
    return found;
  };

  for (let start = 0; start < jobIds.length; start += SQL_CHUNK) {
    const ids = jobIds.slice(start, start + SQL_CHUNK);
    // Finished items only need counting. Waiting items are read one by one,
    // because whether one needs attention is the rule above, written once.
    const byState = db
      .select({
        jobId: importItems.jobId,
        state: importItems.state,
        documentType: importItems.documentType,
        n: sql<number>`count(*)`,
      })
      .from(importItems)
      .where(
        and(
          inArray(importItems.jobId, ids),
          inArray(importItems.state, [
            ImportState.Imported,
            ImportState.Skipped,
            ImportState.Confirmed,
          ]),
        ),
      )
      .groupBy(importItems.jobId, importItems.state, importItems.documentType)
      .all();
    for (const row of byState) {
      const c = entry(row.jobId);
      if (row.state === ImportState.Skipped) c.skipped += row.n;
      else {
        c.confirmed += row.n;
        if (row.documentType === DocumentType.Income) {
          c.confirmedIncome += row.n;
        } else if (isTransferType(row.documentType)) {
          c.confirmedTransfer += row.n;
        }
      }
    }

    const waiting = db
      .select({
        jobId: importItems.jobId,
        state: importItems.state,
        duplicateOf: importItems.duplicateOf,
        currency: importItems.currency,
        exchangeRate: importItems.exchangeRate,
        accountId: importItems.accountId,
        documentType: importItems.documentType,
        reviewNote: importItems.reviewNote,
        checkNote: importItems.checkNote,
        counterAccountId: importItems.counterAccountId,
      })
      .from(importItems)
      .where(
        and(
          inArray(importItems.jobId, ids),
          eq(importItems.state, ImportState.PendingReview),
        ),
      )
      .all();
    for (const item of waiting) {
      const c = entry(item.jobId);
      if (itemAttention(item, main)) c.needsAttention += 1;
      else c.ready += 1;
    }
  }
  return counts;
}

/** Job rows as the screens receive them, each group with its item counts. */
export function jobEvents(
  db: LedgerDb,
  rows: ImportJobRow[],
): ImportJobEvent[] {
  const counts = groupCounts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => jobForEvent(row, counts.get(row.id)));
}

/** Announces a job's current state to every open import screen. */
export function emitJobUpdate(db: LedgerDb, jobId: string, userId: number) {
  const row = db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  if (row) {
    importEvents.emit("job-update", { userId, job: jobEvents(db, [row])[0] });
  }
}

/** Announces each of these items, as they now are, to every open screen. */
export function emitItemUpdates(
  db: LedgerDb,
  jobId: string,
  itemIds: string[],
  userId: number,
) {
  if (itemIds.length === 0) return;
  const main = mainCurrencyCode(db);
  for (let start = 0; start < itemIds.length; start += SQL_CHUNK) {
    const rows = db
      .select()
      .from(importItems)
      .where(inArray(importItems.id, itemIds.slice(start, start + SQL_CHUNK)))
      .all()
      .sort((a, b) => a.position - b.position);
    for (const item of rows) {
      importEvents.emit("item-update", {
        userId,
        jobId,
        item: itemEvent(item, main),
      });
    }
  }
}

/**
 * Marks the group finished when no item waits any more. Run inside the
 * transaction that changed the last waiting item, so a group is never left in
 * the queue with nothing to review. Returns the state it finished in, or null
 * when items still wait (or the row is not a group).
 */
export function finishGroupIfDone(
  db: LedgerDb,
  jobId: string,
): typeof ImportState.Imported | typeof ImportState.Skipped | null {
  const waiting = db
    .select({ id: importItems.id })
    .from(importItems)
    .where(
      and(eq(importItems.jobId, jobId), inArray(importItems.state, WAITING)),
    )
    .limit(1)
    .get();
  if (waiting) return null;
  const imported = db
    .select({ id: importItems.id })
    .from(importItems)
    .where(
      and(
        eq(importItems.jobId, jobId),
        eq(importItems.state, ImportState.Imported),
      ),
    )
    .limit(1)
    .get();
  const state = imported ? ImportState.Imported : ImportState.Skipped;
  const finished = db
    .update(importQueue)
    .set({ state, completedAt: new Date().toISOString() })
    .where(
      and(
        eq(importQueue.id, jobId),
        eq(importQueue.state, ImportState.Grouped),
      ),
    )
    .returning({ id: importQueue.id })
    .get();
  return finished ? state : null;
}
