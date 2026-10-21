import { eq, inArray, or } from "drizzle-orm";
import {
  ledgerMovements,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { getRecord } from "./ledger.js";

/** Presentation links only; balances continue to derive from postings and settlements. */
export function reimbursementsForRecord(db: LedgerDb, recordId: number) {
  const entry = db
    .select()
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.recordId, recordId))
    .get();
  const sides = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .map((m) => m.id);
  const sourceGroups = sides.length
    ? db
        .select()
        .from(reimbursementItems)
        .where(inArray(reimbursementItems.sourceMovementId, sides))
        .all()
        .map((i) => i.groupId)
    : [];
  const ids = [
    ...new Set([...sourceGroups, ...(entry ? [entry.groupId] : [])]),
  ];
  const groups = db
    .select()
    .from(reimbursements)
    .where(
      or(
        eq(reimbursements.paymentRecordId, recordId),
        ...(ids.length ? [inArray(reimbursements.id, ids)] : []),
      ),
    )
    .all();
  return {
    generated: !!entry,
    groups: groups.map((group) => ({
      ...group,
      entries: db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.groupId, group.id))
        .all()
        .map((e) => ({
          ...e,
          contactName: getRecord(db, e.recordId)?.contactName ?? "",
          description: getRecord(db, e.recordId)?.description ?? "",
        })),
      items: db
        .select()
        .from(reimbursementItems)
        .where(eq(reimbursementItems.groupId, group.id))
        .all()
        .map((i) => ({
          ...i,
          recordId: db
            .select()
            .from(ledgerMovements)
            .where(eq(ledgerMovements.id, i.sourceMovementId))
            .get()!.recordId,
        })),
    })),
  };
}
