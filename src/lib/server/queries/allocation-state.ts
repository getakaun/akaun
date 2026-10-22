import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { ledgerMovements, settlements } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";

/** Current settlement calculations must never include reversed relationships. */
export function activeAllocation() {
  return isNull(settlements.reversedAt);
}

export const ALLOCATION_HISTORY_DELETE_REASON =
  "This record has allocation history and cannot be deleted. Its payment and expense links must be preserved.";
export const ALLOCATION_HISTORY_EDIT_REASON =
  "This change would remove a movement referenced by allocation history. Keep the existing payment and expense links.";

export function hasAllocationHistory(
  db: LedgerDb,
  movementIds: number[],
): boolean {
  if (!movementIds.length) return false;
  return !!db
    .select({ id: settlements.id })
    .from(settlements)
    .where(
      and(
        isNotNull(settlements.reversedAt),
        or(
          inArray(settlements.paymentMovementId, movementIds),
          inArray(settlements.owedMovementId, movementIds),
        ),
      ),
    )
    .get();
}

export function allocationHistoryDeletionReason(
  db: LedgerDb,
  recordId: number,
): string | null {
  const ids = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .map((m) => m.id);
  return hasAllocationHistory(db, ids)
    ? ALLOCATION_HISTORY_DELETE_REASON
    : null;
}
