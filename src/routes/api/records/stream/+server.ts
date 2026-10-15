import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { eventStream } from "$lib/server/sse-stream.js";
import { ledgerEvents } from "$lib/server/ledger/events.js";

/**
 * What the Records list is told, live.
 *
 * One list of every kind, so one connection and **no kind filter** — the
 * per-kind streams each had to pick their own records out of the one emitter,
 * and a record that was neither an expense nor an income appeared on no list
 * until the page was reloaded. Everything the emitter carries is forwarded:
 *
 *   record-update      { record }        — the full RecordView, any kind
 *   record-deleted     { id }
 *   settlement-changed { recordIds: [] } — a payment changes another record's
 *                                          paid state without anyone editing it
 *
 * **No snapshot on connect.** Records is a paginated list: SSR gives the first
 * state and this gives only the changes. If the connection drops, `EventSource`
 * reconnects and the next event corrects the row; a reload gets the truth
 * (contracts/events.md, CLAUDE.md).
 *
 * Gated on `records.view` alone — one store, one ability. Nothing here filters
 * by kind any more, which is safe precisely because there is no longer a kind a
 * viewer of this list is not allowed to see (research.md R-11).
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "records.read")) return forbidden();

  return eventStream([
    {
      emitter: ledgerEvents,
      events: {
        "record-update": "record-update",
        "record-deleted": "record-deleted",
        "settlement-changed": "settlement-changed",
      },
    },
  ]);
};
