import { z } from "zod";
import { assetTaxSchemeDefinitionSchema } from "$lib/asset-tax-scheme.js";
import { assetTaxSchemes } from "../db/schema.js";
import { assetTaxSchemeVersions } from "../queries/asset-tax-schemes.js";
import { evidenceHash } from "../tax-evidence.js";
import { recordAudit } from "../audit.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { invalid, ok } from "./result.js";
import { refuse, runTaxTransaction } from "./tax-worksheet-boundary.js";
export const saveAssetTaxSchemeSchema = z
  .object({
    familyKey: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
    requestKey: z.string().uuid(),
    reason: z.string().trim().min(10).max(2000),
    definition: assetTaxSchemeDefinitionSchema,
  })
  .strict();
export function readAssetTaxSchemes(ctx: AppContext) {
  const denied = requirePermissions(ctx, ["tax.read"]);
  if (denied) return denied;
  return ok(assetTaxSchemeVersions(ctx.db));
}
export function saveAssetTaxScheme(ctx: AppContext, input: unknown) {
  const denied = requirePermissions(ctx, ["tax.read", "tax.update"]);
  if (denied) return denied;
  const parsed = saveAssetTaxSchemeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  return runTaxTransaction(ctx, "tax.update", (emits) => {
    const rows = assetTaxSchemeVersions(ctx.db);
    const payloadHash = evidenceHash(v);
    const replay = rows.find((row) => row.requestKey === v.requestKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash)
        refuse(
          "This request key was already used for a different scheme.",
          "CONFLICT",
        );
      return { value: replay, changed: false };
    }
    const previous = rows
      .filter((row) => row.familyKey === v.familyKey)
      .sort((a, b) => b.version - a.version)[0];
    if ((previous?.version ?? 0) !== v.expectedVersion)
      refuse(
        "This scheme changed. Review the latest version before saving.",
        "CONFLICT",
      );
    if (
      previous &&
      previous.definition.jurisdiction !== v.definition.jurisdiction
    )
      refuse("Create a separate scheme for a different tax jurisdiction.");
    const row = ctx.db
      .insert(assetTaxSchemes)
      .values({
        familyKey: v.familyKey,
        version: v.expectedVersion + 1,
        definition: v.definition,
        requestKey: v.requestKey,
        payloadHash,
        actorName: ctx.locals.user!.name ?? ctx.locals.user!.username,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    recordAudit(ctx.db, {
      recordType: "tax_scheme",
      recordId: row.id,
      userId: actor(ctx),
      action: "create",
      changes: [
        {
          field: "customScheme",
          before: previous?.definition ?? null,
          after: row.definition,
        },
        { field: "reason", before: null, after: v.reason },
        {
          field: "verification",
          before: null,
          after: "Custom scheme; not jurisdiction-verified",
        },
      ],
      deferredEmits: emits,
    });
    return { value: row };
  });
}
