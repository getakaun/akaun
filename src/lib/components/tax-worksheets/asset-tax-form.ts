import { percentageToBps } from "$lib/expense-tax.js";
import { taxDecimal, taxMoneyMinor } from "$lib/tax-worksheet.js";
import {
  calculateAssetTaxScheme,
  type AppliedAssetTaxScheme,
} from "$lib/asset-tax-scheme.js";
import type { CapitalRowInput } from "$lib/capital-allowance.js";
export const ASSET_TAX_AMOUNT_FIELDS = [
  "qualifyingMinor",
  "openingResidualMinor",
  "additionsMinor",
  "initialMinor",
  "annualMinor",
] as const;
export type AssetTaxForm = {
  treatment: CapitalRowInput["treatment"];
  taxClass: string;
  businessSource: string;
  percentage: string;
  amounts: Record<(typeof ASSET_TAX_AMOUNT_FIELDS)[number], string>;
  residualAdjustment: string;
  note: string;
  ruleReference: string;
  disposed: boolean;
  disposalDate: string;
  proceeds: string;
  balancingAllowance: string;
  balancingCharge: string;
  disposalEvidence: string;
  schemeId: string;
  firstYear: boolean;
  override: boolean;
};
export const amountInput = (n: number | null | undefined) =>
  n == null ? "" : taxDecimal(n);
export function parseTaxAmount(
  raw: string,
  nullable = false,
  signed = false,
): number | null {
  if (nullable && !raw.trim()) return null;
  const negative = signed && raw.startsWith("-");
  const n = taxMoneyMinor(negative ? raw.slice(1) : raw);
  if (n === null) throw Error("Enter amounts with at most two decimal places.");
  return negative ? -n : n;
}
export function createAssetTaxForm(
  row: CapitalRowInput | undefined,
): AssetTaxForm {
  return {
    treatment: row?.treatment ?? "pending",
    taxClass: row?.taxClass ?? "",
    businessSource: row?.businessSource ?? "",
    percentage:
      row?.businessUseBps == null ? "" : String(row.businessUseBps / 100),
    amounts: Object.fromEntries(
      ASSET_TAX_AMOUNT_FIELDS.map((key) => [key, amountInput(row?.[key])]),
    ) as AssetTaxForm["amounts"],
    residualAdjustment: amountInput(row?.residualAdjustmentMinor ?? 0),
    note: row?.note ?? "",
    ruleReference: row?.ruleReference ?? "",
    disposed: !!row?.disposal,
    disposalDate: row?.disposal?.date ?? "",
    proceeds: amountInput(row?.disposal?.proceedsMinor),
    balancingAllowance: amountInput(
      row?.disposal?.balancingAllowanceMinor ?? 0,
    ),
    balancingCharge: amountInput(row?.disposal?.balancingChargeMinor ?? 0),
    disposalEvidence: row?.disposal?.evidence ?? "",
    schemeId: row?.schemeId ? String(row.schemeId) : "",
    firstYear: row?.schemeFirstYear ?? false,
    override: row?.schemeOverride ?? false,
  };
}
export function assetTaxRowFromForm(
  original: CapitalRowInput,
  form: AssetTaxForm,
  year: number,
  schemes: AppliedAssetTaxScheme[],
): CapitalRowInput {
  const automatic =
    !!form.schemeId && !form.override && form.treatment === "claim";
  const row: CapitalRowInput = {
    ...original,
    treatment: form.treatment,
    taxClass: form.taxClass,
    businessSource: form.businessSource,
    qualifyingMinor: parseTaxAmount(form.amounts.qualifyingMinor, true),
    openingResidualMinor: parseTaxAmount(
      form.amounts.openingResidualMinor,
      true,
    ),
    additionsMinor: parseTaxAmount(form.amounts.additionsMinor, true),
    initialMinor: automatic
      ? null
      : parseTaxAmount(form.amounts.initialMinor, true),
    annualMinor: automatic
      ? null
      : parseTaxAmount(form.amounts.annualMinor, true),
    businessUseBps: form.percentage.trim()
      ? percentageToBps(form.percentage)
      : null,
    residualAdjustmentMinor: parseTaxAmount(
      form.residualAdjustment,
      false,
      true,
    )!,
    note: form.note,
    ruleReference: form.ruleReference,
    effectiveYa: year,
    schemeId: form.schemeId ? Number(form.schemeId) : null,
    schemeFirstYear: form.firstYear,
    schemeOverride: form.override,
    appliedScheme: undefined,
    disposal:
      form.treatment === "claim" && form.disposed
        ? {
            date: form.disposalDate,
            proceedsMinor: parseTaxAmount(form.proceeds)!,
            balancingAllowanceMinor: parseTaxAmount(form.balancingAllowance)!,
            balancingChargeMinor: parseTaxAmount(form.balancingCharge)!,
            evidence: form.disposalEvidence,
          }
        : null,
  };
  if (form.percentage.trim() && row.businessUseBps === null)
    throw Error(
      "Enter business use between 0 and 100%, with at most two decimal places.",
    );
  if (row.treatment !== "claim")
    return {
      ...row,
      disposal: null,
      schemeId: null,
      appliedScheme: undefined,
      schemeFirstYear: false,
      schemeOverride: false,
    };
  if (row.schemeId) {
    const scheme =
      schemes.find((s) => s.id === row.schemeId) ?? original.appliedScheme;
    if (!scheme || scheme.id !== row.schemeId)
      throw Error("Choose an available custom scheme version.");
    row.appliedScheme = scheme;
    if (!form.override) {
      const preview = calculateAssetTaxScheme(scheme.definition, {
        ...row,
        firstYear: form.firstYear,
      });
      row.initialMinor = preview?.firstYearMinor ?? null;
      row.annualMinor = preview?.regularMinor ?? null;
    }
  }
  return row;
}
export type CapitalUseForm = {
  source: string;
  origin: string;
  balance: string;
  used: string;
};
