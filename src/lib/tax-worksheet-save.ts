import { z } from "zod";
import { capitalInputSchema } from "./capital-allowance.js";
import { taxAdjustmentSchema, taxReason, taxVersion } from "./tax-worksheet.js";

/** One worksheet intent; child request keys remain stable across retries. */
export const taxWorksheetSaveSchema = z
  .object({
    action: z.literal("save-worksheet"),
    target: z.enum(["draft", "reviewed", "finalised"]),
    expectedVersion: taxVersion,
    requestKey: z.string().uuid(),
    liveHash: z.string().length(64),
    sourceHashes: z.record(z.string(), z.string().length(64)).default({}),
    adjustments: z.array(taxAdjustmentSchema).max(10000).default([]),
    withdrawals: z
      .array(
        z
          .object({
            adjustmentId: z.number().int().positive(),
            reason: taxReason,
          })
          .strict(),
      )
      .max(10000)
      .default([]),
    capital: z
      .object({
        input: capitalInputSchema,
        liveAssetHash: z.string().length(64),
        rolloverHash: z.string().length(64).nullable().optional(),
        confirmFirstYearTreatments: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TaxWorksheetSaveInput = z.input<typeof taxWorksheetSaveSchema>;
