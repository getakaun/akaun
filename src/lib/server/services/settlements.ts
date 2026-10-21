import { eq } from "drizzle-orm";
import { reimbursementEntries } from "../db/schema.js";
import { recordAudit } from "../audit.js";
import {
  checkAllocations,
  money,
  outstandingOf,
  settlementDirectionForAccount,
} from "../ledger/settlement-rules.js";
import { DefaultAccountPurpose } from "$lib/enums.js";
import { requireAccountDefault } from "./account-defaults.js";
import type {
  AllocationRequest,
  LedgerDb,
  Refusable,
  SettlementSide,
} from "../ledger/types.js";
import {
  deleteSettlement,
  getSettlement,
  settlementIdsForPayment,
  getSide,
  getSides,
  insertSettlements,
  recordIdsForSettlement,
} from "../queries/settlements.js";
import { emitSettlementChanged, type DeferredEmits } from "./ledger.js";

/**
 * Saying that this payment covered those items, and taking it back.
 *
 * A settlement changes no balance — it is a note, and every "paid" figure on
 * every screen is worked out from it (D-09, FR-012). That is why it is audited
 * in its own right (FR-041): settling is the one action that changes what a
 * record reads as without anyone editing the record.
 */

export function createSettlements(
  db: LedgerDb,
  actingUserId: number,
  paymentMovementId: number,
  allocations: AllocationRequest[],
  /** For a caller running this inside its own transaction (see `DeferredEmits`). */
  deferredEmits?: DeferredEmits,
): Refusable<number[]> {
  if (allocations.length === 0) {
    return {
      ok: false,
      reason: "Tick at least one item for this payment to cover.",
    };
  }

  const payment = getSide(db, paymentMovementId);
  if (!payment) {
    return {
      ok: false,
      reason: "That payment no longer exists. Reload and try again.",
    };
  }

  const receivable = requireAccountDefault(
    db,
    DefaultAccountPurpose.Receivable,
  );
  if (!receivable.ok) return receivable;
  const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
  if (!payable.ok) return payable;
  if (
    settlementDirectionForAccount(payment.accountId, {
      receivableAccountId: receivable.value,
      payableAccountId: payable.value,
    }) === null
  ) {
    return {
      ok: false,
      reason:
        "That movement is not on the saved account for money owed to us or money we owe.",
    };
  }

  const owedSides = getSides(
    db,
    allocations.map((a) => a.owedMovementId),
  );

  // Both sides of a settlement must be on the same shared owed account, and
  // must belong to the same person — otherwise one contact's payment would be
  // ticking off another contact's debt, and both balances would be wrong.
  for (const allocation of allocations) {
    const owed = owedSides.get(allocation.owedMovementId);
    if (!owed) {
      return {
        ok: false,
        reason:
          "One of the items this payment covers cannot be found — it may have been deleted. Reload and try again.",
      };
    }
    if (owed.accountId !== payment.accountId) {
      return {
        ok: false,
        reason:
          "A payment can only cover items of the same kind — money we owe, or money owed to us, not both.",
      };
    }
    // A payment naming one contact can only cover that contact's own items.
    // A payment naming none (a batch across several contacts) instead trusts
    // each settlement to carry its own attribution — but every item it covers
    // must still belong to someone; nothing here settles an unowned side.
    if (payment.contactId !== null) {
      if (owed.contactId !== payment.contactId) {
        return {
          ok: false,
          reason:
            "This payment and that item belong to different people. A payment can only cover what the same person is owed.",
        };
      }
    } else if (owed.contactId === null) {
      return {
        ok: false,
        reason:
          "That item belongs to nobody in particular, so this payment cannot say whose debt it clears.",
      };
    }
    // One side has to be the money going out and the other the money coming in;
    // two sides facing the same way would add to the debt rather than clear it.
    if (Math.sign(owed.amountMinor) === Math.sign(payment.amountMinor)) {
      return {
        ok: false,
        reason: "That item is not something this payment can pay off.",
      };
    }
  }

  const sidesForCheck = new Map<number, SettlementSide>(
    [...owedSides].map(([id, side]) => [id, side]),
  );
  const check = checkAllocations(
    allocations,
    sidesForCheck,
    payment.amountMinor,
  );
  if (!check.ok) return check;

  const allocatedMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  // `checkAllocations` weighs these against the payment's whole amount; what
  // earlier settlements already put against it is spoken for. Without this a
  // payment could be spread over more than it is, one call at a time.
  if (allocatedMinor > outstandingOf(payment)) {
    const left = outstandingOf(payment);
    return {
      ok: false,
      reason:
        left === 0
          ? "This payment is already fully put against other items."
          : `Only ${money(left)} of this payment is left to put against anything — the rest already covers other items.`,
    };
  }

  // A payment naming one contact may leave part of itself unallocated — the
  // rest just sits as a payment to that person with nothing (yet) put against
  // it. A payment naming none has nobody left to put a remainder on, so it
  // has to be spent in full.
  if (payment.contactId === null) {
    if (
      allocatedMinor + payment.settledMinor !==
      Math.abs(payment.amountMinor)
    ) {
      return {
        ok: false,
        reason:
          "A payment covering no single contact has to be fully allocated — there is nobody left to put the remainder on.",
      };
    }
  }

  const ids = insertSettlements(
    db,
    actingUserId,
    paymentMovementId,
    allocations,
  );

  const touched = new Set<number>();
  for (const [index, allocation] of allocations.entries()) {
    recordAudit(db, {
      recordType: "settlement",
      recordId: ids[index],
      userId: actingUserId,
      action: "create",
    });
    for (const recordId of recordIdsForSettlement(
      db,
      paymentMovementId,
      allocation.owedMovementId,
    )) {
      touched.add(recordId);
    }
  }

  if (deferredEmits)
    deferredEmits.push(() => emitSettlementChanged(db, [...touched]));
  else emitSettlementChanged(db, [...touched]);
  return { ok: true, value: ids };
}

/**
 * Undoes one allocation. Both sides return to outstanding, and any field the
 * settlement was locking becomes editable again (FR-017).
 *
 * A payment naming no contact (a batch across several) must stay fully
 * allocated — there is nobody to leave a remainder on — so taking back one of
 * its allocations takes back all of them, in one transaction. Returns the ids
 * undone.
 */
export function undoSettlement(
  db: LedgerDb,
  id: number,
  actingUserId: number,
  deferredEmits?: DeferredEmits,
  reason?: string,
  reimbursementReversal = false,
): Refusable<number[]> {
  const existing = getSettlement(db, id);
  if (!existing) {
    return { ok: false, reason: "That settlement has already been undone." };
  }

  const sourceId = recordIdsForSettlement(
    db,
    existing.paymentMovementId,
    existing.paymentMovementId,
  )[0];
  if (
    !reimbursementReversal &&
    db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, sourceId))
      .get()
  )
    return {
      ok: false,
      reason:
        "This allocation is part of a reimbursement transfer and cannot be reversed separately.",
    };
  const payment = getSide(db, existing.paymentMovementId);
  const ids =
    payment && payment.contactId === null
      ? settlementIdsForPayment(db, existing.paymentMovementId)
      : [id];

  const touched = new Set<number>();
  const undone = db.transaction(() => {
    const done: number[] = [];
    for (const settlementId of ids) {
      const row = getSettlement(db, settlementId);
      if (!row) continue;
      for (const recordId of recordIdsForSettlement(
        db,
        row.paymentMovementId,
        row.owedMovementId,
      ))
        touched.add(recordId);
      if (!deleteSettlement(db, settlementId)) continue;
      recordAudit(db, {
        recordType: "settlement",
        recordId: settlementId,
        userId: actingUserId,
        action: "delete",
        changes: [
          { field: "allocation", before: row, after: null },
          ...(reason ? [{ field: "reason", before: null, after: reason }] : []),
        ],
      });
      done.push(settlementId);
    }
    return done;
  });

  if (!undone.includes(id)) {
    return { ok: false, reason: "That settlement has already been undone." };
  }

  if (deferredEmits)
    deferredEmits.push(() => emitSettlementChanged(db, [...touched]));
  else emitSettlementChanged(db, [...touched]);
  return { ok: true, value: undone };
}
