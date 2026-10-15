import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { accountEvents } from "$lib/server/ledger/events.js";
import { eventStream } from "$lib/server/sse-stream.js";

/**
 * Live updates for the chart of accounts.
 *
 * No snapshot on connect: the page gets its initial state from SSR and this
 * carries incremental updates only. A dropped connection auto-reconnects and
 * the next event re-syncs the affected row (contracts/events.md).
 *
 * A balance change counts as an account update — every record write re-emits
 * the accounts it touched, so a balance on this screen never goes stale while
 * someone records an expense in another tab.
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "accounts.read")) return forbidden();

  return eventStream([
    {
      emitter: accountEvents,
      events: {
        "account-update": "account-update",
        "account-deleted": "account-deleted",
        "accounts-refresh": "accounts-refresh",
      },
    },
  ]);
};
