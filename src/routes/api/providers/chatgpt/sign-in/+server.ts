import { can } from "$lib/server/permissions.js";
import { json } from "@sveltejs/kit";
import { startSignIn } from "$lib/server/llm/chatgpt-sign-in.js";
import type { RequestHandler } from "./$types.js";

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "settings.manage"))
    return new Response("Forbidden", { status: 403 });
  try {
    return json(await startSignIn(locals.user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "ChatGPT sign-in could not start.",
      },
      { status: 502 },
    );
  }
};
