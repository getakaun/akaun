import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  displayName,
  recordAttachmentPath,
  storedNamePart,
} from "../file-storage.js";
import {
  addAttachment as addAttachmentRow,
  getRecord,
  searchableAttachmentFilenames,
  setExtractedText,
} from "../queries/ledger.js";
import { emitRecordUpdate } from "../services/ledger.js";
import { sniffAllowedType } from "../storage/file-type.js";
import { hit } from "../rate-limit.js";
import { createLogger } from "../logger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, missing, ok, type AppResult } from "./result.js";
import { positiveId } from "./records.js";
import { recordVersion } from "./version.js";

const log = createLogger("attachments");

/** Largest file attached through MCP, the same as the upload form's. */
export const MAX_ATTACHMENT_FILE_BYTES = 15 * 1024 * 1024;
/** How many files one user may attach through MCP in a window. */
export const ATTACH_LIMIT = { max: 30, windowMs: 10 * 60_000 };

export const attachFileShape = {
  recordId: positiveId,
  /** Shown in the app as the attachment's name. */
  filename: z.string().trim().min(1).max(200),
  /** The file's bytes, base64. PDF, JPEG or PNG, up to 15 MB. */
  contentBase64: z.string().min(4),
};

/**
 * Attaches a file to a record, from an MCP client.
 *
 * The same rules as the upload form (`api/records/[id]/attachments`): the
 * `change` ability, 15 MB, and a type told from the bytes themselves, never
 * from the name. Allowed on a settled or reconciled record — a receipt is
 * supporting evidence, not accounting data (FR-017a).
 *
 * The file is written straight to its final key through the store, and taken
 * back if the row cannot be written, so nothing is left behind for a later
 * cleanup to find. Its text is read for search afterwards and in the
 * background: OCR can take far longer than an MCP call should.
 */
export async function attachFile(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof attachFileShape>>,
): Promise<AppResult<Record<string, unknown>>> {
  const refused = requirePermissions(ctx, ["records.update"]);
  if (refused) return refused;
  const record = getRecord(ctx.db, input.recordId);
  if (!record) return missing("That record no longer exists.");
  if (!ctx.store || !ctx.storageRoot)
    return fail("REFUSED", "File storage is not available here.");
  const userId = actor(ctx);

  if (
    hit(`mcp-attach:${userId}`, ATTACH_LIMIT.max, ATTACH_LIMIT.windowMs).limited
  )
    return fail(
      "REFUSED",
      "Too many files attached recently. Wait a few minutes and try again.",
    );

  const encoded = input.contentBase64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1)
    return fail("INVALID_INPUT", "contentBase64 is not valid base64.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES)
    return fail(
      "PAYLOAD_TOO_LARGE",
      `That file is too big. The largest that can be attached is ${MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)} MB.`,
    );
  // Content-based, so a renamed file cannot get past it.
  if (!sniffAllowedType(bytes))
    return fail(
      "UNSUPPORTED_MEDIA_TYPE",
      "Only PDF, JPEG and PNG files can be attached.",
    );

  const key = recordAttachmentPath(
    `${randomUUID()}_${storedNamePart(input.filename)}`,
    record.date,
  );
  await ctx.store.put(key, bytes);
  let attachment;
  try {
    attachment = addAttachmentRow(ctx.db, record.id, key, displayName(key));
  } catch (error) {
    // No row points at the file, so remove it.
    await ctx.store.delete(key);
    throw error;
  }

  recordAudit(ctx.db, {
    recordType: "record",
    recordId: record.id,
    userId,
    action: "update",
    changes: [
      { field: "attachments", before: null, after: attachment.displayName },
    ],
  });
  emitRecordUpdate(ctx.db, record.id);

  const index = ctx.indexAttachments;
  const root = ctx.storageRoot;
  if (index) {
    // Re-run over every attachment, so the record's searchable text matches
    // what "Rebuild search index" would produce. Best-effort.
    void index(searchableAttachmentFilenames(ctx.db, record.id), root)
      .then((text) => {
        if (text == null || !getRecord(ctx.db, record.id)) return;
        setExtractedText(ctx.db, record.id, text);
        emitRecordUpdate(ctx.db, record.id);
      })
      .catch(() =>
        log.warn({ recordId: record.id }, "Attachment indexing failed"),
      );
  }

  return ok({
    attachment: {
      id: attachment.id,
      displayName: attachment.displayName,
      addedDate: attachment.addedDate,
    },
    recordId: record.id,
    version: recordVersion(ctx.db, record.id),
  });
}
