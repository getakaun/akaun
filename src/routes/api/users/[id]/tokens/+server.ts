import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { users } from "$lib/server/db/schema.js";
import { can } from "$lib/server/permissions.js";
import { listTokens, revokeAllTokens } from "$lib/server/tokens/manage.js";

/**
 * One user's personal access tokens, for an administrator: see them and
 * revoke them. Never create one — a token acts as its owner, so only the
 * owner makes it, signed in as themselves (Profile → Access tokens).
 */
function target(params: { id: string }) {
  const userId = parseInt(params.id);
  return db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get()
    ? userId
    : null;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  const userId = target(params);
  if (userId === null) return new Response("Not Found", { status: 404 });
  return json({ tokens: listTokens(db, userId) });
};

/** Revokes every token the user holds. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "users.manage"))
    return new Response("Forbidden", { status: 403 });
  const userId = target(params);
  if (userId === null) return new Response("Not Found", { status: 404 });
  return json({ revoked: revokeAllTokens(db, userId) });
};
