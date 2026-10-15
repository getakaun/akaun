import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { forbidden, notFound } from "$lib/server/api-response.js";
import {
  deleteAttachment,
  getAttachment,
  getRecord,
} from "$lib/server/queries/ledger.js";
import { permissionForKind } from "$lib/server/ledger/record-permissions.js";
import { recordAudit } from "$lib/server/audit.js";
import { emitRecordUpdate } from "$lib/server/services/ledger.js";
import { fileStore, releaseIfUnreferenced } from "$lib/server/file-storage.js";
import { storedFileResponse } from "$lib/server/stored-file-response.js";

/**
 * The attachment's file. It is found by its id and checked against its record,
 * so the URL says nothing about where the file is stored, and seeing it needs
 * the same ability as seeing the record.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  const p = params as { id: string; attachmentId: string };
  const id = Number(p.id);
  const attachmentId = Number(p.attachmentId);
  if (!Number.isInteger(id) || !Number.isInteger(attachmentId)) {
    return notFound("That attachment no longer exists.");
  }

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  if (!can(locals, permissionForKind(record.kind, "read"))) {
    return forbidden();
  }

  const attachment = getAttachment(db, attachmentId);
  if (!attachment || attachment.recordId !== id) {
    return notFound("That attachment no longer exists.");
  }

  return storedFileResponse(
    fileStore(),
    request,
    attachment.filename,
    attachment.displayName,
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const p = params as { id: string; attachmentId: string };
  const id = Number(p.id);
  const attachmentId = Number(p.attachmentId);
  if (!Number.isInteger(id) || !Number.isInteger(attachmentId)) {
    return notFound("That attachment no longer exists.");
  }

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  // Deleting, not changing: the file can be gone for good, so it needs what
  // deleting a record needs — as the catalog and the consent screen say.
  if (!can(locals, permissionForKind(record.kind, "delete"))) {
    return forbidden();
  }

  const attachment = getAttachment(db, attachmentId);
  if (!attachment || attachment.recordId !== id) {
    return notFound("That attachment no longer exists.");
  }

  if (!deleteAttachment(db, attachmentId)) {
    return notFound("That attachment no longer exists.");
  }
  // The row goes first: a file left behind is recoverable, a row pointing at a
  // file that is gone is not. The file stays while another record still
  // shows it.
  releaseIfUnreferenced(db, attachment.filename);

  recordAudit(db, {
    recordType: "record",
    recordId: id,
    userId: locals.user!.id,
    action: "update",
    changes: [
      { field: "attachments", before: attachment.displayName, after: null },
    ],
  });
  emitRecordUpdate(db, id);

  return new Response(null, { status: 204 });
};
