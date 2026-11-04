import { inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { ledgerRecords } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";

/**
 * A void is a second record — kind Reversal, `reverses_record_id` set — whose
 * movements negate the original's on the same date. Every balance, report and
 * contact total therefore nets the pair to zero without knowing about voids.
 *
 * Only a screen that lists *individual items* has to hide the pair: a list of
 * records, an open-items list, reconciliation candidates, duplicate checks.
 * Each one asks through this fragment, so "voided" is written once.
 *
 * `recordId` is the column holding a ledger record id in the caller's query.
 */
export function inVoidPair(recordId: SQLiteColumn | SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ledger_records AS void_pair
    WHERE void_pair.reverses_record_id IS NOT NULL
      AND (void_pair.id = ${recordId} OR void_pair.reverses_record_id = ${recordId})
  )`;
}

/** The record is neither voided nor a reversal. */
export function notVoided(recordId: SQLiteColumn | SQL): SQL {
  return sql`NOT ${inVoidPair(recordId)}`;
}

export type VoidLink = {
  /** On a voided record: the reversal that voids it. */
  voidedByRecordId: number | null;
  /** On a reversal: the record it voids. */
  reversesRecordId: number | null;
};

/** The void link, both ways, for a page of records — one query. */
export function voidLinksFor(
  db: LedgerDb,
  recordIds: number[],
): Map<number, VoidLink> {
  const out = new Map<number, VoidLink>();
  if (recordIds.length === 0) return out;
  const rows = db
    .select({
      id: ledgerRecords.id,
      reversesRecordId: ledgerRecords.reversesRecordId,
    })
    .from(ledgerRecords)
    .where(
      or(
        inArray(ledgerRecords.id, recordIds),
        inArray(ledgerRecords.reversesRecordId, recordIds),
      ),
    )
    .all()
    .filter((r) => r.reversesRecordId !== null);
  const wanted = new Set(recordIds);
  for (const row of rows) {
    if (wanted.has(row.id))
      out.set(row.id, {
        voidedByRecordId: null,
        reversesRecordId: row.reversesRecordId,
      });
    if (wanted.has(row.reversesRecordId!))
      out.set(row.reversesRecordId!, {
        voidedByRecordId: row.id,
        reversesRecordId: null,
      });
  }
  return out;
}

/** Every record id that is voided or is a reversal. For in-memory filters. */
export function voidPairIds(db: LedgerDb): Set<number> {
  const out = new Set<number>();
  for (const row of db
    .select({
      id: ledgerRecords.id,
      reversesRecordId: ledgerRecords.reversesRecordId,
    })
    .from(ledgerRecords)
    .where(isNotNull(ledgerRecords.reversesRecordId))
    .all()) {
    out.add(row.id);
    out.add(row.reversesRecordId!);
  }
  return out;
}

export const VOIDED_RECORD_REASON =
  "This record is voided. A voided record and its reversal cannot be changed.";
