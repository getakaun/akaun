import {
  resolveFirstYear,
  type FirstYearContext,
  type FirstYearTreatment,
} from "$lib/first-year-allowance.js";
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
  schemeId: string;
  firstYear: boolean;
  firstYearMode: FirstYearTreatment["mode"] | "retained";
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
    schemeId: row?.schemeId ? String(row.schemeId) : "",
    firstYear: row?.schemeFirstYear ?? false,
    firstYearMode:
      row?.firstYearTreatment?.mode ??
      (row?.treatment === "claim" &&
      !(row.annualMinor === null && row.additionsMinor === 0)
        ? "retained"
        : "auto"),
  };
}
export function assetTaxRowFromForm(
  original: CapitalRowInput,
  form: AssetTaxForm,
  year: number,
  schemes: AppliedAssetTaxScheme[],
  firstYear?: {
    context: FirstYearContext | undefined;
    asset: CapitalAssetEvidence | undefined;
    dateFrom: string;
    dateTo: string;
  },
): CapitalRowInput {
  if (form.treatment !== "claim")
    return {
      ...original,
      treatment: form.treatment,
      note: form.note,
      schemeId: null,
      appliedScheme: undefined,
      schemeFirstYear: false,
      firstYearTreatment: undefined,
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
    schemeId: scheme.id,
    schemeFirstYear: form.firstYear,
    appliedScheme: undefined,
  };
  if (form.percentage.trim() && row.businessUseBps === null)
    throw Error(
      "Enter business use between 0 and 100%, with at most two decimal places.",
    );
  if (firstYear && form.firstYearMode !== "retained") {
    row.firstYearTreatment = resolveFirstYear(
      form.firstYearMode,
      scheme.definition,
      row,
      firstYear.asset,
      firstYear.context,
      firstYear.dateFrom,
      firstYear.dateTo,
      form.note,
      "preview",
    );
    row.schemeFirstYear = row.firstYearTreatment.included;
  }
  row.appliedScheme = scheme;
  const preview = calculateAssetTaxScheme(scheme.definition, {
    ...row,
    firstYear: row.schemeFirstYear ?? false,
  });
  row.initialMinor = preview?.firstYearMinor ?? null;
  row.annualMinor = preview?.regularMinor ?? null;
  return row;
}
export function assetTaxFirstYearStatus(
  original: CapitalRowInput,
  form: AssetTaxForm,
  year: number,
  schemes: AppliedAssetTaxScheme[],
  firstYear?: {
    context: FirstYearContext | undefined;
    asset: CapitalAssetEvidence | undefined;
    dateFrom: string;
    dateTo: string;
  },
) {
  try {
    const unchanged =
      original.firstYearTreatment &&
      original.firstYearTreatment.historyHash ===
        firstYear?.context?.historyHash &&
      JSON.stringify(form) ===
        JSON.stringify(
          createAssetTaxForm(
            original,
            firstYear?.asset,
            firstYear?.dateFrom,
            firstYear?.dateTo,
          ),
        );
    const row = unchanged
      ? original
      : assetTaxRowFromForm(original, form, year, schemes, firstYear);
    return {
      included: row.schemeFirstYear ?? false,
      confirmation: row.firstYearTreatment?.confirmation,
      reason:
        row.firstYearTreatment?.confirmation === "pending_save"
          ? "Calculated from this year's qualifying additions. Saving the worksheet confirms the treatment."
          : row.firstYearTreatment?.confirmation === "worksheet_save"
            ? "Treatment confirmed when saving the worksheet."
            : (row.firstYearTreatment?.reason ??
              "Using the previously saved first-year treatment."),
    };
  } catch (error) {
    return {
      included: null,
      confirmation: undefined,
      reason:
        error instanceof Error
          ? error.message
          : "Confirm the first-year treatment.",
    };
  }
}
export type CapitalUseForm = {
  source: string;
  origin: string;
  balance: string;
  used: string;
};
