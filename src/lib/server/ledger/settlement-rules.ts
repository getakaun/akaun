import { fromMinor } from "./money.js";
import type {
  Allowed,
  AllocationRequest,
  Minor,
  RecordSettlementState,
  SettlementSide,
} from "./types.js";

/**
 * What is still owed, what a payment may cover, and what undoing one gives back.
 *
 * Nothing about payment state is stored (FR-012). "Paid", "how much is left"
 * and a contact's balance are all worked out from a movement's own amount less
 * the settlements written against it, so two screens can never disagree.
 *
 * A settlement changes no balance — it is only a note saying that this payment
 * covered that item, for this much (D-09).
 */

export function money(minor: Minor): string {
  return Math.abs(fromMinor(minor)).toFixed(2);
}

export function settlementDirectionForAccount(
  accountId: number,
  defaults: { receivableAccountId: number; payableAccountId: number },
): "owed-to-us" | "we-owe" | null {
  if (accountId === defaults.receivableAccountId) return "owed-to-us";
  if (accountId === defaults.payableAccountId) return "we-owe";
  return null;
}

/**
 * How much of one side is still uncovered. A movement's amount is signed, but
 * the question "how much is left" is about size, not direction — money owed to
 * us and money we owe read the same way.
 */
export function outstandingOf(side: SettlementSide): Minor {
  return Math.max(0, Math.abs(side.amountMinor) - side.settledMinor);
}

export function isFullySettled(side: SettlementSide): boolean {
  return outstandingOf(side) === 0;
}

/**
 * Whether a record reads paid, and by how much it does not.
 *
 * A record with no side on a shared owed account was paid straight from an
 * account and is paid the moment it exists (FR-013). Otherwise it is paid once
 * every one of those sides is fully covered (FR-014).
 */
export function recordSettlementState(
  owedSides: SettlementSide[],
): RecordSettlementState {
  const outstandingMinor = owedSides.reduce(
    (sum, side) => sum + outstandingOf(side),
    0,
  );
  return { paid: outstandingMinor === 0, outstandingMinor };
}

/**
 * Whether a payment may be allocated the way it is being asked to be.
 *
 * Refuses rather than silently truncating, and says the figure still available,
 * because a payment quietly reduced to fit is the kind of wrong nobody notices
 * (FR-016).
 */
export function checkAllocations(
  requests: AllocationRequest[],
  owedByMovementId: ReadonlyMap<number, SettlementSide>,
  paymentAmountMinor: Minor,
): Allowed {
  const seen = new Set<number>();
  let allocatedMinor = 0;

  for (const request of requests) {
    if (request.amountMinor <= 0) {
      return {
        ok: false,
        reason: "A payment has to cover more than nothing of an item.",
      };
    }

    if (seen.has(request.owedMovementId)) {
      return {
        ok: false,
        reason:
          "The same item is listed twice on this payment. Put the whole amount on one line.",
      };
    }
    seen.add(request.owedMovementId);

    const owed = owedByMovementId.get(request.owedMovementId);
    if (!owed) {
      return {
        ok: false,
        reason:
          "One of the items this payment covers cannot be found — it may have been deleted. Reload and try again.",
      };
    }

    const available = outstandingOf(owed);
    if (request.amountMinor > available) {
      return {
        ok: false,
        reason:
          available === 0
            ? "That item is already fully paid."
            : `That is more than is still owed on that item — ${money(available)} is still outstanding.`,
      };
    }

    allocatedMinor += request.amountMinor;
  }

  if (allocatedMinor > Math.abs(paymentAmountMinor)) {
    return {
      ok: false,
      reason: `This payment is only ${money(paymentAmountMinor)}, but it is being spread across ${money(allocatedMinor)}.`,
    };
  }

  return { ok: true };
}

/**
 * One side after a settlement against it is undone: it returns to outstanding
 * by exactly what that settlement covered, and never by more (FR-017).
 */
export function afterUndo(
  side: SettlementSide,
  amountMinor: Minor,
): SettlementSide {
  return {
    ...side,
    settledMinor: Math.max(0, side.settledMinor - Math.abs(amountMinor)),
  };
}
