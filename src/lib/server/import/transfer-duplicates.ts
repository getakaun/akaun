/**
 * Whether a transfer read off a document is already in the books (006
 * FR-060).
 *
 * A withdrawal from a marketplace wallet to the bank is often recorded before
 * the wallet report is imported: in Reconciliation, when the bank statement
 * shows the money arriving (`createRecordFromLines`), or by hand. The receipt
 * duplicate check (`duplicate-detector.ts`) compares a document with expenses
 * and incomes by their wording and other party, and a transfer has neither, so
 * a transfer is compared on what it is instead: the same amount, between the
 * same two accounts, the same way round, within seven days.
 *
 * The way round matters. A transfer out of the wallet to the bank is matched
 * only by an existing transfer from the wallet to the bank, never by one from
 * the bank into the wallet: that is money going back, a different event.
 *
 * One existing transfer flags at most one item of a reading. A report that
 * lists two withdrawals of the same amount a few days apart, of which only one
 * is in the books, must leave the other one ready: it is a real transfer that
 * is not recorded yet. The pairing flags as many items as it can, and within
 * that prefers the nearest date.
 */

import { and, between, eq, sql } from "drizzle-orm";
import { DocumentType, LedgerRecordKind } from "$lib/enums.js";
import { ledgerMovements, ledgerRecords } from "../db/schema.js";
import type { LedgerDb, Minor } from "../ledger/types.js";
import { notVoided } from "../queries/void-state.js";

/** How far apart, in days, a transfer and an item may be dated. */
export const TRANSFER_DUPLICATE_DAYS = 7;

/** One transfer item to look for. */
export type TransferProbe = {
  /** TransferOut or TransferIn: which way it moved from `accountId`. */
  documentType: number;
  /** The account the document is about, such as the wallet. */
  accountId: number;
  /** The other side, such as the bank. */
  counterAccountId: number;
  /** Positive whole cents in the main currency. */
  amountMinor: Minor;
  /** `YYYY-MM-DD`. */
  date: string;
};

/** The existing transfer an item may repeat, as the review fields keep it. */
export type TransferDuplicate = {
  duplicateOf: number;
  confidence: number;
  reasons: string[];
};

const DAY_MS = 86_400_000;

function dayNumber(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / DAY_MS);
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * How sure the match is: certain on the same day, less so the further apart
 * the two are dated. Never below 65, since amount, both accounts and their
 * way round already agree.
 */
function confidenceFor(days: number): number {
  return Math.max(65, 100 - days * 5);
}

/**
 * The existing transfer each probe may repeat, by the probe's index. A probe
 * with none, or whose every candidate is needed by another probe, is left out
 * of the map.
 */
export function detectTransferDuplicates(
  db: LedgerDb,
  probes: readonly TransferProbe[],
): Map<number, TransferDuplicate> {
  type Pair = { probe: number; record: number; days: number };
  const pairs: Pair[] = [];

  probes.forEach((probe, index) => {
    const day = dayNumber(probe.date);
    if (day === null || !(probe.amountMinor > 0)) return;
    if (probe.accountId === probe.counterAccountId) return;
    const out = probe.documentType === DocumentType.TransferOut;
    if (!out && probe.documentType !== DocumentType.TransferIn) return;

    // A movement is positive when value goes into its account (CLAUDE.md, the
    // ledger). Out of the document's account: its side is negative and the
    // other side positive; into it, the other way round.
    const accountSide = out ? -probe.amountMinor : probe.amountMinor;
    const own = sql`exists (select 1 from ${ledgerMovements} where ${ledgerMovements.recordId} = ${ledgerRecords.id} and ${ledgerMovements.accountId} = ${probe.accountId} and ${ledgerMovements.amountMinor} = ${accountSide})`;
    const other = sql`exists (select 1 from ${ledgerMovements} where ${ledgerMovements.recordId} = ${ledgerRecords.id} and ${ledgerMovements.accountId} = ${probe.counterAccountId} and ${ledgerMovements.amountMinor} = ${-accountSide})`;

    const rows = db
      .select({ id: ledgerRecords.id, date: ledgerRecords.date })
      .from(ledgerRecords)
      .where(
        and(
          eq(ledgerRecords.kind, LedgerRecordKind.Transfer),
          // A voided transfer never happened, so it is not a duplicate.
          notVoided(ledgerRecords.id),
          between(
            ledgerRecords.date,
            isoDay(day - TRANSFER_DUPLICATE_DAYS),
            isoDay(day + TRANSFER_DUPLICATE_DAYS),
          ),
          own,
          other,
        ),
      )
      .all();
    for (const row of rows) {
      const recordDay = dayNumber(row.date);
      if (recordDay === null) continue;
      const days = Math.abs(recordDay - day);
      if (days > TRANSFER_DUPLICATE_DAYS) continue;
      pairs.push({ probe: index, record: row.id, days });
    }
  });

  // Every probe that can be flagged must be (FR-060), so this is a maximum
  // matching, not a greedy one: handing a transfer to the first item that
  // wants it can leave a later item with nothing while another transfer it
  // could not reach goes unused by an item that could. Kuhn's augmenting
  // paths, with each probe trying its nearest dates first and the probes
  // taken nearest-first, keep the nearest-date preference wherever it does
  // not cost a flag. Ties go to the earlier item and the older record, so the
  // answer is the same every time.
  const candidates = new Map<number, Pair[]>();
  for (const pair of pairs) {
    const list = candidates.get(pair.probe) ?? [];
    list.push(pair);
    candidates.set(pair.probe, list);
  }
  for (const list of candidates.values()) {
    list.sort((a, b) => a.days - b.days || a.record - b.record);
  }
  const order = [...candidates.keys()].sort(
    (a, b) => candidates.get(a)![0].days - candidates.get(b)![0].days || a - b,
  );

  const holder = new Map<number, Pair>(); // record -> the pair holding it
  const augment = (probe: number, seen: Set<number>): boolean => {
    for (const pair of candidates.get(probe) ?? []) {
      if (seen.has(pair.record)) continue;
      seen.add(pair.record);
      const held = holder.get(pair.record);
      if (!held || augment(held.probe, seen)) {
        holder.set(pair.record, pair);
        return true;
      }
    }
    return false;
  };
  for (const probe of order) augment(probe, new Set());

  const found = new Map<number, TransferDuplicate>();
  for (const pair of holder.values()) {
    found.set(pair.probe, {
      duplicateOf: pair.record,
      confidence: confidenceFor(pair.days),
      reasons:
        pair.days === 0
          ? ["amount", "accounts", "date"]
          : ["amount", "accounts"],
    });
  }
  return found;
}
