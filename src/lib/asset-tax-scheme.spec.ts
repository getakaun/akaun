import { describe, expect, it } from "vitest";
import {
  assetTaxSchemeDefinitionSchema,
  assetTaxSchemeRemark,
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
  it("supports one optional remark and reads legacy notes without rewriting retained definitions", () => {
    const { reference, conditions, ...simple } = definition;
    expect(assetTaxSchemeDefinitionSchema.parse(simple)).toEqual(simple);
    expect(assetTaxSchemeRemark(simple)).toBe("");
    expect(
      assetTaxSchemeRemark({ ...simple, remark: "Reviewed machinery rates" }),
    ).toBe("Reviewed machinery rates");
    const retained = JSON.stringify(definition);
    expect(assetTaxSchemeRemark(definition)).toBe(
      `${reference}\n\n${conditions}`,
    );
    expect(
      JSON.stringify(assetTaxSchemeDefinitionSchema.parse(definition)),
    ).toBe(retained);
    expect(assetTaxSchemeRemark({ ...definition, remark: "" })).toBe("");
    expect(
      assetTaxSchemeDefinitionSchema.safeParse({
        ...simple,
        remark: "x".repeat(5001),
      }).success,
    ).toBe(false);
  });

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

describe("simplified asset tax workings", () => {
  it("does not validate hidden claim inputs when excluding an asset", async () => {
    const { createAssetTaxForm, assetTaxRowFromForm } =
      await import("./components/tax-worksheets/asset-tax-form.js");
    const { blankCapitalRow } = await import("./capital-allowance.js");
    const original = blankCapitalRow(1, 2025);
    const form = createAssetTaxForm(original);
    Object.assign(form, {
      treatment: "exclude",
      percentage: "invalid",
      note: "Personal asset",
      disposed: true,
    });
    form.amounts.qualifyingMinor = "invalid";
    expect(assetTaxRowFromForm(original, form, 2025, [])).toMatchObject({
      treatment: "exclude",
      note: "Personal asset",
      disposal: null,
      schemeId: null,
    });
  });

  const applied = {
    id: 1,
    familyKey: "ac9ae028-7a16-41fb-8dd0-ddb18ef8860d",
    version: 1,
    definition,
    verification: "custom_unverified" as const,
  };
  async function setup() {
    const { createAssetTaxForm, assetTaxRowFromForm } =
      await import("./components/tax-worksheets/asset-tax-form.js");
    const { blankCapitalRow } = await import("./capital-allowance.js");
    const original = blankCapitalRow(1, 2025);
    const form = createAssetTaxForm(original);
    Object.assign(form, {
      treatment: "claim",
      schemeId: "1",
      basisMode: "new",
      businessSource: "Trading",
      percentage: "80",
      firstYear: true,
    });
    form.amounts.qualifyingMinor = "5000.00";
    return {
      original,
      form,
      createAssetTaxForm,
      convert: () => assetTaxRowFromForm(original, form, 2025, [applied]),
    };
  }
  it("requires a Settings scheme and rejects unavailable choices", async () => {
    const { form, convert } = await setup();
    form.schemeId = "";
    expect(convert).toThrow("Choose a calculation scheme from Tax settings");
    form.schemeId = "999";
    expect(convert).toThrow("Choose a calculation scheme from Tax settings");
  });
  it("derives new additions once from cost/business use and ignores manual allowance inputs or overrides", async () => {
    const { form, convert } = await setup();
    Object.assign(form, { override: true, taxClass: "Unrelated class" });
    Object.assign(form.amounts, {
      initialMinor: "invalid hidden amount",
      annualMinor: "99999.00",
    });
    expect(convert()).toMatchObject({
      taxClass: definition.name,
      openingResidualMinor: 0,
      additionsMinor: 400000,
      initialMinor: 80000,
      annualMinor: 40000,
      schemeOverride: false,
    });
    form.percentage = "60";
    expect(convert()).toMatchObject({
      additionsMinor: 300000,
      initialMinor: 60000,
      annualMinor: 30000,
    });
    form.firstYear = false;
    expect(convert().initialMinor).toBe(0);
  });
  it("keeps brought-forward tax balances independent of the gross qualifying cost", async () => {
    const { form, convert } = await setup();
    form.basisMode = "existing";
    form.amounts.openingResidualMinor = "2800.00";
    form.amounts.additionsMinor = "";
    form.firstYear = false;
    expect(convert()).toMatchObject({
      openingResidualMinor: 280000,
      additionsMinor: 0,
      initialMinor: 0,
      annualMinor: 40000,
    });
  });
  it("preserves partial legacy additions instead of treating them as a full new purchase", async () => {
    const { original, createAssetTaxForm } = await setup();
    const retained = {
      ...original,
      treatment: "claim" as const,
      qualifyingMinor: 500000,
      businessUseBps: 8000,
      openingResidualMinor: 0,
      additionsMinor: 100000,
      initialMinor: 20000,
      annualMinor: 40000,
    };
    const before = JSON.stringify(retained);
    const form = createAssetTaxForm(retained);
    expect(form.basisMode).toBe("detailed");
    expect(form.amounts.additionsMinor).toBe("1000.00");
    expect(JSON.stringify(retained)).toBe(before);
  });
  it("uses the single remark for a new disposal while preserving existing disposal evidence", async () => {
    const { form, convert } = await setup();
    Object.assign(form, {
      disposed: true,
      disposalDate: "2025-11-01",
      proceeds: "2500.00",
      note: "Reviewed disposal computation",
    });
    expect(convert().disposal?.evidence).toBe("Reviewed disposal computation");
    form.disposalEvidence = "Retained working paper";
    expect(convert().disposal?.evidence).toBe("Retained working paper");
  });
});
