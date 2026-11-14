import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Import confirm split into an asynchronous prepare and a synchronous commit,
 * and skip / discard inside a unit of work.
 *
 * Every database is in memory (`releaseBook`), every file lives under
 * `os.tmpdir()`, the configured storage path is mocked to that sandbox too, and
 * the exchange-rate lookup is a stub, so nothing here reaches `data/` or the
 * network.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-import-confirm-split-"));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return join(sandbox, "default-root");
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

const rateLookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("$lib/server/currency/rates.js", () => ({
  getExchangeRate: async () => {
    rateLookups.count += 1;
    return { rate: 4.5, source: "api" };
  },
}));

const { AccountType, DocumentType, ImportState } =
  await import("$lib/enums.js");
const schema = await import("../db/schema.js");
const { eq } = await import("drizzle-orm");
const { releaseBook, resultValue } =
  await import("./__fixtures__/release-book.js");
const { createAccount } = await import("../services/accounts.js");
const { fileExists } = await import("../file-storage.js");
const { importEvents } = await import("../import/events.js");
const { accountEvents, ledgerEvents } = await import("../ledger/events.js");
const { auditEvents } = await import("../audit-events.js");
const { runUnitOfWork } = await import("../unit-of-work.js");
const { confirmImportRow } = await import("../services/import.js");
const { localsFor } = await import("../permissions/test-locals.js");
const {
  commitImportConfirm,
  commitImportConfirmItem,
  confirmImport,
  discardImportJob,
  prepareImportConfirm,
  skipImport,
} = await import("./import.js");
const { importJobVersion } = await import("./version.js");

type Book = ReturnType<typeof releaseBook>;
type Ctx = Book["ctx"] & { storageRoot: string };

const receiptId = "5f0c9a52-6f5e-4c1e-9d38-3e1e0b7c2a11";
const groupId = "7a1d3c44-2b9e-4f10-8c55-0d2e6b9f4a22";
const receiptTemp = `import/temp/${receiptId}_receipt.pdf`;
const receiptDest = `records/2026/08/${receiptId}_receipt.pdf`;
const groupTemp = `import/temp/${groupId}_fees.pdf`;
const groupDest = `records/2026/07/${groupId}_fees.pdf`;

let book: Book;
let ctx: Ctx;
let root: string;
let category: number;
const stopListening: (() => void)[] = [];

beforeEach(() => {
  rateLookups.count = 0;
  book = releaseBook();
  root = mkdtempSync(join(sandbox, "root-"));
  ctx = { ...book.ctx, storageRoot: root };
  category = resultValue(
    createAccount(book.db, 1, {
      name: "Marketplace fees",
      type: AccountType.Expense,
    }),
  ).id;
});
afterEach(() => {
  for (const stop of stopListening.splice(0)) stop();
  book.raw.close();
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

function queueReceipt(currency = "MYR") {
  book.db
    .insert(schema.importQueue)
    .values({
      id: receiptId,
      createdBy: 1,
      state: ImportState.PendingReview,
      tempFilePath: receiptTemp,
      originalFilename: "receipt.pdf",
      documentType: DocumentType.Expense,
      itemName: "Printer paper",
      supplier: "Stationery Sdn Bhd",
      date: "2026-08-14",
      amount: 12.5,
      currency,
      extractedText: "RECEIPT 12.50",
      processedAt: "2026-08-14T10:00:00.000Z",
    })
    .run();
  putFile(receiptTemp);
}

function queueGroup(count = 3): string[] {
  book.db
    .insert(schema.importQueue)
    .values({
      id: groupId,
      createdBy: 1,
      state: ImportState.Grouped,
      tempFilePath: groupTemp,
      originalFilename: "fees.pdf",
      date: "2026-07-31",
      supplier: "Shopee Malaysia",
      currency: "MYR",
    })
    .run();
  putFile(groupTemp);
  const ids: string[] = [];
  for (let position = 0; position < count; position++) {
    const id = `item-${position}`;
    ids.push(id);
    book.db
      .insert(schema.importItems)
      .values({
        id,
        jobId: groupId,
        state: ImportState.PendingReview,
        position,
        sourceLine: 10 + position,
        sectionKey: "items",
        documentType: DocumentType.Expense,
        itemName: `Fee ${position + 1}`,
        supplier: "Shopee Malaysia",
        date: `2026-08-${String(10 + position).padStart(2, "0")}`,
        amount: 10 + position,
        currency: "MYR",
        exchangeRate: 1,
        category: "Marketplace fees",
        categoryAccountId: category,
        accountId: book.bank,
      })
      .run();
  }
  return ids;
}

function sides() {
  return { fromAccountId: book.bank, toAccountId: category };
}

function jobRow(id: string) {
  return book.db
    .select()
    .from(schema.importQueue)
    .where(eq(schema.importQueue.id, id))
    .get();
}

function count(table: string): number {
  return (
    book.raw.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;
}

/** Row count and an order-independent digest of every row, per table. */
function snapshot(): Record<string, { count: number; digest: string }> {
  const names = (
    book.raw
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
  const out: Record<string, { count: number; digest: string }> = {};
  for (const name of names) {
    const rows = book.raw
      .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) =>
        JSON.stringify(row, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
        ),
      )
      .sort();
    out[name] = {
      count: rows.length,
      digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    };
  }
  return out;
}

/**
 * Every event DELIVERED on the buses a confirm uses, and whether a transaction
 * was open then. `DeferrableEmitter.emit` queues or drops an event and hands it
 * to `EventEmitter.prototype.emit` only when it is really sent, so that is
 * where this listens.
 */
function recordEvents() {
  const labels = new Map<EventEmitter, string>([
    [importEvents, "importEvents"],
    [ledgerEvents, "ledgerEvents"],
    [accountEvents, "accountEvents"],
    [auditEvents, "auditEvents"],
  ]);
  const seen: { name: string; inTransaction: boolean }[] = [];
  const proto = EventEmitter.prototype;
  const original = proto.emit;
  proto.emit = function (
    this: EventEmitter,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const label = labels.get(this);
    if (label) {
      seen.push({
        name: `${label}:${String(event)}`,
        inTransaction: book.raw.inTransaction,
      });
    }
    return original.call(this, event, ...args);
  };
  stopListening.push(() => {
    proto.emit = original;
  });
  return seen;
}

/** Lets a microtask queued during a unit (the audit feed) run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

class Sentinel extends Error {}

async function preparedReceipt(currency = "MYR") {
  queueReceipt(currency);
  return resultValue(
    await prepareImportConfirm(ctx, {
      jobId: receiptId,
      overrides: sides(),
      expectedVersion: importJobVersion(book.db, receiptId),
    }),
  );
}

describe("prepareImportConfirm and commitImportConfirm", () => {
  it("looks up a rate only in prepare, writes nothing there, and commits synchronously", async () => {
    queueReceipt("USD");
    const before = snapshot();

    const prepared = resultValue(
      await prepareImportConfirm(ctx, { jobId: receiptId, overrides: sides() }),
    );
    expect(rateLookups.count).toBe(1);
    expect(snapshot()).toEqual(before);
    // Plain data: it survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
    expect(prepared.kind === "receipt" && prepared.fields.exchangeRate).toBe(
      4.5,
    );

    const result = commitImportConfirm(ctx, prepared);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
    expect(result.ok).toBe(true);
    expect(rateLookups.count).toBe(1);
    expect(jobRow(receiptId)?.state).toBe(ImportState.Imported);
    expect(fileExists(receiptDest, root)).toBe(true);
    expect(fileExists(receiptTemp, root)).toBe(false);
  });

  it("needs only import.confirm, never records.create (006 FR-045)", async () => {
    const prepared = await preparedReceipt();
    const confirmOnly = {
      ...ctx,
      locals: localsFor(["import.confirm"], { userId: 1 }),
    };
    const result = commitImportConfirm(confirmOnly, prepared);
    expect(result.ok).toBe(true);
    expect(count("ledger_records")).toBe(1);
  });

  it("gives CONFLICT and writes nothing when the job changed after prepare", async () => {
    const prepared = await preparedReceipt();
    book.db
      .update(schema.importQueue)
      .set({ supplier: "Another supplier" })
      .where(eq(schema.importQueue.id, receiptId))
      .run();
    const before = snapshot();

    const result = commitImportConfirm(ctx, prepared);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("CONFLICT");
    expect(snapshot()).toEqual(before);
    expect(fileExists(receiptTemp, root)).toBe(true);
  });

  it("changes nothing, moves no file and sends no event in a dry run", async () => {
    const prepared = await preparedReceipt();
    const before = snapshot();
    const seen = recordEvents();

    expect(() =>
      runUnitOfWork("dry_run", () =>
        ctx.db.transaction(() => {
          const result = commitImportConfirm(ctx, prepared);
          expect(result.ok).toBe(true);
          expect(count("ledger_records")).toBe(1);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);
    await settle();

    expect(snapshot()).toEqual(before);
    expect(fileExists(receiptTemp, root)).toBe(true);
    expect(fileExists(receiptDest, root)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("puts the file back when the unit fails after the move", async () => {
    const prepared = await preparedReceipt();
    const before = snapshot();
    const seen = recordEvents();

    expect(() =>
      runUnitOfWork("write", () =>
        ctx.db.transaction(() => {
          expect(commitImportConfirm(ctx, prepared).ok).toBe(true);
          // The move happened for real inside the write.
          expect(fileExists(receiptDest, root)).toBe(true);
          expect(fileExists(receiptTemp, root)).toBe(false);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);
    await settle();

    expect(snapshot()).toEqual(before);
    expect(jobRow(receiptId)?.state).toBe(ImportState.PendingReview);
    expect(fileExists(receiptTemp, root)).toBe(true);
    expect(fileExists(receiptDest, root)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("puts the file back when its savepoint fails inside a unit that goes on", async () => {
    const prepared = await preparedReceipt();
    if (prepared.kind !== "receipt") throw new Error("expected a receipt");
    // The attachment insert comes after the file move.
    book.raw.run(
      `CREATE TRIGGER refuse_attachment BEFORE INSERT ON record_attachments
       BEGIN SELECT RAISE(ABORT, 'attachment refused'); END;`,
    );

    runUnitOfWork("write", () =>
      ctx.db.transaction(() => {
        expect(() =>
          confirmImportRow(ctx.db, prepared.job, prepared.fields, {
            actingUserId: 1,
            storageRoot: root,
          }),
        ).toThrow("attachment refused");
      }),
    );

    expect(jobRow(receiptId)?.state).toBe(ImportState.PendingReview);
    expect(count("ledger_records")).toBe(0);
    expect(fileExists(receiptTemp, root)).toBe(true);
    expect(fileExists(receiptDest, root)).toBe(false);
  });

  it("sends its events only once the unit has committed", async () => {
    queueReceipt();
    const seen = recordEvents();

    const result = await confirmImport(ctx, receiptId, { overrides: sides() });
    expect(result.ok).toBe(true);
    await settle();

    const names = seen.map((event) => event.name);
    expect(names).toContain("ledgerEvents:record-update");
    expect(names).toContain("importEvents:job-update");
    expect(seen.every((event) => !event.inTransaction)).toBe(true);
    expect(jobRow(receiptId)?.state).toBe(ImportState.Imported);
    expect(
      book.raw
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE record_type = 'record'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});

describe("grouped confirm", () => {
  it("confirms every item inside one unit, with one file move", async () => {
    const ids = queueGroup();
    const prepared = resultValue(
      await prepareImportConfirm(ctx, { jobId: groupId, all: true }),
    );
    const seen = recordEvents();

    const result = runUnitOfWork("write", () =>
      commitImportConfirm(ctx, prepared),
    );
    expect(result.ok).toBe(true);
    const results = (result.ok ? result.value.results : []) as {
      id: string;
      ok: boolean;
    }[];
    expect(results.map((r) => [r.id, r.ok])).toEqual(
      ids.map((id) => [id, true]),
    );
    expect(count("ledger_records")).toBe(3);
    expect(jobRow(groupId)?.state).toBe(ImportState.Imported);
    expect(jobRow(groupId)?.tempFilePath).toBe(groupDest);
    expect(fileExists(groupDest, root)).toBe(true);
    expect(fileExists(groupTemp, root)).toBe(false);
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => !event.inTransaction)).toBe(true);
  });

  it("commits item by item inside one transaction, and undoes all of it", async () => {
    queueGroup();
    const prepared = resultValue(
      await prepareImportConfirm(ctx, { jobId: groupId, all: true }),
    );
    if (prepared.kind !== "group") throw new Error("expected a group");
    const before = snapshot();
    const seen = recordEvents();

    expect(() =>
      runUnitOfWork("write", () =>
        ctx.db.transaction(() => {
          for (const entry of prepared.items) {
            const outcome = resultValue(commitImportConfirmItem(ctx, entry));
            expect(outcome.ok).toBe(true);
          }
          expect(count("ledger_records")).toBe(3);
          expect(fileExists(groupDest, root)).toBe(true);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);
    await settle();

    expect(snapshot()).toEqual(before);
    expect(fileExists(groupTemp, root)).toBe(true);
    expect(fileExists(groupDest, root)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("changes nothing in a dry run", async () => {
    queueGroup();
    const prepared = resultValue(
      await prepareImportConfirm(ctx, { jobId: groupId, all: true }),
    );
    const before = snapshot();

    expect(() =>
      runUnitOfWork("dry_run", () =>
        ctx.db.transaction(() => {
          expect(commitImportConfirm(ctx, prepared).ok).toBe(true);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);

    expect(snapshot()).toEqual(before);
    expect(fileExists(groupTemp, root)).toBe(true);
  });

  it("reports an item changed since prepare as a conflict and confirms the rest", async () => {
    const ids = queueGroup();
    const prepared = resultValue(
      await prepareImportConfirm(ctx, { jobId: groupId, all: true }),
    );
    if (prepared.kind !== "group") throw new Error("expected a group");
    book.db
      .update(schema.importItems)
      .set({ itemName: "Changed in another tab" })
      .where(eq(schema.importItems.id, ids[1]))
      .run();

    const conflicted = commitImportConfirmItem(ctx, prepared.items[1]);
    expect(!conflicted.ok && conflicted.code).toBe("CONFLICT");
    expect(
      resultValue(commitImportConfirmItem(ctx, prepared.items[0])).ok,
    ).toBe(true);
    expect(count("ledger_records")).toBe(1);
  });

  it("answers confirmImport for a group as before", async () => {
    const ids = queueGroup();
    const result = await confirmImport(
      ctx,
      groupId,
      { all: true },
      importJobVersion(book.db, groupId),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.results).toEqual(
      ids.map((id) => ({ id, ok: true, recordId: expect.any(Number) })),
    );
    expect(jobRow(groupId)?.state).toBe(ImportState.Imported);
    expect(fileExists(groupDest, root)).toBe(true);
  });
});

describe("skip and discard inside a unit of work", () => {
  it("skipping a receipt deletes its file only once the unit commits", () => {
    queueReceipt();
    const before = snapshot();

    expect(() =>
      runUnitOfWork("write", () =>
        ctx.db.transaction(() => {
          expect(skipImport(ctx, receiptId, {}).ok).toBe(true);
          expect(fileExists(receiptTemp, root)).toBe(true);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);
    expect(snapshot()).toEqual(before);
    expect(fileExists(receiptTemp, root)).toBe(true);

    const seen = recordEvents();
    runUnitOfWork("write", () =>
      ctx.db.transaction(() => {
        expect(skipImport(ctx, receiptId, {}).ok).toBe(true);
        expect(fileExists(receiptTemp, root)).toBe(true);
        expect(seen).toEqual([]);
      }),
    );
    expect(fileExists(receiptTemp, root)).toBe(false);
    expect(jobRow(receiptId)?.state).toBe(ImportState.Skipped);
    expect(seen.map((event) => event.name)).toContain(
      "importEvents:job-update",
    );
  });

  it("discarding a receipt keeps its file and row when the unit rolls back", () => {
    queueReceipt();
    const before = snapshot();
    const seen = recordEvents();

    expect(() =>
      runUnitOfWork("write", () =>
        ctx.db.transaction(() => {
          expect(discardImportJob(ctx, receiptId).ok).toBe(true);
          throw new Sentinel();
        }),
      ),
    ).toThrow(Sentinel);
    expect(snapshot()).toEqual(before);
    expect(fileExists(receiptTemp, root)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("discarding a receipt alone announces it after the row is gone", () => {
    queueReceipt();
    let rowWhenAnnounced: unknown = "not announced";
    const listener = () => {
      rowWhenAnnounced = jobRow(receiptId);
    };
    importEvents.on("job-deleted", listener);
    stopListening.push(() => importEvents.off("job-deleted", listener));

    expect(discardImportJob(ctx, receiptId).ok).toBe(true);
    expect(rowWhenAnnounced).toBeUndefined();
    expect(fileExists(receiptTemp, root)).toBe(false);
  });

  it("skipping and discarding a group keep the file when the unit rolls back", () => {
    queueGroup();
    const before = snapshot();

    for (const write of [
      () => skipImport(ctx, groupId, { all: true }),
      () => discardImportJob(ctx, groupId),
    ]) {
      expect(() =>
        runUnitOfWork("write", () =>
          ctx.db.transaction(() => {
            expect(write().ok).toBe(true);
            throw new Sentinel();
          }),
        ),
      ).toThrow(Sentinel);
      expect(snapshot()).toEqual(before);
      expect(fileExists(groupTemp, root)).toBe(true);
    }
  });
});
