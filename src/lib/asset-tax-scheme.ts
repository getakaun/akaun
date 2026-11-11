import { z } from "zod";

export class AssetTaxSchemeError extends Error {}
export const taxJurisdictionSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, "Use a two-letter tax jurisdiction code.");
export const TAX_JURISDICTIONS = [
  { code: "MY", label: "Malaysia" },
  { code: "GB", label: "United Kingdom" },
  { code: "US", label: "United States" },
] as const;
export function taxJurisdictionLabel(code: string | null | undefined) {
  return (
    TAX_JURISDICTIONS.find((j) => j.code === code)?.label ??
    code ??
    "Not selected"
  );
}
export const assetTaxSchemeDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    jurisdiction: taxJurisdictionSchema,
    yearFrom: z.number().int().min(2000).max(9999),
    yearTo: z.number().int().min(2000).max(9999).nullable(),
    method: z.enum(["original_cost", "reducing_balance"]),
    firstYearRateBps: z.number().int().min(0).max(10000),
    regularRateBps: z.number().int().min(0).max(10000),
    reference: z.string().trim().min(1).max(2000),
    conditions: z.string().trim().max(2000),
  })
  .strict()
  .refine(
    (v) => v.yearTo === null || v.yearTo >= v.yearFrom,
    "The end tax year cannot precede the start year.",
  );
export const appliedAssetTaxSchemeSchema = z
  .object({
    id: z.number().int().positive(),
    familyKey: z.string().uuid(),
    version: z.number().int().positive(),
    definition: assetTaxSchemeDefinitionSchema,
    verification: z.literal("custom_unverified"),
  })
  .strict();
export type AssetTaxSchemeDefinition = z.infer<
  typeof assetTaxSchemeDefinitionSchema
>;
export type AppliedAssetTaxScheme = z.infer<typeof appliedAssetTaxSchemeSchema>;
export type SchemeBasis = {
  qualifyingMinor: number | null;
  businessUseBps: number | null;
  openingResidualMinor: number | null;
  additionsMinor: number | null;
  residualAdjustmentMinor: number;
  firstYear: boolean;
};
const safe = (n: bigint) => {
  const result = Number(n);
  if (!Number.isSafeInteger(result))
    throw new AssetTaxSchemeError(
      "The scheme amount exceeds safe integer minor units.",
    );
  return result;
};
const roundRate = (minor: bigint, bps: number) =>
  (minor * BigInt(bps) + 5000n) / 10000n;
/** Configurable full-period arithmetic, not a country's eligibility/rate engine. */
export function calculateAssetTaxScheme(
  definition: AssetTaxSchemeDefinition,
  basis: SchemeBasis,
) {
  if (
    [
      basis.qualifyingMinor,
      basis.businessUseBps,
      basis.openingResidualMinor,
      basis.additionsMinor,
    ].some((n) => n === null)
  )
    return null;
  for (const n of [
    basis.qualifyingMinor!,
    basis.openingResidualMinor!,
    basis.additionsMinor!,
  ]) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new AssetTaxSchemeError(
        "Enter non-negative amounts in whole minor units.",
      );
  }
  if (
    !Number.isSafeInteger(basis.residualAdjustmentMinor) ||
    !Number.isInteger(basis.businessUseBps) ||
    basis.businessUseBps! < 0 ||
    basis.businessUseBps! > 10000
  )
    throw new AssetTaxSchemeError(
      "Choose valid business use and a precise residual adjustment.",
    );
  const eligible = roundRate(
    BigInt(basis.qualifyingMinor!),
    basis.businessUseBps!,
  );
  const opening = BigInt(basis.openingResidualMinor!),
    additions = BigInt(basis.additionsMinor!);
  const available = opening + additions + BigInt(basis.residualAdjustmentMinor);
  if (opening + additions > eligible || available < 0n || available > eligible)
    throw new AssetTaxSchemeError(
      "Opening residual, additions and adjustments must reconcile to business-use qualifying expenditure.",
    );
  const firstBase = basis.firstYear ? additions : 0n;
  const firstSuggested = roundRate(firstBase, definition.firstYearRateBps);
  const first = firstSuggested > available ? available : firstSuggested;
  const afterFirst = available - first;
  const regularBase =
    definition.method === "original_cost" ? eligible : afterFirst;
  const regularSuggested = roundRate(regularBase, definition.regularRateBps);
  const regular = regularSuggested > afterFirst ? afterFirst : regularSuggested;
  return {
    eligibleMinor: safe(eligible),
    firstYearBasisMinor: safe(firstBase),
    regularBasisMinor: safe(regularBase),
    firstYearMinor: safe(first),
    regularMinor: safe(regular),
    closingMinor: safe(afterFirst - regular),
    capped: first !== firstSuggested || regular !== regularSuggested,
  };
}
export function schemeApplies(
  definition: AssetTaxSchemeDefinition,
  jurisdiction: string | null | undefined,
  year: number,
) {
  return (
    definition.jurisdiction === jurisdiction &&
    year >= definition.yearFrom &&
    (definition.yearTo === null || year <= definition.yearTo)
  );
}
