/**
 * What the direct-entry screen checks while the entry is still being typed.
 *
 * Every sentence here is the sentence the server would refuse with, checked in
 * the same order, so the screen can never say one thing and the save say
 * another. The point of showing them live is that the balance rule becomes
 * something the user can watch rather than something that rejects them at the
 * end.
 *
 * Hand-duplicated from `src/lib/server/ledger/entry-builder.ts` and
 * `src/lib/server/ledger/money.ts` because `$lib/server` is stripped from
 * client code at build time. Keep the two in step when a rule changes — there
 * is no shared import to enforce it (CLAUDE.md § Gotchas).
 */

/** Which way value goes on one side: into the account, or out of it. */
export type SideDirection = "in" | "out";

/** One side of an entry while it is being typed. */
export type SideDraft = {
  /** Stable key, so a row keeps its identity when a row above it is removed. */
  key: number;
  accountId: number | null;
  direction: SideDirection;
  /** Exactly what was typed. Turned into cents only by `sideMinor`. */
  amount: string;
  /** This line's own name. Blank means "fall back to the record's description". */
  label: string;
};

// Mirrors src/lib/server/ledger/money.ts's toMinor at a rate of 1 — binary
// floating point cannot hold most decimal amounts exactly (`1.005 * 100` is
// 100.49999999999999), so the value is rounded to twelve significant digits
// before the cent, and halves round away from zero.
const SIGNIFICANT_DIGITS = 12;

function toMinor(amount: number): number {
  const scaled = amount * 100;
  if (!Number.isFinite(scaled)) return 0;
  const clean = Number(scaled.toPrecision(SIGNIFICANT_DIGITS));
  return Math.sign(clean) * Math.round(Math.abs(clean));
}

/**
 * One side in whole cents, signed: positive when value goes into the account.
 * The direction the user picked is the only thing that decides the sign, so a
 * minus typed into the amount box cannot quietly reverse what the row says.
 */
export function sideMinor(side: SideDraft): number {
  const typed = parseFloat(side.amount);
  if (!Number.isFinite(typed)) return 0;
  const minor = toMinor(Math.abs(typed));
  return side.direction === "in" ? minor : -minor;
}

/** Everything going in, added up. */
export function moneyInMinor(sides: SideDraft[]): number {
  return sides.reduce((sum, side) => sum + Math.max(sideMinor(side), 0), 0);
}

/** Everything going out, added up and shown as a positive figure. */
export function moneyOutMinor(sides: SideDraft[]): number {
  return sides.reduce((sum, side) => sum - Math.min(sideMinor(side), 0), 0);
}

/** How far apart the two sides are, in cents. Zero means they cancel out. */
export function differenceMinor(sides: SideDraft[]): number {
  return sides.reduce((sum, side) => sum + sideMinor(side), 0);
}

/** Cents the way a refusal sentence shows them: 1234 → "12.34". */
function plainAmount(minor: number): string {
  return (Math.abs(minor) / 100).toFixed(2);
}

/**
 * Why this entry cannot be saved yet, in the words the server would use, or
 * null when nothing is in the way. The order is `validate`'s order — the most
 * useful message first.
 */
export function whyNotSaveable(
  sides: SideDraft[],
  requiresContact: (accountId: number) => boolean,
  contactId: number | null,
): string | null {
  if (sides.length < 2) {
    return "A journal entry needs at least two lines: one debit and one credit.";
  }

  // The server never sees a side with no account on it: the request would be
  // turned away before any rule ran, so this one sentence is the screen's own.
  if (sides.some((side) => side.accountId === null)) {
    return "Select an account for each line.";
  }

  if (sides.some((side) => sideMinor(side) === 0)) {
    return "A line amount cannot be zero.";
  }

  const difference = differenceMinor(sides);
  if (difference !== 0) {
    return `Debits and credits do not balance. Difference: ${plainAmount(difference)}.`;
  }

  const touchesSharedOwed = sides.some((side) => {
    return side.accountId !== null && requiresContact(side.accountId);
  });
  if (touchesSharedOwed && contactId === null) {
    return "Select the contact for this receivable or payable.";
  }

  return null;
}
