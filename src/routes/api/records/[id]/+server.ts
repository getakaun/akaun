import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, notFound } from "$lib/server/api-response.js";
import { getRecord } from "$lib/server/queries/ledger.js";
import { permissionForKind } from "$lib/server/ledger/record-permissions.js";
import {
  deleteRecord,
  patchSchema,
  updateRecord,
} from "$lib/server/application/records.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Only the everyday fields (`application/records.ts`'s `patchSchema`). A
 * settled or reconciled record refuses the amount, the date and any account
 * with a `409` naming what to undo first — the service enforces that, so the
 * schema stays about shape rather than state (FR-017a).
 */

function idOf(params: { id: string }): number | null {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const id = idOf(params as { id: string });
  if (id === null) return notFound("That record no longer exists.");

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  if (!can(locals, permissionForKind(record.kind, "read"))) {
    return forbidden();
  }
  return Response.json(record);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const id = idOf(params as { id: string });
  if (id === null) return notFound("That record no longer exists.");

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  // Who may, the read-only invoice posting, and the adjustments gate when the
  // patch re-derives the kind or restates the extra lines — all asked by the
  // one operation the MCP tools call too.
  return toResponse(
    updateRecord({ db, locals }, id, parsed.data),
    200,
    (written) => written.record,
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const id = idOf(params as { id: string });
  if (id === null) return notFound("That record no longer exists.");
  return toResponse(deleteRecord({ db, locals }, id), 204);
};
