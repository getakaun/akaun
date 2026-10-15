import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ImportState, LedgerRecordKind } from "$lib/enums.js";

/**
 * The file helpers that move and delete stored files.
 *
 * Every call here passes its own storage root under `os.tmpdir()`, and the
 * database is an in-memory copy migrated from `drizzle/`. The configured
 * storage path is mocked too, so a helper that forgot to take the root would
 * still land in the sandbox and not in `data/storage`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-file-storage-spec-"));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return join(sandbox, "default-root");
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

const schema = await import("./db/schema.js");
const { importQueue, ledgerRecords, recordAttachments, users } = schema;
const {
  deleteStatementFile,
  displayName,
  fileExists,
  moveToRecordStorage,
  releaseIfUnreferenced,
  saveCompanyImage,
  saveToTemp,
  storedNamePart,
} = await import("./file-storage.js");
type LedgerDb = import("./ledger/types.js").LedgerDb;

let sqlite: Database;
let db: LedgerDb;
let root: string;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  root = mkdtempSync(join(sandbox, "root-"));
});
afterEach(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function putFile(rel: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "%PDF-1.4 test");
}

function addRecord(): number {
  return db
    .insert(ledgerRecords)
    .values({ kind: LedgerRecordKind.Expense, date: "2026-08-01", amount: 10 })
    .returning({ id: ledgerRecords.id })
    .get().id;
}

function attach(recordId: number, filename: string) {
  db.insert(recordAttachments)
    .values({ recordId, filename, displayName: "receipt.pdf" })
    .run();
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

describe("moveToRecordStorage", () => {
  const temp = "import/temp/0b7e-receipt.pdf";

  it("moves the temp file into records/YYYY/MM/", () => {
    putFile(temp);
    const rel = moveToRecordStorage(temp, "2026-08-14", root);
    expect(rel).toBe("records/2026/08/0b7e-receipt.pdf");
    expect(fileExists(rel, root)).toBe(true);
    expect(fileExists(temp, root)).toBe(false);
  });

  it("returns the destination again when the file was already moved", () => {
    putFile(temp);
    const first = moveToRecordStorage(temp, "2026-08-14", root);
    // A second record made from the same document moves the same temp path.
    const second = moveToRecordStorage(temp, "2026-08-14", root);
    expect(second).toBe(first);
    expect(fileExists(second, root)).toBe(true);
  });

  it("throws when the file is in neither place", () => {
    expect(() => moveToRecordStorage(temp, "2026-08-14", root)).toThrow();
  });
});

describe("releaseIfUnreferenced", () => {
  const file = "records/2026/08/receipt.pdf";

  it("deletes a file nothing uses", () => {
    putFile(file);
    expect(releaseIfUnreferenced(db, file, root)).toBe(true);
    expect(fileExists(file, root)).toBe(false);
  });

  it("keeps a file a record attachment points at", () => {
    putFile(file);
    attach(addRecord(), file);
    expect(releaseIfUnreferenced(db, file, root)).toBe(false);
    expect(fileExists(file, root)).toBe(true);
  });

  it("keeps a temp file an unfinished import job still uses", () => {
    const temp = "import/temp/abc_receipt.pdf";
    for (const state of [
      ImportState.Queued,
      ImportState.Extracting,
      ImportState.Processing,
      ImportState.PendingReview,
      ImportState.Confirmed,
      ImportState.Failed,
    ]) {
      putFile(temp);
      queueJob(`job-${state}`, temp, state);
      expect(releaseIfUnreferenced(db, temp, root)).toBe(false);
      expect(fileExists(temp, root)).toBe(true);
      db.delete(importQueue).run();
    }
  });

  it("does not count a job that is done with the file", () => {
    const temp = "import/temp/abc_receipt.pdf";
    putFile(temp);
    queueJob("imported", temp, ImportState.Imported);
    queueJob("skipped", temp, ImportState.Skipped);
    expect(releaseIfUnreferenced(db, temp, root)).toBe(true);
    expect(fileExists(temp, root)).toBe(false);
  });

  it("never deletes outside the storage root", () => {
    const outside = join(sandbox, "outside.pdf");
    writeFileSync(outside, "keep");
    expect(releaseIfUnreferenced(db, "../outside.pdf", root)).toBe(false);
    expect(fileExists("outside.pdf", sandbox)).toBe(true);
  });
});

describe("storedNamePart", () => {
  it("keeps only the base name of a client filename", () => {
    expect(storedNamePart("../../evil.pdf")).toBe("evil.pdf");
    expect(storedNamePart("C:\\Users\\me\\receipt.pdf")).toBe("receipt.pdf");
    expect(storedNamePart("a/b/c.png")).toBe("c.png");
  });

  it("keeps spaces and non-ASCII letters, drops control characters", () => {
    expect(storedNamePart("Kedai Runcit\u0000 收据.pdf")).toBe(
      "Kedai Runcit 收据.pdf",
    );
  });

  it("never returns an empty or dot name", () => {
    for (const name of ["", "..", ".", "../", "\u0001"]) {
      expect(storedNamePart(name)).toBe("file");
    }
  });

  it("cuts a long name and keeps its extension", () => {
    const name = storedNamePart(`${"x".repeat(300)}.pdf`);
    expect(name.length).toBe(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("saving an upload", () => {
  const configuredRoot = join(sandbox, "default-root");

  it("keeps a traversal filename inside the upload folder", async () => {
    const rel = await saveToTemp(Buffer.from("%PDF-1.4"), "../../../evil.pdf");
    expect(rel).toMatch(/^import\/temp\/[0-9a-f-]{36}_evil\.pdf$/);
    expect(existsSync(join(configuredRoot, rel))).toBe(true);
    expect(existsSync(join(sandbox, "evil.pdf"))).toBe(false);
    expect(displayName(rel)).toBe("evil.pdf");
  });

  it("names a company image by its sniffed type, not the client name", async () => {
    const rel = await saveCompanyImage(Buffer.from([0xff, 0xd8, 0xff]), "jpeg");
    expect(rel).toMatch(/^company\/[0-9a-f-]{36}\.jpg$/);
    expect(existsSync(join(configuredRoot, rel))).toBe(true);
  });
});

describe("deleteStatementFile", () => {
  it("deletes the statement's file and its now-empty folder", () => {
    putFile("reconciliation/k1/a_august.pdf");
    deleteStatementFile("reconciliation/k1/a_august.pdf", root);
    expect(existsSync(join(root, "reconciliation/k1"))).toBe(false);
    expect(existsSync(join(root, "reconciliation"))).toBe(true);
  });

  it("keeps the folder while another file is in it", () => {
    putFile("reconciliation/k2/a_august.pdf");
    putFile("reconciliation/k2/b_other.pdf");
    deleteStatementFile("reconciliation/k2/a_august.pdf", root);
    expect(fileExists("reconciliation/k2/a_august.pdf", root)).toBe(false);
    expect(fileExists("reconciliation/k2/b_other.pdf", root)).toBe(true);
  });

  it("touches nothing outside a statement folder", () => {
    putFile("records/2026/08/receipt.pdf");
    deleteStatementFile("records/2026/08/receipt.pdf", root);
    deleteStatementFile("reconciliation/../records/2026/08/receipt.pdf", root);
    expect(fileExists("records/2026/08/receipt.pdf", root)).toBe(true);
  });
});
