import { can } from "$lib/server/permissions.js";
import { json } from "@sveltejs/kit";
import { cancelSignIn } from "$lib/server/llm/chatgpt-sign-in.js";
import type { RequestHandler } from "./$types.js";
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "settings.manage"))
    return new Response("Forbidden", { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.state !== "string")
    return json({ error: "Missing sign-in attempt." }, { status: 400 });
  cancelSignIn(locals.user.id, body.state);
  return json({ success: true });
};
