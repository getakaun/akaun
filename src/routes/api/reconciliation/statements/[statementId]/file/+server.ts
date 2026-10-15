import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { getStatement } from "$lib/server/queries/reconciliation.js";
import { fileStore } from "$lib/server/file-storage.js";
import { storedFileResponse } from "$lib/server/stored-file-response.js";

/** The uploaded file a bank statement was read from. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "reconciliation.read")) {
    return new Response("Forbidden", { status: 403 });
  }

  const id = Number(params.statementId);
  const statement = Number.isInteger(id) ? getStatement(db, id) : undefined;
  if (!statement?.storedFilePath) {
    return new Response("Not found", { status: 404 });
  }

  return storedFileResponse(
    fileStore(),
    request,
    statement.storedFilePath,
    statement.originalFilename,
  );
};
