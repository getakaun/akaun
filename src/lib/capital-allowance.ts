import { z } from "zod";
import { firstYearTreatmentSchema } from "./first-year-allowance.js";
import {
  utilisationPolicySchema,
  type UtilisationEvidence,
} from "./capital-utilisation-policy.js";
import {
  appliedAssetTaxSchemeSchema,
  taxJurisdictionSchema,
  calculateAssetTaxScheme,
  schemeApplies,
} from "./asset-tax-scheme.js";

export class CapitalAllowanceError extends Error {}
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedCents = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().max(2000);
export const capitalRowSchema = z
  .object({
    assetId: z.number().int().positive(),
    schemeId: z.number().int().positive().nullable().optional(),
    schemeFirstYear: z.boolean().optional(),
    firstYearTreatment: firstYearTreatmentSchema.optional(),
    appliedScheme: appliedAssetTaxSchemeSchema.optional(),
    treatment: z.enum(["pending", "claim", "exclude"]),
    taxClass: z.string().trim().max(100),
    businessSource: z.string().trim().max(100),
    qualifyingMinor: cents.nullable(),
    businessUseBps: z.number().int().min(0).max(10000).nullable(),
    openingResidualMinor: cents.nullable(),
    additionsMinor: cents.nullable(),
    initialMinor: cents.nullable(),
    annualMinor: cents.nullable(),
    residualAdjustmentMinor: signedCents,
    note: text,
  })
  .strict();
export const capitalUseSchema = z
  .object({
    businessSource: z.string().trim().min(1).max(100),
    originYa: z.number().int().min(2000).max(9999),
    balanceMinor: cents,
    usedMinor: cents,
    restrictedMinor: cents.optional(),
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.usedMinor) + BigInt(v.restrictedMinor ?? 0) <=
      BigInt(v.balanceMinor),
    "Utilisation cannot exceed the reviewed balance.",
  );
export const capitalInputSchema = z
  .object({
    jurisdiction: taxJurisdictionSchema.nullable().optional(),
    evidence: text,
    rows: z.array(capitalRowSchema).max(10000),
    utilisation: z.array(capitalUseSchema).max(10000),
    utilisationPolicy: utilisationPolicySchema.optional(),
  })
  .strict();
export type CapitalRowInput = z.infer<typeof capitalRowSchema>;
export type CapitalInput = z.infer<typeof capitalInputSchema>;
export type CapitalAssetEvidence = {
  assetId: number;
  name: string;
  assetType: string;
  acquisitionDate: string;
  inServiceDate: string | null;
  costMinor: number;
  sourceRecordId: number | null;
  documentReference: string;
  version: string;
  sourceVersion: string | null;
  reviewReason: string | null;
};
export type CapitalPredecessor = {
  worksheetId: number;
  revisionId: number;
  ya: number;
  hash: string;
};
export type CapitalSchedule = CapitalInput & {
  calculationVersion: 2;
  currency: string;
  assets: CapitalAssetEvidence[];
  predecessor: CapitalPredecessor | null;
  utilisationEvidence?: UtilisationEvidence;
};

export function capitalSum(values: number[]) {
  const total = values.reduce((sum, n) => {
    if (!Number.isSafeInteger(n))
      throw new CapitalAllowanceError(
        "Capital allowance amounts must be safe integer cents.",
      );
    return sum + BigInt(n);
  }, 0n);
  const value = Number(total);
  if (!Number.isSafeInteger(value))
    throw new CapitalAllowanceError(
      "The capital allowance total exceeds safe integer cents.",
    );
  return value;
}

/** Validates scheme-derived deductions against declared asset tax basis. */
export function capitalTotals(schedule: CapitalSchedule, ya: number) {
  const problems: string[] = [];
  if (!schedule.jurisdiction)
    problems.push(
      "Select the tax jurisdiction independently of the book currency.",
    );
  const ids = new Set<number>();
  const assets = new Map(schedule.assets.map((a) => [a.assetId, a]));
  const rows = schedule.rows.map((row) => {
    const asset = assets.get(row.assetId);
    const issues: string[] = [];
    if (!asset || ids.has(row.assetId))
      throw new CapitalAllowanceError(
        "Choose each registered asset exactly once.",
      );
    ids.add(row.assetId);
    if (row.treatment === "pending") issues.push("Choose a tax treatment.");
    if (row.treatment === "exclude" && !row.note)
      issues.push("Explain why this asset is excluded.");
    let allowanceMinor = 0;
    let closingResidualMinor: number | null = null;
    if (row.treatment === "claim") {
      if (asset.reviewReason)
        issues.push("Resolve the asset register review first.");
      if (!row.taxClass || !row.businessSource)
        issues.push("Confirm the tax class and business source.");
      if (
        row.firstYearTreatment &&
        row.firstYearTreatment.included !== !!row.schemeFirstYear
      )
        issues.push(
          "The saved first-year treatment does not match the calculation.",
        );
      if (!row.schemeId)
        issues.push("Choose a calculation scheme from Tax settings.");
      else {
        if (!row.appliedScheme || row.appliedScheme.id !== row.schemeId)
          issues.push("Apply a retained custom scheme version.");
        else {
          if (
            !schemeApplies(
              row.appliedScheme.definition,
              schedule.jurisdiction,
              ya,
            )
          )
            issues.push(
              "The scheme jurisdiction or effective tax year does not match this worksheet.",
            );
          try {
            const calculated = calculateAssetTaxScheme(
              row.appliedScheme.definition,
              { ...row, firstYear: row.schemeFirstYear ?? false },
            );
            if (
              calculated &&
              (row.initialMinor !== calculated.firstYearMinor ||
                row.annualMinor !== calculated.regularMinor)
            )
              issues.push(
                "The deduction amounts must match the selected scheme calculation.",
              );
          } catch (error) {
            issues.push(
              error instanceof Error
                ? error.message
                : "The scheme basis needs review.",
            );
          }
        }
      }
      const amounts = [
        row.qualifyingMinor,
        row.businessUseBps,
        row.openingResidualMinor,
        row.additionsMinor,
        row.initialMinor,
        row.annualMinor,
      ];
      if (amounts.some((n) => n === null))
        issues.push(
          "Complete qualifying expenditure, business use and the annual workings.",
        );
      else {
        const eligibleMinor = Number(
          (BigInt(row.qualifyingMinor!) * BigInt(row.businessUseBps!) + 5000n) /
            10000n,
        );
        allowanceMinor = capitalSum([row.initialMinor!, row.annualMinor!]);
        const available = capitalSum([
          row.openingResidualMinor!,
          row.additionsMinor!,
          row.residualAdjustmentMinor,
        ]);
        if (
          capitalSum([row.openingResidualMinor!, row.additionsMinor!]) >
          eligibleMinor
        )
          issues.push(
            "Opening residual plus additions exceed business-use qualifying expenditure.",
          );
        if (
          available < 0 ||
          available > eligibleMinor ||
          allowanceMinor > available
        )
          issues.push(
            "The tax residual does not reconcile to qualifying expenditure and allowances.",
          );
        const remaining = capitalSum([available, -allowanceMinor]);
        closingResidualMinor = remaining;
        if (row.residualAdjustmentMinor && !row.note)
          issues.push("Explain the residual expenditure adjustment.");
      }
    }
    problems.push(...issues.map((issue) => `${asset.name}: ${issue}`));
    return {
      ...row,
      asset,
      issues,
      allowanceMinor,
      closingResidualMinor,
    };
  });
  if (ids.size !== assets.size)
    throw new CapitalAllowanceError(
      "Retain all prepared assets; explicitly exclude assets instead of removing them.",
    );
  const sources = new Set([
    ...rows.filter((r) => r.treatment === "claim").map((r) => r.businessSource),
    ...schedule.utilisation.map((u) => u.businessSource),
  ]);
  const useKeys = new Set<string>();
  for (const use of schedule.utilisation) {
    const key = JSON.stringify([use.businessSource, use.originYa]);
    if (useKeys.has(key))
      throw new CapitalAllowanceError(
        "Enter one utilisation balance per business source and origin YA.",
      );
    useKeys.add(key);
    if (use.originYa > ya)
      throw new CapitalAllowanceError(
        "An allowance balance cannot originate in a future YA.",
      );
  }
  const groups = [...sources].sort().map((businessSource) => {
    const sourceRows = rows.filter(
      (r) => r.treatment === "claim" && r.businessSource === businessSource,
    );
    const availableMinor = capitalSum(sourceRows.map((r) => r.allowanceMinor));
    const current = schedule.utilisation.find(
      (u) => u.businessSource === businessSource && u.originYa === ya,
    );
    if (!current)
      problems.push(
        `${businessSource || "Business source"}: confirm current-year utilisation, including zero.`,
      );
    else if (current.balanceMinor !== availableMinor)
      problems.push(
        `${businessSource}: current-year balance must match the schedule allowances.`,
      );
    const uses = schedule.utilisation.filter(
      (u) => u.businessSource === businessSource,
    );
    return {
      businessSource,
      availableMinor,
      usedMinor: capitalSum(uses.map((u) => u.usedMinor)),
      broughtForwardMinor: capitalSum(
        uses.filter((u) => u.originYa < ya).map((u) => u.balanceMinor),
      ),
      carryForwardMinor: capitalSum(
        uses.map((u) =>
          capitalSum([u.balanceMinor, -u.usedMinor, -(u.restrictedMinor ?? 0)]),
        ),
      ),
      restrictedMinor: capitalSum(uses.map((u) => u.restrictedMinor ?? 0)),
    };
  });
  const allowanceMinor = capitalSum(groups.map((g) => g.availableMinor));
  const usedMinor = capitalSum(groups.map((g) => g.usedMinor));
  if (schedule.utilisationPolicy)
    problems.push(
      ...(schedule.utilisationEvidence?.problems ?? [
        "Save the worksheet to calculate automatic utilisation.",
      ]),
    );
  return {
    rows,
    groups,
    problems,
    allowanceMinor,
    usedMinor,
    carryForwardMinor: capitalSum(groups.map((g) => g.carryForwardMinor)),
    effectMinor: usedMinor === 0 ? 0 : -usedMinor,
  };
}

export function blankCapitalRow(assetId: number): CapitalRowInput {
  return {
    assetId,
    treatment: "pending",
    taxClass: "",
    businessSource: "",
    qualifyingMinor: null,
    businessUseBps: null,
    openingResidualMinor: null,
    additionsMinor: null,
    initialMinor: null,
    annualMinor: null,
    residualAdjustmentMinor: 0,
    note: "",
  };
}
