import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  ledgerMovements,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  settlements,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { activeAllocation } from "./allocation-state.js";
import { getRecord } from "./ledger.js";
import { getSide } from "./settlements.js";

/**
 * The rules for a legacy *group* reimbursement, in one place.
 *
 * A group moves each expense's payable from its supplier to one recipient
 * through generated entries: a supplier entry per supplier settles the
 * expenses, and a recipient entry is what the recipient is owed, settled by
 * the payment. Correct allocation shows that payment's group as its own
 * per-expense allocations, keyed by the real supplier-entry → expense
 * settlement, so one expense can be taken out like any direct allocation.
 *
 * That is only well defined when ONE payment funds the whole group: then the
 * released amount belongs to that payment. Anything else is refused and the
 * whole reimbursement is reversed instead.
 */

type SettlementRow = typeof settlements.$inferSelect;

export const MIXED_FUNDING_REASON =
  "This reimbursement is paid by several payments or is not fully paid, so one expense cannot be taken out of it. Use Reverse entire reimbursement, then reimburse the other expenses again.";
export const RECORDS_DISAGREE_REASON =
  "This reimbursement's entries do not agree with its expenses, so one expense cannot be taken out safely. Use Reverse entire reimbursement instead.";
export const NO_PAYEE_REASON =
  "The payment funding this reimbursement names no payee. Correct its recipient first, then remove the expense.";
export const RECIPIENT_MISMATCH_REASON =
  "The payment funding this reimbursement is to a different person than the reimbursement. Correct the payment's recipient first.";

export type GroupItemState = {
  itemId: number;
  /** The expense record. */
  recordId: number;
  sourceMovementId: number;
  amountMinor: number;
  /** The one active supplier-entry → expense allocation, when it agrees. */
  settlement: SettlementRow | null;
  supplierRecordId: number | null;
};

export type GroupFunding = {
  settlement: SettlementRow;
  paymentMovementId: number;
  paymentRecordId: number;
};

export type GroupState = {
  group: typeof reimbursements.$inferSelect;
  /** Every entry of the group, by record id. */
  entryRoles: Map<number, string>;
  recipient: {
    recordId: number;
    owedMovementId: number;
    contactId: number | null;
    date: string;
  } | null;
  /** Active (not removed) items only. */
  items: GroupItemState[];
  funding: GroupFunding | null;
  /** Why one expense cannot be taken out; null when it can. */
  refusal: string | null;
};

/** One allocation row per expense, in the shape of a settlement row. */
export type GroupAllocation = SettlementRow & {
  groupAllocation: true;
  reimbursementGroupId: number;
  expenseRecordId: number;
  itemSettlementIds: number[];
  fundingSettlementId: number;
};

function entryMovementRecords(db: LedgerDb, recordIds: number[]) {
  return new Map(
    (recordIds.length
      ? db
          .select({
            id: ledgerMovements.id,
            recordId: ledgerMovements.recordId,
          })
          .from(ledgerMovements)
          .where(inArray(ledgerMovements.recordId, recordIds))
          .all()
      : []
    ).map((m) => [m.id, m.recordId]),
  );
}

export function inspectGroup(db: LedgerDb, groupId: number): GroupState | null {
  const group = db
    .select()
    .from(reimbursements)
    .where(eq(reimbursements.id, groupId))
    .get();
  if (!group) return null;
  const entries = db
    .select()
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.groupId, groupId))
    .all();
  const entryRoles = new Map<number, string>(
    entries.map((e) => [e.recordId, e.role]),
  );
  const movementRecord = entryMovementRecords(
    db,
    entries.map((e) => e.recordId),
  );
  const recipientEntry = entries.find((e) => e.role === "recipient");
  const recipientRecord = recipientEntry
    ? getRecord(db, recipientEntry.recordId)
    : null;
  // The recipient leg posts clearing in, payable out: its payable side is the
  // negative one, whatever the payable default is today.
  const recipientOwed = recipientRecord?.movements.find(
    (m) => m.amountMinor < 0,
  );
  const recipient =
    recipientRecord && recipientOwed
      ? {
          recordId: recipientRecord.id,
          owedMovementId: recipientOwed.id,
          contactId: recipientRecord.contactId,
          date: recipientRecord.date,
        }
      : null;

  const rows = db
    .select({ item: reimbursementItems, recordId: ledgerMovements.recordId })
    .from(reimbursementItems)
    .innerJoin(
      ledgerMovements,
      eq(ledgerMovements.id, reimbursementItems.sourceMovementId),
    )
    .where(
      and(
        eq(reimbursementItems.groupId, groupId),
        isNull(reimbursementItems.removedAt),
      ),
    )
    .orderBy(asc(reimbursementItems.id))
    .all();
  const sourceIds = rows.map((r) => r.item.sourceMovementId);
  const itemSettlements = sourceIds.length
    ? db
        .select()
        .from(settlements)
        .where(
          and(
            activeAllocation(),
            inArray(settlements.owedMovementId, sourceIds),
          ),
        )
        .all()
    : [];
  const items: GroupItemState[] = rows.map(({ item, recordId }) => {
    const matches = itemSettlements.filter(
      (s) =>
        s.owedMovementId === item.sourceMovementId &&
        entryRoles.get(movementRecord.get(s.paymentMovementId) ?? -1) ===
          "supplier",
    );
    const settlement = matches.length === 1 ? matches[0] : null;
    return {
      itemId: item.id,
      recordId,
      sourceMovementId: item.sourceMovementId,
      amountMinor: item.amountMinor,
      settlement,
      supplierRecordId: settlement
        ? (movementRecord.get(settlement.paymentMovementId) ?? null)
        : null,
    };
  });

  const state: GroupState = {
    group,
    entryRoles,
    recipient,
    items,
    funding: null,
    refusal: null,
  };
  if (group.reversedAt) {
    state.refusal = "This reimbursement has already been reversed.";
    return state;
  }
  if (
    !recipient ||
    !items.length ||
    items.some(
      (i) => !i.settlement || i.settlement.amountMinor !== i.amountMinor,
    )
  ) {
    state.refusal = RECORDS_DISAGREE_REASON;
    return state;
  }
  // Funding is what actually settles the recipient entry from outside the
  // group — never `payment_record_id`, which is null for credit-only groups.
  const external = db
    .select()
    .from(settlements)
    .where(
      and(
        activeAllocation(),
        eq(settlements.owedMovementId, recipient.owedMovementId),
      ),
    )
    .all()
    .filter((s) => !movementRecord.has(s.paymentMovementId));
  const totalMinor = items.reduce((sum, i) => sum + i.amountMinor, 0);
  if (external.length !== 1 || external[0].amountMinor !== totalMinor) {
    state.refusal = MIXED_FUNDING_REASON;
    return state;
  }
  const side = getSide(db, external[0].paymentMovementId);
  const paymentMovement = db
    .select({ recordId: ledgerMovements.recordId })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.id, external[0].paymentMovementId))
    .get();
  if (!side || !paymentMovement || side.contactId === null) {
    state.refusal = NO_PAYEE_REASON;
    return state;
  }
  if (side.contactId !== recipient.contactId) {
    state.refusal = RECIPIENT_MISMATCH_REASON;
    return state;
  }
  state.funding = {
    settlement: external[0],
    paymentMovementId: external[0].paymentMovementId,
    paymentRecordId: paymentMovement.recordId,
  };
  return state;
}

/** Whether a settlement only links two generated entries of the same group. */
export function isInternalAllocation(
  db: LedgerDb,
  settlement: Pick<SettlementRow, "paymentMovementId" | "owedMovementId">,
): boolean {
  const rows = db
    .select({ groupId: reimbursementEntries.groupId })
    .from(ledgerMovements)
    .innerJoin(
      reimbursementEntries,
      eq(reimbursementEntries.recordId, ledgerMovements.recordId),
    )
    .where(
      inArray(ledgerMovements.id, [
        settlement.paymentMovementId,
        settlement.owedMovementId,
      ]),
    )
    .all();
  return rows.length === 2 && rows[0].groupId === rows[1].groupId;
}

/** The active group whose recipient entry owns this movement, if any. */
export function activeGroupOfRecipientMovement(
  db: LedgerDb,
  movementId: number,
): number | null {
  const row = db
    .select({
      groupId: reimbursementEntries.groupId,
      role: reimbursementEntries.role,
      reversedAt: reimbursements.reversedAt,
    })
    .from(ledgerMovements)
    .innerJoin(
      reimbursementEntries,
      eq(reimbursementEntries.recordId, ledgerMovements.recordId),
    )
    .innerJoin(
      reimbursements,
      eq(reimbursements.id, reimbursementEntries.groupId),
    )
    .where(eq(ledgerMovements.id, movementId))
    .get();
  return row && row.role === "recipient" && !row.reversedAt
    ? row.groupId
    : null;
}

/** Groups this payment movement funds on its own, in full. */
export function groupsFundedBy(
  db: LedgerDb,
  paymentMovementId: number,
): GroupState[] {
  const groupIds = db
    .select({ owedMovementId: settlements.owedMovementId })
    .from(settlements)
    .where(
      and(
        activeAllocation(),
        eq(settlements.paymentMovementId, paymentMovementId),
      ),
    )
    .all()
    .map((s) => activeGroupOfRecipientMovement(db, s.owedMovementId))
    .filter((id): id is number => id !== null);
  return [...new Set(groupIds)]
    .map((id) => inspectGroup(db, id))
    .filter(
      (state): state is GroupState =>
        state?.funding?.paymentMovementId === paymentMovementId,
    );
}

/** A fully, singly funded group's expenses as the funding payment's rows. */
export function groupAllocations(state: GroupState): GroupAllocation[] {
  const funding = state.funding;
  if (!funding) return [];
  const byRecord = new Map<number, GroupItemState[]>();
  for (const item of state.items) {
    byRecord.set(item.recordId, [...(byRecord.get(item.recordId) ?? []), item]);
  }
  return [...byRecord].map(([recordId, items]) => ({
    ...items[0].settlement!,
    paymentMovementId: funding.paymentMovementId,
    owedMovementId: items[0].sourceMovementId,
    amountMinor: items.reduce((sum, i) => sum + i.amountMinor, 0),
    groupAllocation: true as const,
    reimbursementGroupId: state.group.id,
    expenseRecordId: recordId,
    itemSettlementIds: items.map((i) => i.settlement!.id),
    fundingSettlementId: funding.settlement.id,
  }));
}

export function groupAllocationsForPayment(
  db: LedgerDb,
  paymentMovementId: number,
): GroupAllocation[] {
  return groupsFundedBy(db, paymentMovementId).flatMap(groupAllocations);
}

/**
 * The movement a correction works on. A supplier entry's movement stands for
 * the payment funding its group, so `undo_settlement` on an expense's group
 * allocation lands on the payment the user actually made.
 */
export function correctionMovementFor(
  db: LedgerDb,
  movementId: number,
): { ok: true; movementId: number } | { ok: false; reason: string } {
  const row = db
    .select({
      groupId: reimbursementEntries.groupId,
      role: reimbursementEntries.role,
    })
    .from(ledgerMovements)
    .innerJoin(
      reimbursementEntries,
      eq(reimbursementEntries.recordId, ledgerMovements.recordId),
    )
    .where(eq(ledgerMovements.id, movementId))
    .get();
  if (!row || row.role !== "supplier") return { ok: true, movementId };
  const state = inspectGroup(db, row.groupId);
  if (!state || state.group.reversedAt) return { ok: true, movementId };
  return state.funding
    ? { ok: true, movementId: state.funding.paymentMovementId }
    : { ok: false, reason: state.refusal ?? MIXED_FUNDING_REASON };
}
