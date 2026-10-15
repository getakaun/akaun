import {
  AccountType,
  LedgerRecordKind,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import { isMoneyPotAccount, isPurchaseAssetAccount } from "./account-type.js";
import { remainderMinor } from "./money.js";
import type { Minor, RecordCreateSides, Refusable } from "./types.js";

/**
 * Two accounts in, one of the seven record shapes out (data-model.md §5).
 *
 * The user is asked two everyday questions — which account the money left, and
 * which it went to — and never which *kind* of record this is. The kind is a
 * consequence of the two accounts, not a separate decision, and asking for it
 * was asking the user to classify their own bookkeeping (D-01, research.md
 * R-02).
 *
 * **This module constructs no movements.** It translates the answer into the
 * shape `entry-builder.ts` already accepts and hands it over; the builder stays
 * the only place a movement is built and the only enforcement point of the
 * zero-sum rule. Two places that construct sides is how the two drift.
 *
 * `invoice-issue` is not producible here: it is created only by the invoice
 * endpoints and is read-only through the records API (FR-013).
 */

/** The little a derivation needs to know about an account. */
export type SidesAccount = {
  id: number;
  type: AccountTypeCode;
  /**
   * Needed because `type` alone cannot tell a bank account from equipment: both
   * are assets, and only one of them holds money. See `isMoneyPotAccount`.
   */
  role: number;
  /** Meaningful only when `type === Asset`. `null` means "needs review". */
  subType: AccountSubTypeCode | null;
  archived: boolean;
};

export type SidesInput = {
  /** The account money left. */
  fromAccountId: number;
  /** The account money went to. */
  toAccountId: number;
  /**
   * The record's own figure in cents.
   *
   * Needed only by the journal shape, which is the one variant of
   * `RecordCreateSides` that *is* a list of sides — every other kind states two
   * accounts and lets the builder fill the pair from the record's amount. Whole
   * cents, never a float (D-02).
   */
  amountMinor: Minor;
  /** Who it is owed to or by, when a side is a shared owed account. */
  contactId?: number | null;
  /** Third and later sides. Their presence alone makes it a journal entry. */
  extraSides?: {
    accountId: number;
    amountMinor: Minor;
    label?: string | null;
  }[];
  /**
   * The named category's own typed amount, on an everyday split
   * (`extraSides` present and the shape ends up filed as Expense/Income).
   * Always a positive magnitude — `levelPrimarySide` applies the sign, the
   * same way an extra side's own direction does. Absent means "whatever the
   * extra sides leave" — see `levelPrimarySide`. Ignored on a real
   * adjustment, which balances by hand like every other side already does.
   */
  categoryAmountMinor?: Minor;
  /**
   * The named category's own name, alongside `categoryAmountMinor`. Absent or
   * null falls back to the record's description, the same as an extra side's
   * own `label`.
   */
  categoryLabel?: string | null;
};

export type SidesContext = {
  accountById: (id: number) => SidesAccount | null;
  /** Whether the caller may write a record between any two accounts (FR-031c). */
  canAdjust: boolean;
  receivableAccountId: number;
  payableAccountId: number;
  openingBalancesAccountId: number;
};

const SAME_ACCOUNT =
  "Money cannot move from an account to itself. Choose two different accounts.";
const NEEDS_CONTACT = "Say who this is owed to or by.";
const NEEDS_ADJUSTMENTS =
  "These two accounts need the Adjustments ability. Ask an administrator for it, or choose an everyday account on each side.";

function isMoneyPot(account: SidesAccount): boolean {
  return isMoneyPotAccount(account);
}

/** What a record is "for": a spending category, an earning category, equipment. */
function isSpendingCategory(account: SidesAccount): boolean {
  return (
    account.type === AccountType.Expense || isPurchaseAssetAccount(account)
  );
}

function isOwedAccount(account: SidesAccount, ctx: SidesContext): boolean {
  return (
    account.id === ctx.receivableAccountId ||
    account.id === ctx.payableAccountId
  );
}

/**
 * Whether an N-sided set is an ordinary purchase or sale rather than an
 * adjustment — and if so, which.
 *
 * One supplier bill can cover fuel and paper. That is three sides, and it used
 * to demand the `adjustments` ability: the one that exists because a record
 * written freely between any two accounts can make the books say anything. An
 * everyday bill is not that, and asking for that ability to record it is asking
 * far too much (FR-031c).
 *
 * The pattern that makes it everyday: **exactly one side holds or owes money,
 * and every other side says what the money was for.** That is what a bill or a
 * receipt looks like. Anything else — two money pots, partner capital, an
 * opening balance — is a rearrangement of the books and keeps its gate.
 *
 * Returns the kind to file it under, or null when it is a real adjustment.
 */
function everydayKindFor(
  sides: SidesAccount[],
  ctx: SidesContext,
): LedgerRecordKindCode | null {
  const holdsMoney = sides.filter(
    (account) => isMoneyPot(account) || isOwedAccount(account, ctx),
  );
  if (holdsMoney.length !== 1) return null;

  const rest = sides.filter((account) => account !== holdsMoney[0]);
  if (rest.length === 0) return null;

  // Every other side must say what the money was for.
  const allSpending = rest.every(isSpendingCategory);
  if (allSpending) return LedgerRecordKind.Expense;

  const allEarning = rest.every(
    (account) => account.type === AccountType.Revenue,
  );
  if (allEarning) return LedgerRecordKind.Income;

  // A mix of spending and earning categories on one record is not one everyday
  // event, whatever else it is.
  return null;
}

/**
 * Whether a record naming these accounts is a real adjustment — the question
 * the gate in `sidesFromAccounts` asks, for a caller that is changing a
 * record's lines without re-answering both of its accounts (a patch that only
 * restates `extraSides`). Unknown accounts answer `true`: refuse rather than
 * guess.
 */
export function needsAdjustments(
  accountIds: number[],
  ctx: SidesContext,
): boolean {
  const named: SidesAccount[] = [];
  for (const id of new Set(accountIds)) {
    const account = ctx.accountById(id);
    if (!account) return true;
    named.push(account);
  }
  return everydayKindFor(named, ctx) === null;
}

export function sidesFromAccounts(
  input: SidesInput,
  ctx: SidesContext,
): Refusable<RecordCreateSides> {
  const { fromAccountId, toAccountId } = input;

  if (fromAccountId === toAccountId) {
    return { ok: false, reason: SAME_ACCOUNT };
  }

  const from = ctx.accountById(fromAccountId);
  const to = ctx.accountById(toAccountId);
  for (const [account, id] of [
    [from, fromAccountId],
    [to, toAccountId],
  ] as const) {
    if (!account) {
      return {
        ok: false,
        reason: `Account ${id} is not one of your accounts.`,
      };
    }
    // A retired category keeps its history but is never offered again (FR-021).
    if (account.archived) {
      return {
        ok: false,
        reason:
          "That account is no longer in use. Choose one that is still open.",
      };
    }
  }

  // Narrowed by the loop above; restated for the type checker.
  if (!from || !to) return { ok: false, reason: SAME_ACCOUNT };

  // A side on a shared owed account is meaningless without saying whose it is
  // (FR-008) — the balance would be owed to nobody.
  const hasContact = input.contactId !== null && input.contactId !== undefined;
  if ((isOwedAccount(from, ctx) || isOwedAccount(to, ctx)) && !hasContact) {
    return { ok: false, reason: NEEDS_CONTACT };
  }

  const sides = derive(from, to, input, ctx);

  // Checked after the derivation, never before: whether a record needs the
  // ability is a fact about the accounts it names, not about what the client
  // sent (FR-031c).
  if (sides.kind === "journal") {
    // Every account the record names, so the everyday test can look at all of
    // them rather than only the two the form asked about.
    const named: SidesAccount[] = [from, to];
    for (const side of input.extraSides ?? []) {
      const account = ctx.accountById(side.accountId);
      if (!account) {
        return {
          ok: false,
          reason: `Account ${side.accountId} is not one of your accounts.`,
        };
      }
      if (account.archived) {
        return {
          ok: false,
          reason:
            "That account is no longer in use. Choose one that is still open.",
        };
      }
      named.push(account);
    }

    // A shared owed side is meaningless without saying whose it is, on an
    // extra side exactly as on a named one (FR-008).
    if (named.some((account) => isOwedAccount(account, ctx)) && !hasContact) {
      return { ok: false, reason: NEEDS_CONTACT };
    }

    const everyday = everydayKindFor(named, ctx);
    if (everyday === null && !ctx.canAdjust) {
      return { ok: false, reason: NEEDS_ADJUSTMENTS };
    }
    if (everyday !== null) {
      const leveled = levelPrimarySide(sides.movements, from, input, ctx);
      if (!leveled.ok) return leveled;
      return {
        ok: true,
        value: { ...sides, movements: leveled.value, storedKind: everyday },
      };
    }
  }

  return { ok: true, value: sides };
}

/**
 * Gives the named category its own share of the bill, once extra sides make
 * this an everyday split rather than a free-form adjustment.
 *
 * `journalOf` gives the named category the record's whole figure and adds
 * every extra side on top, which is right for a real adjustment — the user
 * balances it by hand, the same way the running difference already asks them
 * to. An everyday bill is different: the named category has its own figure
 * too, once there is more than one — `categoryAmountMinor`, when the caller
 * typed it directly, or otherwise whatever the typed extra sides leave of the
 * total (data-model.md invariant 6). Whether the result actually cancels is
 * `entry-builder.ts`'s question either way, exactly as for a real adjustment
 * — this only decides what figure the named category gets, never whether it
 * is a valid one.
 */
function levelPrimarySide(
  movements: { accountId: number; amountMinor: Minor; label?: string | null }[],
  from: SidesAccount,
  input: SidesInput,
  ctx: SidesContext,
): Refusable<
  { accountId: number; amountMinor: Minor; label?: string | null }[]
> {
  let magnitude: number;
  if (input.categoryAmountMinor !== undefined) {
    magnitude = Math.abs(input.categoryAmountMinor);
  } else {
    magnitude = remainderMinor(
      input.amountMinor,
      (input.extraSides ?? []).map((side) => side.amountMinor),
    );
    if (magnitude <= 0) {
      return {
        ok: false,
        reason:
          "The other lines already account for the whole amount, or more of it. Reduce them, or increase the total.",
      };
    }
  }

  // `journalOf` always puts `from` first and `to` second — whichever of the
  // two is not the money side is the one to level.
  const moneyIsFrom = isMoneyPot(from) || isOwedAccount(from, ctx);
  const primaryIndex = moneyIsFrom ? 1 : 0;
  const primarySign = moneyIsFrom ? 1 : -1;
  return {
    ok: true,
    value: movements.map((movement, i) =>
      i === primaryIndex
        ? {
            ...movement,
            amountMinor: primarySign * magnitude,
            label: input.categoryLabel ?? null,
          }
        : movement,
    ),
  };
}

function derive(
  from: SidesAccount,
  to: SidesAccount,
  input: SidesInput,
  ctx: SidesContext,
): RecordCreateSides {
  // A third side is never an everyday record, whatever the first two are.
  const hasExtraSides = (input.extraSides?.length ?? 0) > 0;
  if (hasExtraSides) return journalOf(from, to, input);

  // Starting balances are their own kind whatever they face.
  if (from.id === ctx.openingBalancesAccountId) {
    return { kind: "opening-balance", accountId: to.id };
  }
  if (to.id === ctx.openingBalancesAccountId) {
    return { kind: "opening-balance", accountId: from.id };
  }

  // Receivable is itself an Asset, so its saved identity must be checked
  // before the general Asset-to-Asset transfer rule.
  if (from.id === ctx.receivableAccountId && isMoneyPot(to)) {
    return {
      kind: "payment",
      paidFromAccountId: to.id,
      direction: "we-receive",
    };
  }

  if (isMoneyPot(from)) {
    if (isSpendingCategory(to)) {
      return {
        kind: "expense",
        categoryAccountId: to.id,
        paidFromAccountId: from.id,
      };
    }
    if (isMoneyPot(to)) {
      return { kind: "transfer", fromAccountId: from.id, toAccountId: to.id };
    }
    if (to.id === ctx.payableAccountId) {
      // Money leaving an account to settle what the business owes.
      return {
        kind: "payment",
        paidFromAccountId: from.id,
        direction: "we-pay",
      };
    }
  }

  if (from.type === AccountType.Revenue && isMoneyPot(to)) {
    return {
      kind: "income",
      categoryAccountId: from.id,
      receivedIntoAccountId: to.id,
    };
  }

  if (from.id === ctx.payableAccountId && isSpendingCategory(to)) {
    // Somebody else paid for this. A null paying side is what makes it read as
    // owed to that person rather than as already paid (FR-008, FR-011).
    return {
      kind: "expense",
      categoryAccountId: to.id,
      paidFromAccountId: null,
    };
  }

  return journalOf(from, to, input);
}

/**
 * Anything the everyday shapes do not cover, written as its own two sides.
 *
 * `journal` is the one variant of `RecordCreateSides` that names its sides
 * outright rather than letting the builder derive them, so the record's own
 * figure has to be spent here: value leaves the "from" account and arrives at
 * the "to" account, and any further sides the user added come through as typed.
 *
 * This still constructs no *movements*. `entry-builder.ts` turns these into
 * movement drafts and remains the only place the zero-sum rule is enforced —
 * which is what catches a set of extra sides that does not cancel (FR-009).
 */
function journalOf(
  from: SidesAccount,
  to: SidesAccount,
  input: SidesInput,
): RecordCreateSides {
  return {
    kind: "journal",
    movements: [
      { accountId: from.id, amountMinor: -input.amountMinor },
      { accountId: to.id, amountMinor: input.amountMinor },
      ...(input.extraSides ?? []),
    ],
  };
}
