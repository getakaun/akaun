import { describe, expect, it } from "vitest";
import { LedgerRecordKind } from "$lib/enums.js";
import { checkIntegrity, type VoidPairInput } from "./integrity.js";
import type { RecordBalanceInput } from "./types.js";

/** A record whose sides cancel out and whose figure agrees with them. */
function sound(recordId: number, amountMinor: number): RecordBalanceInput {
  return {
    recordId,
    kind: LedgerRecordKind.Expense,
    movementCount: 2,
    movementSumMinor: 0,
    positiveSumMinor: amountMinor,
    expectedMinor: amountMinor,
    hasZeroMovement: false,
    missingContact: false,
  };
}

describe("a set of records that is sound", () => {
  it("reports clean", () => {
    const report = checkIntegrity({
      records: [sound(1, 5000), sound(2, 12345), sound(3, 1)],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(true);
    expect(report.unbalancedRecords).toEqual([]);
    expect(report.recordsChecked).toBe(3);
    expect(report.totalDifferenceMinor).toBe(0);
    expect(report.booksBalance).toBe(true);
  });

  it("reports clean over no records at all", () => {
    const report = checkIntegrity({ records: [], wholeBooksSumMinor: 0 });
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBe(0);
  });
});

describe("a record whose two sides do not cancel out", () => {
  it("is reported with its difference", () => {
    const report = checkIntegrity({
      records: [sound(1, 5000), { ...sound(2, 5000), movementSumMinor: 100 }],
      wholeBooksSumMinor: 100,
    });
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords).toHaveLength(1);
    expect(report.unbalancedRecords[0].recordId).toBe(2);
    expect(report.unbalancedRecords[0].differenceMinor).toBe(100);
  });

  it("adds every difference up, so a sweep says how far out the books are", () => {
    const report = checkIntegrity({
      records: [
        { ...sound(1, 5000), movementSumMinor: 100 },
        { ...sound(2, 5000), movementSumMinor: -40 },
      ],
      wholeBooksSumMinor: 60,
    });
    // Differences are magnitudes: two records 1.00 and 0.40 out is 1.40 out,
    // not 0.60 — they must not cancel each other in the headline figure.
    expect(report.totalDifferenceMinor).toBe(140);
  });

  it("says which invariant failed in plain words", () => {
    const report = checkIntegrity({
      records: [{ ...sound(1, 5000), movementSumMinor: 100 }],
      wholeBooksSumMinor: 100,
    });
    expect(report.unbalancedRecords[0].problem).toMatch(/cancel|add up|sides|balance/i);
  });
});

describe("the other things a record can get wrong", () => {
  it("reports a record with only one side", () => {
    const report = checkIntegrity({
      records: [{ ...sound(1, 5000), movementCount: 1 }],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords[0].problem).toMatch(/one side|two sides|one line/i);
  });

  it("reports a side worth nothing", () => {
    const report = checkIntegrity({
      records: [{ ...sound(1, 5000), movementCount: 3, hasZeroMovement: true }],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords[0].problem).toMatch(/nothing|zero/i);
  });

  it("reports money owed with nobody named", () => {
    const report = checkIntegrity({
      records: [{ ...sound(1, 5000), missingContact: true }],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords[0].problem).toMatch(/who|nobody|contact/i);
  });

  it("reports a record whose own figure disagrees with its sides", () => {
    const report = checkIntegrity({
      records: [{ ...sound(1, 5000), positiveSumMinor: 4900 }],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(false);
    // Signed: the sides come to 1.00 LESS than the figure that was entered, and
    // which way round it is out is the first thing someone fixing it needs.
    expect(report.unbalancedRecords[0].differenceMinor).toBe(-100);
    expect(report.unbalancedRecords[0].problem).toMatch(/entered|figure|typed/i);
  });

  it("exempts a journal entry from the entered-figure check, having no single figure", () => {
    const report = checkIntegrity({
      records: [
        {
          ...sound(1, 5000),
          kind: LedgerRecordKind.Journal,
          positiveSumMinor: 4900,
          expectedMinor: 0,
        },
      ],
      wholeBooksSumMinor: 0,
    });
    expect(report.ok).toBe(true);
  });
});

describe("the whole-books check", () => {
  it("passes when every side in the table cancels out", () => {
    const report = checkIntegrity({ records: [sound(1, 5000)], wholeBooksSumMinor: 0 });
    expect(report.booksBalance).toBe(true);
    expect(report.wholeBooksDifferenceMinor).toBe(0);
  });

  it("fails, with the difference, when they do not", () => {
    const report = checkIntegrity({ records: [sound(1, 5000)], wholeBooksSumMinor: -250 });
    expect(report.booksBalance).toBe(false);
    expect(report.wholeBooksDifferenceMinor).toBe(-250);
    expect(report.ok).toBe(false);
  });

  it("fails the whole sweep even when every single record looks sound", () => {
    // Every record balances but the table does not — a movement belongs to no
    // record, or one was deleted without its sides. Checking records alone
    // would call this clean.
    const report = checkIntegrity({
      records: [sound(1, 5000), sound(2, 5000)],
      wholeBooksSumMinor: 700,
    });
    expect(report.unbalancedRecords).toEqual([]);
    expect(report.ok).toBe(false);
  });
});

describe("a void (invariant 7)", () => {
  function pair(overrides: Partial<VoidPairInput> = {}): VoidPairInput {
    return {
      reversalId: 2,
      reversalKind: LedgerRecordKind.Reversal,
      originalId: 1,
      originalExists: true,
      originalIsReversal: false,
      sameDate: true,
      accountImbalanceMinor: 0,
      ...overrides,
    };
  }
  const reversal = { ...sound(2, 5000), kind: LedgerRecordKind.Reversal };
  function check(p: VoidPairInput) {
    return checkIntegrity({
      records: [sound(1, 5000), reversal],
      wholeBooksSumMinor: 0,
      voidPairs: [p],
    });
  }

  it("passes when the reversal cancels the original on its date", () => {
    expect(check(pair()).ok).toBe(true);
  });

  it("exempts a reversal from the entered-figure rule, as it copies the original's", () => {
    const report = checkIntegrity({
      records: [{ ...reversal, expectedMinor: 0 }],
      wholeBooksSumMinor: 0,
      voidPairs: [pair()],
    });
    expect(report.ok).toBe(true);
  });

  it.each([
    ["a missing target", pair({ originalExists: false }), "no longer exists"],
    ["a void of a void", pair({ originalIsReversal: true }), "voids a reversal"],
    ["a different date", pair({ sameDate: false }), "same day"],
    ["no target at all", pair({ originalId: null }), "does not say"],
    [
      "a link on a record that is not a reversal",
      pair({ reversalKind: LedgerRecordKind.Expense }),
      "not a reversal",
    ],
  ])("reports %s against the reversal", (_label, p, phrase) => {
    const report = check(p);
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords).toHaveLength(1);
    expect(report.unbalancedRecords[0].recordId).toBe(2);
    expect(report.unbalancedRecords[0].problem).toContain(phrase);
  });

  it("reports a pair that does not net to zero on every account, with how far out", () => {
    const report = check(pair({ accountImbalanceMinor: 400 }));
    expect(report.ok).toBe(false);
    expect(report.unbalancedRecords[0].differenceMinor).toBe(400);
    expect(report.totalDifferenceMinor).toBe(400);
  });
});
