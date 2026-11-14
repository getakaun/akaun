import {
  withAsyncClosingRefusal,
  withClosingRefusal,
} from "./closing-refusal.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ImportState } from "$lib/enums.js";
import { importItems, importQueue } from "../db/schema.js";
import { releaseIfUnreferenced } from "../file-storage.js";
import { importEvents } from "../import/events.js";
import { auditJobDiscarded, auditJobSkipped } from "../import/audit.js";
import { jobForEvent } from "../import/job-event.js";
import {
  reviewOverridesSchema,
  settleReviewFields,
} from "../import/settle-review.js";
import {
  confirmImportRow,
  type ImportJobSource,
  type ImportReviewFields,
} from "../services/import.js";
import {
  commitGroupEntry,
  discardGroup,
  prepareGroupItems,
  skipGroupItems,
  updateGroupItem,
  type ItemOutcome,
  type PreparedGroupEntry,
} from "../services/import-items.js";
import { runUnitOfWork } from "../unit-of-work.js";
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
 * `import.confirm` — deliberately, as the REST routes do (006 FR-045: confirm
 * needs the import ability only, never `records.create`). The record stays
 * the uploader's, as it always was (`ImportJobSource.uploadedBy`); the audit
 * trail names whoever confirmed it.
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

type ConfirmInput = {
  itemIds?: string[];
  all?: boolean;
  overrides?: z.output<typeof reviewOverridesSchema>;
};

/**
 * A confirm made ready by `prepareImportConfirm`: every field settled, every
 * exchange rate looked up, and the versions it was prepared against. Plain,
 * serialisable data; `commitImportConfirm` writes it.
 */
export type PreparedImportConfirm =
  | {
      kind: "receipt";
      jobId: string;
      /** The job as prepared. The commit refuses with CONFLICT if it changed. */
      jobVersion: string;
      job: ImportJobSource;
      fields: ImportReviewFields;
    }
  | {
      kind: "group";
      jobId: string;
      jobVersion: string;
      /** The selected items in order; each carries its version when ready. */
      items: PreparedGroupEntry[];
    };

/**
 * Everything about a confirm that waits, and nothing that writes to the books:
 * the permission and version checks, the reviewer's corrections settled into
 * what each record will say, and any exchange rate looked up (the rate is
 * cached as it always was, outside any transaction).
 *
 * Asks only for `import.confirm`, never `records.create` (006 FR-045).
 */
export async function prepareImportConfirm(
  ctx: AppContext,
  input: ConfirmInput & { jobId: string; expectedVersion?: string },
): Promise<AppResult<PreparedImportConfirm>> {
  const refused = requirePermissions(ctx, ["import.confirm"]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const { jobId } = input;
  const row = job(ctx, jobId);
  if (!row) return missing("That import job no longer exists.");
  const jobVersion = importJobVersion(ctx.db, jobId);
  const stale = checkVersion(jobVersion, input.expectedVersion);
  if (stale) return stale;

  if (row.state === ImportState.Grouped) {
    if (input.overrides)
      return fail(
        "INVALID_INPUT",
        "A grouped document's items are corrected with update_import_item, then confirmed.",
      );
    if (!input.all && !input.itemIds?.length)
      return fail("INVALID_INPUT", "Name the items to confirm, or set `all`.");
    const items = await prepareGroupItems(
      ctx.db,
      jobId,
      selection(input),
      (itemId) => importItemVersion(ctx.db, itemId),
    );
    if (!items.ok) return fail("REFUSED", items.reason);
    return ok({ kind: "group", jobId, jobVersion, items: items.value });
  }

  if (row.state !== ImportState.PendingReview)
    return fail("REFUSED", "This document is not waiting for review.");
  if (input.itemIds || input.all)
    return fail(
      "INVALID_INPUT",
      "This document is a single receipt; it has no items.",
    );
  const settled = await settleReviewFields(ctx.db, row, input.overrides ?? {});
  if (!settled.ok)
    return fail(
      settled.kind === "rate" ? "RATE_UNAVAILABLE" : "REFUSED",
      settled.reason,
    );
  return ok({
    kind: "receipt",
    jobId,
    jobVersion,
    job: {
      jobId,
      uploadedBy: row.createdBy,
      tempFilePath: row.tempFilePath,
      extractedText: row.extractedText,
      // Only the reading the caller saw (its version covers it) is confirmed,
      // not a newer one that lands while an exchange rate is looked up.
      readAt: row.processedAt,
    },
    fields: settled.value,
  });
}

/**
 * Writes a prepared confirm. Synchronous, and never waits on anything.
 *
 * It runs as a unit of work around one `ctx.db.transaction`, so inside a
 * batch it joins the batch's unit and nests as a savepoint: events wait for
 * the outermost commit, the file move is undone if that does not commit, and
 * a dry run moves no file at all. First it checks the job is still as it was
 * prepared; any change since gives CONFLICT and writes nothing.
 *
 * A group's items are each their own savepoint: one the books refuse is
 * reported in its result and the others go on, as in `confirmGroupItems`.
 */
export function commitImportConfirm(
  ctx: AppContext,
  prepared: PreparedImportConfirm,
): AppResult<Record<string, unknown>> {
  const refused = requirePermissions(ctx, ["import.confirm"]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const options = { actingUserId: actor(ctx), storageRoot: storage.value };

  return withClosingRefusal(() =>
    runUnitOfWork("write", () =>
      ctx.db.transaction((): AppResult<Record<string, unknown>> => {
        const stale = checkVersion(
          importJobVersion(ctx.db, prepared.jobId),
          prepared.jobVersion,
        );
        if (stale) return stale;
        if (prepared.kind === "group") {
          return ok({
            results: prepared.items.map((entry) =>
              outcomeOf(entry.id, commitImportConfirmItem(ctx, entry)),
            ),
          });
        }
        const confirmed = confirmImportRow(
          ctx.db,
          prepared.job,
          prepared.fields,
          options,
        );
        if (!confirmed.ok) return fail("REFUSED", confirmed.reason);
        return ok({
          recordId: confirmed.value.record.id,
          recordNumber: confirmed.value.record.recordNumber ?? null,
          uncategorised: confirmed.value.uncategorised,
          path: `/records/${confirmed.value.record.id}`,
        });
      }),
    ),
  );
}

/**
 * Writes one prepared item of a group, for a batch that commits items one by
 * one inside its own transaction. Synchronous; a unit of work around one
 * `ctx.db.transaction`, as `commitImportConfirm` is.
 *
 * An item that changed since it was prepared gives CONFLICT and writes
 * nothing. Otherwise the answer is the item's outcome, which says whether a
 * record was made or why not.
 */
export function commitImportConfirmItem(
  ctx: AppContext,
  entry: PreparedGroupEntry,
): AppResult<ItemOutcome> {
  if ("outcome" in entry) return ok(entry.outcome);
  const refused = requirePermissions(ctx, ["import.confirm"]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const options = { actingUserId: actor(ctx), storageRoot: storage.value };

  return withClosingRefusal(() =>
    runUnitOfWork("write", () =>
      ctx.db.transaction((): AppResult<ItemOutcome> => {
        const stale = checkVersion(
          importItemVersion(ctx.db, entry.id),
          entry.version,
        );
        if (stale) return stale;
        return ok(commitGroupEntry(ctx.db, entry, options));
      }),
    ),
  );
}

/** An item's result, with a failure to commit it given as its reason. */
function outcomeOf(id: string, result: AppResult<ItemOutcome>): ItemOutcome {
  return result.ok ? result.value : { id, ok: false, reason: result.reason };
}

/**
 * Confirms a document in review: a single receipt with optional corrections,
 * or items of a group (their corrections were saved with update_import_item).
 *
 * `prepareImportConfirm`, then `commitImportConfirm` as its own unit of work,
 * so open tabs hear of the record only once it is committed and a file moved
 * by a write that then fails goes back. A group's items still commit one by
 * one, each as its own unit, letting other work run between them as the
 * group's REST route does (FR-019, FR-047).
 */
export async function confirmImport(
  ctx: AppContext,
  jobId: string,
  input: ConfirmInput,
  expectedVersion?: string,
): Promise<AppResult<Record<string, unknown>>> {
  return withAsyncClosingRefusal(async () => {
    const prepared = await prepareImportConfirm(ctx, {
      ...input,
      jobId,
      expectedVersion,
    });
    if (!prepared.ok) return prepared;
    if (prepared.value.kind === "receipt") {
      const receipt = prepared.value;
      return runUnitOfWork("write", () => commitImportConfirm(ctx, receipt));
    }

    const { items, jobVersion } = prepared.value;
    // The whole group as prepared, checked once. Nothing waits between this
    // and the first item; each item is checked again on its own.
    const stale = checkVersion(importJobVersion(ctx.db, jobId), jobVersion);
    if (stale) return stale;
    const results: ItemOutcome[] = [];
    let first = true;
    for (const entry of items) {
      if (!("outcome" in entry)) {
        if (!first) await new Promise<void>((done) => setImmediate(done));
        first = false;
      }
      const committed = runUnitOfWork("write", () =>
        commitImportConfirmItem(ctx, entry),
      );
      results.push(outcomeOf(entry.id, committed));
    }
    return ok({ results });
  });
}

/** Declines a document in review, or items of a group. No record is made. */
export function skipImport(
  ctx: AppContext,
  jobId: string,
  input: { itemIds?: string[]; all?: boolean },
  expectedVersion?: string,
): AppResult<Record<string, unknown>> {
  const refused = requirePermissions(ctx, ["import.confirm"]);
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
    const skipped = runUnitOfWork("write", () =>
      skipGroupItems(ctx.db, jobId, selection(input), {
        actingUserId: userId,
        storageRoot: storage.value,
      }),
    );
    return skipped.ok
      ? ok({ results: skipped.value })
      : fail("REFUSED", skipped.reason);
  }
  if (row.state !== ImportState.PendingReview)
    return fail("REFUSED", "This document is not waiting for review.");

  // One unit of work: inside a batch the file is deleted, and open tabs hear
  // of it, only once the batch commits; in a dry run neither happens.
  return runUnitOfWork("write", () => {
    ctx.db.transaction((tx) => {
      tx.update(importQueue)
        .set({ state: ImportState.Skipped })
        .where(eq(importQueue.id, jobId))
        .run();
      auditJobSkipped(tx, jobId, userId);
    });
    // After the state change, so this job no longer counts as using the file.
    releaseIfUnreferenced(ctx.db, row.tempFilePath, storage.value);
    const updated = job(ctx, jobId);
    if (updated)
      importEvents.emit("job-update", { userId, job: jobForEvent(updated) });
    return ok({ jobId, state: "skipped" });
  });
}

/** Saves corrections to one waiting item of a grouped document. */
export function updateImportItem(
  ctx: AppContext,
  jobId: string,
  itemId: string,
  overrides: z.output<typeof reviewOverridesSchema>,
  expectedVersion?: string,
): AppResult<Record<string, unknown>> {
  const refused = requirePermissions(ctx, ["import.update"]);
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
  const updated = runUnitOfWork("write", () =>
    updateGroupItem(ctx.db, jobId, itemId, overrides, {
      actingUserId: actor(ctx),
      storageRoot: ctx.storageRoot,
    }),
  );
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
  const refused = requirePermissions(ctx, ["import.delete"]);
  if (refused) return refused;
  const storage = root(ctx);
  if (!storage.ok) return storage;
  const row = job(ctx, jobId);
  if (!row) return missing("That import job no longer exists.");
  const stale = checkVersion(importJobVersion(ctx.db, jobId), expectedVersion);
  if (stale) return stale;

  if (row.state === ImportState.Grouped) {
    const discarded = runUnitOfWork("write", () =>
      discardGroup(ctx.db, jobId, {
        actingUserId: actor(ctx),
        storageRoot: storage.value,
      }),
    );
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
  return runUnitOfWork("write", () => {
    ctx.db.transaction((tx) => {
      tx.delete(importQueue).where(eq(importQueue.id, jobId)).run();
      auditJobDiscarded(tx, row, actor(ctx));
    });
    // After the row is gone, so it no longer counts as using the file. Inside
    // a batch the delete, and the event, wait for the batch to commit.
    releaseIfUnreferenced(ctx.db, row.tempFilePath, storage.value);
    importEvents.emit("job-deleted", { userId: row.createdBy, jobId });
    return ok({ jobId });
  });
}
