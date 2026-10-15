import { json } from "@sveltejs/kit";
import { z } from "zod";
import {
  badRequest,
  forbidden,
  notFound,
  refused,
} from "$lib/server/api-response.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { readDocumentAgain } from "$lib/server/services/import-read-again.js";
import type { RequestHandler } from "./$types.js";

/**
 * "Read again" (006 FR-023, US9 AS6-7): reads the document once more from
 * the file already uploaded, as `readAs` now names it, and replaces what the
 * last reading proposed. `readAs` takes the words an upload's "Read as" takes:
 * `auto`, `receipt`, `items` or `profile:<id>`. A profile is read in its own
 * import mode (FR-023), so there is no other choice; an `importMode` field
 * an older screen still sends is dropped unread.
 *
 * It needs two permissions. Reading a document needs the upload permission
 * and nothing more (FR-045), so `import.add`. It also throws away the items
 * or the card waiting for review and queues the job again, which is a change
 * to a job, as skipping one is, so `import.change` too. No new permission.
 *
 * Replies 202 once the job is queued again; the worker reads it, and every
 * open screen follows it through the live updates. A job that may not be read
 * again now (an item is confirmed, it is still being read, it is imported)
 * is refused with 409 and the reason, which the job's live update also
 * carries as `readAgainReason`.
 */
const bodySchema = z.object({
  readAs: z.string().max(64),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (
    !can(locals, "import.create") ||
    !can(locals, "import.update")
  ) {
    return forbidden();
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const done = readDocumentAgain(db, params.jobId, parsed.data.readAs, {
    actingUserId: locals.user.id,
  });
  if (!done.ok) {
    if (done.kind === "missing") return notFound(done.reason);
    if (done.kind === "invalid") {
      return json({ error: done.reason }, { status: 400 });
    }
    return refused(done.reason);
  }
  return json(
    { jobId: params.jobId, removedItems: done.value.removedItems },
    { status: 202 },
  );
};
