import { describe, expect, it } from "vitest";
import {
  needsTaxReview,
  switchTaxTreatment,
  taxFormValues,
  taxOverrideSchema,
  taxValuesSchema,
} from "./expense-tax.js";

describe("treatment-first deduction entry", () => {
  it("defaults an unconfigured line to Requires review without manufacturing a zero deduction", () => {
    expect(taxFormValues("", "")).toEqual({
      treatment: "requires_review",
      percentageBps: null,
      error: null,
    });
    expect(taxFormValues("", "", true)).toEqual({
      treatment: null,
      percentageBps: null,
      error: null,
    });
    expect(needsTaxReview(null)).toBe(true);
    expect(
      needsTaxReview({ treatment: "requires_review", percentageBps: 2500 }),
    ).toBe(true);
    expect(
      needsTaxReview({ treatment: "non_deductible", percentageBps: 0 }),
    ).toBe(false);
  });
  it("fixes ordinary at 100% and non-deductible/capital at 0% regardless of a stale partial draft", () => {
    expect(taxFormValues("ordinary_deductible", "25").percentageBps).toBe(
      10000,
    );
    expect(taxFormValues("non_deductible", "25").percentageBps).toBe(0);
    expect(taxFormValues("capital_expenditure", "25").percentageBps).toBe(0);
    expect(taxFormValues("requires_review", "25").percentageBps).toBeNull();
  });
  it("requires strictly partial percentages at both UI and server boundaries", () => {
    for (const text of [
      "",
      "0",
      "0.00",
      "100",
      "100.00",
      "-1",
      "100.01",
      "25.001",
      "NaN",
    ]) {
      expect(taxFormValues("partial", text).error).toBeTruthy();
    }
    for (const [text, bps] of [
      ["0.01", 1],
      ["99.99", 9999],
    ] as const) {
      expect(taxFormValues("partial", text)).toEqual({
        treatment: "partial",
        percentageBps: bps,
        error: null,
      });
    }
    for (const percentageBps of [null, 0, 10000])
      expect(
        taxValuesSchema.safeParse({ treatment: "partial", percentageBps })
          .success,
      ).toBe(false);
    expect(
      taxOverrideSchema.safeParse({
        accountId: 1,
        treatment: "requires_review",
        percentageBps: null,
        reason: "Ask accountant",
      }).success,
    ).toBe(true);
    expect(
      taxOverrideSchema.safeParse({
        accountId: 1,
        treatment: "ordinary_deductible",
        percentageBps: null,
        reason: "Ask accountant",
      }).success,
    ).toBe(false);
  });
  it("starts Partial blank instead of 0/100 and restores a valid partial only within the draft", () => {
    expect(
      switchTaxTreatment(
        { treatment: "ordinary_deductible", percentage: "100" },
        "partial",
      ).percentage,
    ).toBe("");
    expect(
      switchTaxTreatment(
        { treatment: "non_deductible", percentage: "0" },
        "partial",
      ).percentage,
    ).toBe("");
    const zero = switchTaxTreatment(
      { treatment: "partial", percentage: "25.50" },
      "non_deductible",
    );
    expect(zero.percentage).toBe("0.00");
    expect(
      switchTaxTreatment(zero, "partial", zero.previousPartial).percentage,
    ).toBe("25.50");
    const unresolved = switchTaxTreatment(
      { treatment: "partial", percentage: "100" },
      "requires_review",
    );
    expect(unresolved.percentage).toBe("");
    expect(
      switchTaxTreatment(unresolved, "partial", unresolved.previousPartial)
        .percentage,
    ).toBe("");
  });
});
