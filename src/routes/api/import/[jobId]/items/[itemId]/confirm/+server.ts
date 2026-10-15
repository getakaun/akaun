import { json } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { forbidden, refused } from "$lib/server/api-response.js";
import { can } from "$lib/server/permissions.js";
import { confirmGroupItem } from "$lib/server/services/import-items.js";
import type { RequestHandler } from "./$types.js";

/**
 * Confirms one item of a group and makes its record (006 FR-020).
 *
 * The item's corrections were saved as they were made, so there is no body.
 * This is also the item's "Import anyway": a possible duplicate is confirmed
 * here when the reviewer says so, and is only held back by a confirm-all.
 * Needs the same permission as confirming a receipt (FR-045).
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.confirm")) return forbidden();

  const confirmed = await confirmGroupItem(db, params.jobId, params.itemId, {
    actingUserId: locals.user.id,
  });
  if (!confirmed.ok) {
    // No rate known for a foreign currency, answered as for a receipt.
    if (confirmed.kind === "rate") {
      return json({ error: confirmed.reason }, { status: 400 });
    }
    return refused(confirmed.reason);
  }

  const { record, uncategorised } = confirmed.value;
  return json(
    { id: record.id, number: record.recordNumber ?? "", uncategorised },
    { status: 201 },
  );
};
