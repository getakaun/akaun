import { z } from "zod";
import { eq } from "drizzle-orm";
import { ImportState } from "$lib/enums.js";
import { importItems, importQueue } from "../db/schema.js";
import { releaseIfUnreferenced } from "../file-storage.js";
import { importEvents } from "../import/events.js";
import { jobForEvent } from "../import/job-event.js";
import { reviewOverridesSchema } from "../import/settle-review.js";
import { confirmReviewed } from "../services/import.js";
import {
  confirmGroupItems,
  discardGroup,
  skipGroupItems,
  updateGroupItem,
} from "../services/import-items.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, missing, ok, type AppResult } from "./result.js";
import {
  checkVersion,
  importItemVersion,
  importJobVersion,
} from "./version.js";

/**
 * Auto Import's review step as authorized operations.
 *
 * Confirming turns a reviewed document into a record, yet asks only for
 * `import:change` — deliberately, as the REST routes do (006 FR-045: "Confirm
 * checks `import.change` only, not `records.add`"). The record stays the
 * uploader's, as it always was (`ImportJobSource.uploadedBy`); the audit trail
 * names whoever confirmed it.
 *
 * Every file path goes through `ctx.storageRoot`, never the configured default,
 * so a test can never touch the real `data/storage`.
 */

export const overridesShape = reviewOverridesSchema.shape;

export const selectionShape = {
  /** Items of a grouped document. Omit, with `all`, for every waiting item. */
  itemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  all: z.boolean().optional(),
};

function job(ctx: AppContext, jobId: string) {
  return ctx.db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
}

function root(ctx: AppContext): AppResult<string> {
  return ctx.storageRoot
    ? ok(ctx.storageRoot)
    : fail("REFUSED", "File storage is not available here.");
}

function selection(input: { itemIds?: string[]; all?: boolean }) {
  return input.all ? ("all" as const) : (input.itemIds ?? []);
}

/**
 * Confirms a document in review: a single receipt with optional corrections,
 * or items of a group (their corrections were saved with update_import_item).
 */
export async function confirmImport(
  ctx: AppContext,
  jobId: string,
  input: {
    itemIds?: string[];
    all?: boolean;
    overrides?: z.output<typeof reviewOverridesSchema>;
  },
  expectedVersion?: string,
): Promise<AppResult<Record<string, unknown>>> {
  const refused = requirePermissions(ctx, [["import", "change"]]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const row = job(ctx, jobId);
  if (!row) return missing("That import job no longer exists.");
  const stale = checkVersion(importJobVersion(ctx.db, jobId), expectedVersion);
  if (stale) return stale;
  const options = { actingUserId: actor(ctx), storageRoot: storage.value };

  if (row.state === ImportState.Grouped) {
    if (input.overrides)
      return fail(
        "INVALID_INPUT",
        "A grouped document's items are corrected with update_import_item, then confirmed.",
      );
    if (!input.all && !input.itemIds?.length)
      return fail("INVALID_INPUT", "Name the items to confirm, or set `all`.");
    const done = await confirmGroupItems(
      ctx.db,
      jobId,
      selection(input),
      options,
    );
    return done.ok ? ok({ results: done.value }) : fail("REFUSED", done.reason);
  }

  if (row.state !== ImportState.PendingReview)
    return fail("REFUSED", "This document is not waiting for review.");
  if (input.itemIds || input.all)
    return fail(
      "INVALID_INPUT",
      "This document is a single receipt; it has no items.",
    );
  const confirmed = await confirmReviewed(
    ctx.db,
    {
      jobId,
      uploadedBy: row.createdBy,
      tempFilePath: row.tempFilePath,
      extractedText: row.extractedText,
      // Only the reading the caller saw (its version covers it) is confirmed,
      // not a newer one that lands while an exchange rate is looked up.
      readAt: row.processedAt,
    },
    row,
    input.overrides ?? {},
    options,
  );
  if (!confirmed.ok)
    return fail(
      confirmed.kind === "rate" ? "RATE_UNAVAILABLE" : "REFUSED",
      confirmed.reason,
    );
  return ok({
    recordId: confirmed.value.record.id,
    recordNumber: confirmed.value.record.recordNumber ?? null,
    uncategorised: confirmed.value.uncategorised,
    path: `/records/${confirmed.value.record.id}`,
  });
}

/** Declines a document in review, or items of a group. No record is made. */
export function skipImport(
  ctx: AppContext,
  jobId: string,
  input: { itemIds?: string[]; all?: boolean },
  expectedVersion?: string,
): AppResult<Record<string, unknown>> {
  const refused = requirePermissions(ctx, [["import", "change"]]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const row = job(ctx, jobId);
  if (!row) return missing("That import job no longer exists.");
  const stale = checkVersion(importJobVersion(ctx.db, jobId), expectedVersion);
  if (stale) return stale;
  const userId = actor(ctx);

  if (row.state === ImportState.Grouped) {
    if (!input.all && !input.itemIds?.length)
      return fail("INVALID_INPUT", "Name the items to skip, or set `all`.");
    const skipped = skipGroupItems(ctx.db, jobId, selection(input), {
      actingUserId: userId,
      storageRoot: storage.value,
    });
    return skipped.ok
      ? ok({ results: skipped.value })
      : fail("REFUSED", skipped.reason);
  }
  if (row.state !== ImportState.PendingReview)
    return fail("REFUSED", "This document is not waiting for review.");

  ctx.db
    .update(importQueue)
    .set({ state: ImportState.Skipped })
    .where(eq(importQueue.id, jobId))
    .run();
  // After the state change, so this job no longer counts as using the file.
  releaseIfUnreferenced(ctx.db, row.tempFilePath, storage.value);
  const updated = job(ctx, jobId);
  if (updated)
    importEvents.emit("job-update", { userId, job: jobForEvent(updated) });
  return ok({ jobId, state: "skipped" });
}

/** Saves corrections to one waiting item of a grouped document. */
export function updateImportItem(
  ctx: AppContext,
  jobId: string,
  itemId: string,
  overrides: z.output<typeof reviewOverridesSchema>,
  expectedVersion?: string,
): AppResult<Record<string, unknown>> {
  const refused = requirePermissions(ctx, [["import", "change"]]);
  if (refused) return refused;
  const item = ctx.db
    .select({ jobId: importItems.jobId })
    .from(importItems)
    .where(eq(importItems.id, itemId))
    .get();
  if (!item || item.jobId !== jobId)
    return missing("That item is no longer part of this document.");
  const stale = checkVersion(
    importItemVersion(ctx.db, itemId),
    expectedVersion,
  );
  if (stale) return stale;
  const updated = updateGroupItem(ctx.db, jobId, itemId, overrides, {
    actingUserId: actor(ctx),
    storageRoot: ctx.storageRoot,
  });
  return updated.ok
    ? ok({ item: updated.value, version: importItemVersion(ctx.db, itemId) })
    : fail("REFUSED", updated.reason);
}

/**
 * Discards a job. A group loses only its waiting items; records already made
 * from it stay. The file goes only when nothing uses it.
 */
export function discardImportJob(
  ctx: AppContext,
  jobId: string,
  expectedVersion?: string,
): AppResult<{ jobId: string }> {
  const refused = requirePermissions(ctx, [["import", "delete"]]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const row = job(ctx, jobId);
  if (!row) return missing("That import job no longer exists.");
  const stale = checkVersion(importJobVersion(ctx.db, jobId), expectedVersion);
  if (stale) return stale;

  if (row.state === ImportState.Grouped) {
    const discarded = discardGroup(ctx.db, jobId, {
      actingUserId: actor(ctx),
      storageRoot: storage.value,
    });
    return discarded.ok ? ok({ jobId }) : fail("REFUSED", discarded.reason);
  }
  const deletable: number[] = [
    ImportState.Queued,
    ImportState.Failed,
    ImportState.PendingReview,
  ];
  if (!deletable.includes(row.state))
    return fail(
      "REFUSED",
      "Only queued, failed or waiting documents can be discarded.",
    );
  importEvents.emit("job-deleted", { userId: row.createdBy, jobId });
  ctx.db.delete(importQueue).where(eq(importQueue.id, jobId)).run();
  releaseIfUnreferenced(ctx.db, row.tempFilePath, storage.value);
  return ok({ jobId });
}
