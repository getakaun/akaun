import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { listAuditLog, parseAuditFilters } from "$lib/server/audit-feed.js";

/**
 * The Audit Log, a page at a time: the same filters as the page's address
 * (`user`, `via`, `credential`, `client`, `type`, `record`, `action`, `from`,
 * `to`, `request`), plus `before=<id>` for older entries or `after=<id>` for
 * newer ones. `audit.read` is never delegable, so no token reaches this.
 */
export const GET: RequestHandler = ({ locals, url }) => {
  if (!can(locals, "audit.read")) return forbidden();
  const cursor = (name: string) => {
    const value = Number(url.searchParams.get(name));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  return json(
    listAuditLog(db, parseAuditFilters(url.searchParams), {
      before: cursor("before"),
      after: cursor("after"),
      limit: cursor("limit"),
    }),
  );
};
