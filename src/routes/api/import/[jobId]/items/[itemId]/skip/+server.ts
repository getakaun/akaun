import { db } from "$lib/server/db/client.js";
import { forbidden, refused } from "$lib/server/api-response.js";
import { can } from "$lib/server/permissions.js";
import { skipGroupItems } from "$lib/server/services/import-items.js";
import type { RequestHandler } from "./$types.js";

/**
 * Skips one item of a group: no record is made, and the other items and the
 * shared file are left as they are (006 FR-020, US4 scenario 9).
 */
export const POST: RequestHandler = ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.confirm")) return forbidden();

  const skipped = skipGroupItems(db, params.jobId, [params.itemId], {
    actingUserId: locals.user.id,
  });
  if (!skipped.ok) return refused(skipped.reason);
  const [outcome] = skipped.value;
  if (!outcome?.ok) {
    return refused(outcome?.reason ?? "That item could not be skipped.");
  }
  return new Response(null, { status: 204 });
};
