import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { FirstYearAllowanceError } from "$lib/first-year-allowance.js";
import { AssetTaxSchemeError } from "$lib/asset-tax-scheme.js";
import { CapitalAllowanceError } from "$lib/capital-allowance.js";
import { TaxCalculationError } from "$lib/tax-worksheet.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { taxWorksheets, taxWorksheetRevisions } from "../db/schema.js";
import { recordAudit, type FieldChange } from "../audit.js";
import {
  latestTaxRevision,
  taxWorksheetDetail,
  type TaxWorksheetDetail,
} from "../queries/tax-worksheets.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  ok,
  Rollback,
  type AppResult,
  type AppFailure,
} from "./result.js";
export const taxWorksheetEvents = new EventEmitter();
taxWorksheetEvents.setMaxListeners(200);
export function refuse(
  reason: string,
  code: AppFailure["code"] = "REFUSED",
): never {
  throw new Rollback(fail(code, reason));
}
export function audit(
  ctx: AppContext,
  worksheetId: number,
  changes: FieldChange[],
  emits: (() => void)[],
  create = false,
) {
  recordAudit(ctx.db, {
    recordType: "tax_worksheet",
    recordId: worksheetId,
    userId: actor(ctx),
    action: create ? "create" : "update",
    changes,
    deferredEmits: emits,
  });
}
type Target = {
  worksheetId: number;
  revisionNumber?: number;
  changed?: boolean;
};
/** All tax writes share authority checks, one immediate transaction, and after-commit signals. */
export function runTaxTransaction<T>(
  ctx: AppContext,
  permission: LeafPermission,
  body: (emits: (() => void)[]) => { value: T; changed?: boolean },
): AppResult<T> {
  const denied = requirePermissions(ctx, ["tax.read", permission]);
  if (denied) return denied;
  if (
    (permission === "tax.finalise" || permission === "tax.amend") &&
    ctx.locals.credential
  )
    return fail(
      "FORBIDDEN",
      "Finalising or amending requires a signed-in session.",
    );
  const emits: (() => void)[] = [];
  try {
    const result = ctx.db.transaction(
      () => {
        const target = body(emits);
        if (target.changed !== false)
          emits.push(() => taxWorksheetEvents.emit("changed"));
        return target.value;
      },
      { behavior: "immediate" },
    );
    for (const emit of emits) emit();
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    if (
      error instanceof TaxCalculationError ||
      error instanceof CapitalAllowanceError ||
      error instanceof AssetTaxSchemeError ||
      error instanceof FirstYearAllowanceError
    )
      return fail("REFUSED", error.message);
    throw error;
  }
}
export function write(
  ctx: AppContext,
  permission: LeafPermission,
  body: (emits: (() => void)[]) => Target,
): AppResult<TaxWorksheetDetail> {
  return runTaxTransaction(ctx, permission, (emits) => {
    const target = body(emits);
    const detail = taxWorksheetDetail(
      ctx.db,
      target.worksheetId,
      target.revisionNumber,
    );
    if (!detail) refuse("That tax worksheet no longer exists.", "NOT_FOUND");
    return { value: detail, changed: target.changed };
  });
}
export function current(ctx: AppContext, id: number, expectedVersion: number) {
  const worksheet = ctx.db
    .select()
    .from(taxWorksheets)
    .where(eq(taxWorksheets.id, id))
    .get();
  const revision = latestTaxRevision(ctx.db, id);
  if (!worksheet || !revision)
    refuse("That tax worksheet no longer exists.", "NOT_FOUND");
  if (revision.version !== expectedVersion)
    refuse(
      "This worksheet changed. Refresh and review it before trying again.",
      "CONFLICT",
    );
  return { worksheet, revision };
}
export function draft(
  ctx: AppContext,
  revision: typeof taxWorksheetRevisions.$inferSelect,
) {
  if (revision.status === "finalised")
    refuse("This revision is finalised. Create an amendment to make changes.");
  ctx.db
    .update(taxWorksheetRevisions)
    .set({
      status: "draft",
      version: revision.version + 1,
      reviewedBy: null,
      reviewedAt: null,
    })
    .where(eq(taxWorksheetRevisions.id, revision.id))
    .run();
}
