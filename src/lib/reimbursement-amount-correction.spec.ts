import { describe, expect, it } from "vitest";
import {
  correctionAmountMinor,
  correctionPreview,
} from "./reimbursement-amount-correction.js";

const item = {
  owedMovementId: 12,
  amountMinor: 550,
  allocatedMinor: 550,
  otherPaidMinor: 0,
  availableMinor: 550,
};

describe("reimbursement correction preview", () => {
  it("accepts exact cents and refuses rounding, negative, empty and unsafe input", () => {
    expect(correctionAmountMinor("5.50")).toBe(550);
    expect(correctionAmountMinor(" 5. ")).toBe(500);
    expect(correctionAmountMinor("0.29")).toBe(29);
    for (const raw of ["", "5.501", "-5", "NaN", "1e3", "9007199254740992"])
      expect(correctionAmountMinor(raw)).toBeNull();
  });
  it("automatically leaves fifty cents outstanding for a single expense", () => {
    const preview = correctionPreview(500, [item], {});
    expect(preview).toMatchObject({
      valid: true,
      creditMinor: 0,
      allocations: [{ owedMovementId: 12, amountMinor: 500 }],
    });
    expect(item.availableMinor - preview.allocations[0].amountMinor).toBe(50);
  });
  it("caps a single expense at its remaining balance and retains extra credit", () => {
    expect(
      correctionPreview(
        700,
        [{ ...item, otherPaidMinor: 100, availableMinor: 450 }],
        {},
      ),
    ).toMatchObject({
      valid: true,
      creditMinor: 250,
      allocations: [{ amountMinor: 450 }],
    });
    expect(correctionPreview(700, [], {})).toMatchObject({
      valid: true,
      creditMinor: 700,
      allocations: [],
    });
  });
  it("requires valid explicit allocations for multiple expenses", () => {
    const expenses = [item, { ...item, owedMovementId: 13 }];
    expect(
      correctionPreview(500, expenses, { 12: "5.50", 13: "5.50" }).valid,
    ).toBe(false);
    expect(
      correctionPreview(500, expenses, { 12: "5.00", 13: "0" }),
    ).toMatchObject({ valid: true, creditMinor: 0 });
    expect(
      correctionPreview(500, expenses, { 12: "4.999", 13: "0" }).valid,
    ).toBe(false);
    expect(correctionPreview(700, expenses, { 12: "6", 13: "0" }).valid).toBe(
      false,
    );
    expect(correctionPreview(0, expenses, { 12: "0", 13: "0" }).valid).toBe(
      false,
    );
  });
});
