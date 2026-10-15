import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { invoiceEvents } from "$lib/server/finance/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

/**
 * Live updates for the Invoices list.
 *
 *   invoice-update { item } — the full list row
 *   invoice-delete { id }
 *
 * No snapshot on connect: the list is paginated, so SSR gives the first state
 * and this carries only the changes. A dropped connection reconnects and the
 * next event corrects the row; a reload gets the truth (CLAUDE.md).
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "invoices.read")) return forbidden();

  return eventStream([
    {
      emitter: invoiceEvents,
      events: {
        "invoice-update": "invoice-update",
        "invoice-delete": "invoice-delete",
      },
    },
  ]);
};
