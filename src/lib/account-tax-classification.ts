import { z } from "zod";
import type { ExpenseTaxSnapshot } from "./expense-tax.js";

export const ACCOUNT_TAX_BATCH_LIMIT = 200;
export const accountTaxPreviewSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export const accountTaxApplySchema = accountTaxPreviewSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AccountTaxProtected = {
  resolved: number;
  individual: number;
  closed: number;
  voided: number;
  readOnly: number;
  ambiguous: number;
};
export type AccountTaxOverview = {
  eligibleCount: number;
  protected: AccountTaxProtected;
  hasResolvedDefault: boolean;
};
export type AccountTaxPreview = AccountTaxOverview & {
  revision: string;
  accountId: number;
  accountName: string;
  treatment: Pick<ExpenseTaxSnapshot, "treatment" | "percentageBps">;
  selectedCount: number;
  recordCount: number;
  remainingCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  expenseMinor: number;
  refundMinor: number;
  deductibleMinor: number;
  addBackMinor: number;
};
