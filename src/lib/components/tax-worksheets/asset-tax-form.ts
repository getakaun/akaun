import { percentageToBps } from "$lib/expense-tax.js";
import { taxDecimal, taxMoneyMinor } from "$lib/tax-worksheet.js";
import {
  calculateAssetTaxScheme,
  type AppliedAssetTaxScheme,
} from "$lib/asset-tax-scheme.js";
import type {
  CapitalAssetEvidence,
  CapitalRowInput,
} from "$lib/capital-allowance.js";
export const ASSET_TAX_AMOUNT_FIELDS = [
  "qualifyingMinor",
  "openingResidualMinor",
  "additionsMinor",
] as const;
export type AssetTaxForm = {
  treatment: CapitalRowInput["treatment"];
  basisMode: "new" | "existing" | "detailed";
  businessSource: string;
  percentage: string;
  amounts: Record<(typeof ASSET_TAX_AMOUNT_FIELDS)[number], string>;
  residualAdjustment: string;
  note: string;
  disposed: boolean;
  disposalDate: string;
  proceeds: string;
  balancingAllowance: string;
  balancingCharge: string;
  disposalEvidence: string;
  schemeId: string;
  firstYear: boolean;
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
  asset?: CapitalAssetEvidence,
  dateFrom?: string,
  dateTo?: string,
): AssetTaxForm {
  const eligible =
    row?.qualifyingMinor != null && row?.businessUseBps != null
      ? Number(
          (BigInt(row.qualifyingMinor) * BigInt(row.businessUseBps) + 5000n) /
            10000n,
        )
      : null;
  return {
    treatment: row?.treatment ?? "pending",
    basisMode:
      row?.openingResidualMinor === 0 &&
      (row?.additionsMinor ?? 0) > 0 &&
      row?.additionsMinor === eligible
        ? "new"
        : row?.additionsMinor === 0
          ? "existing"
          : row?.openingResidualMinor != null
            ? "detailed"
            : asset && dateFrom && dateTo
              ? asset.acquisitionDate >= dateFrom &&
                asset.acquisitionDate <= dateTo
                ? "new"
                : "existing"
              : "detailed",
    businessSource: row?.businessSource ?? "",
    percentage:
      row?.businessUseBps == null ? "" : String(row.businessUseBps / 100),
    amounts: Object.fromEntries(
      ASSET_TAX_AMOUNT_FIELDS.map((key) => [key, amountInput(row?.[key])]),
    ) as AssetTaxForm["amounts"],
    residualAdjustment: amountInput(row?.residualAdjustmentMinor ?? 0),
    note: row?.note ?? "",
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
  };
}
export function assetTaxRowFromForm(
  original: CapitalRowInput,
  form: AssetTaxForm,
  year: number,
  schemes: AppliedAssetTaxScheme[],
): CapitalRowInput {
  if (form.treatment !== "claim")
    return {
      ...original,
      treatment: form.treatment,
      note: form.note,
      effectiveYa: year,
      disposal: null,
      schemeId: null,
      appliedScheme: undefined,
      schemeFirstYear: false,
      schemeOverride: false,
    };
  const scheme =
    schemes.find((s) => String(s.id) === form.schemeId) ??
    (String(original.appliedScheme?.id) === form.schemeId
      ? original.appliedScheme
      : undefined);
  if (!scheme)
    throw Error(
      "Choose a calculation scheme from Tax settings before saving this asset.",
    );
  const qualifyingMinor = parseTaxAmount(form.amounts.qualifyingMinor, true);
  const businessUseBps = form.percentage.trim()
    ? percentageToBps(form.percentage)
    : null;
  const newAdditions =
    qualifyingMinor === null || businessUseBps === null
      ? null
      : Number(
          (BigInt(qualifyingMinor) * BigInt(businessUseBps) + 5000n) / 10000n,
        );
  const row: CapitalRowInput = {
    ...original,
    treatment: form.treatment,
    taxClass: scheme.definition.name.slice(0, 100),
    businessSource: form.businessSource,
    qualifyingMinor,
    openingResidualMinor:
      form.basisMode === "new"
        ? 0
        : parseTaxAmount(form.amounts.openingResidualMinor, true),
    additionsMinor:
      form.basisMode === "new"
        ? newAdditions
        : parseTaxAmount(form.amounts.additionsMinor || "0", true),
    initialMinor: null,
    annualMinor: null,
    businessUseBps,
    residualAdjustmentMinor: parseTaxAmount(
      form.residualAdjustment,
      false,
      true,
    )!,
    note: form.note,
    effectiveYa: year,
    schemeId: scheme.id,
    schemeFirstYear: form.firstYear,
    schemeOverride: false,
    appliedScheme: undefined,
    disposal:
      form.treatment === "claim" && form.disposed
        ? {
            date: form.disposalDate,
            proceedsMinor: parseTaxAmount(form.proceeds)!,
            balancingAllowanceMinor: parseTaxAmount(form.balancingAllowance)!,
            balancingChargeMinor: parseTaxAmount(form.balancingCharge)!,
            evidence: form.disposalEvidence || form.note,
          }
        : null,
  };
  if (form.percentage.trim() && row.businessUseBps === null)
    throw Error(
      "Enter business use between 0 and 100%, with at most two decimal places.",
    );
  row.appliedScheme = scheme;
  const preview = calculateAssetTaxScheme(scheme.definition, {
    ...row,
    firstYear: form.firstYear,
  });
  row.initialMinor = preview?.firstYearMinor ?? null;
  row.annualMinor = preview?.regularMinor ?? null;
  return row;
}
export type CapitalUseForm = {
  source: string;
  origin: string;
  balance: string;
  used: string;
};
