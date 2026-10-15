import { can } from "$lib/server/permissions.js";
import { json } from "@sveltejs/kit";
import {
  peekConnection,
  setConnectionModels,
} from "$lib/server/llm/chatgpt-sign-in.js";
import { listChatgptModels } from "$lib/server/llm/chatgpt-oauth.js";
import type { RequestHandler } from "./$types.js";

/**
 * The models a ChatGPT sign-in that has not been saved yet can use. The sheet
 * picks a model before Save, and a saved provider lists them through
 * `/api/providers/[id]/models` instead.
 */
export const GET: RequestHandler = async ({ locals, url, fetch }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  // AI provider set-up belongs to Settings.
  if (!can(locals, "settings.manage"))
    return new Response("Forbidden", { status: 403 });
  const connectionId = url.searchParams.get("connection") ?? "";
  const credentials = peekConnection(locals.user.id, connectionId);
  if (!credentials)
    return json(
      { error: "The sign-in has expired. Sign in with ChatGPT again." },
      { status: 404 },
    );
  try {
    const models = await listChatgptModels(
      credentials.accessToken,
      fetch,
      credentials.accountId,
    );
    setConnectionModels(
      locals.user.id,
      connectionId,
      models.map((m) => m.id),
    );
    return json({
      models: models.map((m) => ({ ...m, isFree: false })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch models";
    return json({ error: message }, { status: 502 });
  }
};
