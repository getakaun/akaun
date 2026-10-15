import { json } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { badRequest, forbidden, refused } from "$lib/server/api-response.js";
import { reviewOverridesSchema } from "$lib/server/import/settle-review.js";
import { can } from "$lib/server/permissions.js";
import { updateGroupItem } from "$lib/server/services/import-items.js";
import type { RequestHandler } from "./$types.js";

/**
 * Saves a reviewer's corrections to one item of a group (006 FR-020).
 *
 * The body takes the same fields a receipt card sends with its confirm; only
 * the fields present change. The edits are kept on the server, so the item
 * confirms later with them, from this tab or another. Replies with the item as
 * it now is.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.update")) return forbidden();

  const parsed = reviewOverridesSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const updated = updateGroupItem(
    db,
    params.jobId,
    params.itemId,
    parsed.data,
    {
      actingUserId: locals.user.id,
    },
  );
  if (!updated.ok) return refused(updated.reason);
  return json(updated.value);
};
