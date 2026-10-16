import type { RequestHandler } from "./$types.js";
import { quotationEvents, invoiceEvents } from "$lib/server/finance/events.js";
import { accountEvents, ledgerEvents } from "$lib/server/ledger/events.js";
import { importEvents } from "$lib/server/import/events.js";
import { reconciliationEvents } from "$lib/server/reconciliation/events.js";
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
 *
 * Accounts, imports and bank statements feed the "needs attention" list and
 * the cash figures (an account classified as Bank becomes cash), so they
 * signal too (007 FR-015). Every import job change is forwarded, including a
 * job sent back from review to be read again; the page debounces them.
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
      emitter: accountEvents,
      events: {
        "account-update": changed,
        "account-deleted": changed,
        "accounts-refresh": changed,
      },
      signalOnly: true,
    },
    {
      emitter: importEvents,
      events: { "job-update": changed, "job-deleted": changed },
      signalOnly: true,
    },
    {
      emitter: reconciliationEvents,
      events: {
        "allocation-update": changed,
        "allocations-bulk-update": changed,
        "lines-added": changed,
        "line-update": changed,
        "line-deleted": changed,
        "statement-deleted": changed,
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
