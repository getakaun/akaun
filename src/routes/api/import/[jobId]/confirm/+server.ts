import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import { importQueue } from "$lib/server/db/schema.js";
import { badRequest, forbidden, refused } from "$lib/server/api-response.js";
import {
  reviewOverridesSchema,
  type ReviewOverrides,
} from "$lib/server/import/settle-review.js";
import {
  confirmReviewed,
  RECEIPT_NOT_AS_SHOWN,
} from "$lib/server/services/import.js";
import { ImportState } from "$lib/enums.js";
import type { RequestHandler } from "./$types.js";
import { can } from "$lib/server/permissions.js";

/**
 * Turning a reviewed document into a record.
 *
 * Every field the reviewer corrected arrives here as an override; anything they
 * left alone keeps what was read off the document. The result is one ledger
 * record with the account that paid or received it on one side and the category
 * on the other — the same shape the expenses and income screens write.
 *
 * This route reads and checks the request. `confirmReviewed` settles the fields
 * (looking up an exchange rate when one is missing, which can take a moment) and
 * then does every write in one transaction. An item of a group is confirmed by
 * the same function, from `items/[itemId]/confirm`.
 *
 * `readAt` is the reading the reviewer saw: the job's `processedAt` as their
 * screen had it. "Read again" can replace the reading while the card is open
 * (FR-023), and the reviewer's corrections were made to the old one, so a
 * confirm that names another reading is refused and makes no record
 * (FR-044). Left out, the reading in review now is confirmed.
 */
const bodySchema = reviewOverridesSchema.extend({
  readAt: z.string().nullable().optional(),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  // Shared ledger: any user with import.change may confirm, not just the uploader.
  if (!can(locals, "import.confirm")) return forbidden();

  const row = db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, params.jobId))
    .get();

  if (!row) return new Response("Not found", { status: 404 });
  // An early answer for the usual case. The final check is the claim inside
  // `confirmImportRow`, because the job can change while this route waits.
  if (row.state !== ImportState.PendingReview) {
    return json(
      { error: "Job is not in pending_review state" },
      { status: 400 },
    );
  }

  // Parse the optional correction body — only present fields override extracted values
  let overrides: ReviewOverrides = {};
  let readAt: string | null | undefined;
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return badRequest(parsed.error);
    ({ readAt, ...overrides } = parsed.data);
  }
  // The reviewer saw another reading than the one in review now.
  if (readAt !== undefined && readAt !== row.processedAt) {
    return refused(RECEIPT_NOT_AS_SHOWN);
  }

  const confirmed = await confirmReviewed(
    db,
    {
      jobId: params.jobId,
      uploadedBy: row.createdBy,
      tempFilePath: row.tempFilePath,
      extractedText: row.extractedText,
      // Only the reading checked above may be confirmed, not a newer one
      // that lands while the exchange rate is looked up.
      readAt: row.processedAt,
    },
    row,
    overrides,
    { actingUserId: locals.user.id },
  );
  if (!confirmed.ok) {
    // No rate known for a foreign currency: the reviewer must type one.
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
