import type { TaxWorksheetDetail } from "../../queries/tax-worksheets.js";
import type { CapitalInput } from "$lib/capital-allowance.js";
import { automaticUtilisation } from "$lib/capital-utilisation-policy.js";
import { utilisationAdjustmentKey } from "$lib/capital-utilisation.js";

export function utilisationContext(d: TaxWorksheetDetail) {
  return {
    ...d.capital.utilisationBasis!,
    snapshot: d.revision.snapshot,
    adjustments: d.adjustments,
  };
}
/** Explicit reviewed income limits for older tests whose books contain no trading income.
 * These fixtures test schemes, manual claims and rollover independently of income derivation. */
export function reviewedUtilisation(
  d: TaxWorksheetDetail,
  input: CapitalInput,
): CapitalInput {
  const context = utilisationContext(d);
  const sources = [
    ...new Set([
      ...input.rows
        .filter((r) => r.treatment === "claim")
        .map((r) => r.businessSource),
      ...input.utilisation.map((u) => u.businessSource),
    ]),
  ].filter(Boolean);
  return {
    ...input,
    utilisationPolicy: {
      ...automaticUtilisation(),
      income: sources.map((businessSource) => ({
        businessSource,
        capacityMinor: input.utilisation
          .filter((u) => u.businessSource === businessSource)
          .reduce((n, u) => n + u.usedMinor, 0),
        reason: "Synthetic reviewed business income for this test",
        basisHash: context.hash,
        adjustmentKey: utilisationAdjustmentKey(context),
      })),
    },
  };
}
