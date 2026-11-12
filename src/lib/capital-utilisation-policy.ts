import { z } from "zod";

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const utilisationPolicySchema = z
  .object({
    version: z.literal(1),
    singleBusiness: z.boolean().default(true),
    income: z
      .array(
        z
          .object({
            businessSource: z.string().trim().min(1).max(100),
            capacityMinor: cents,
            reason: z.string().trim().min(10).max(2000),
            basisHash: z.string().length(64),
            adjustmentKey: z.string().max(2000000),
          })
          .strict(),
      )
      .max(10000),
    overrides: z
      .array(
        z
          .object({
            businessSource: z.string().trim().min(1).max(100),
            usedMinor: cents,
            reason: z.string().trim().min(10).max(2000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type UtilisationPolicy = z.infer<typeof utilisationPolicySchema>;
export const automaticUtilisation = (): UtilisationPolicy => ({
  version: 1,
  singleBusiness: true,
  income: [],
  overrides: [],
});
export type UtilisationEvidence = {
  version: 1;
  basisHash: string;
  adjustmentKey: string;
  allocation: "oldest_first";
  excludedIncome?: {
    accountId: number;
    accountName: string;
    amountMinor: number;
  }[];
  groups: {
    businessSource: string;
    capacityMinor: number | null;
    basis: "bookkeeping" | "reviewed" | "needs_review";
    availableMinor: number;
    usedMinor: number;
    carriedMinor: number;
    restrictedMinor: number;
    overrideReason: string | null;
  }[];
  problems: string[];
};
