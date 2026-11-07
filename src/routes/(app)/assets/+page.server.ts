import { parseChanges } from "$lib/server/audit.js";
import { error, fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { accounts, auditLog } from "$lib/server/db/schema.js";
import { can } from "$lib/server/permissions.js";
import { assetRegister } from "$lib/server/queries/fixed-assets.js";
import { saveAsset } from "$lib/server/application/fixed-assets.js";
import { desc, eq } from "drizzle-orm";
import { isValidDate, today } from "$lib/server/date.js";

export const load: PageServerLoad = ({ locals, url }) => {
  if (!can(locals, "accounts.read"))
    error(403, "You cannot view the asset register.");
  const asOf = url.searchParams.get("asOf") ?? today();
  if (!isValidDate(asOf)) error(400, "Choose a valid reconciliation date.");
  const report = assetRegister(db, asOf);
  const sourceRead = can(locals, "records.read");
  return {
    report: {
      ...report,
      unregistered: sourceRead ? report.unregistered : [],
      rows: report.rows.map((a) =>
        sourceRead ? a : { ...a, sourceRecordId: null, sourceMovementId: null },
      ),
    },
    accounts: db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        subType: accounts.subType,
        archivedAt: accounts.archivedAt,
      })
      .from(accounts)
      .all(),
    canWrite: can(locals, "accounts.update"),
    sourceRead,
    audit: db
      .select({
        id: auditLog.id,
        recordId: auditLog.recordId,
        action: auditLog.action,
        actorName: auditLog.actorName,
        createdAt: auditLog.createdAt,
        changes: auditLog.changes,
      })
      .from(auditLog)
      .where(eq(auditLog.recordType, "fixed_asset"))
      .orderBy(desc(auditLog.id))
      .limit(100)
      .all()
      .map((entry) =>
        sourceRead
          ? entry
          : {
              ...entry,
              changes: JSON.stringify(
                (parseChanges(entry.changes) ?? []).filter(
                  (c) =>
                    !["sourceMovementId", "sourceRecordId"].includes(c.field),
                ),
              ),
            },
      ),
  };
};
export const actions: Actions = {
  save: async ({ locals, request }) => {
    const form = await request.formData();
    let input: unknown;
    let edit:
      | { id: number; expectedVersion: number; reason: string }
      | undefined;
    try {
      input = JSON.parse(String(form.get("input")));
      if (form.get("id"))
        edit = {
          id: Number(form.get("id")),
          expectedVersion: Number(form.get("version")),
          reason: String(form.get("reason") ?? ""),
        };
    } catch {
      return fail(400, { error: "Invalid asset form. Refresh and try again." });
    }
    const result = saveAsset({ db, locals }, input, edit);
    if (!result.ok)
      return fail(result.code === "FORBIDDEN" ? 403 : 400, {
        error:
          result.issues
            ?.map((issue) =>
              [issue.path.map(String).join("."), issue.message]
                .filter(Boolean)
                .join(": "),
            )
            .join(" ") || result.reason,
        issues: result.issues,
      });
    return { saved: result.value.id };
  },
};
