import { z } from "zod";
import { firstYearTreatmentSchema } from "./first-year-allowance.js";
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
    schemeOverride: z.boolean().optional(),
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
    ruleReference: text,
    effectiveYa: z.number().int().min(2000).max(9999),
    disposal: z
      .object({
        date: z.iso.date(),
        proceedsMinor: cents,
        balancingAllowanceMinor: cents,
        balancingChargeMinor: cents,
        evidence: text.min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const capitalUseSchema = z
  .object({
    businessSource: z.string().trim().min(1).max(100),
    originYa: z.number().int().min(2000).max(9999),
    balanceMinor: cents,
    usedMinor: cents,
  })
  .strict()
  .refine(
    (v) => v.usedMinor <= v.balanceMinor,
    "Utilisation cannot exceed the reviewed balance.",
  );
export const capitalInputSchema = z
  .object({
    jurisdiction: taxJurisdictionSchema.nullable().optional(),
    evidence: text,
    rows: z.array(capitalRowSchema).max(10000),
    utilisation: z.array(capitalUseSchema).max(10000),
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
  calculationVersion: 1 | 2;
  currency: string;
  assets: CapitalAssetEvidence[];
  predecessor: CapitalPredecessor | null;
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

/** Only arithmetic on accountant-entered amounts; no statutory rates or eligibility rules. */
export function capitalTotals(
  schedule: CapitalSchedule,
  ya: number,
  dateFrom: string,
  dateTo: string,
) {
  const problems: string[] = [];
  if (schedule.calculationVersion === 2 && !schedule.jurisdiction)
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
    if (row.effectiveYa !== ya)
      issues.push("Confirm the effective YA for this worksheet.");
    if (row.treatment === "exclude" && !row.note)
      issues.push("Explain why this asset is excluded.");
    let allowanceMinor = 0;
    let closingResidualMinor: number | null = null;
    let residualRemovedMinor = 0;
    if (row.treatment === "claim") {
      if (asset.reviewReason)
        issues.push("Resolve the asset register review first.");
      if (!row.taxClass || !row.businessSource)
        issues.push("Confirm the tax class and business source.");
      if (
        schedule.calculationVersion === 1 &&
        !(row.ruleReference || schedule.evidence)
      )
        issues.push("Add a source or working-paper reference.");
      if (
        row.firstYearTreatment &&
        row.firstYearTreatment.included !== !!row.schemeFirstYear
      )
        issues.push(
          "The saved first-year treatment does not match the calculation.",
        );
      if (row.schemeId) {
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
          if (row.schemeOverride) {
            if (row.note.trim().length < 10)
              issues.push("Explain the manual override of scheme amounts.");
          } else {
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
                  "The entered amounts differ from the scheme preview. Reapply the scheme or explain a manual override.",
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
        if (row.disposal) {
          if (
            row.disposal.date < dateFrom ||
            row.disposal.date > dateTo ||
            row.disposal.date < asset.acquisitionDate
          )
            issues.push(
              "Choose a disposal date within the accounting period and after acquisition.",
            );
          if (
            row.disposal.balancingAllowanceMinor &&
            row.disposal.balancingChargeMinor
          )
            issues.push("Enter a balancing allowance or charge, not both.");
          residualRemovedMinor = remaining;
          closingResidualMinor = 0;
        }
      }
    } else if (row.disposal)
      issues.push("Disposal workings require the claim treatment.");
    problems.push(...issues.map((issue) => `${asset.name}: ${issue}`));
    return {
      ...row,
      asset,
      issues,
      allowanceMinor,
      closingResidualMinor,
      residualRemovedMinor,
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
    const availableMinor = capitalSum(
      sourceRows.map((r) =>
        capitalSum([
          r.allowanceMinor,
          r.disposal?.balancingAllowanceMinor ?? 0,
        ]),
      ),
    );
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
        uses.map((u) => capitalSum([u.balanceMinor, -u.usedMinor])),
      ),
    };
  });
  if (schedule.calculationVersion === 1 && !schedule.evidence)
    problems.push("Add the shared accountant working-paper reference.");
  const allowanceMinor = capitalSum(groups.map((g) => g.availableMinor));
  const usedMinor = capitalSum(groups.map((g) => g.usedMinor));
  const balancingChargeMinor = capitalSum(
    rows
      .filter((r) => r.treatment === "claim")
      .map((r) => r.disposal?.balancingChargeMinor ?? 0),
  );
  return {
    rows,
    groups,
    problems,
    allowanceMinor,
    usedMinor,
    balancingChargeMinor,
    carryForwardMinor: capitalSum(groups.map((g) => g.carryForwardMinor)),
    effectMinor: capitalSum([balancingChargeMinor, -usedMinor]),
  };
}

export function blankCapitalRow(assetId: number, ya: number): CapitalRowInput {
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
    ruleReference: "",
    effectiveYa: ya,
    disposal: null,
  };
}
