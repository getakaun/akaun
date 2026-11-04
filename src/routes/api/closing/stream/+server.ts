import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { readClosingStatus } from "$lib/server/application/closing.js";
import { failureResponse } from "$lib/server/application/http.js";
import { closingEvents } from "$lib/server/closing/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

/** Signed-in users see the boundary only; no review, history or financial data. */
export const GET: RequestHandler = ({ locals }) => {
  const status = readClosingStatus({ db, locals });
  if (!status.ok) return failureResponse(status);
  return eventStream(
    [
      {
        emitter: closingEvents,
        events: { "closing-changed": "closing-changed" },
      },
    ],
    () => ({ type: "closing-status", ...status.value }),
  );
};
