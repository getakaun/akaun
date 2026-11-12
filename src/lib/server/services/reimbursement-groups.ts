import { eq, inArray } from "drizzle-orm";
import { DefaultAccountPurpose } from "$lib/enums.js";
import {
  originalReimbursementDescription,
  reimbursementEntryDescription,
} from "$lib/reimbursement-labels.js";
import {
  ledgerMovements,
  reimbursementEntries,
  reimbursementItems,
} from "../db/schema.js";
import { closedThrough } from "../closing/policy.js";
import { money } from "../ledger/settlement-rules.js";
import type { LedgerDb, RecordView, Refusable } from "../ledger/types.js";
import { getRecord } from "../queries/ledger.js";
import {
  inspectGroup,
  MIXED_FUNDING_REASON,
  RECORDS_DISAGREE_REASON,
  type GroupItemState,
} from "../queries/reimbursement-groups.js";
import { requireAccountDefault } from "./account-defaults.js";
import { createRecord, type DeferredEmits } from "./ledger.js";
import { createSettlements, undoSettlement } from "./settlements.js";

export type GroupRemoval = {
  groupId: number;
  paymentRecordId: number;
  amountMinor: number;
  /** Per removed expense, what this group had reimbursed for it. */
  expenses: { recordId: number; amountMinor: number }[];
  undoneSettlementIds: number[];
  entryRecordIds: number[];
};

const refuse = (reason: string) => ({ ok: false as const, reason });

/** The posting date of a group's entries, or why it is closed. */
export function groupDateRefusal(db: LedgerDb, date: string): string | null {
  const closed = closedThrough(db);
  return closed && date <= closed
    ? `The reimbursement is dated ${date}, inside the closed period (closed through ${closed}). Reopen that month to take an expense out of it.`
    : null;
}

/**
 * Takes some (never all) expenses out of a singly funded group reimbursement,
 * inside the caller's transaction. The caller must roll back on a refusal:
 * earlier steps may already have written.
 *
 * For the removed amount r, posted on the group's own date:
 * 1. each expense's supplier-entry allocation is reversed (history kept);
 * 2. each affected supplier entry is netted by a supplier-removal entry;
 * 3. the funding allocation is reversed and re-made r smaller;
 * 4. the recipient entry is netted by a recipient-removal entry.
 * The payment keeps every movement; r becomes its available credit.
 */
export function removeGroupExpenses(
  db: LedgerDb,
  actingUserId: number,
  input: { groupId: number; expenseRecordIds: number[]; reason: string },
  emits: DeferredEmits,
): Refusable<GroupRemoval> {
  const state = inspectGroup(db, input.groupId);
  if (!state) return refuse("That reimbursement no longer exists.");
  if (!state.funding || !state.recipient || state.refusal)
    return refuse(state.refusal ?? MIXED_FUNDING_REASON);
  const funding = state.funding;
  const recipient = state.recipient;
  const selected = state.items.filter((i) =>
    input.expenseRecordIds.includes(i.recordId),
  );
  if (!selected.length)
    return refuse(
      "That expense is no longer part of this reimbursement. Reload and review it.",
    );
  if (selected.length === state.items.length)
    return refuse(
      "Taking out every expense reverses the whole reimbursement. Use Reverse entire reimbursement.",
    );
  const closed = groupDateRefusal(db, recipient.date);
  if (closed) return refuse(closed);
  const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
  if (!payable.ok) return payable;
  const reason = input.reason.trim();
  const amountMinor = selected.reduce((sum, i) => sum + i.amountMinor, 0);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    return refuse(RECORDS_DISAGREE_REASON);

  const recipientRecord = getRecord(db, recipient.recordId)!;
  const paymentRecord = getRecord(db, funding.paymentRecordId);
  const description =
    paymentRecord?.description ||
    originalReimbursementDescription(recipientRecord.description);
  // The new entries net the old ones, so they must sit on the same accounts.
  const sidesOf = (record: RecordView) => ({
    payableSide: record.movements.find((m) => m.accountId === payable.value),
    clearingSide: record.movements.find((m) => m.accountId !== payable.value),
  });
  const recipientSides = sidesOf(recipientRecord);
  if (
    recipientSides.payableSide?.id !== recipient.owedMovementId ||
    !recipientSides.clearingSide
  )
    return refuse(RECORDS_DISAGREE_REASON);

  const undoneSettlementIds: number[] = [];
  for (const item of selected) {
    const undone = undoSettlement(
      db,
      item.settlement!.id,
      actingUserId,
      emits,
      reason,
      true,
    );
    if (!undone.ok) return undone;
    undoneSettlementIds.push(...undone.value);
  }

  const entryRecordIds: number[] = [];
  const bySupplier = new Map<number, GroupItemState[]>();
  for (const item of selected)
    bySupplier.set(item.supplierRecordId!, [
      ...(bySupplier.get(item.supplierRecordId!) ?? []),
      item,
    ]);
  for (const [supplierRecordId, items] of bySupplier) {
    const supplier = getRecord(db, supplierRecordId)!;
    const { payableSide, clearingSide } = sidesOf(supplier);
    if (!payableSide || payableSide.amountMinor <= 0 || !clearingSide)
      return refuse(RECORDS_DISAGREE_REASON);
    const supplierMinor = items.reduce((sum, i) => sum + i.amountMinor, 0);
    const posted = createRecord(
      db,
      actingUserId,
      {
        kind: "reimbursement-transfer",
        leg: "supplier-reversal",
        clearingAccountId: clearingSide.accountId,
        date: recipient.date,
        description: reimbursementEntryDescription(
          "supplier-removal",
          description,
        ),
        amount: supplierMinor / 100,
        currency: supplier.currency,
        exchangeRate: 1,
        contactId: supplier.contactId,
        reference: supplier.reference,
        remark: reason,
      },
      emits,
    );
    if (!posted.ok) return posted;
    const owed = posted.value.movements.find(
      (m) => m.accountId === payable.value,
    );
    // Verify the actual posting rather than trusting the decimal round trip.
    if (!owed || owed.amountMinor !== -supplierMinor)
      return refuse(RECORDS_DISAGREE_REASON);
    db.insert(reimbursementEntries)
      .values({
        recordId: posted.value.id,
        groupId: state.group.id,
        role: "supplier-removal",
      })
      .run();
    const settled = createSettlements(
      db,
      actingUserId,
      payableSide.id,
      [{ owedMovementId: owed.id, amountMinor: supplierMinor }],
      emits,
    );
    if (!settled.ok) return settled;
    entryRecordIds.push(posted.value.id);
  }

  const remainingMinor = funding.settlement.amountMinor - amountMinor;
  const removedLabels = [...new Set(selected.map((i) => i.recordId))]
    .map((id) => {
      const record = getRecord(db, id);
      return record?.recordNumber ?? `#${id}`;
    })
    .join(", ");
  const reduced = undoSettlement(
    db,
    funding.settlement.id,
    actingUserId,
    emits,
    `Reduced to ${money(remainingMinor)} after removing ${removedLabels}: ${reason}`.slice(
      0,
      2000,
    ),
  );
  if (!reduced.ok) return reduced;

  const posted = createRecord(
    db,
    actingUserId,
    {
      kind: "reimbursement-transfer",
      leg: "recipient-reversal",
      clearingAccountId: recipientSides.clearingSide.accountId,
      date: recipient.date,
      description: reimbursementEntryDescription(
        "recipient-removal",
        description,
      ),
      amount: amountMinor / 100,
      currency: recipientRecord.currency,
      exchangeRate: 1,
      contactId: recipientRecord.contactId,
      reference: recipientRecord.reference,
      remark: reason,
    },
    emits,
  );
  if (!posted.ok) return posted;
  const paying = posted.value.movements.find(
    (m) => m.accountId === payable.value,
  );
  if (!paying || paying.amountMinor !== amountMinor)
    return refuse(RECORDS_DISAGREE_REASON);
  db.insert(reimbursementEntries)
    .values({
      recordId: posted.value.id,
      groupId: state.group.id,
      role: "recipient-removal",
    })
    .run();
  entryRecordIds.push(posted.value.id);
  const netted = createSettlements(
    db,
    actingUserId,
    paying.id,
    [{ owedMovementId: recipient.owedMovementId, amountMinor }],
    emits,
  );
  if (!netted.ok) return netted;
  const refunded = createSettlements(
    db,
    actingUserId,
    funding.paymentMovementId,
    [{ owedMovementId: recipient.owedMovementId, amountMinor: remainingMinor }],
    emits,
  );
  if (!refunded.ok) return refunded;

  db.update(reimbursementItems)
    .set({ removedAt: new Date().toISOString() })
    .where(
      inArray(
        reimbursementItems.id,
        selected.map((i) => i.itemId),
      ),
    )
    .run();

  // The group's clearing must still net to zero on every account.
  const entryIds = db
    .select({ recordId: reimbursementEntries.recordId })
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.groupId, state.group.id))
    .all()
    .map((e) => e.recordId);
  const sums = new Map<number, number>();
  for (const m of db
    .select()
    .from(ledgerMovements)
    .where(inArray(ledgerMovements.recordId, entryIds))
    .all())
    if (m.accountId !== payable.value)
      sums.set(m.accountId, (sums.get(m.accountId) ?? 0) + m.amountMinor);
  if ([...sums.values()].some((total) => total !== 0))
    return refuse("The reimbursement transfers do not balance.");

  const byExpense = new Map<number, number>();
  for (const item of selected)
    byExpense.set(
      item.recordId,
      (byExpense.get(item.recordId) ?? 0) + item.amountMinor,
    );
  return {
    ok: true,
    value: {
      groupId: state.group.id,
      paymentRecordId: funding.paymentRecordId,
      amountMinor,
      expenses: [...byExpense].map(([recordId, minor]) => ({
        recordId,
        amountMinor: minor,
      })),
      undoneSettlementIds,
      entryRecordIds,
    },
  };
}
