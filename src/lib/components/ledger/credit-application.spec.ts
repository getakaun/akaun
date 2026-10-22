import { describe, expect, it } from "vitest";
import { planCreditApplication } from "./credit-application.js";

describe("explicit credit application", () => {
  it("leaves cash unchanged until a credit is selected", () => {
    expect(
      planCreditApplication([{ owedMovementId: 1, amountMinor: 10000 }], []),
    ).toEqual({
      cashAllocations: [{ owedMovementId: 1, amountMinor: 10000 }],
      creditApplications: [],
      creditAppliedMinor: 0,
    });
  });
  it("spreads selected credits over claims and preserves every cent", () => {
    expect(
      planCreditApplication(
        [
          { owedMovementId: 1, amountMinor: 2000 },
          { owedMovementId: 2, amountMinor: 8000 },
        ],
        [{ paymentMovementId: 3, amountMinor: 2800 }],
      ),
    ).toEqual({
      creditApplications: [
        { paymentMovementId: 3, owedMovementId: 1, amountMinor: 2000 },
        { paymentMovementId: 3, owedMovementId: 2, amountMinor: 800 },
      ],
      cashAllocations: [{ owedMovementId: 2, amountMinor: 7200 }],
      creditAppliedMinor: 2800,
    });
  });
  it("caps use at the claim amount and supports several selected credits", () => {
    expect(
      planCreditApplication(
        [{ owedMovementId: 1, amountMinor: 2000 }],
        [
          { paymentMovementId: 2, amountMinor: 1001 },
          { paymentMovementId: 3, amountMinor: 1000 },
        ],
      ),
    ).toEqual({
      cashAllocations: [],
      creditAppliedMinor: 2000,
      creditApplications: [
        { paymentMovementId: 2, owedMovementId: 1, amountMinor: 1001 },
        { paymentMovementId: 3, owedMovementId: 1, amountMinor: 999 },
      ],
    });
  });
});
