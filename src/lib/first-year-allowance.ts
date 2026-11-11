import { z } from "zod";
import type { CapitalAssetEvidence } from "./capital-allowance.js";
import type { AssetTaxSchemeDefinition } from "./asset-tax-scheme.js";
export class FirstYearAllowanceError extends Error {}
export const firstYearTreatmentSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    confirmation: z.enum(["pending_save", "worksheet_save"]).optional(),
    mode: z.enum(["auto", "include", "exclude"]),
    included: z.boolean(),
    reason: z.string().max(2000),
    historyHash: z.string().length(64),
    previous: z
      .array(
        z
          .object({
            ya: z.number().int(),
            revisionId: z.number().int().positive(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type FirstYearTreatment = z.infer<typeof firstYearTreatmentSchema>;
export type FirstYearRecord = {
  jurisdiction?: string | null;
  currency?: string;
  ya: number;
  revisionId: number;
  status: string;
  active: boolean;
  qualifyingMinor: number | null;
  businessUseBps: number | null;
  additionsMinor: number | null;
  initialMinor: number | null;
  annualMinor: number | null;
};
export type FirstYearContext = {
  historyHash: string;
  purchaseLinked?: boolean;
  currentCurrency?: string;
  records: FirstYearRecord[];
};
export type FirstYearBasis = {
  qualifyingMinor: number | null;
  businessUseBps: number | null;
  additionsMinor: number | null;
};
export type FirstYearDecision = {
  included: boolean | null;
  reason: string;
  blocked: boolean;
};
export function firstYearDecision(
  definition: AssetTaxSchemeDefinition,
  basis: FirstYearBasis,
  asset: CapitalAssetEvidence | undefined,
  context: FirstYearContext | undefined,
  dateFrom: string,
  dateTo: string,
): FirstYearDecision {
  const decision = (
    included: boolean | null,
    reason: string,
    blocked = false,
  ) => ({ included, reason, blocked });
  if (!definition.firstYearRateBps)
    return decision(false, "The selected scheme has no first-year allowance.");
  if (basis.additionsMinor === 0)
    return decision(false, "No new qualifying expenditure this year.");
  if (
    basis.additionsMinor == null ||
    basis.qualifyingMinor == null ||
    basis.businessUseBps == null
  )
    return decision(
      null,
      "Confirm the qualifying cost and business use first.",
    );
  if (!context)
    return decision(
      null,
      "Tax history is unavailable. Confirm the first-year treatment.",
    );
  const prior = context.records.filter(
    (r) =>
      r.active &&
      r.status === "finalised" &&
      (r.jurisdiction === undefined ||
        r.jurisdiction === definition.jurisdiction) &&
      (context.currentCurrency === undefined ||
        r.currency === context.currentCurrency),
  );
  // A recorded initial allowance counts even if its utilisation was zero.
  const covered = prior.find(
    (r) =>
      (r.initialMinor ?? 0) > 0 &&
      r.qualifyingMinor != null &&
      r.businessUseBps != null &&
      r.additionsMinor != null &&
      r.qualifyingMinor >= basis.qualifyingMinor! &&
      BigInt(r.additionsMinor) >=
        (BigInt(r.qualifyingMinor) * BigInt(r.businessUseBps) + 5000n) / 10000n,
  );
  if (covered)
    return decision(
      false,
      `Initial allowance for this cost was already recorded in YA ${covered.ya}.`,
      true,
    );
  if (
    context.records.some(
      (r) =>
        (r.jurisdiction !== undefined &&
          r.jurisdiction !== definition.jurisdiction) ||
        (context.currentCurrency !== undefined &&
          r.currency !== context.currentCurrency),
    )
  )
    return decision(
      null,
      "Earlier workings use a different tax jurisdiction or currency. Confirm the current qualifying expenditure and treatment.",
    );
  if (context.records.some((r) => r.status !== "finalised"))
    return decision(
      null,
      "Earlier tax workings are not finalised. Confirm their treatment before proceeding.",
    );
  if (context.records.length)
    return decision(
      null,
      "Earlier tax workings exist. Confirm whether these additions are distinct, previously unclaimed expenditure.",
    );
  if (!asset?.sourceRecordId || context.purchaseLinked === false)
    return decision(
      null,
      "This asset is not linked to a purchase record. Confirm any claims made outside Akaun.",
    );
  if (asset.acquisitionDate < dateFrom || asset.acquisitionDate > dateTo)
    return decision(
      null,
      "The purchase is outside this tax period. Confirm the first eligible year.",
    );
  if (
    !asset.inServiceDate ||
    asset.inServiceDate < dateFrom ||
    asset.inServiceDate > dateTo
  )
    return decision(
      null,
      "Confirm when the asset entered business use before applying first-year allowance.",
    );
  if (asset.reviewReason)
    return decision(
      null,
      "Resolve the asset register review before confirming first-year allowance.",
    );
  return decision(
    true,
    "Purchased and put into business use this year, with no earlier allowance claim recorded for this asset.",
  );
}
export function resolveFirstYear(
  mode: FirstYearTreatment["mode"],
  definition: AssetTaxSchemeDefinition,
  basis: FirstYearBasis,
  asset: CapitalAssetEvidence | undefined,
  context: FirstYearContext | undefined,
  dateFrom: string,
  dateTo: string,
  note: string,
  confirmation?: "preview" | "worksheet_save",
): FirstYearTreatment {
  const automatic = firstYearDecision(
    definition,
    basis,
    asset,
    context,
    dateFrom,
    dateTo,
  );
  if (!context)
    throw new FirstYearAllowanceError(
      "Refresh the worksheet to load the asset's tax history.",
    );
  let included = automatic.included;
  let reason = automatic.reason;
  if (mode === "exclude") {
    included = false;
    reason = `First-year allowance excluded by confirmed treatment. ${automatic.reason}`;
  }
  if (mode === "include") {
    if (automatic.blocked)
      throw new FirstYearAllowanceError(
        `${automatic.reason} Do not claim the same cost twice; correct the prior working or identify genuinely new expenditure.`,
      );
    if (!definition.firstYearRateBps || !basis.additionsMinor)
      throw new FirstYearAllowanceError(
        "This scheme and expenditure have no first-year allowance to include.",
      );
    if (!confirmation && automatic.included !== true && note.trim().length < 10)
      throw new FirstYearAllowanceError(
        "Add a remark explaining why this is eligible, previously unclaimed expenditure (at least 10 characters).",
      );
    included = true;
    reason =
      automatic.included === true
        ? automatic.reason
        : confirmation
          ? `First-year inclusion selected for worksheet confirmation. ${automatic.reason}`
          : `First-year treatment confirmed: ${note.trim()}`;
  }
  const needsConfirmation =
    !!confirmation && (automatic.included === null || mode !== "auto");
  if (included === null && confirmation) {
    included =
      definition.firstYearRateBps > 0 && (basis.additionsMinor ?? 0) > 0;
    reason = `Calculated from declared this-year qualifying additions. ${automatic.reason}`;
  }
  if (included === null) throw new FirstYearAllowanceError(automatic.reason);
  return {
    version: confirmation ? 2 : 1,
    ...(needsConfirmation
      ? {
          confirmation:
            confirmation === "worksheet_save"
              ? ("worksheet_save" as const)
              : ("pending_save" as const),
        }
      : {}),
    mode,
    included,
    reason: reason.slice(0, 2000),
    historyHash: context.historyHash,
    previous: context.records.map((r) => ({
      ya: r.ya,
      revisionId: r.revisionId,
    })),
  };
}
