import { describe, expect, it } from "vitest";
import { StatementDirection } from "$lib/enums.js";
import type { StatementDirectionCode } from "$lib/enums.js";
import {
  directionFor,
  suggestLinesForMovement,
  suggestionsForMovements,
} from "./suggestions.js";
import type { SuggestionLine, SuggestionMovement } from "./suggestions.js";

const BANK = 7;
const WALLET = 8;

const line = (
  id: number,
  amount: number,
  direction: StatementDirectionCode = StatementDirection.Out,
  date = "2026-03-10",
  accountId: number | null = BANK,
): SuggestionLine => ({
  id,
  accountId,
  date,
  direction,
  remainingAmount: amount,
});

const movement = (
  overrides: Partial<SuggestionMovement> = {},
): SuggestionMovement => ({
  accountId: BANK,
  amountMinor: -10_000,
  date: "2026-03-10",
  remainingAmount: 100,
  ...overrides,
});

describe("reconciliation suggestions", () => {
  it("reads the direction off the movement's sign", () => {
    expect(directionFor(-10_000)).toBe(StatementDirection.Out);
    expect(directionFor(10_000)).toBe(StatementDirection.In);
  });

  it("ignores lines moving money the wrong way", () => {
    expect(
      suggestLinesForMovement(movement(), [
        line(1, 100, StatementDirection.In),
      ]),
    ).toEqual([]);
    expect(
      suggestLinesForMovement(movement(), [
        line(2, 100, StatementDirection.Out),
      ]),
    ).toEqual([2]);
  });

  it("never offers a line from a statement on another account", () => {
    expect(
      suggestLinesForMovement(movement(), [
        line(1, 100, StatementDirection.Out, "2026-03-10", WALLET),
      ]),
    ).toEqual([]);
    // A statement the upgrade has not assigned an account to offers nothing.
    expect(
      suggestLinesForMovement(movement(), [
        line(2, 100, StatementDirection.Out, "2026-03-10", null),
      ]),
    ).toEqual([]);
  });

  it("scopes suggestions by account even when both accounts share a fixed type", () => {
    expect(
      suggestLinesForMovement(movement(), [
        line(1, 100),
        line(2, 100, StatementDirection.Out, "2026-03-10", WALLET),
      ]),
    ).toEqual([1]);
  });

  it("drops a line an earlier movement already consumed", () => {
    expect(suggestLinesForMovement(movement(), [line(1, 100)])).toEqual([1]);
    // Same call once line 1 has been spent: nothing left that sums to 100.
    expect(suggestLinesForMovement(movement(), [line(1, 0)])).toEqual([]);
  });

  it("keeps a spent line eligible for the movement it is already allocated to", () => {
    // A fully allocated movement has nothing left to suggest for.
    expect(
      suggestLinesForMovement(
        movement({ amountMinor: 10_000, remainingAmount: 0 }),
        [line(1, 0, StatementDirection.In)],
        new Set([1]),
      ),
    ).toEqual([]);
  });

  it("combines lines that sum exactly and gives up when none do", () => {
    const target = movement({ amountMinor: -7550, remainingAmount: 75.5 });
    expect(
      suggestLinesForMovement(target, [line(1, 50.25), line(2, 25.25)]),
    ).toEqual([1, 2]);
    expect(
      suggestLinesForMovement(target, [line(1, 50.25), line(2, 20)]),
    ).toEqual([]);
  });

  it("only offers lines on the same date", () => {
    expect(
      suggestLinesForMovement(movement(), [
        line(1, 100, StatementDirection.Out, "2026-03-25"),
        line(2, 100, StatementDirection.Out, "2026-03-10"),
      ]),
    ).toEqual([2]);
  });
});

describe("same-date suggestions and conflicts", () => {
  const creditLines = [
    line(1, 1000, StatementDirection.In, "2026-01-30"),
    line(2, 0.22, StatementDirection.In, "2026-01-31"),
  ];
  const credit = (movementId: number, date: string) => ({
    ...movement({ amountMinor: 100000, remainingAmount: 1000, date }),
    movementId,
  });

  it("only suggests the January record for the two-entry statement", () => {
    const suggestions = suggestionsForMovements(
      [
        credit(1, "2026-01-30"),
        credit(2, "2026-02-07"),
        credit(3, "2026-08-29"),
      ],
      creditLines,
    );
    expect(suggestions.get(1)).toEqual({
      suggestedLineIds: [1],
      suggestionConflict: false,
    });
    expect(suggestions.get(2)?.suggestedLineIds).toEqual([]);
    expect(suggestions.get(3)?.suggestedLineIds).toEqual([]);
  });

  it("rejects adjacent dates and invalid calendar dates", () => {
    for (const date of [
      "2026-01-29",
      "2026-01-31",
      "2026-02-30",
      "invalid",
      "2026-1-30",
    ]) {
      expect(suggestLinesForMovement(credit(1, date), creditLines)).toEqual([]);
    }
    expect(
      suggestLinesForMovement(credit(1, "2026-02-30"), [
        line(1, 1000, StatementDirection.In, "2026-02-30"),
      ]),
    ).toEqual([]);
  });

  it("requires manual choice for every competing proposal regardless of order", () => {
    for (const movements of [
      [credit(1, "2026-01-30"), credit(2, "2026-01-30")],
      [credit(2, "2026-01-30"), credit(1, "2026-01-30")],
    ]) {
      const suggestions = suggestionsForMovements(movements, creditLines);
      for (const id of [1, 2])
        expect(suggestions.get(id)).toEqual({
          suggestedLineIds: [],
          suggestionConflict: true,
        });
    }
  });

  it("detects conflicts between combinations and individual lines", () => {
    const suggestions = suggestionsForMovements(
      [
        { ...movement(), movementId: 1 },
        {
          ...movement({ amountMinor: -4000, remainingAmount: 40 }),
          movementId: 2,
        },
      ],
      [line(1, 40), line(2, 60)],
    );
    expect(suggestions.get(1)?.suggestionConflict).toBe(true);
    expect(suggestions.get(2)?.suggestionConflict).toBe(true);
  });

  it("does not treat an already allocated movement as an automatic competitor", () => {
    const suggestions = suggestionsForMovements(
      [
        credit(1, "2026-01-30"),
        { ...credit(2, "2026-01-30"), allocatedAmount: 5 },
      ],
      creditLines,
    );
    expect(suggestions.get(1)?.suggestedLineIds).toEqual([1]);
    expect(suggestions.get(2)).toEqual({
      suggestedLineIds: [],
      suggestionConflict: false,
    });
  });
});
