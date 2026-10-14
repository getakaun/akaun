import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening an attachment: it is found by its id, it must belong to the record
 * in the URL, and seeing it needs `records:view` like the record itself.
 *
 * The route imports the singleton `db`, which opens DATABASE_PATH at import
 * time, so that module is mocked and never loads the real one. The storage
 * path is a folder under `os.tmpdir()`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-attachment-file-spec-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));
vi.mock("$lib/server/db/client.js", () => ({ db: {} }));

const allowed = { view: true };
vi.mock("$lib/server/permissions.js", () => ({
  hasPermission: (_locals: unknown, resource: string, action: string) =>
    resource === "records" && action === "view" && allowed.view,
}));

const records: Record<number, { id: number; kind: number }> = {
  42: { id: 42, kind: 1 },
  43: { id: 43, kind: 1 },
};
const attachments: Record<
  number,
  { id: number; recordId: number; filename: string; displayName: string }
> = {
  7: {
    id: 7,
    recordId: 42,
    filename:
      "records/2026/08/0b3f8e8e-7c1a-4f7e-9d6a-1c2b3d4e5f60_receipt.pdf",
    displayName: "receipt.pdf",
  },
};
vi.mock("$lib/server/queries/ledger.js", () => ({
  getRecord: (_db: unknown, id: number) => records[id],
  getAttachment: (_db: unknown, id: number) => attachments[id] ?? null,
  deleteAttachment: () => false,
}));
vi.mock("$lib/server/audit.js", () => ({ recordAudit: () => {} }));
vi.mock("$lib/server/services/ledger.js", () => ({
  emitRecordUpdate: () => {},
}));

const { GET } = await import("./[attachmentId]/+server.js");
const PDF = "%PDF-1.4 receipt";

function open(id: string, attachmentId: string, user: unknown = { id: 1 }) {
  return (GET as (event: never) => Promise<Response>)({
    locals: { user },
    params: { id, attachmentId },
    request: new Request("http://localhost/"),
  } as never);
}

beforeEach(() => {
  allowed.view = true;
  const abs = join(sandbox, "storage", attachments[7].filename);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, PDF);
});

describe("GET /api/records/[id]/attachments/[attachmentId]", () => {
  it("streams the file under its display name", async () => {
    const response = await open("42", "7");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain(
      'filename="receipt.pdf"',
    );
    expect(await response.text()).toBe(PDF);
  });

  it("refuses a caller who is not signed in", async () => {
    expect((await open("42", "7", null)).status).toBe(401);
  });

  it("refuses a user without records:view", async () => {
    allowed.view = false;
    expect((await open("42", "7")).status).toBe(403);
  });

  it("does not open an attachment through another record", async () => {
    expect((await open("43", "7")).status).toBe(404);
  });

  it("is 404 for an unknown attachment or record", async () => {
    expect((await open("42", "999")).status).toBe(404);
    expect((await open("999", "7")).status).toBe(404);
    expect((await open("42", "abc")).status).toBe(404);
  });
});
