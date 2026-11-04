import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ClosedPeriodError } from "$lib/server/closing/policy.js";

/**
 * An attachment upload whose row cannot be written must not leave its file
 * behind. The record queries are mocked to fail at the insert; the database
 * `releaseIfUnreferenced` asks is an in-memory copy migrated from `drizzle/`,
 * and the storage path is a folder under `os.tmpdir()`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-attachment-cleanup-spec-"));
const storage = join(sandbox, "storage");
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  error: new Error("database is locked"),
  boundary: null as string | null,
}));
vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));
vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("$lib/server/permissions.js", () => ({
  can: () => true,
  canAll: () => true,
}));
vi.mock("$lib/server/queries/ledger.js", () => ({
  getRecord: () => ({
    id: 42,
    kind: 1,
    date: "2026-08-01",
    periodClosedThrough: holder.boundary,
  }),
  addAttachment: () => {
    throw holder.error;
  },
  listAttachments: () => [],
  searchableAttachmentFilenames: () => [],
  setExtractedText: () => {},
}));
vi.mock("$lib/server/audit.js", () => ({ recordAudit: () => {} }));
vi.mock("$lib/server/services/ledger.js", () => ({
  emitRecordUpdate: () => {},
}));
vi.mock("$lib/server/extraction/attachment-text.js", () => ({
  extractAttachmentsText: async () => null,
}));

const schema = await import("$lib/server/db/schema.js");
const sqlite = new Database(":memory:");
holder.db = drizzle(sqlite, { schema });
migrate(holder.db as never, { migrationsFolder: "drizzle" });
afterAll(() => sqlite.close());

const { POST } = await import("./+server.js");

describe("POST /api/records/[id]/attachments when the row cannot be written", () => {
  it("removes the moved file again", async () => {
    holder.error = new Error("database is locked");
    holder.boundary = null;
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4 receipt"], "receipt.pdf"));
    const saving = (POST as (event: never) => Promise<Response>)({
      locals: { user: { id: 1 } },
      params: { id: "42" },
      request: new Request("http://localhost/", { method: "POST", body: form }),
    } as never);
    await expect(saving).rejects.toThrow("database is locked");
    expect(readdirSync(join(storage, "records/2026/08"))).toEqual([]);
    expect(readdirSync(join(storage, "import/temp"))).toEqual([]);
  });

  it("returns a closing refusal after cleaning up a file saved before the month closed", async () => {
    holder.error = new ClosedPeriodError("2026-10-31");
    holder.boundary = null;
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4 receipt"], "receipt.pdf"));
    const response = await (POST as (event: never) => Promise<Response>)({
      locals: { user: { id: 1 } },
      params: { id: "42" },
      request: new Request("http://localhost/", { method: "POST", body: form }),
    } as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: expect.stringMatching(/closed through 2026-10-31/),
    });
    expect(readdirSync(join(storage, "records/2026/08"))).toEqual([]);
    expect(readdirSync(join(storage, "import/temp"))).toEqual([]);
  });

  it("refuses an already frozen record before reading the upload", async () => {
    holder.boundary = "2026-10-31";
    const formData = vi.fn();
    const response = await (POST as (event: never) => Promise<Response>)({
      locals: { user: { id: 1 } },
      params: { id: "42" },
      request: { formData },
    } as never);
    expect(response.status).toBe(409);
    expect(formData).not.toHaveBeenCalled();
    holder.boundary = null;
  });
});
