import type { Allowed, LockResult, LockState } from "./types.js";

/**
 * What a record stops allowing once money has moved against it.
 *
 * Once a payment has settled a record, or a bank line has been matched to it,
 * its amount, its date and the accounts it touches are fixed — changing any of
 * them would silently make a settlement or a bank match wrong. What the record
 * *says* stays editable, because correcting a description or attaching a
 * missing receipt cannot make any other record wrong (FR-017a).
 *
 * The refusal always names what to undo, so a locked field is never a dead end.
 */

/**
 * Fixed while the record is settled or reconciled.
 *
 * `categoryAccountId` and `extraSides` are deliberately not here: a
 * settlement or a bank match always points at the money side (a
 * receivable/payable or a money-pot movement), never at a category account,
 * so correcting what an already-paid or already-matched record was *for* —
 * whether that is swapping its one category or splitting it into several —
 * cannot make either wrong. `services/ledger.ts`'s `sidesFor` keeps the
 * money-side movement itself untouched (same id, same account, same amount)
 * regardless of how many category lines the patch names.
 */
export const LOCKED_FIELDS = [
  "expensePaymentSource",
  "paidByContactId",
  "amount",
  "currency",
  "exchangeRate",
  "date",
  "paidFromAccountId",
  "receivedIntoAccountId",
  "fromAccountId",
  "toAccountId",
  "accountId",
  "incomeAccountId",
] as const;

/** Editable whatever has happened to the record. */
export const ALWAYS_EDITABLE_FIELDS = [
  "description",
  "contactId",
  "reference",
  "remark",
  "attachments",
] as const;

const LOCKED = new Set<string>(LOCKED_FIELDS);

const SETTLED_REASON =
  "This record is settled by a payment. Reverse the settlement before you change its amount, date or account. Eligible expenses and income can instead use Correct date with the required permission.";
const RECONCILED_REASON =
  "This record is reconciled to a bank statement line. Unmatch it from that line before you change its amount, date or account.";
const BOTH_REASON =
  "This record is settled by a payment and reconciled to a bank statement line. Reverse the settlement and unmatch the bank statement line before you change its amount, date or account.";

function reasonFor(state: LockState): string | null {
  if (state.settled && state.reconciled) return BOTH_REASON;
  if (state.settled) return SETTLED_REASON;
  if (state.reconciled) return RECONCILED_REASON;
  return null;
}

export function lockStateOf(state: LockState): LockResult {
  const locked = state.settled || state.reconciled;
  return {
    locked,
    lockedFields: locked ? LOCKED_FIELDS : [],
    reason: reasonFor(state),
  };
}

export function canEditField(field: string, state: LockState): boolean {
  if (!state.settled && !state.reconciled) return true;
  return !LOCKED.has(field);
}

/**
 * Deleting is refused outright while locked — there is no partial version of
 * removing a record a settlement or a bank match still points at.
 */
export function canDeleteRecord(state: LockState): Allowed {
  if (!state.settled && !state.reconciled) return { ok: true };
  if (state.settled && state.reconciled) {
    return {
      ok: false,
      reason:
        "This record is settled by a payment and reconciled to a bank statement line. Reverse the settlement and unmatch the bank statement line before you delete it.",
    };
  }
  if (state.settled) {
    return {
      ok: false,
      reason:
        "This record is settled by a payment. Reverse the settlement before you delete it.",
    };
  }
  return {
    ok: false,
    reason:
      "This record is reconciled to a bank statement line. Unmatch it from that line before you delete it.",
  };
}
