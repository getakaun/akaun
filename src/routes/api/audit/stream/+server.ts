import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { eventStream } from "$lib/server/sse-stream.js";
import { auditEvents } from "$lib/server/audit-events.js";

/**
 * What the Audit Log page is told, live: `entry-added`, carrying nothing.
 *
 * **No snapshot on connect** — the log is paginated: SSR gives the first page
 * and the page asks `/api/audit?after=<newest id>` with its own filters when
 * told something was written. A burst of writes costs one fetch, and the
 * entries are filtered on the server rather than sent to every viewer.
 */
export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "audit.read")) return forbidden();

  return eventStream([
    { emitter: auditEvents, events: { "entry-added": "entry-added" } },
  ]);
};
