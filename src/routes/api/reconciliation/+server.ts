import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { workspace } from "$lib/server/services/reconciliation.js";
export const GET: RequestHandler = ({ locals, url }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "reconciliation.read"))
    return new Response("Forbidden", { status: 403 });
  return Response.json(
    workspace(
      db,
      locals,
      url.searchParams.get("from"),
      url.searchParams.get("to"),
    ),
  );
};
