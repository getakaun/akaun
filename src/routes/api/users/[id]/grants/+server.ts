import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { users } from "$lib/server/db/schema.js";
import { can } from "$lib/server/permissions.js";
import { readUserGrants, saveUserGrants } from "$lib/server/admin/access.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Extra permissions for one user, on top of their groups'. They only ever add,
 * and are never delegable: they were given to the person, not to their tools.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  return json({ grants: readUserGrants(db, parseInt(params.id)) });
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  const userId = parseInt(params.id);
  if (
    !db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()
  )
    return new Response("Not Found", { status: 404 });
  const body = await request.json().catch(() => null);
  return toResponse(
    saveUserGrants(db, userId, body?.grants, locals.user!.id),
    200,
    (grants) => ({ grants }),
  );
};
