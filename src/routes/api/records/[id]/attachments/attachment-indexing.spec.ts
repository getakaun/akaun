import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Attaching a file to an *existing* record used to save the file and stop
 * there — nothing re-ran extraction or reindexed the record's search text, so
 * a manually attached receipt was never findable by its content, unlike one
 * that arrived through auto-import or a later "Rebuild search index" run.
 * This spec pins the fix: POST must re-extract over every attachment the
 * record now has and feed the result into `setExtractedText`.
 *
 * The route imports the singleton `db`, which opens DATABASE_PATH at import
 * time — mocked here, like `attachment-file.spec.ts`, so it never loads the
 * real one.
 */

vi.mock("$lib/server/db/client.js", () => ({ db: {} }));
vi.mock("$lib/server/permissions.js", () => ({ hasPermission: () => true }));

const record = { id: 42, kind: 1, date: "2026-01-01" };
const attachment = { id: 7, recordId: 42, filename: "records/2026/08/receipt.pdf", displayName: "receipt.pdf" };
const existingAttachments = [{ filename: "records/2026/08/older.pdf" }];

const getRecord = vi.fn(() => record);
const addAttachment = vi.fn(() => attachment);
const listAttachments = vi.fn(() => [...existingAttachments, { filename: attachment.filename }]);
const setExtractedText = vi.fn();
vi.mock("$lib/server/queries/ledger.js", () => ({
  getRecord: (...args: unknown[]) => getRecord(...(args as [])),
  addAttachment: (...args: unknown[]) => addAttachment(...(args as [])),
  listAttachments: (...args: unknown[]) => listAttachments(...(args as [])),
  // No file here is shared with another record, so every one is searchable.
  searchableAttachmentFilenames: () => listAttachments().map((a) => a.filename),
  setExtractedText: (...args: unknown[]) => setExtractedText(...(args as [])),
}));

const recordAudit = vi.fn();
vi.mock("$lib/server/audit.js", () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...(args as [])),
}));

const emitRecordUpdate = vi.fn();
vi.mock("$lib/server/services/ledger.js", () => ({
  emitRecordUpdate: (...args: unknown[]) => emitRecordUpdate(...(args as [])),
}));

const extractAttachmentsText = vi.fn();
vi.mock("$lib/server/extraction/attachment-text.js", () => ({
  extractAttachmentsText: (...args: unknown[]) => extractAttachmentsText(...(args as [])),
}));

vi.mock("$lib/server/file-storage.js", () => ({
  displayName: () => "receipt.pdf",
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  moveToRecordStorage: () => "records/2026/08/receipt.pdf",
  saveToTemp: () => "/tmp/upload",
  sniffAllowedType: () => true,
}));

const locals = { user: { id: 1 } } as never;

async function post(file: File) {
  const { POST } = await import("./+server.js");
  const formData = new FormData();
  formData.append("file", file);
  const request = { formData: async () => formData } as unknown as Request;
  return (POST as (event: never) => Promise<Response>)({
    locals,
    params: { id: "42" },
    request,
  } as never);
}

function pdfFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "receipt.pdf", {
    type: "application/pdf",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getRecord.mockReturnValue(record);
  addAttachment.mockReturnValue(attachment);
  listAttachments.mockReturnValue([
    ...existingAttachments,
    { filename: attachment.filename },
  ]);
});

describe("POST /api/records/[id]/attachments", () => {
  it("re-extracts over every attachment and saves the result", async () => {
    extractAttachmentsText.mockResolvedValue("Receipt from Acme Hardware");

    const response = await post(pdfFile());

    expect(response.status).toBe(201);
    expect(extractAttachmentsText).toHaveBeenCalledWith([
      "records/2026/08/older.pdf",
      attachment.filename,
    ]);
    expect(setExtractedText).toHaveBeenCalledWith({}, 42, "Receipt from Acme Hardware");
    // The broadcast reflects the fully-settled state, so it fires after indexing.
    const indexOrder = setExtractedText.mock.invocationCallOrder[0];
    const emitOrder = emitRecordUpdate.mock.invocationCallOrder[0];
    expect(indexOrder).toBeLessThan(emitOrder);
  });

  it("still saves the attachment when extraction finds no text", async () => {
    extractAttachmentsText.mockResolvedValue(null);

    const response = await post(pdfFile());

    expect(response.status).toBe(201);
    expect(setExtractedText).not.toHaveBeenCalled();
    expect(emitRecordUpdate).toHaveBeenCalledWith({}, 42);
  });

  it("still saves the attachment when extraction throws", async () => {
    extractAttachmentsText.mockRejectedValue(new Error("ocr worker crashed"));

    const response = await post(pdfFile());

    expect(response.status).toBe(201);
    expect(setExtractedText).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalled();
    expect(emitRecordUpdate).toHaveBeenCalledWith({}, 42);
  });
});
