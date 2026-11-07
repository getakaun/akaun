import type { RequestHandler } from "./$types.js";
import { canAll } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import {
  ASSET_READ_PERMISSIONS,
  fixedAssetEvents,
} from "$lib/server/application/fixed-assets.js";
import { accountEvents, ledgerEvents } from "$lib/server/ledger/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!canAll(locals, ASSET_READ_PERMISSIONS)) return forbidden();
  return eventStream(
    [
      {
        emitter: fixedAssetEvents,
        events: { "assets-refresh": "assets-refresh" },
        signalOnly: true,
      },
      {
        emitter: ledgerEvents,
        events: {
          "record-update": "assets-refresh",
          "record-deleted": "assets-refresh",
        },
        signalOnly: true,
      },
      {
        emitter: accountEvents,
        events: {
          "account-update": "assets-refresh",
          "account-deleted": "assets-refresh",
          "accounts-refresh": "assets-refresh",
        },
        signalOnly: true,
      },
    ],
    () => ({ type: "assets-refresh" }),
  );
};
