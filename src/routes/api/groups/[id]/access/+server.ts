import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { readGroupAccess, saveGroupAccess } from "$lib/server/admin/access.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * A group's grants (what members can do) and its delegation ceiling (what
 * members may hand on to personal access tokens and OAuth apps). Saved
 * together, so reducing the grants reduces the ceiling in the same write.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  return json(readGroupAccess(db, parseInt(params.id)));
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return json({ error: "Send { grants, delegations }." }, { status: 400 });
  return toResponse(
    saveGroupAccess(db, parseInt(params.id), body, locals.user!.id),
  );
};
