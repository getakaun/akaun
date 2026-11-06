import { z } from "zod";
import {
  taxValuesSchema,
  needsTaxReview,
  type ExpenseTaxSnapshot,
} from "./expense-tax.js";

export const BULK_TAX_LIMIT = 200;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const treatmentAction = z
  .object({ kind: z.literal("treatment"), ...taxValuesSchema.shape })
  .strict()
  .superRefine((value, ctx) => {
    const valid = taxValuesSchema.safeParse(value);
    if (!valid.success || needsTaxReview(value))
      ctx.addIssue({
        code: "custom",
        message: "Choose a resolved treatment and a valid percentage.",
      });
  });
export const bulkTaxSchema = z
  .object({
    dateFrom: date,
    dateTo: date,
    accountId: z.number().int().positive().nullable().default(null),
    movementIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(BULK_TAX_LIMIT)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each line only once.",
      ),
    reason: z.string().trim().min(1).max(500),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("account-default") }).strict(),
      treatmentAction,
    ]),
  })
  .strict()
  .refine(
    (value) => value.dateFrom <= value.dateTo,
    "The start date must not follow the end date.",
  );
export const bulkTaxApplySchema = bulkTaxSchema.safeExtend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BulkTaxInput = z.output<typeof bulkTaxSchema>;
export type BulkTaxLine = {
  movementId: number;
  recordId: number;
  recordNumber: string | null;
  date: string;
  accountId: number;
  accountName: string;
  description: string;
  amountMinor: number;
  before: ExpenseTaxSnapshot | null;
  after: Pick<
    ExpenseTaxSnapshot,
    "percentageBps" | "treatment" | "source"
  > | null;
  deductibleMinor: number | null;
  addBackMinor: number | null;
  blockedReason: string | null;
};
export type BulkTaxPreview = {
  revision: string;
  lines: BulkTaxLine[];
  eligibleLineCount: number;
  recordCount: number;
  skippedLineCount: number;
  expenseMinor: number;
  refundMinor: number;
  deductibleMinor: number;
  addBackMinor: number;
  unresolvedBefore: number;
  unresolvedAfter: number;
};
