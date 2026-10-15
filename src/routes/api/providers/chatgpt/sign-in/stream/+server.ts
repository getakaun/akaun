import { can } from "$lib/server/permissions.js";
import { eventStream } from "$lib/server/sse-stream.js";
import {
  chatgptSignInEvents,
  signInSnapshot,
} from "$lib/server/llm/chatgpt-sign-in.js";
import type { RequestHandler } from "./$types.js";
export const GET: RequestHandler = ({ locals, url }) => {
  const user = locals.user;
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "settings.manage"))
    return new Response("Forbidden", { status: 403 });
  const state = url.searchParams.get("state") ?? "";
  if (!signInSnapshot(user.id, state))
    return new Response("Sign-in expired. Start again.", { status: 404 });
  return eventStream(
    [
      {
        emitter: chatgptSignInEvents,
        events: {
          "sign-in-complete": "sign-in-complete",
          "sign-in-failed": "sign-in-failed",
        },
        filter: (payload) =>
          payload.userId === user.id && payload.state === state,
      },
    ],
    () => signInSnapshot(user.id, state),
  );
};
