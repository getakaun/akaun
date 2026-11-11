import { describe, expect, it } from "vitest";
import {
  assetTaxSchemeDefinitionSchema,
  calculateAssetTaxScheme,
  schemeApplies,
  type AssetTaxSchemeDefinition,
} from "./asset-tax-scheme.js";
const definition: AssetTaxSchemeDefinition = {
  name: "Custom test scheme",
  jurisdiction: "MY",
  yearFrom: 2025,
  yearTo: null,
  method: "original_cost",
  firstYearRateBps: 2000,
  regularRateBps: 1000,
  reference: "Unverified test inputs",
  conditions: "Illustrative only",
};
const basis = {
  qualifyingMinor: 1000000,
  businessUseBps: 10000,
  openingResidualMinor: 0,
  additionsMinor: 1000000,
  residualAdjustmentMinor: 0,
  firstYear: true,
};
describe("custom asset tax scheme arithmetic", () => {
  it("calculates original-cost rates without asserting statutory eligibility", () => {
    expect(calculateAssetTaxScheme(definition, basis)).toMatchObject({
      firstYearMinor: 200000,
      regularMinor: 100000,
      closingMinor: 700000,
      capped: false,
    });
  });
  it("uses remaining residual after the first-year deduction for reducing balance", () => {
    expect(
      calculateAssetTaxScheme(
        { ...definition, method: "reducing_balance" },
        basis,
      ),
    ).toMatchObject({
      firstYearMinor: 200000,
      regularMinor: 80000,
      closingMinor: 720000,
    });
  });
  it("requires an explicit first-year election and caps the final regular amount", () => {
    expect(
      calculateAssetTaxScheme(definition, { ...basis, firstYear: false })
        ?.firstYearMinor,
    ).toBe(0);
    expect(
      calculateAssetTaxScheme(definition, {
        ...basis,
        openingResidualMinor: 50000,
        additionsMinor: 0,
      }),
    ).toMatchObject({
      firstYearMinor: 0,
      regularMinor: 50000,
      closingMinor: 0,
      capped: true,
    });
  });
  it("rounds business use and rates in integer minor units, without multiplying adjusted additions twice", () => {
    expect(
      calculateAssetTaxScheme(
        { ...definition, firstYearRateBps: 5000, regularRateBps: 5000 },
        {
          ...basis,
          qualifyingMinor: 101,
          businessUseBps: 5000,
          additionsMinor: 51,
        },
      ),
    ).toMatchObject({
      eligibleMinor: 51,
      firstYearMinor: 26,
      regularMinor: 25,
      closingMinor: 0,
      capped: true,
    });
  });
  it("leaves incomplete bases unresolved and refuses impossible bases or unsafe amounts", () => {
    expect(
      calculateAssetTaxScheme(definition, { ...basis, businessUseBps: null }),
    ).toBeNull();
    expect(() =>
      calculateAssetTaxScheme(definition, {
        ...basis,
        openingResidualMinor: 1,
      }),
    ).toThrow("reconcile");
    expect(() =>
      calculateAssetTaxScheme(definition, {
        ...basis,
        qualifyingMinor: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("whole minor");
  });
  it("restricts a scheme to its explicitly selected jurisdiction and effective years", () => {
    expect(schemeApplies(definition, "MY", 2025)).toBe(true);
    expect(schemeApplies(definition, "US", 2025)).toBe(false);
    expect(schemeApplies(definition, null, 2025)).toBe(false);
    expect(schemeApplies({ ...definition, yearTo: 2026 }, "MY", 2027)).toBe(
      false,
    );
  });
  it("validates rates, year ranges and jurisdiction independently of currency", () => {
    expect(
      assetTaxSchemeDefinitionSchema.safeParse({
        ...definition,
        firstYearRateBps: 10001,
      }).success,
    ).toBe(false);
    expect(
      assetTaxSchemeDefinitionSchema.safeParse({ ...definition, yearTo: 2024 })
        .success,
    ).toBe(false);
    expect(
      assetTaxSchemeDefinitionSchema.safeParse({
        ...definition,
        jurisdiction: "GB",
      }).success,
    ).toBe(true);
  });
});

describe("asset tax form previews", () => {
  it("clears a disposal and scheme when an asset is explicitly excluded", async () => {
    const { createAssetTaxForm, assetTaxRowFromForm } =
      await import("./components/tax-worksheets/asset-tax-form.js");
    const { blankCapitalRow } = await import("./capital-allowance.js");
    const original = blankCapitalRow(1, 2025);
    const form = createAssetTaxForm(original);
    form.treatment = "exclude";
    form.note = "Outside the scope of this tax computation";
    form.disposed = true;
    form.schemeId = "999";
    expect(assetTaxRowFromForm(original, form, 2025, [])).toMatchObject({
      treatment: "exclude",
      schemeId: null,
      disposal: null,
    });
  });
});
