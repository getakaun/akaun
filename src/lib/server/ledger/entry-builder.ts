import { fromMinor } from "./money.js";
import type {
  BuildContext,
  BuildInput,
  Minor,
  MovementDraft,
  Refusable,
} from "./types.js";

/**
 * The single place a record's sides are constructed.
 *
 * Every screen describes what happened in its own everyday terms — "an expense
 * someone else paid", "a withdrawal from the Shopee wallet" — and one function
 * per kind turns that into the two or more movements that say where the money
 * came from and where it went. Because this is the only writer, the balance
 * rule (FR-002) and the "say who it is owed to" rule (FR-008) have exactly one
 * enforcement point, and `integrity.ts` sweeps for the same invariants after
 * the fact.
 *
 * Nothing here throws. A rule that refuses returns the plain sentence the user
 * is shown, which is what the API sends as a `409`'s `reason`.
 */

/** Cents rendered the way a refusal sentence shows them: 1234 → "12.34". */
function money(minor: Minor): string {
  return Math.abs(fromMinor(minor)).toFixed(2);
}

function refuse(reason: string): Refusable<MovementDraft[]> {
  return { ok: false, reason };
}

function accept(movements: MovementDraft[]): Refusable<MovementDraft[]> {
  return { ok: true, value: movements };
}

/** Builds the ordinary two-sided shape: value into one account, out of another. */
function twoSided(
  intoAccountId: number,
  outOfAccountId: number,
  amountMinor: Minor,
): MovementDraft[] {
  return [
    { accountId: intoAccountId, amountMinor, sortOrder: 0, label: null },
    {
      accountId: outOfAccountId,
      amountMinor: -amountMinor,
      sortOrder: 1,
      label: null,
    },
  ];
}

/**
 * The checks every kind's movements must pass — invariants 1 to 4 of
 * data-model.md, in the order that produces the most useful message first.
 */
function validate(
  movements: MovementDraft[],
  contactId: number | null,
  ctx: BuildContext,
  input: BuildInput,
): Refusable<MovementDraft[]> {
  if (movements.length < 2) {
    return refuse(
      "A journal entry needs at least two lines: one debit and one credit.",
    );
  }

  for (const movement of movements) {
    if (!ctx.accounts.has(movement.accountId)) {
      return refuse(
        "One of the accounts on this record no longer exists. Pick another and try again.",
      );
    }
  }

  if (movements.some((m) => m.amountMinor === 0)) {
    return refuse("A line amount cannot be zero.");
  }

  const difference = movements.reduce((sum, m) => sum + m.amountMinor, 0);
  if (difference !== 0) {
    return refuse(
      `Debits and credits do not balance. Difference: ${money(difference)}.`,
    );
  }

  const touchesSharedOwed = movements.some(
    (m) =>
      m.accountId === ctx.receivableAccountId ||
      m.accountId === ctx.payableAccountId,
  );
  // A payment that ticks off items across several contacts at once (one real
  // bank transfer, several suppliers) names no single contact of its own —
  // each settlement it creates already points at the contact its own bill
  // belongs to, so the attribution is not lost, just not on this record. Every
  // other kind that touches the shared owed account still must name one.
  const isBatchPayment =
    input.kind === "payment" && (input.settlements?.length ?? 0) > 0;
  if (touchesSharedOwed && contactId === null && !isBatchPayment) {
    return refuse("Select the contact for this receivable or payable.");
  }

  return accept(movements);
}

export function buildMovements(
  input: BuildInput,
  ctx: BuildContext,
): Refusable<MovementDraft[]> {
  const built = buildFor(input, ctx);
  if (!built.ok) return built;
  return validate(built.value, input.contactId, ctx, input);
}

function buildFor(
  input: BuildInput,
  ctx: BuildContext,
): Refusable<MovementDraft[]> {
  // A journal entry names its own sides; every other kind derives them, and
  // none of those can be built from an amount of nothing.
  if (input.kind !== "journal" && input.amountMinor === 0) {
    return refuse("Enter an amount greater than zero.");
  }

  const amount = input.amountMinor;

  switch (input.kind) {
    // The category (or equipment account) gains the value; the account that
    // paid loses it. When nobody's account paid, it is owed instead (FR-008).
    case "expense":
      return accept(
        twoSided(
          input.categoryAccountId,
          input.paidFromAccountId ?? ctx.payableAccountId,
          amount,
        ),
      );

    // The receiving account gains it; the income category is where it came from.
    case "income":
      return accept(
        twoSided(input.receivedIntoAccountId, input.categoryAccountId, amount),
      );

    // Neither side is a category, so a transfer is never income or an expense
    // — which is the whole point of it (FR-007).
    case "transfer":
      if (input.fromAccountId === input.toAccountId) {
        return refuse(
          "Money cannot move to the same account it came from. Pick a different one.",
        );
      }
      return accept(twoSided(input.toAccountId, input.fromAccountId, amount));

    // Paying what we owe clears the shared owed account and empties the payer.
    // Receiving what is owed to us does the same the other way round.
    case "payment":
      return accept(
        input.direction === "we-pay"
          ? twoSided(ctx.payableAccountId, input.paidFromAccountId, amount)
          : twoSided(input.paidFromAccountId, ctx.receivableAccountId, amount),
      );

    // The customer now owes us what the invoice says, earned into its income
    // account (FR-018a).
    case "invoice-issue":
      return accept(
        twoSided(ctx.receivableAccountId, input.incomeAccountId, amount),
      );

    // What was already there on the day the books start (FR-010).
    case "opening-balance":
      if (input.accountId === ctx.openingBalancesAccountId) {
        return refuse(
          "The opening balances account cannot have an opening balance of its own.",
        );
      }
      return accept(
        twoSided(input.accountId, ctx.openingBalancesAccountId, amount),
      );

    // The only shape that names its sides directly (FR-040). `validate` does
    // the rest, so a journal entry is held to exactly the same rules.
    case "journal":
      return accept(
        input.movements.map((m, i) => ({
          accountId: m.accountId,
          amountMinor: m.amountMinor,
          sortOrder: i,
          label: m.label ?? null,
        })),
      );
  }
}
