import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { accountEvents, ledgerEvents } from "$lib/server/ledger/events.js";
import { contactEvents } from "$lib/server/finance/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

// Reports need only invalidation signals. Do not send record/account/contact
// payloads: a reports reader need not hold those directories' read permissions.
// The initial signal also refreshes changes missed before connect / during an outage.
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "reports.read"))
    return new Response("Forbidden", { status: 403 });
  const changed = "data-changed";
  return eventStream(
    [
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
        emitter: contactEvents,
        events: { "contact-update": changed, "contact-delete": changed },
        signalOnly: true,
      },
    ],
    () => ({ type: changed }),
  );
};
