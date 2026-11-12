import { z } from "zod";
import { currencyMeta } from "./currency.js";
import {
  deductionMinor,
  needsTaxReview,
  taxValuesSchema,
  type ExpenseTaxSnapshot,
  type TaxTreatment,
} from "./expense-tax.js";

export const TAX_PREPARATION_NOTE =
  "Preparatory worksheet for accountant review. Not a tax return, filing-ready computation or calculation of tax payable. Manual claims and utilisation require eligibility and ordering review.";
export class TaxCalculationError extends Error {}
export const taxReason = z.string().trim().min(10).max(2000);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const taxVersion = z.number().int().positive();
export const taxCreateSchema = z
  .object({
    ya: z.number().int().min(2000).max(9999),
    dateFrom: z.iso.date(),
    dateTo: z.iso.date(),
    requestKey: z.string().uuid(),
  })
  .strict()
  .refine(
    (v) => v.dateFrom <= v.dateTo,
    "Choose a valid inclusive accounting period.",
  );
export const taxManualKinds = [
  "other",
  "capital_allowance",
  "allowance_brought_forward",
  "loss_brought_forward",
] as const;
export type TaxManualKind = (typeof taxManualKinds)[number];
export const taxManualLabels: Record<TaxManualKind, string> = {
  other: "Other tax adjustment",
  capital_allowance: "Current-year capital allowance claim",
  allowance_brought_forward: "Brought-forward capital allowances",
  loss_brought_forward: "Brought-forward business losses",
};
export const taxAdjustmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      sourceMovementId: z.number().int().positive(),
      ...taxValuesSchema.shape,
      reason: taxReason,
      evidence: z.string().trim().min(1).max(1000),
      requestKey: z.string().uuid(),
      expectedVersion: taxVersion,
    })
    .strict()
    .refine(
      (v) => taxValuesSchema.safeParse(v).success && !needsTaxReview(v),
      "Choose a resolved treatment and matching percentage.",
    ),
  z
    .object({
      kind: z.enum(taxManualKinds),
      direction: z.enum(["increase", "decrease"]),
      amountMinor: cents,
      balanceMinor: cents.default(0),
      originYa: z.number().int().min(2000).max(9999).nullable().default(null),
      reason: taxReason,
      evidence: z.string().trim().min(1).max(1000),
      requestKey: z.string().uuid(),
      expectedVersion: taxVersion,
    })
    .strict()
    .superRefine((v, ctx) => {
      const carry =
        v.kind === "allowance_brought_forward" ||
        v.kind === "loss_brought_forward";
      if (v.kind !== "other" && v.direction !== "decrease")
        ctx.addIssue({
          code: "custom",
          message: "Claims and utilisation decrease the result.",
        });
      if (
        carry
          ? v.originYa === null || v.amountMinor > v.balanceMinor
          : v.balanceMinor !== 0 || v.originYa !== null
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Carry-forwards need an origin YA and utilisation no greater than the reviewed balance; other entries have no brought-forward balance.",
        });
      if (!carry && v.amountMinor === 0)
        ctx.addIssue({ code: "custom", message: "Enter a positive amount." });
    }),
]);
export type TaxAdjustmentInput = z.output<typeof taxAdjustmentSchema>;
export type TaxSource = {
  movementId: number;
  recordId: number;
  recordNumber: string | null;
  date: string;
  description: string;
  label: string | null;
  accountId: number;
  accountName: string;
  expenseMinor: number;
  classification: ExpenseTaxSnapshot | null;
  voided: boolean;
};
export type TaxSourceSnapshot = {
  calculationVersion: 1;
  /** Unresolved annual corrections retained across draft source updates. */
  pendingCorrectionIds?: number[];
  currency: string;
  companyName: string;
  profitMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  profitLines: {
    accountId: number;
    accountName: string;
    amountMinor: number;
    type: "income" | "expense";
  }[];
  notes: string[];
  expenses: TaxSource[];
};
export type TaxAdjustment = {
  id: number;
  revisionId: number;
  kind: "source" | TaxManualKind;
  sourceMovementId: number | null;
  percentageBps: number | null;
  treatment: TaxTreatment | null;
  amountMinor: number;
  direction: "increase" | "decrease";
  balanceMinor: number;
  originYa: number | null;
  reason: string;
  evidence: string;
  requestKey: string;
  createdBy: number | null;
  actorName: string;
  createdAt: string;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
};

export function safeTaxSum(values: number[]): number {
  const total = values.reduce((sum, n) => {
    if (!Number.isSafeInteger(n))
      throw new TaxCalculationError("Tax amounts must be safe integer cents.");
    return sum + BigInt(n);
  }, 0n);
  const result = Number(total);
  if (!Number.isSafeInteger(result))
    throw new TaxCalculationError(
      "The worksheet total exceeds safe integer cents.",
    );
  return result;
}

export function taxWorksheetTotals(
  snapshot: TaxSourceSnapshot,
  adjustments: TaxAdjustment[],
  capital: { effectMinor: number } | null = null,
) {
  const active = adjustments.filter(
    (a) =>
      a.withdrawnAt === null && !snapshot.pendingCorrectionIds?.includes(a.id),
  );
  const corrections = new Map(
    active
      .filter((a) => a.kind === "source")
      .map((a) => [a.sourceMovementId, a]),
  );
  const lines = snapshot.expenses.map((source) => {
    const correction = corrections.get(source.movementId);
    const effective = correction
      ? {
          percentageBps: correction.percentageBps,
          treatment: correction.treatment ?? "unclassified",
        }
      : source.classification;
    const unresolved = needsTaxReview(effective) && !source.voided;
    const originalDeduction = needsTaxReview(source.classification)
      ? null
      : deductionMinor(
          source.expenseMinor,
          source.classification!.percentageBps!,
        );
    const deduction = needsTaxReview(effective)
      ? null
      : deductionMinor(source.expenseMinor, effective!.percentageBps!);
    const originalAddBack =
      originalDeduction === null
        ? null
        : safeTaxSum([source.expenseMinor, -originalDeduction]);
    const addBack =
      deduction === null ? null : safeTaxSum([source.expenseMinor, -deduction]);
    return {
      ...source,
      correctionId: correction?.id ?? null,
      effectivePercentageBps: effective?.percentageBps ?? null,
      effectiveTreatment: effective?.treatment ?? "unclassified",
      unresolved,
      originalAddBackMinor: originalAddBack,
      deductibleMinor: deduction,
      addBackMinor: addBack,
    };
  });
  const baseAddBackMinor = safeTaxSum(
    lines.map((l) => l.originalAddBackMinor ?? 0),
  );
  const addBackMinor = safeTaxSum(lines.map((l) => l.addBackMinor ?? 0));
  const manual = active.filter((a) => a.kind !== "source");
  const manualMinor = safeTaxSum(
    manual.map((a) =>
      a.direction === "increase" ? a.amountMinor : -a.amountMinor,
    ),
  );
  return {
    lines,
    baseAddBackMinor,
    correctionMinor: safeTaxSum([addBackMinor, -baseAddBackMinor]),
    addBackMinor,
    manualMinor,
    unresolvedCount: lines.filter((l) => l.unresolved).length,
    unresolvedMinor: safeTaxSum(
      lines.filter((l) => l.unresolved).map((l) => l.expenseMinor),
    ),
    capitalMinor: capital?.effectMinor ?? 0,
    resultMinor: safeTaxSum([
      snapshot.profitMinor,
      addBackMinor,
      manualMinor,
      capital?.effectMinor ?? 0,
    ]),
  };
}

/** Decimal entry without binary floating-point multiplication. */
export function taxMoneyMinor(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const value = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function taxDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor))
    throw new TaxCalculationError("Tax amounts must be safe integer cents.");
  const value = BigInt(minor);
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

/** Retained worksheet currency and exact cents, independent of current settings. */
export function formatTaxMinor(minor: number, currency: string): string {
  const [whole, decimals] = taxDecimal(minor).split(".");
  return `${currencyMeta(currency).symbol} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals}`;
}
