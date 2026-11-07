import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { assetEvents } from "$lib/server/application/fixed-assets.js";
import { ledgerEvents, accountEvents } from "$lib/server/ledger/events.js";
import { eventStream } from "$lib/server/sse-stream.js";
export const GET: RequestHandler = ({ locals }) => {
  if (!can(locals, "accounts.read")) return forbidden();
  return eventStream([
    {
      emitter: assetEvents,
      events: { "asset-update": "refresh" },
      signalOnly: true,
    },
    {
      emitter: ledgerEvents,
      events: { "record-update": "refresh", "record-deleted": "refresh" },
      signalOnly: true,
    },
    {
      emitter: accountEvents,
      events: {
        "account-update": "refresh",
        "account-deleted": "refresh",
        "accounts-refresh": "refresh",
      },
      signalOnly: true,
    },
  ]);
};
