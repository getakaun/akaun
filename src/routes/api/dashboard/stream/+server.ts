import type { RequestHandler } from "./$types.js";
import { quotationEvents, invoiceEvents } from "$lib/server/finance/events.js";
import { ledgerEvents } from "$lib/server/ledger/events.js";
import { can } from "$lib/server/permissions.js";
import { eventStream } from "$lib/server/sse-stream.js";

/**
 * The dashboard shows totals rather than rows, so it does not need to know what
 * changed — only that something did. Every frame is the same "data-changed"
 * signal and the page re-fetches its figures.
 *
 * One emitter now covers every kind of record (`ledgerEvents`), which is the
 * point of having one: a dashboard figure that moved because of a transfer or a
 * settlement is just as stale as one that moved because of an expense, and with
 * three emitters it was possible to forget one silently (D-21).
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "dashboard.read"))
    return new Response("Forbidden", { status: 403 });

  const changed = "data-changed";

  return eventStream([
    {
      emitter: ledgerEvents,
      events: {
        "record-update": changed,
        "record-deleted": changed,
        "settlement-changed": changed,
      },
      signalOnly: true,
    },
    {
      emitter: quotationEvents,
      events: { "quotation-update": changed, "quotation-delete": changed },
      signalOnly: true,
    },
    {
      emitter: invoiceEvents,
      events: { "invoice-update": changed, "invoice-delete": changed },
      signalOnly: true,
    },
  ]);
};
