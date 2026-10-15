import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { dirname, basename, extname, join, resolve, sep } from "path";
import { existsSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { ImportState } from "$lib/enums.js";
import { STORAGE_PATH } from "./env.js";
import { importQueue, recordAttachments } from "./db/schema.js";
import type { LedgerDb } from "./ledger/types.js";
import { LocalBlobStore, type BlobStore } from "./storage/blob-store.js";

/** Largest accepted upload, in bytes. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

/** Largest accepted company logo upload, in bytes. */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

// Content sniffing lives with the store, in a module that reads no
// configuration, so MCP code can use it under a plain `bun test`.
export { sniffAllowedType } from "./storage/file-type.js";

/**
 * True when a stored path is still in the upload folder `saveToTemp` writes
 * to, so it has not yet been moved to a record's folder.
 */
export function isImportTempPath(relativePath: string): boolean {
  return relativePath.startsWith("import/temp/");
}

/**
 * The configured file store. Every new write goes through it. Built on each
 * call, not once at module load, so the root is read when it is used — the
 * same as every helper here that reads `STORAGE_PATH`.
 */
export function fileStore(): BlobStore {
  return new LocalBlobStore(STORAGE_PATH);
}

/** Longest original name kept in a stored file's name, in characters. */
const MAX_STORED_NAME_LENGTH = 120;

/**
 * The part of a client-supplied filename that is safe to put in a stored
 * file's name. The name comes from the multipart request, which the client
 * controls completely: a browser sends only the base name, but a crafted
 * request can send `../../x` or `C:\x`. So both kinds of separator, control
 * characters and the `.`/`..` names are removed, and a long name is cut,
 * keeping its extension. Spaces and non-ASCII letters stay, because
 * `displayName` shows this part to the user.
 */
export function storedNamePart(originalFilename: string): string {
  const base = originalFilename.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "" || name === "." || name === "..") return "file";
  if (name.length > MAX_STORED_NAME_LENGTH) {
    const extension = extname(name).slice(0, 10);
    name = name.slice(0, MAX_STORED_NAME_LENGTH - extension.length) + extension;
  }
  return name;
}

export async function saveToTemp(
  buffer: Buffer,
  originalFilename: string,
): Promise<string> {
  const rel = `import/temp/${randomUUID()}_${storedNamePart(originalFilename)}`;
  await fileStore().put(rel, buffer);
  return rel;
}

export async function saveReconciliationStatement(
  buffer: Buffer,
  statementKey: number | string,
  originalFilename: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9-]+$/.test(String(statementKey)))
    throw new Error("Invalid bank statement key");
  const safeName = storedNamePart(originalFilename).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const rel = `reconciliation/${statementKey}/${randomUUID()}_${safeName}`;
  await fileStore().put(rel, buffer);
  return rel;
}

export function moveToFinal(
  tempRelPath: string,
  type: "expenses" | "income" | "claims",
  documentDate: string,
): string {
  const [year, month] = documentDate.split("-");
  // Defence-in-depth: callers validate the date, but never trust it for path building.
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) {
    throw new Error(`Invalid document date for file path: ${documentDate}`);
  }
  const filename = basename(tempRelPath);
  const rel = `${type}/${year}/${month}/${filename}`;
  const src = join(STORAGE_PATH, tempRelPath);
  const dest = join(STORAGE_PATH, rel);
  const storageRoot = resolve(STORAGE_PATH);
  if (!resolve(dest).startsWith(storageRoot + sep)) {
    throw new Error("Resolved destination escapes storage root");
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  return rel;
}

// ---------------------------------------------------------------------------
// Ledger record attachments (specs/002-double-entry-ledger, D-16)
//
// One store of records means one place their files live: `records/YYYY/MM/`,
// replacing the three per-kind folders. The upgrade moves existing files there
// by copy → verify → deferred remove, never by rename: a rename that half-runs
// leaves the file in neither place, and there is no second copy to recover it
// from. Copying leaves the original untouched until every file has been
// verified by size and hash, which is what makes the move rerunnable after an
// interruption and safe to abandon (FR-032b, SC-014).
// ---------------------------------------------------------------------------

/** Guards a `YYYY-MM-DD` before any of it is used to build a path. */
function yearMonthOf(documentDate: string): { year: string; month: string } {
  const [year, month] = documentDate.split("-");
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) {
    throw new Error(`Invalid document date for file path: ${documentDate}`);
  }
  return { year, month };
}

function assertInsideStorage(
  absolutePath: string,
  storageRoot = STORAGE_PATH,
): void {
  const root = resolve(storageRoot);
  if (!resolve(absolutePath).startsWith(root + sep)) {
    throw new Error("Resolved destination escapes storage root");
  }
}

/** Where a record's attachment belongs, given the record's date. */
export function recordAttachmentPath(
  filename: string,
  documentDate: string,
): string {
  const { year, month } = yearMonthOf(documentDate);
  return `records/${year}/${month}/${basename(filename)}`;
}

/**
 * Moves an uploaded temp file into `records/YYYY/MM/`.
 *
 * Safe to call twice for the same file. When the temp file is already gone
 * but the file is at its destination, an earlier call moved it, so the
 * destination is returned. Several records made from one document call this
 * with the same temp path, and only the first one finds it there. The
 * destination is built from `documentDate`, so every such call must pass the
 * same date (the document's, not each record's own), or a later call looks in
 * a different month and misses the file. When the file is in neither place
 * this throws: returning the temp path would attach a file that does not exist.
 */
export function moveToRecordStorage(
  tempRelPath: string,
  documentDate: string,
  root = STORAGE_PATH,
): string {
  const rel = recordAttachmentPath(tempRelPath, documentDate);
  const src = join(root, tempRelPath);
  const dest = join(root, rel);
  assertInsideStorage(dest, root);
  if (!existsSync(src) && existsSync(dest)) return rel;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  return rel;
}

/**
 * Puts a file that `moveToRecordStorage` moved back where it came from.
 *
 * For a save that moved the file and then did not commit: the import job is
 * still waiting for review, so its file must be at its temp path again. Does
 * nothing when the temp path is already taken or the moved file is not there.
 * Only call it for a move this same save made. A file that was already in
 * `records/` before the save may belong to a record another save made.
 */
export function returnToTemp(
  recordRelPath: string,
  tempRelPath: string,
  root = STORAGE_PATH,
): void {
  const src = join(root, recordRelPath);
  const dest = join(root, tempRelPath);
  assertInsideStorage(dest, root);
  if (existsSync(dest) || !existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
}

/**
 * Every helper below takes the storage root it should work under, defaulting to
 * the configured one.
 *
 * That parameter is not a convenience — it is the whole safety property. These
 * are the functions the ledger upgrade uses to copy and then DELETE a business's
 * receipts. Reading `STORAGE_PATH` from module scope meant that handing the
 * upgrade a temporary database still pointed every file operation at the real
 * `data/storage`, because the database and the files were configured
 * independently. A caller that owns a sandbox must be able to say so once and
 * have it hold for both.
 */
export function fileExists(relativePath: string, root = STORAGE_PATH): boolean {
  return existsSync(join(root, relativePath));
}

export function fileSize(
  relativePath: string,
  root = STORAGE_PATH,
): number | null {
  try {
    return statSync(join(root, relativePath)).size;
  } catch {
    return null;
  }
}

/** SHA-256 of a stored file, or null when it is not there. */
export function fileHash(
  relativePath: string,
  root = STORAGE_PATH,
): string | null {
  try {
    return createHash("sha256")
      .update(readFileSync(join(root, relativePath)))
      .digest("hex");
  } catch {
    return null;
  }
}

export type CopyOutcome =
  | { status: "copied"; hash: string }
  | { status: "already-there"; hash: string }
  | { status: "source-missing" }
  | { status: "mismatch"; sourceHash: string; destinationHash: string };

/**
 * Copies a file to its new home and proves the copy is identical before anyone
 * relies on it. Never removes the original — that is `removeVerifiedOriginals`,
 * run only after the whole upgrade has verified (D-16).
 *
 * A rerun that finds the file already at its destination with a matching hash
 * reports `already-there` and does nothing, which is what makes the move
 * resumable after an interruption (FR-037).
 */
export function copyVerified(
  from: string,
  to: string,
  root = STORAGE_PATH,
): CopyOutcome {
  const sourceHash = fileHash(from, root);
  const destinationHash = fileHash(to, root);

  if (sourceHash === null) {
    // Already moved on a previous run and the original has since gone: the
    // destination standing alone is a finished move, not a failure.
    return destinationHash === null
      ? { status: "source-missing" }
      : { status: "already-there", hash: destinationHash };
  }

  if (destinationHash !== null) {
    return destinationHash === sourceHash
      ? { status: "already-there", hash: destinationHash }
      : { status: "mismatch", sourceHash, destinationHash };
  }

  const dest = join(root, to);
  assertInsideStorage(dest, root);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, from), dest);

  const copiedHash = fileHash(to, root);
  if (copiedHash !== sourceHash) {
    return {
      status: "mismatch",
      sourceHash,
      destinationHash: copiedHash ?? "",
    };
  }
  if (fileSize(to, root) !== fileSize(from, root)) {
    return { status: "mismatch", sourceHash, destinationHash: copiedHash };
  }
  return { status: "copied", hash: copiedHash };
}

/**
 * Removes the originals of files already proven identical at their destination.
 * Deferred to the very end of the upgrade, after verification passes, so an
 * interrupted or failed run leaves every original where it was (FR-038).
 */
export function removeVerifiedOriginals(
  pairs: { from: string; to: string }[],
  root = STORAGE_PATH,
): { removed: number; kept: string[] } {
  let removed = 0;
  const kept: string[] = [];
  for (const { from, to } of pairs) {
    if (from === to) continue;
    const sourceHash = fileHash(from, root);
    if (sourceHash === null) continue; // already gone
    if (fileHash(to, root) !== sourceHash) {
      kept.push(from);
      continue;
    }
    deleteFile(from, root);
    removed += 1;
  }
  return { removed, kept };
}

export function urlForFile(relativePath: string): string {
  return join(STORAGE_PATH, relativePath);
}

export function displayName(relativePath: string): string {
  const filename = basename(relativePath);
  const match = filename.match(/^[0-9a-f-]{36}_(.+)$/i);
  return match ? match[1] : filename;
}

export function deleteFile(relativePath: string, root = STORAGE_PATH): void {
  try {
    unlinkSync(join(root, relativePath));
  } catch {
    // ignore missing files
  }
}

/**
 * Import states in which a queue row no longer needs its temp file. Imported
 * means the file was moved to the record (or attached where it lay), and
 * Skipped means the user said no. Every other state still reads the file:
 * it waits to be processed, waits for review, or is part-way through confirm
 * (Confirmed is set before the file is moved), and a Failed job still shows
 * its file until it is discarded.
 */
const IMPORT_STATES_DONE_WITH_FILE: number[] = [
  ImportState.Imported,
  ImportState.Skipped,
];

/**
 * Deletes a stored file, but only when nothing still uses it. A file is in use
 * while a record attachment points at it, or while an import job that is not
 * done with it (see above) has it as its temp file.
 *
 * Call it after the row that used the file has been deleted or marked done, so
 * that row does not count. Returns false when the file was kept because
 * something uses it, and true when nothing does and the delete was tried.
 * `deleteFile` ignores errors, so true does not prove the file is gone.
 *
 * This is how one file can be shared safely: an import that makes several
 * records from one document gives each the same file, and removing one of them
 * must not delete the file the others still show.
 */
export function releaseIfUnreferenced(
  db: LedgerDb,
  relativePath: string,
  root = STORAGE_PATH,
): boolean {
  // A path that points outside storage is never ours to delete.
  if (!resolve(root, relativePath).startsWith(resolve(root) + sep)) {
    return false;
  }
  const attached = db
    .select({ id: recordAttachments.id })
    .from(recordAttachments)
    .where(eq(recordAttachments.filename, relativePath))
    .limit(1)
    .get();
  if (attached) return false;
  const pending = db
    .select({ id: importQueue.id })
    .from(importQueue)
    .where(
      and(
        eq(importQueue.tempFilePath, relativePath),
        notInArray(importQueue.state, IMPORT_STATES_DONE_WITH_FILE),
      ),
    )
    .limit(1)
    .get();
  if (pending) return false;
  deleteFile(relativePath, root);
  return true;
}

/**
 * Deletes a bank statement's file and then its folder
 * (`reconciliation/<key>/`), which `saveReconciliationStatement` made for it
 * alone. The folder is removed only when it is empty, so a file that is not
 * this statement's is never deleted with it.
 */
export function deleteStatementFile(
  storedFilePath: string,
  root = STORAGE_PATH,
): void {
  const statementsRoot = resolve(root, "reconciliation");
  const file = resolve(root, storedFilePath);
  const dir = dirname(file);
  if (dirname(dir) !== statementsRoot) return;
  deleteFile(storedFilePath, root);
  try {
    rmdirSync(dir);
  } catch {
    // not empty, or already gone
  }
}

// ---------------------------------------------------------------------------
// Company image helper
// ---------------------------------------------------------------------------

/**
 * Save a company image (the logo or the letterhead). Returns the relative path within STORAGE_PATH.
 * The extension comes from the sniffed type, never from the client's filename.
 */
export async function saveCompanyImage(
  buffer: Buffer,
  type: "jpeg" | "png",
): Promise<string> {
  const rel = `company/${randomUUID()}.${type === "jpeg" ? "jpg" : "png"}`;
  await fileStore().put(rel, buffer);
  return rel;
}
