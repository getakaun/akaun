import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { importQueue } from "$lib/server/db/schema.js";
import { forbidden, notFound } from "$lib/server/api-response.js";
import { can } from "$lib/server/permissions.js";
import { listGroupItems } from "$lib/server/services/import-items.js";
import type { RequestHandler } from "./$types.js";

/**
 * Every item of a group, in the document's order (006 FR-017).
 *
 * A group holds at most a thousand items, and each item row is small (it keeps
 * no document text), so the group's page loads them all at once and pages and
 * filters them itself, as the Records screen does. Later changes arrive as
 * `item-update` and `item-deleted` events on the import stream.
 */
export const GET: RequestHandler = ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.read")) return forbidden();

  const job = db
    .select({ id: importQueue.id })
    .from(importQueue)
    .where(eq(importQueue.id, params.jobId))
    .get();
  if (!job) return notFound("That document is no longer in the import queue.");

  return json(listGroupItems(db, params.jobId));
};
