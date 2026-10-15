import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { revokeToken } from "$lib/server/tokens/manage.js";
import { notFound } from "$lib/server/api-response.js";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  return revokeToken(db, parseInt(params.id), parseInt(params.tokenId))
    ? new Response(null, { status: 204 })
    : notFound("That token no longer exists.");
};
