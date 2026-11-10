import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { taxWorksheetEvents } from "$lib/server/application/tax-worksheets.js";
import { ledgerEvents, accountEvents } from "$lib/server/ledger/events.js";
import { eventStream } from "$lib/server/sse-stream.js";
export const GET: RequestHandler = ({ locals }) => {
  if (!can(locals, "tax.read"))
    return new Response("Forbidden", { status: 403 });
  return eventStream(
    [
      {
        emitter: taxWorksheetEvents,
        events: { changed: "data-changed" },
        signalOnly: true,
      },
      {
        emitter: ledgerEvents,
        events: {
          "record-update": "data-changed",
          "record-deleted": "data-changed",
        },
        signalOnly: true,
      },
      {
        emitter: accountEvents,
        events: {
          "account-update": "data-changed",
          "account-deleted": "data-changed",
          "accounts-refresh": "data-changed",
        },
        signalOnly: true,
      },
    ],
    () => ({ type: "data-changed" }),
  );
};
