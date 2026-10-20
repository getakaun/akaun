import { StatementDirection } from "$lib/enums.js";
import type { StatementDirectionCode } from "$lib/enums.js";
import type { Minor } from "$lib/server/ledger/types.js";
import { suggestExactAllocationSet } from "./allocation.js";
import { EPSILON } from "./types.js";

/** Reject malformed and overflowing dates instead of normalising them. */
function validDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
  );
}

/** The side of a record that a statement line could be, on that statement's account. */
export type SuggestionMovement = {
  accountId: number;
  /** Signed whole cents. Positive = money in. */
  amountMinor: Minor;
  date: string;
  remainingAmount?: number;
};
export type SuggestionLine = {
  id: number;
  /** The account the line's statement belongs to; null until the upgrade assigns one. */
  accountId: number | null;
  date: string;
  direction: StatementDirectionCode;
  remainingAmount: number;
};

/**
 * A movement that took money out of the account is a money-out line on that
 * account's statement, and vice versa. Nothing about *what kind of record* it
 * was enters into it — that is what makes a wallet purchase impossible to
 * suggest against a bank statement (D-11).
 */
export function directionFor(amountMinor: Minor): StatementDirectionCode {
  return amountMinor > 0 ? StatementDirection.In : StatementDirection.Out;
}

/**
 * Pick the statement lines whose remaining balances sum to exactly what this
 * movement still needs. Shared by the page loader (so the UI can label a
 * movement "exact match") and the bulk auto-match service (so it saves the same
 * set the UI promised) — keep it the only definition of that rule.
 *
 * Lines must have the same valid date, account and direction as the movement.
 * Different posting dates require a manual allocation.
 *
 * `savedLineIds` are lines already allocated to *this* movement: they stay
 * eligible even with no remaining balance, since re-saving reclaims them.
 */
export function suggestLinesForMovement(
  movement: SuggestionMovement,
  lines: readonly SuggestionLine[],
  savedLineIds: ReadonlySet<number> = new Set(),
): number[] {
  const direction = directionFor(movement.amountMinor);
  if (!validDay(movement.date)) return [];
  return suggestExactAllocationSet(
    movement.remainingAmount ?? 0,
    lines
      .filter(
        (line) =>
          line.accountId === movement.accountId &&
          line.date === movement.date &&
          line.direction === direction &&
          (line.remainingAmount >= EPSILON || savedLineIds.has(line.id)),
      )
      .map((line) => ({
        id: line.id,
        amount: line.remainingAmount,
        score: 0,
      })),
  );
}

export type MovementSuggestion = {
  suggestedLineIds: number[];
  suggestionConflict: boolean;
};

/**
 * Evaluate the whole population before filtering or truncating results. A line
 * proposed for multiple movements requires a human choice, never input order.
 * Conflicting proposals are not preselected in the manual composer.
 */
export function suggestionsForMovements(
  movements: readonly (SuggestionMovement & {
    movementId: number;
    allocatedAmount?: number;
  })[],
  lines: readonly SuggestionLine[],
): Map<number, MovementSuggestion> {
  const proposals = new Map<number, number[]>();
  const owners = new Map<number, number[]>();
  for (const movement of movements) {
    const ids =
      (movement.allocatedAmount ?? 0) >= EPSILON
        ? []
        : suggestLinesForMovement(movement, lines);
    proposals.set(movement.movementId, ids);
    for (const id of ids) {
      const group = owners.get(id) ?? [];
      group.push(movement.movementId);
      owners.set(id, group);
    }
  }
  return new Map(
    [...proposals].map(([id, ids]) => {
      const suggestionConflict = ids.some(
        (lineId) => owners.get(lineId)!.length > 1,
      );
      return [
        id,
        {
          suggestedLineIds: suggestionConflict ? [] : ids,
          suggestionConflict,
        },
      ];
    }),
  );
}
