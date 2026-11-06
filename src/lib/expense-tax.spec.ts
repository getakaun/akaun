import { describe, expect, it } from "vitest";
import {
  accountTaxDefault,
  canApplyAccountTaxDefault,
  needsTaxReview,
  deductionMinor,
  percentageToBps,
  taxValuesSchema,
} from "./expense-tax.js";

describe("expense tax arithmetic and validation", () => {
  it("separates never classified defaults from deliberate review holds", () => {
    expect(accountTaxDefault({})).toEqual({
      treatment: "unclassified",
      percentageBps: null,
    });
    expect(
      taxValuesSchema.safeParse({
        treatment: "unclassified",
        percentageBps: null,
      }).success,
    ).toBe(true);
    expect(
      taxValuesSchema.safeParse({ treatment: "unclassified", percentageBps: 0 })
        .success,
    ).toBe(false);
    expect(
      needsTaxReview({ treatment: "unclassified", percentageBps: null }),
    ).toBe(true);
    expect(canApplyAccountTaxDefault(null)).toBe(true);
  });
  it("calculates the RM1,000 at 50% example and exact split amounts", () => {
    expect(deductionMinor(100000, 5000)).toBe(50000);
    expect(deductionMinor(60000, 10000) + deductionMinor(40000, 0)).toBe(60000);
  });
  it("rounds halves away from zero, including refunds, without binary multiplication", () => {
    expect(deductionMinor(1, 5000)).toBe(1);
    expect(deductionMinor(-1, 5000)).toBe(-1);
    expect(deductionMinor(1234567890123, 3333)).toBe(411481477778);
    expect(deductionMinor(-100000, 2500)).toBe(-25000);
  });
  it("accepts at most two percentage decimals with no coercion surprises", () => {
    expect(percentageToBps("33.33")).toBe(3333);
    expect(percentageToBps("100.00")).toBe(10000);
    for (const text of ["-1", "100.01", "12.345", "NaN", "1e2", ""]) {
      expect(percentageToBps(text)).toBeNull();
    }
  });
  it("rejects invalid ranges, fractional basis points and contradictory treatments", () => {
    for (const percentageBps of [-1, 10001, 1.5, Infinity]) {
      expect(
        taxValuesSchema.safeParse({ percentageBps, treatment: "partial" })
          .success,
      ).toBe(false);
    }
    expect(
      taxValuesSchema.safeParse({
        percentageBps: 5000,
        treatment: "ordinary_deductible",
      }).success,
    ).toBe(false);
    expect(
      taxValuesSchema.safeParse({
        percentageBps: 0,
        treatment: "capital_expenditure",
      }).success,
    ).toBe(true);
  });
});
