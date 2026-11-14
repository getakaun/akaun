import { DefaultAccountPurpose } from "$lib/enums.js";
import {
  balancesByContact,
  getSides,
  listOutstanding,
} from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import type { AppContext } from "./context.js";
import { fail, ok, type AppFailure, type AppResult } from "./result.js";

/**
 * Which way a payment settles, and which control account it clears.
 *
 * One rule for every caller that records a payment without the person picking
 * the direction: the MCP `record_payments` tool, which knows the open items it
 * settles, and a payment made from bank lines (`createRecordFromLines`), which
 * also knows whether the money came in or went out. Both used to work it out
 * on their own, one of them in the MCP layer.
 *
 * The table every answer comes from (`directionOn`):
 *
 * | Control account                     | Money in          | Money out     |
 * |-------------------------------------|-------------------|---------------|
 * | Receivable                          | `we-receive`      | `refund-paid` |
 * | Payable, Reimbursements payable     | `refund-received` | `we-pay`      |
 *
 * Only the direction and the settlement account are chosen here. Every rule
 * about them — the settlement account fits the direction, a refund names one
 * contact and is applied in full, an allocation is that contact's and on that
 * account — is `createRecord`'s, which then builds and checks the record.
 */

export const PAYMENT_DIRECTIONS = [
  "we-receive",
  "we-pay",
  "refund-received",
  "refund-paid",
] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

/**
 * A direction that could not be told.
 *
 * - `paymentDirections`: the money's way is known but where it settles is
 *   not (bank lines); the directions that way allows, for the caller to choose.
 * - `undecided`: the money's way is not known and the items settled do not
 *   tell it — `settles-nothing` when there are none, `mixed` when they point
 *   different ways.
 */
export type PaymentDirectionFailure = AppFailure & {
  paymentDirections?: PaymentDirection[];
  undecided?: "settles-nothing" | "mixed";
};

export type PaymentDirectionInput = {
  /** Who was paid, or who paid. */
  contactId: number;
  /**
   * Whether the money came in (true) or went out (false), when that is known
   * — a bank line says so. Absent: read from the items settled, each of which
   * a payment can only settle one way.
   */
  moneyIn?: boolean;
  /** The caller's own choice. With `moneyIn`, it must be a way that money can go. */
  direction?: PaymentDirection;
  /** The owed sides the payment settles, as `createRecord`'s settlements. */
  allocateTo?: readonly { owedMovementId: number }[];
  /** The control account the caller names. Only checked when `moneyIn` is known. */
  settlementAccountId?: number;
};

export type PaymentDirectionChoice = {
  direction: PaymentDirection;
  /** Set only when it is not the account the direction implies. */
  settlementAccountId?: number;
};

type ControlAccounts = {
  receivable: number | null;
  payable: number | null;
  reimbursements: number | null;
};

const RECEIVABLE_SIDE: readonly PaymentDirection[] = [
  "we-receive",
  "refund-paid",
];
const MONEY_IN: readonly PaymentDirection[] = ["we-receive", "refund-received"];
const MONEY_OUT: readonly PaymentDirection[] = ["we-pay", "refund-paid"];

/** Whether a payment of this direction settles on Receivable (else on a payable account). */
export function settlesReceivable(direction: PaymentDirection): boolean {
  return RECEIVABLE_SIDE.includes(direction);
}

/** The direction a payment moving money this way takes on one control account. */
function directionOn(
  accounts: ControlAccounts,
  accountId: number,
  moneyIn: boolean,
): PaymentDirection | null {
  if (accountId === accounts.receivable)
    return moneyIn ? "we-receive" : "refund-paid";
  if (accountId === accounts.payable || accountId === accounts.reimbursements)
    return moneyIn ? "refund-received" : "we-pay";
  return null;
}

/**
 * Which way a payment settles, and the control account it clears when that is
 * not the one the direction implies.
 *
 * With `moneyIn` known (bank lines):
 * 1. `direction` and `settlementAccountId` when the caller gives them; a
 *    direction the money cannot take, or a settlement account that is not a
 *    control account, is refused;
 * 2. else the account the allocations' open items are on (refused when they
 *    are on more than one);
 * 3. else where the contact's open balance sits: money in from a contact we
 *    overpaid is a refund of that overpayment, and money out to a contact we
 *    owe a reimbursement settles Reimbursements payable;
 * 4. else the default: money in is `we-receive`, money out `we-pay`.
 *
 * A contact whose only open balance is on the other control account, or on
 * two that would each fit, is refused with the choices rather than guessed:
 * a payment on the wrong control account leaves both accounts wrong.
 *
 * Without `moneyIn` (`record_payments`):
 * 1. `direction` when the caller gives it;
 * 2. else each item says it: a side is settled by money moving the way it
 *    points (a positive side, value into the account, by money in). All items
 *    must agree; none, or a disagreement, is refused as `undecided`.
 *
 * The settlement account is named when the payment is on the payable side and
 * its items share Reimbursements payable. Two differences between the callers
 * are kept as they were: without `moneyIn`, items on two payable accounts are
 * one payment with no settlement account named (bank lines refuse them), and
 * items sharing any account but Payable name it (bank lines name only
 * Reimbursements payable). Either way `createRecord` decides the rest.
 *
 * Reads only; asks no permission. The operation that records the payment asks
 * its own.
 */
export function inferPaymentDirection(
  ctx: AppContext,
  input: PaymentDirectionInput,
): AppResult<PaymentDirectionChoice> | PaymentDirectionFailure {
  const { db } = ctx;
  const accounts: ControlAccounts = {
    receivable: accountDefaultId(db, DefaultAccountPurpose.Receivable),
    payable: accountDefaultId(db, DefaultAccountPurpose.Payable),
    reimbursements: accountDefaultId(
      db,
      DefaultAccountPurpose.ReimbursementsPayable,
    ),
  };
  const sides = [
    ...getSides(
      db,
      (input.allocateTo ?? []).map((a) => a.owedMovementId),
    ).values(),
  ];
  const on = new Set(sides.map((side) => side.accountId));

  if (input.moneyIn === undefined) {
    let direction = input.direction;
    if (direction === undefined) {
      const found = new Set(
        sides.map((side) =>
          directionOn(accounts, side.accountId, side.amountMinor > 0),
        ),
      );
      const only = found.size === 1 ? [...found][0] : null;
      if (only === null || only === undefined)
        return {
          ...fail(
            "INVALID_INPUT",
            found.size === 0
              ? "The direction cannot be worked out: this payment settles no record."
              : "The records it settles are owed in different directions.",
          ),
          undecided: found.size === 0 ? "settles-nothing" : "mixed",
        };
      direction = only;
    }
    const shared = on.size === 1 ? [...on][0] : undefined;
    return chosen(
      direction,
      input.settlementAccountId ??
        (!settlesReceivable(direction) &&
        shared !== undefined &&
        shared !== accounts.payable
          ? shared
          : undefined),
    );
  }

  const moneyIn = input.moneyIn;
  const allowed = moneyIn ? MONEY_IN : MONEY_OUT;
  if (input.direction !== undefined && !allowed.includes(input.direction))
    return {
      ...fail(
        "REFUSED",
        `These lines are ${moneyIn ? "money in" : "money out"}, so a payment from them is ${allowed.join(" or ")}, not ${input.direction}.`,
      ),
      paymentDirections: [...allowed],
    };
  if (on.size > 1)
    return fail(
      "REFUSED",
      "The allocations are on more than one control account. Record one payment for each.",
    );
  const named = input.settlementAccountId;
  if (named !== undefined && directionOn(accounts, named, moneyIn) === null)
    return fail(
      "REFUSED",
      "The settlement account must be the saved Receivable, Payable or Reimbursements payable account.",
    );
  let account: number | undefined = named ?? [...on][0];
  let direction =
    input.direction ??
    (account !== undefined ? directionOn(accounts, account, moneyIn) : null);

  if (direction === null) {
    const balance = fromOpenBalance(ctx, input.contactId, moneyIn, accounts);
    if (!balance.ok) return balance;
    direction = balance.value.direction;
    account = balance.value.accountId;
  }

  // The account the direction implies needs no naming; a payable-side
  // direction on Reimbursements payable does.
  return chosen(
    direction,
    named ??
      (account !== undefined &&
      account === accounts.reimbursements &&
      !settlesReceivable(direction)
        ? account
        : undefined),
  );
}

function chosen(
  direction: PaymentDirection,
  settlementAccountId: number | undefined,
): AppResult<PaymentDirectionChoice> {
  return ok({
    direction,
    ...(settlementAccountId !== undefined ? { settlementAccountId } : {}),
  });
}

/** One contact's open items on one control account, as `contactBalances` totals them. */
function openOn(
  ctx: AppContext,
  contactId: number,
  accountId: number | null,
  receiving: boolean,
): { obligationsMinor: number; creditsMinor: number } {
  if (accountId === null) return { obligationsMinor: 0, creditsMinor: 0 };
  const [balance] = balancesByContact(
    listOutstanding(ctx.db, {
      direction: receiving ? "owed-to-us" : "we-owe",
      accountId,
      contactId,
    }).items,
  );
  return {
    obligationsMinor: balance?.obligationsMinor ?? 0,
    creditsMinor: balance?.creditsMinor ?? 0,
  };
}

/** Steps 3 and 4 with `moneyIn`: the direction from where the contact's open balance sits. */
function fromOpenBalance(
  ctx: AppContext,
  contactId: number,
  movesIn: boolean,
  accounts: ControlAccounts,
):
  | AppResult<{ direction: PaymentDirection; accountId?: number }>
  | PaymentDirectionFailure {
  const r = openOn(ctx, contactId, accounts.receivable, true);
  const p = openOn(ctx, contactId, accounts.payable, false);
  const e = openOn(ctx, contactId, accounts.reimbursements, false);
  const open = (b: typeof r) => b.obligationsMinor + b.creditsMinor > 0;
  const ambiguous = (why: string): PaymentDirectionFailure => ({
    ...fail(
      "REFUSED",
      `${why} Say which with the payment's direction (${(movesIn ? MONEY_IN : MONEY_OUT).join(" or ")}), or the settlement account it clears.`,
    ),
    paymentDirections: [...(movesIn ? MONEY_IN : MONEY_OUT)],
  });

  if (movesIn) {
    // Money back from someone we overpaid, on Payable or ReimbursementsPayable.
    const overpaid = [
      ...(p.creditsMinor > 0 && accounts.payable !== null
        ? [accounts.payable]
        : []),
      ...(e.creditsMinor > 0 && accounts.reimbursements !== null
        ? [accounts.reimbursements]
        : []),
    ];
    if (overpaid.length === 1 && !open(r))
      return ok({ direction: "refund-received", accountId: overpaid[0] });
    if (overpaid.length > 0)
      return ambiguous(
        open(r)
          ? "This contact owes us money and was also overpaid, so this money in could be either."
          : "This contact was overpaid on both Payable and Reimbursements payable.",
      );
    if (open(r) || (!open(p) && !open(e)))
      return ok({ direction: "we-receive" });
    return ambiguous(
      "This contact's open balance is money we owe them, not money they owe us, so this money in could be a refund or a payment.",
    );
  }

  // Money out to someone we owe a reimbursement.
  if (e.obligationsMinor > 0) {
    if (open(p))
      return ambiguous(
        "This contact is owed on both Payable and Reimbursements payable.",
      );
    return ok({ direction: "we-pay", accountId: accounts.reimbursements! });
  }
  if (open(p) || (!open(r) && !open(e))) return ok({ direction: "we-pay" });
  return ambiguous(
    open(r)
      ? "This contact's open balance is on Receivable, not on Payable, so this money out could be a refund of their overpayment or a payment to them."
      : "This contact's open balance is on Reimbursements payable and is not money we owe them.",
  );
}
