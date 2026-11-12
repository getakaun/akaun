import { error } from "@sveltejs/kit";
import { db } from "../db/client.js";
import {
  readTaxWorksheet,
  readTaxWorksheets,
} from "../application/tax-worksheets.js";
import { can } from "../permissions.js";
export function loadTaxWorksheets(locals: App.Locals) {
  const result = readTaxWorksheets({ db, locals });
  if (!result.ok) throw error(403, result.reason);
  return { worksheets: result.value, canCreate: can(locals, "tax.create") };
}
export function loadTaxWorksheet(locals: App.Locals, id: number, url: URL) {
  const revision = url.searchParams.has("revision")
    ? Number(url.searchParams.get("revision"))
    : undefined;
  const result = readTaxWorksheet({ db, locals }, id, revision);
  if (!result.ok)
    throw error(
      result.code === "FORBIDDEN"
        ? 403
        : result.code === "NOT_FOUND"
          ? 404
          : 400,
      result.reason,
    );
  return {
    detail: result.value,
    canUpdate: can(locals, "tax.update"),
    canReview: can(locals, "tax.review"),
    canFinalise:
      can(locals, "tax.finalise") && !locals.credential && !locals.oauth,
    canAmend: can(locals, "tax.amend") && !locals.credential && !locals.oauth,
    canReadRecords: can(locals, "records.read"),
    canReadAssets: can(locals, "accounts.read") && can(locals, "records.read"),
  };
}
