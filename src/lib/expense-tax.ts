import { z } from "zod";
import { AccountType } from "./enums.js";

export const TAX_TREATMENTS = [
  "ordinary_deductible",
  "partial",
  "non_deductible",
  "capital_expenditure",
  "requires_review",
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
export const TaxTreatmentLabels: Record<TaxTreatment, string> = {
  ordinary_deductible: "Ordinary deductible",
  partial: "Partial",
  non_deductible: "Non-deductible",
  capital_expenditure: "Capital expenditure",
  requires_review: "Requires review",
};
export const basisPointsSchema = z.number().int().min(0).max(10000);
export const taxTreatmentSchema = z.enum(TAX_TREATMENTS);
export const taxValuesSchema = z
  .object({
    percentageBps: basisPointsSchema.nullable(),
    treatment: taxTreatmentSchema,
  })
  .refine(
    ({ percentageBps: p, treatment: t }) =>
      t === "requires_review" ||
      (t === "ordinary_deductible" && p === 10000) ||
      (t === "partial" && p !== null && p > 0 && p < 10000) ||
      ((t === "non_deductible" || t === "capital_expenditure") && p === 0),
    {
      message:
        "The treatment must agree with the percentage (ordinary 100%, partial between 0% and 100%, non-deductible or capital expenditure 0%).",
    },
  );
export const taxOverrideSchema = z
  .object({
    accountId: z.number().int().positive(),
    /** Zero-based occurrence among movements on this account, in movement order. */
    occurrence: z.number().int().min(0).default(0),
    ...taxValuesSchema.shape,
    source: z
      .enum(["override", "account_default"])
      .optional()
      .describe(
        "Omit for a manual override. account_default explicitly reapplies the current default; percentage and treatment must match it.",
      ),
    reason: z.string().trim().min(1).max(500),
  })
  .superRefine((value, ctx) => {
    const result = taxValuesSchema.safeParse(value);
    if (!result.success)
      ctx.addIssue({ code: "custom", message: result.error.issues[0].message });
  });
export type TaxOverride = z.output<typeof taxOverrideSchema>;
export type ExpenseTaxSnapshot = {
  percentageBps: number | null;
  source: "account_default" | "override" | "unreviewed";
  treatment: TaxTreatment;
  reason: string | null;
  classifiedBy: number | null;
  classifiedAt: string;
  provenance:
    | "record_creation"
    | "account_change"
    | "line_override"
    | "account_default_reset";
};

export function treatmentForPercentage(p: number): TaxTreatment {
  return p === 10000
    ? "ordinary_deductible"
    : p === 0
      ? "non_deductible"
      : "partial";
}

/** Parses a decimal percentage by digits, never floating point multiplication. */
export function percentageToBps(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const value =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return value <= 10000 ? value : null;
}

/** Main-currency cents; halves away from zero on each line. */
export function deductionMinor(
  amountMinor: number,
  percentageBps: number,
): number {
  if (!Number.isSafeInteger(amountMinor))
    throw new Error("Expense amounts must be safe integer cents.");
  basisPointsSchema.parse(percentageBps);
  const product = BigInt(amountMinor) * BigInt(percentageBps);
  const magnitude = product < 0n ? -product : product;
  return Number((magnitude + 5000n) / 10000n) * (product < 0n ? -1 : 1);
}

/** Empty defaults mean unreviewed, never an implied 100% deduction. */
export function taxDefaultError(
  type: number,
  percentageBps: number | null,
  treatment: TaxTreatment | null,
): string | null {
  if (
    type !== AccountType.Expense &&
    (percentageBps !== null || treatment !== null)
  )
    return "Tax deduction defaults apply only to Expense accounts.";
  if (percentageBps === null)
    return treatment && treatment !== "requires_review"
      ? "Set a percentage for this treatment, or choose Requires review."
      : null;
  const result = taxValuesSchema.safeParse({
    percentageBps,
    treatment: treatment ?? treatmentForPercentage(percentageBps),
  });
  return result.success ? null : result.error.issues[0].message;
}

/** Classification status is independent of signed amount or accountant approval. */
export function needsTaxReview(
  tax:
    | Pick<ExpenseTaxSnapshot, "percentageBps" | "treatment">
    | null
    | undefined,
): boolean {
  return tax?.percentageBps == null || tax.treatment === "requires_review";
}

export type TaxFormDraft = { treatment: string; percentage: string };
/** Normalize only an explicitly edited form; never rewrite saved snapshots on read. */
export function taxFormValues(
  treatment: string,
  percentage: string,
  allowNoDefault = false,
): {
  treatment: TaxTreatment | null;
  percentageBps: number | null;
  error: string | null;
} {
  if (!treatment && allowNoDefault)
    return { treatment: null, percentageBps: null, error: null };
  const selected = taxTreatmentSchema.safeParse(treatment || "requires_review");
  if (!selected.success)
    return {
      treatment: null,
      percentageBps: null,
      error: "Choose a tax treatment.",
    };
  const t = selected.data;
  if (t === "requires_review")
    return { treatment: t, percentageBps: null, error: null };
  if (t !== "partial")
    return {
      treatment: t,
      percentageBps: t === "ordinary_deductible" ? 10000 : 0,
      error: null,
    };
  const p = percentageToBps(String(percentage));
  return {
    treatment: t,
    percentageBps: p,
    error:
      p === null || p <= 0 || p >= 10000
        ? "Enter a partial deduction from 0.01% to 99.99%, with at most two decimal places."
        : null,
  };
}

/** Keep a valid partial draft when switching, and never seed Partial with a fixed endpoint. */
export function switchTaxTreatment(
  current: TaxFormDraft,
  next: string,
  previousPartial = "",
) {
  const p = percentageToBps(String(current.percentage));
  const partial =
    current.treatment === "partial" && p !== null && p > 0 && p < 10000
      ? current.percentage
      : previousPartial;
  const values = taxFormValues(next, "", true);
  return {
    treatment: next,
    percentage:
      next === "partial"
        ? partial
        : values.percentageBps === null
          ? ""
          : (values.percentageBps / 100).toFixed(2),
    previousPartial: partial,
  };
}

/** The current account policy, distinct from a movement's saved effective values. */
export function accountTaxDefault(account: {
  defaultTaxPercentageBps?: number | null;
  defaultTaxTreatment?: TaxTreatment | null;
}): Pick<ExpenseTaxSnapshot, "percentageBps" | "treatment"> {
  const percentageBps = account.defaultTaxPercentageBps ?? null;
  return {
    percentageBps,
    treatment:
      account.defaultTaxTreatment ??
      (percentageBps === null
        ? "requires_review"
        : treatmentForPercentage(percentageBps)),
  };
}
