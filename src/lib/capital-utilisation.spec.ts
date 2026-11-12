import { describe, expect, it } from "vitest";
import {
  blankCapitalRow,
  capitalTotals,
  type CapitalSchedule,
} from "./capital-allowance.js";
import { automaticUtilisation } from "./capital-utilisation-policy.js";
import {
  calculateUtilisation,
  utilisationAdjustmentKey,
  type UtilisationContext,
} from "./capital-utilisation.js";
import type { TaxAdjustment } from "./tax-worksheet.js";

function schedule(): CapitalSchedule {
  return {
    calculationVersion: 2,
    currency: "MYR",
    jurisdiction: "MY",
    evidence: "",
    predecessor: null,
    assets: [
      {
        assetId: 1,
        name: "Plant",
        assetType: "Equipment",
        acquisitionDate: "2025-01-01",
        inServiceDate: "2025-01-01",
        costMinor: 100000,
        sourceRecordId: null,
        documentReference: "",
        version: "test",
        sourceVersion: null,
        reviewReason: null,
      },
    ],
    rows: [
      {
        ...blankCapitalRow(1),
        treatment: "claim",
        businessSource: "Trading",
        taxClass: "Test",
        businessUseBps: 10000,
        qualifyingMinor: 100000,
        openingResidualMinor: 0,
        additionsMinor: 100000,
        initialMinor: 20000,
        annualMinor: 10000,
        schemeFirstYear: true,
        schemeId: 1,
        appliedScheme: {
          id: 1,
          familyKey: "7683b304-b688-4478-b1d3-f049305d26a8",
          version: 1,
          verification: "custom_unverified",
          definition: {
            name: "Test",
            jurisdiction: "MY",
            yearFrom: 2025,
            yearTo: null,
            method: "original_cost",
            firstYearRateBps: 2000,
            regularRateBps: 1000,
          },
        },
      },
    ],
    utilisation: [],
    utilisationPolicy: automaticUtilisation(),
  };
}
function context(profitMinor = 100000): UtilisationContext {
  return {
    hash: "a".repeat(64),
    adjustments: [],
    businessIncomeAccounts: [1],
    snapshot: {
      calculationVersion: 1,
      currency: "MYR",
      companyName: "Test",
      profitMinor,
      incomeMinor: profitMinor,
      expenseMinor: 0,
      profitLines: [
        {
          accountId: 1,
          accountName: "Sales",
          type: "income",
          amountMinor: profitMinor,
        },
      ],
      expenses: [],
      notes: [],
    },
  };
}
const group = (s: CapitalSchedule, c = context()) =>
  calculateUtilisation(s, 2025, c).utilisationEvidence!.groups[0];
const adjustment = (extra: Partial<TaxAdjustment>): TaxAdjustment => ({
  id: 1,
  revisionId: 1,
  kind: "other",
  sourceMovementId: null,
  percentageBps: null,
  treatment: null,
  amountMinor: 5000,
  direction: "decrease",
  balanceMinor: 5000,
  originYa: 2024,
  reason: "Reviewed tax adjustment",
  evidence: "",
  requestKey: "test",
  createdBy: 1,
  actorName: "Tester",
  createdAt: "test",
  withdrawnAt: null,
  withdrawalReason: null,
  ...extra,
});

describe("automatic same-business capital allowance utilisation", () => {
  it.each([
    [100000, 30000, 0],
    [8000, 8000, 22000],
    [0, 0, 30000],
    [-1000, 0, 30000],
  ])(
    "caps use at income %i and carries only unabsorbed allowances",
    (profit, used, carry) => {
      const original = schedule(),
        before = JSON.stringify(original);
      const result = calculateUtilisation(original, 2025, context(profit));
      expect(result.utilisationEvidence!.groups[0]).toMatchObject({
        usedMinor: used,
        carriedMinor: carry,
        restrictedMinor: 0,
        basis: "bookkeeping",
      });
      expect(capitalTotals(result, 2025)).toMatchObject({
        usedMinor: used,
        carryForwardMinor: carry,
        problems: [],
      });
      expect(JSON.stringify(original)).toBe(before);
    },
  );
  it("uses add-backs including signed refunds and staged annual corrections, before brought-forward losses", () => {
    const c = context(1000);
    c.snapshot.expenses = [
      {
        movementId: 3,
        recordId: 1,
        recordNumber: "EX-1",
        label: "Expense",
        date: "2025-01-01",
        description: "Expense",
        accountId: 2,
        accountName: "Expense",
        expenseMinor: 10000,
        voided: false,
        classification: {
          treatment: "non_deductible",
          percentageBps: 0,
          source: "override",
          reason: "Reviewed",
          classifiedAt: "test",
          classifiedBy: 1,
          provenance: "line_override",
        },
      },
      {
        movementId: 4,
        recordId: 2,
        recordNumber: "EX-2",
        label: "Refund",
        date: "2025-01-02",
        description: "Refund",
        accountId: 2,
        accountName: "Expense",
        expenseMinor: -1000,
        voided: false,
        classification: {
          treatment: "non_deductible",
          percentageBps: 0,
          source: "override",
          reason: "Reviewed",
          classifiedAt: "test",
          classifiedBy: 1,
          provenance: "line_override",
        },
      },
    ];
    c.adjustments = [
      adjustment({
        kind: "source",
        sourceMovementId: 3,
        percentageBps: 5000,
        treatment: "partial",
      }),
      adjustment({
        id: 2,
        requestKey: "loss",
        kind: "loss_brought_forward",
        amountMinor: 50000,
      }),
    ];
    expect(group(schedule(), c)).toMatchObject({
      capacityMinor: 5000,
      usedMinor: 5000,
      carriedMinor: 25000,
    });
  });
  it.each([
    ["increase", 15000],
    ["decrease", 5000],
  ])(
    "includes signed annual %s adjustments without asking for an income limit",
    (direction, capacity) => {
      const c = context(10000);
      c.adjustments = [
        adjustment({ direction: direction as "increase" | "decrease" }),
      ];
      expect(group(schedule(), c)).toMatchObject({
        capacityMinor: capacity,
        usedMinor: capacity,
        basis: "bookkeeping",
      });
      expect(
        calculateUtilisation(schedule(), 2025, c).utilisationEvidence!.problems,
      ).toEqual([]);
    },
  );
  it("clamps adjusted losses to zero and ignores withdrawn annual adjustments", () => {
    const c = context(1000);
    c.adjustments = [adjustment({})];
    expect(group(schedule(), c)).toMatchObject({
      capacityMinor: 0,
      usedMinor: 0,
      carriedMinor: 30000,
    });
    c.adjustments[0].withdrawnAt = "withdrawn";
    expect(group(schedule(), c)).toMatchObject({
      capacityMinor: 1000,
      usedMinor: 1000,
      carriedMinor: 29000,
    });
  });
  it.each([
    [10000, 2000, 10000],
    [0, 12000, 0],
    [-1000, 5000, 0],
    [10000, -2000, 10000],
  ])(
    "excludes other income from allowance capacity: trading %i, other %i",
    (trading, other, used) => {
      const c = context(trading);
      c.snapshot.profitMinor += other;
      c.snapshot.incomeMinor += other;
      c.snapshot.profitLines.push({
        accountId: 2,
        accountName: "Bank interest",
        type: "income",
        amountMinor: other,
      });
      const result = calculateUtilisation(schedule(), 2025, c);
      expect(result.utilisationEvidence!.problems).toEqual([]);
      expect(result.utilisationEvidence!.groups[0]).toMatchObject({
        capacityMinor: used,
        usedMinor: used,
        carriedMinor: 30000 - used,
        basis: "bookkeeping",
      });
      expect(result.utilisationEvidence!.excludedIncome).toEqual([
        { accountId: 2, accountName: "Bank interest", amountMinor: other },
      ]);
      expect(c.snapshot.profitMinor).toBe(trading + other);
    },
  );
  it("allocates oldest origins first and rebuilds forged current uses", () => {
    const s = schedule();
    s.utilisation = [
      {
        businessSource: "Trading",
        originYa: 2023,
        balanceMinor: 6000,
        usedMinor: 6000,
      },
      {
        businessSource: "Trading",
        originYa: 2024,
        balanceMinor: 7000,
        usedMinor: 7000,
      },
      {
        businessSource: "Trading",
        originYa: 2025,
        balanceMinor: 0,
        usedMinor: 0,
      },
    ];
    const result = calculateUtilisation(s, 2025, context(10000));
    expect(result.utilisation.map((u) => [u.originYa, u.usedMinor])).toEqual([
      [2023, 6000],
      [2024, 4000],
      [2025, 0],
    ]);
    expect(result.utilisationEvidence!.groups[0].carriedMinor).toBe(33000);
  });
  it.each([
    "multiple_sources",
    "unknown_jurisdiction",
    "single_business_unchecked",
  ])("requires a reviewed income limit for %s", (condition) => {
    const s = schedule(),
      c = context();
    if (condition === "multiple_sources")
      s.utilisation.push({
        businessSource: "Rental",
        originYa: 2024,
        balanceMinor: 1000,
        usedMinor: 0,
      });
    if (condition === "unknown_jurisdiction") s.jurisdiction = null;
    if (condition === "single_business_unchecked")
      s.utilisationPolicy!.singleBusiness = false;
    expect(group(s, c)).toMatchObject({
      capacityMinor: null,
      usedMinor: 0,
      basis: "needs_review",
    });
    const problem = calculateUtilisation(
      s,
      2025,
      c,
    ).utilisationEvidence!.problems.join(" ");
    if (condition === "multiple_sources") {
      expect(problem).toContain("Trading");
      expect(problem).toContain("Rental");
      expect(problem).toContain("Use the same label");
    }
    if (condition === "unknown_jurisdiction")
      expect(problem).toContain("Choose a tax jurisdiction");
    if (condition === "single_business_unchecked")
      expect(problem).toContain("saved multiple-business setting");

    s.utilisationPolicy!.income = [
      ...new Set(["Trading", ...s.utilisation.map((u) => u.businessSource)]),
    ].map((businessSource) => ({
      businessSource,
      capacityMinor: businessSource === "Trading" ? 5000 : 0,
      reason: "Reviewed separate business income",
      basisHash: c.hash,
      adjustmentKey: utilisationAdjustmentKey(c),
    }));
    const reviewed = calculateUtilisation(s, 2025, c);
    expect(
      reviewed.utilisationEvidence!.groups.find(
        (g) => g.businessSource === "Trading",
      ),
    ).toMatchObject({
      capacityMinor: 5000,
      usedMinor: 5000,
      basis: "reviewed",
    });
    expect(
      reviewed.utilisationEvidence!.groups.find(
        (g) => g.businessSource === "Rental",
      )?.usedMinor ?? 0,
    ).toBe(0);
  });
  it("identifies a non-Malaysian jurisdiction rather than implying another business exists", () => {
    const s = schedule();
    s.jurisdiction = "GB";
    const result = calculateUtilisation(s, 2025, context());
    expect(result.utilisationEvidence!.problems).toEqual([
      "Automatic allowance usage is available for Malaysia (MY); this worksheet uses GB.",
    ]);
    expect(result.utilisationEvidence!.groups[0].usedMinor).toBe(0);
  });
  it("invalidates reviewed limits on source or adjustment changes, but ignores withdrawn adjustments", () => {
    const s = schedule(),
      c = context();
    s.utilisationPolicy!.income = [
      {
        businessSource: "Trading",
        capacityMinor: 5000,
        reason: "Reviewed business income",
        basisHash: c.hash,
        adjustmentKey: utilisationAdjustmentKey(c),
      },
    ];
    expect(group(s, c).usedMinor).toBe(5000);
    expect(group(s, { ...c, hash: "b".repeat(64) }).capacityMinor).toBeNull();
    c.adjustments = [adjustment({ kind: "loss_brought_forward" })];
    expect(group(s, c).capacityMinor).toBeNull();
    c.adjustments[0].withdrawnAt = "test";
    expect(group(s, c).usedMinor).toBe(5000);
  });
  it("separates a manual restriction from unabsorbed carry and rejects an excessive override", () => {
    const s = schedule();
    s.utilisationPolicy!.overrides = [
      {
        businessSource: "Trading",
        usedMinor: 2000,
        reason: "Accountant restricted this claim",
      },
    ];
    const result = calculateUtilisation(s, 2025, context(8000), true);
    expect(result.utilisationEvidence!.groups[0]).toMatchObject({
      usedMinor: 2000,
      restrictedMinor: 6000,
      carriedMinor: 22000,
    });
    expect(capitalTotals(result, 2025).carryForwardMinor).toBe(22000);
    s.utilisationPolicy!.overrides[0].usedMinor = 9000;
    expect(() => calculateUtilisation(s, 2025, context(8000), true)).toThrow(
      "override exceeds",
    );
    expect(
      calculateUtilisation(s, 2025, context(8000)).utilisationEvidence!.problems
        .length,
    ).toBeGreaterThan(0);
  });
  it("blocks utilisation while annual source corrections are unresolved", () => {
    const c = context();
    c.snapshot.pendingCorrectionIds = [1];
    expect(group(schedule(), c).capacityMinor).toBeNull();
  });
  it("preserves pre-automatic schedules without recalculating retained uses", () => {
    const s = schedule();
    delete s.utilisationPolicy;
    expect(calculateUtilisation(s, 2025, context())).toBe(s);
  });
});
