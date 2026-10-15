import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { hasPermission } from "$lib/server/permissions.js";
import { forbidden, notFound, refused } from "$lib/server/api-response.js";
import {
  addAttachment,
  getRecord,
  listAttachments,
  searchableAttachmentFilenames,
  setExtractedText,
} from "$lib/server/queries/ledger.js";
import { resourceForKind } from "$lib/server/ledger/record-permissions.js";
import { recordAudit } from "$lib/server/audit.js";
import { emitRecordUpdate } from "$lib/server/services/ledger.js";
import { extractAttachmentsText } from "$lib/server/extraction/attachment-text.js";
import {
  displayName,
  MAX_UPLOAD_BYTES,
  moveToRecordStorage,
  releaseIfUnreferenced,
  saveToTemp,
  sniffAllowedType,
} from "$lib/server/file-storage.js";

/**
 * One pair of endpoints now serves every record, whatever its kind. Files land
 * in `records/YYYY/MM/` (D-16).
 *
 * Attachments stay editable on a settled or reconciled record: a receipt is a
 * supporting document, not accounting data, and adding a missing one cannot
 * make any other record wrong (FR-017a).
 */
/** What is already attached, so the record's page shows the receipts on it
 *  rather than an empty box until something new is uploaded. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    return notFound("That record no longer exists.");
  }

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  if (!hasPermission(locals, resourceForKind(record.kind), "view")) {
    return forbidden();
  }

  return Response.json(listAttachments(db, id));
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    return notFound("That record no longer exists.");
  }

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  if (!hasPermission(locals, resourceForKind(record.kind), "change")) {
    return forbidden();
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return refused("Choose a file to attach.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return refused(
      `That file is too big. The largest that can be attached is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Content-based, so a renamed file cannot get past it.
  if (!sniffAllowedType(buffer)) {
    return refused("Only PDF, JPEG and PNG files can be attached.");
  }

  let finalPath = await saveToTemp(buffer, file.name);
  let attachment;
  try {
    finalPath = moveToRecordStorage(finalPath, record.date);
    attachment = addAttachment(db, id, finalPath, displayName(finalPath));
  } catch (e) {
    // No row points at the upload, so remove it wherever it got to.
    releaseIfUnreferenced(db, finalPath);
    throw e;
  }

  // Re-run over every attachment, not just the new one, so the record's
  // searchable text matches what "Rebuild search index" would produce. A file
  // other records share (one document imported as several items) is left out,
  // so its text is not put back on this record (006 FR-029).
  try {
    const text = await extractAttachmentsText(
      searchableAttachmentFilenames(db, id),
    );
    if (text != null) setExtractedText(db, id, text);
  } catch {
    // Best-effort: an attachment must still save even if it can't be indexed.
  }

  recordAudit(db, {
    recordType: "record",
    recordId: id,
    userId: locals.user!.id,
    action: "update",
    changes: [{ field: "attachments", before: null, after: attachment.displayName }],
  });
  emitRecordUpdate(db, id);

  return Response.json(attachment, { status: 201 });
};
