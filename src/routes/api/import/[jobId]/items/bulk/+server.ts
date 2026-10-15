import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import { importQueue } from "$lib/server/db/schema.js";
import { badRequest, forbidden, refused } from "$lib/server/api-response.js";
import { DOCUMENT_ITEMS_MAX } from "$lib/import-reading.js";
import { groupCounts } from "$lib/server/import/group-state.js";
import { can } from "$lib/server/permissions.js";
import {
  confirmGroupItems,
  setGroupItemsAccount,
  setGroupItemsCategory,
  skipGroupItems,
  type ItemSelection,
} from "$lib/server/services/import-items.js";
import type { RequestHandler } from "./$types.js";

/**
 * One action on many items of a group: "Confirm all", "Confirm selected",
 * "Skip all", "Skip selected", and setting a category or an account on the
 * selected items (006 FR-018, FR-019).
 *
 * The items are named by `itemIds`, or `all: true` for every item still
 * waiting. Confirming runs one item after another on the server and leaves
 * behind any item that needs attention, so the reply lists each item with
 * whether it was done and, if not, why. A confirm that is interrupted and sent
 * again creates no record twice: an item already imported is only reported.
 *
 * `readAt` is the reading the screen shows: the group's `processedAt` as the
 * page had it. Named items belong to one reading (a new reading makes new
 * items), but `all: true` means whatever items are waiting when the request
 * lands. If the document was read again meanwhile (FR-023), those are items
 * of a reading the user has not seen, so a request that names another
 * reading is refused and nothing is done.
 */
const bodySchema = z
  .object({
    action: z.enum(["confirm", "skip", "setCategory", "setAccount"]),
    itemIds: z
      .array(z.string().min(1))
      .min(1)
      .max(DOCUMENT_ITEMS_MAX)
      .optional(),
    all: z.literal(true).optional(),
    categoryAccountId: z.number().int().positive().optional(),
    accountId: z.number().int().positive().optional(),
    readAt: z.string().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.itemIds === undefined) === (body.all === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["itemIds"],
        message: "Name the items, or say all.",
      });
    }
    if (body.action === "setCategory" && body.categoryAccountId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["categoryAccountId"],
        message: "Choose a category.",
      });
    }
    if (body.action === "setAccount" && body.accountId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["accountId"],
        message: "Choose an account.",
      });
    }
  });

const NOT_AS_SHOWN =
  "This document was read again since this page showed it, so nothing was done. Look at the new reading first.";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const body = parsed.data;
  // Confirming and skipping decide what reaches the books (import.confirm);
  // setting a category or an account corrects the reading (import.update).
  const needed =
    body.action === "confirm" || body.action === "skip"
      ? "import.confirm"
      : "import.update";
  if (!can(locals, needed)) return forbidden();

  if (body.readAt !== undefined) {
    const group = db
      .select({ processedAt: importQueue.processedAt })
      .from(importQueue)
      .where(eq(importQueue.id, params.jobId))
      .get();
    // A missing group is left to the action, which already says so.
    if (group && group.processedAt !== body.readAt) {
      return refused(NOT_AS_SHOWN);
    }
  }
  // Nothing is awaited between the check above and the moment the action
  // picks the items it works on, so a "Read again" cannot land in between.

  const selection: ItemSelection = body.all ? "all" : (body.itemIds ?? []);
  const options = { actingUserId: locals.user.id };
  const run = () => {
    switch (body.action) {
      case "confirm":
        return confirmGroupItems(db, params.jobId, selection, options);
      case "skip":
        return skipGroupItems(db, params.jobId, selection, options);
      case "setCategory":
        return setGroupItemsCategory(
          db,
          params.jobId,
          selection,
          body.categoryAccountId ?? 0,
          options,
        );
      case "setAccount":
        return setGroupItemsAccount(
          db,
          params.jobId,
          selection,
          body.accountId ?? 0,
          options,
        );
    }
  };
  // The schema already refused a missing category or account, so the zeros
  // above are never sent.
  const done = await run();
  if (!done.ok) return refused(done.reason);

  return json({
    results: done.value,
    counts: groupCounts(db, [params.jobId]).get(params.jobId) ?? null,
  });
};
