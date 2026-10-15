import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ImportState, LedgerRecordKind } from "$lib/enums.js";

/**
 * The four routes that delete a stored file: removing an attachment, skipping
 * an import, discarding one, and clearing import history. Each used to delete
 * the file outright. Now each deletes it only when no record attachment and no
 * unfinished import job still uses it, so one file can be shared safely.
 *
 * The routes import the singleton `db`, which opens DATABASE_PATH at import
 * time. Under a test runner that resolves to the real `data/akaun.db`, so the
 * module is mocked with an in-memory database migrated from `drizzle/`, and
 * the storage path is mocked to a folder under `os.tmpdir()`.
 */

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
}));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return holder.storageRoot;
  },
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

// Emitting a record update reads balances this bare database has no accounts
// for; the event itself is not what these tests check.
vi.mock("$lib/server/services/ledger.js", () => ({
  emitRecordUpdate: () => {},
}));

const schema = await import("$lib/server/db/schema.js");
const { importQueue, ledgerRecords, recordAttachments, users } = schema;

let sqlite: Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  holder.db = db;
  holder.storageRoot = mkdtempSync(join(tmpdir(), "akaun-file-release-"));
});
afterEach(() => {
  sqlite.close();
  rmSync(holder.storageRoot, { recursive: true, force: true });
});

const locals = { user: { id: 1 } } as never;

// Load the four routes once, before any test's clock starts. Skip and discard
// now also reach the group code (services/import-items.ts), and loading that
// the first time can take longer than one test is given on a busy run.
beforeAll(async () => {
  await Promise.all([
    import("./records/[id]/attachments/[attachmentId]/+server.js"),
    import("./import/history/+server.js"),
    import("./import/[jobId]/skip/+server.js"),
    import("./import/[jobId]/+server.js"),
  ]);
}, 60_000);

function putFile(rel: string) {
  const abs = join(holder.storageRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "%PDF-1.4 test");
}

function stored(rel: string): boolean {
  return existsSync(join(holder.storageRoot, rel));
}

function addRecord(): number {
  return db
    .insert(ledgerRecords)
    .values({ kind: LedgerRecordKind.Expense, date: "2026-08-01", amount: 10 })
    .returning({ id: ledgerRecords.id })
    .get().id;
}

function attach(recordId: number, filename: string): number {
  return db
    .insert(recordAttachments)
    .values({ recordId, filename, displayName: "receipt.pdf" })
    .returning({ id: recordAttachments.id })
    .get().id;
}

function queueJob(id: string, tempFilePath: string, state: number) {
  db.insert(importQueue)
    .values({
      id,
      createdBy: 1,
      state,
      tempFilePath,
      originalFilename: "receipt.pdf",
    })
    .run();
}

type Handler = (event: never) => Promise<Response>;

async function deleteAttachment(recordId: number, attachmentId: number) {
  const { DELETE } =
    await import("./records/[id]/attachments/[attachmentId]/+server.js");
  return (DELETE as Handler)({
    locals,
    params: { id: String(recordId), attachmentId: String(attachmentId) },
  } as never);
}

async function clearHistory() {
  const { DELETE } = await import("./import/history/+server.js");
  return (DELETE as Handler)({ locals } as never);
}

async function skipJob(jobId: string) {
  const { POST } = await import("./import/[jobId]/skip/+server.js");
  return (POST as Handler)({ locals, params: { jobId } } as never);
}

async function discardJob(jobId: string) {
  const { DELETE } = await import("./import/[jobId]/+server.js");
  return (DELETE as Handler)({ locals, params: { jobId } } as never);
}

describe("attachment delete", () => {
  const file = "records/2026/08/shared.pdf";

  it("keeps a file another record still shows, and deletes it with the last one", async () => {
    putFile(file);
    const first = addRecord();
    const second = addRecord();
    const firstAttachment = attach(first, file);
    const secondAttachment = attach(second, file);

    expect((await deleteAttachment(first, firstAttachment)).status).toBe(204);
    expect(stored(file)).toBe(true);

    expect((await deleteAttachment(second, secondAttachment)).status).toBe(204);
    expect(stored(file)).toBe(false);
  });
});

describe("history clear", () => {
  it("keeps a file a record uses, even when it is the job's temp path", async () => {
    // A failed move leaves the record attached to the temp file itself, and
    // the job's temp path is never updated, so both point at the same file.
    const temp = "import/temp/abc_receipt.pdf";
    putFile(temp);
    attach(addRecord(), temp);
    queueJob("imported", temp, ImportState.Imported);

    expect((await clearHistory()).status).toBe(204);
    expect(db.select().from(importQueue).all()).toHaveLength(0);
    expect(stored(temp)).toBe(true);
  });

  it("deletes the temp file of a skipped job nothing else uses", async () => {
    const temp = "import/temp/def_receipt.pdf";
    putFile(temp);
    queueJob("skipped", temp, ImportState.Skipped);

    expect((await clearHistory()).status).toBe(204);
    expect(stored(temp)).toBe(false);
  });
});

describe("skip and discard", () => {
  const temp = "import/temp/ghi_statement.pdf";

  it("skip deletes a file only that job uses", async () => {
    putFile(temp);
    queueJob("only", temp, ImportState.PendingReview);

    expect((await skipJob("only")).status).toBe(204);
    expect(stored(temp)).toBe(false);
  });

  it("skip keeps a file another pending job shares", async () => {
    putFile(temp);
    queueJob("a", temp, ImportState.PendingReview);
    queueJob("b", temp, ImportState.PendingReview);

    expect((await skipJob("a")).status).toBe(204);
    expect(stored(temp)).toBe(true);

    expect((await skipJob("b")).status).toBe(204);
    expect(stored(temp)).toBe(false);
  });

  it("discard deletes a file only that job uses", async () => {
    putFile(temp);
    queueJob("only", temp, ImportState.PendingReview);

    expect((await discardJob("only")).status).toBe(204);
    expect(stored(temp)).toBe(false);
  });

  it("discard keeps a file a record already uses", async () => {
    putFile(temp);
    attach(addRecord(), temp);
    queueJob("pending", temp, ImportState.PendingReview);

    expect((await discardJob("pending")).status).toBe(204);
    expect(stored(temp)).toBe(true);
  });
});
