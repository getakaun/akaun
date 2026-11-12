import { z } from "zod";
import { taxJurisdictionSchema } from "$lib/asset-tax-scheme.js";
import { getSetting, setSetting, SETTING_KEYS } from "../settings.js";
import { recordAudit } from "../audit.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { invalid, ok } from "./result.js";
import { refuse, runTaxTransaction } from "./tax-worksheet-boundary.js";

export function readTaxSettings(ctx: AppContext) {
  const denied = requirePermissions(ctx, ["tax.read"]);
  if (denied) return denied;
  return ok({
    jurisdiction: getSetting(ctx.db, SETTING_KEYS.taxJurisdiction) || null,
  });
}

const inputSchema = z
  .object({
    jurisdiction: taxJurisdictionSchema.nullable(),
    expectedJurisdiction: taxJurisdictionSchema.nullable(),
  })
  .strict();

/** Updating this default never changes a retained worksheet's jurisdiction. */
export function saveTaxSettings(ctx: AppContext, input: unknown) {
  const denied = requirePermissions(ctx, ["tax.read", "tax.update"]);
  if (denied) return denied;
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  return runTaxTransaction(ctx, "tax.update", (emits) => {
    const before = getSetting(ctx.db, SETTING_KEYS.taxJurisdiction) || null;
    if (before === v.jurisdiction)
      return { value: { jurisdiction: before }, changed: false };
    if (before !== v.expectedJurisdiction)
      refuse(
        "Tax settings changed. Reload the latest settings before saving.",
        "CONFLICT",
      );
    setSetting(ctx.db, SETTING_KEYS.taxJurisdiction, v.jurisdiction ?? "");
    recordAudit(ctx.db, {
      recordType: "settings",
      recordId: "tax",
      userId: actor(ctx),
      action: "update",
      changes: [{ field: "tax.jurisdiction", before, after: v.jurisdiction }],
      deferredEmits: emits,
    });
    return { value: { jurisdiction: v.jurisdiction } };
  });
}
