import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { hasPermission } from "$lib/server/permissions.js";
import { forbidden, notFound } from "$lib/server/api-response.js";
import { removeSettlement } from "$lib/server/application/records.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Undoes one allocation. Both sides return to outstanding, and any field the
 * settlement was locking becomes editable again (FR-017).
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!hasPermission(locals, "records", "delete")) return forbidden();

  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    return notFound("That settlement no longer exists.");
  }

  return toResponse(removeSettlement({ db, locals }, id), 204);
};
