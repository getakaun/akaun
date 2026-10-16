/**
 * "Read again": reads a document once more from the file already uploaded,
 * the way the user now names, and replaces what the last reading proposed
 * (006 FR-023, US9 AS6-7).
 *
 * Nothing is read here. The job is put back in the queue as if it had just
 * been uploaded with the new choice, and the worker reads it as it reads any
 * upload: Auto-detect, the receipt reading, several items or a saved profile.
 * The file stays where it is, and so does any text that came with the upload
 * or that OCR read from an image, so the slow part of reading is not done
 * twice (see `keepsReadText` and `documentText`).
 */

import { and, eq, inArray } from "drizzle-orm";
import { ImportState } from "$lib/enums.js";
import { importItems, importQueue, REVIEW_COLUMN_NAMES } from "../db/schema.js";
import { STORAGE_PATH } from "../env.js";
import { keepsReadText } from "../extraction/document-text.js";
import { fileExists } from "../file-storage.js";
import { importEvents } from "../import/events.js";
import { emitJobUpdate } from "../import/group-state.js";
import {
  profileSnapshotOf,
  serializeProfileSnapshot,
} from "../import/profile-snapshot.js";
import { readAgainRefusal } from "../import/read-again.js";
import { readingForUpload } from "../import/upload-reading.js";
import type { LedgerDb } from "../ledger/types.js";
import { deletedProfileName, getImportProfile } from "./import-profiles.js";
import { auditImportJob } from "../import/audit.js";

type ImportJobInsert = typeof importQueue.$inferInsert;

export type ReadAgainOptions = { actingUserId: number; storageRoot?: string };

/**
 * Why a "Read again" was not done. `invalid` is a choice the system does not
 * know, or a profile that is off or gone; `missing` is a job that is not
 * there; `rule` is a job that may not be read again now. Each reason is a
 * sentence the screen shows as it is.
 */
export type ReadAgainRefusal = {
  ok: false;
  kind: "invalid" | "missing" | "rule";
  reason: string;
};

export type ReadAgainResult =
  | { ok: true; value: { removedItems: number } }
  | ReadAgainRefusal;

const FILE_GONE =
  "The file of this document is no longer stored, so it cannot be read again. Upload it again to read it.";

/**
 * Every column a reading writes on the queue row, emptied: what was read off
 * the document, the reviewer's choices on it, and how far the reading got.
 * The file, its hash, its name, the uploader and any text that came with the
 * upload are not here, so they stay.
 */
function clearedReading(): Partial<ImportJobInsert> {
  const cleared: Record<string, null> = {};
  for (const name of REVIEW_COLUMN_NAMES) cleared[name] = null;
  return {
    ...cleared,
    extractionNotes: null,
    profileSnapshot: null,
    progressDone: null,
    progressTotal: null,
    // The group's Source account was written into the items it replaces.
    // The new items do not have it, so the group must not claim it either.
    groupAccountId: null,
    resultId: null,
    resultType: null,
    error: null,
    processedAt: null,
    confirmedAt: null,
    completedAt: null,
  };
}

/**
 * Reads a document again from the same file, the way `rawReadAs` names it:
 * `auto`, `receipt`, `items` or `profile:<id>`, the same words an upload sends
 * and checked by the same function, so a profile that is off or deleted is
 * refused by name here too (FR-001, US6 AS12). A profile brings its own
 * import mode (FR-023), so reading again with another profile reads in that
 * profile's mode, and there is no other choice.
 *
 * Allowed for a receipt waiting for review, a group none of whose items is
 * confirmed, a failed document, and a skipped document that made no record
 * while its file is still stored; see `readAgainRefusal`. In one
 * transaction, the job's items go (only waiting or skipped ones can be left,
 * since none is confirmed), every column the last reading wrote is emptied,
 * the new choice is stored, and the job is queued again. The worker then
 * reads it within a tick.
 *
 * The check is made again inside the transaction, so a confirm that lands
 * between the screen's last update and this request still wins: the request
 * is refused, and the confirmed item keeps its record.
 *
 * Announced after the commit: each item removed, then the job.
 */
export function readDocumentAgain(
  db: LedgerDb,
  jobId: string,
  rawReadAs: string,
  options: ReadAgainOptions,
): ReadAgainResult {
  const reading = readingForUpload(
    rawReadAs,
    (id) => getImportProfile(db, id),
    (id) => deletedProfileName(db, id),
  );
  if (!reading.ok) return { ok: false, kind: "invalid", reason: reading.error };

  const job = db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  if (!job) {
    return {
      ok: false,
      kind: "missing",
      reason: "This document is no longer in the import queue.",
    };
  }

  // The copy of a chosen profile, taken now, as an upload takes it: the queue
  // names the profile while the document waits (FR-041). The reading replaces
  // it with the profile as it is then (FR-038).
  const chosenProfile = reading.profileId
    ? getImportProfile(db, Number(reading.profileId))
    : null;
  const profileSnapshot = chosenProfile
    ? serializeProfileSnapshot(profileSnapshotOf(chosenProfile))
    : null;

  const storageRoot = options.storageRoot ?? STORAGE_PATH;
  const outcome = db.transaction(
    (tx): { ok: true; removed: string[] } | ReadAgainRefusal => {
      const current = tx
        .select({ state: importQueue.state })
        .from(importQueue)
        .where(eq(importQueue.id, jobId))
        .get();
      if (!current) {
        return {
          ok: false,
          kind: "missing",
          reason: "This document is no longer in the import queue.",
        };
      }
      const confirmed = tx
        .select({ id: importItems.id })
        .from(importItems)
        .where(
          and(
            eq(importItems.jobId, jobId),
            inArray(importItems.state, [
              ImportState.Confirmed,
              ImportState.Imported,
            ]),
          ),
        )
        .all().length;
      const refusal = readAgainRefusal(current.state, confirmed, () =>
        fileExists(job.tempFilePath, storageRoot),
      );
      if (refusal) return { ok: false, kind: "rule", reason: refusal };

      // Checked only for a job that may be read again, so a refusal for a
      // reason the user can see on the screen comes first. (A skipped job's
      // file was already looked for by the rule, with its own reason.)
      if (!fileExists(job.tempFilePath, storageRoot)) {
        return { ok: false, kind: "rule", reason: FILE_GONE };
      }

      // No item is confirmed, so every item left is one the new reading
      // replaces: waiting, or skipped, which made nothing.
      const removed = tx
        .delete(importItems)
        .where(eq(importItems.jobId, jobId))
        .returning({ id: importItems.id })
        .all()
        .map((row) => row.id);

      tx.update(importQueue)
        .set({
          ...clearedReading(),
          state: ImportState.Queued,
          readAs: reading.readAs,
          readHow: reading.readHow,
          profileId: reading.profileId,
          importMode: reading.importMode,
          profileSnapshot,
          // An image's text is kept, so it is not read by OCR again; any
          // other text was the last reading's and goes with it.
          ...(keepsReadText(job.originalFilename)
            ? {}
            : { extractedText: null }),
        })
        .where(eq(importQueue.id, jobId))
        .run();
      auditImportJob(tx, {
        jobId,
        userId: options.actingUserId,
        action: "update",
        changes: [
          { field: "readAs", before: job.readAs, after: reading.readAs },
          {
            field: "readAgain",
            before: removed.length ? `${removed.length} items` : null,
            after: "queued",
          },
        ],
      });
      return { ok: true, removed };
    },
  );
  if (!outcome.ok) return outcome;

  for (const itemId of outcome.removed) {
    importEvents.emit("item-deleted", {
      userId: options.actingUserId,
      jobId,
      itemId,
    });
  }
  emitJobUpdate(db, jobId, options.actingUserId);
  return { ok: true, value: { removedItems: outcome.removed.length } };
}
