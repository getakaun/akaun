import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { quotationEvents } from "$lib/server/finance/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

/**
 * Live updates for the Quotations list.
 *
 *   quotation-update { item } — the full list row
 *   quotation-delete { id }
 *
 * No snapshot on connect: the list is paginated, so SSR gives the first state
 * and this carries only the changes. A dropped connection reconnects and the
 * next event corrects the row; a reload gets the truth (CLAUDE.md).
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "quotations.read")) return forbidden();

  return eventStream([
    {
      emitter: quotationEvents,
      events: {
        "quotation-update": "quotation-update",
        "quotation-delete": "quotation-delete",
      },
    },
  ]);
};
