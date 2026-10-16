import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Reviewing a group of items through its routes (006 S1): confirm one or many,
 * skip, edit, the group's Source account, discard, history, the one shared
 * file, and the search text of the records made from it.
 *
 * The routes import the singleton `db`, which opens DATABASE_PATH at import
 * time, so that module is mocked with a database file under `os.tmpdir()`,
 * migrated from `drizzle/`. The storage path is mocked to a folder there too,
 * so no file under `data/` is ever touched. Nothing in the ledger is mocked:
 * confirming an item makes a real record with real movements.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-import-items-spec-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
  // Which permissions the caller has; every one unless a test says otherwise.
  allow: (() => true) as (resource: string, action: string) => boolean,
  // What reading each attachment file gives, by stored path.
  textOf: new Map<string, string>(),
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

vi.mock("$lib/server/permissions.js", async () => {
  // The fake answers in the old grid's terms; each leaf is asked as the
  // (resource, action) it came from.
  const { legacyPairOf } = await import("$lib/server/permissions/legacy-map.js");
  const allow = (resource: string, action: string) =>
    holder.allow(resource, action);
  return {
    can: (_locals: unknown, permission: string) =>
      allow(...legacyPairOf(permission)),
    canAll: (_locals: unknown, permissions: string[]) =>
      permissions.every((permission) => allow(...legacyPairOf(permission))),
  };
});

vi.mock("$lib/server/logger.js", () => {
  const silent = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return { createLogger: () => silent };
});

// No exchange rate service is ever asked; a foreign item without a rate keeps
// asking for one.
vi.mock("$lib/server/currency/rates.js", () => ({
  getExchangeRate: vi.fn(async () => ({ rate: null, source: "api" })),
}));

const extractAttachmentsText = vi.fn(async (filenames: string[]) => {
  const parts = filenames
    .map((name) => holder.textOf.get(name))
    .filter((text): text is string => !!text);
  return parts.length ? parts.join("\n") : null;
});
vi.mock("$lib/server/extraction/attachment-text.js", () => ({
  extractAttachmentsText: (filenames: string[]) =>
    extractAttachmentsText(filenames),
}));

const {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
} = await import("$lib/enums.js");
const { ImportReadAs } = await import("$lib/import-reading.js");
const schema = await import("$lib/server/db/schema.js");
const {
  accountDefaults,
  auditLog,
  contacts,
  importItems,
  importQueue,
  ledgerRecords,
  recordAttachments,
  users,
} = schema;
const { createAccount } = await import("$lib/server/services/accounts.js");
const { setSetting, SETTING_KEYS } = await import("$lib/server/settings.js");
const { importEvents } = await import("$lib/server/import/events.js");
const { searchableAttachmentFilenames } =
  await import("$lib/server/queries/ledger.js");
const { confirmGroupItem } =
  await import("$lib/server/services/import-items.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;
type ItemInsert = typeof importItems.$inferInsert;

let dir: string;
let sqlite: Database;
let db: LedgerDb;
let ids: {
  payable: number;
  receivable: number;
  uncategorised: number;
  uncategorisedIncome: number;
  fees: number;
  sales: number;
  bank: number;
};

type Emitted = { event: string; inTransaction: boolean; payload: unknown };
let emitted: Emitted[];
const stopListening: (() => void)[] = [];

function account(name: string, type: number, subType?: number): number {
  const created = createAccount(db, 1, {
    name,
    type: type as never,
    ...(subType === undefined ? {} : { subType: subType as never }),
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(sandbox, "case-"));
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  holder.db = db;
  holder.storageRoot = join(dir, "storage");
  holder.allow = () => true;
  holder.textOf.clear();
  extractAttachmentsText.mockClear();
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");

  ids = {
    payable: account(
      "Accounts Payable",
      AccountType.Liability,
      AccountSubType.AccountsPayable,
    ),
    receivable: account(
      "Accounts Receivable",
      AccountType.Asset,
      AccountSubType.Receivable,
    ),
    uncategorised: account("Uncategorised Expense", AccountType.Expense),
    uncategorisedIncome: account("Uncategorised Income", AccountType.Revenue),
    fees: account("Marketplace Fees", AccountType.Expense),
    sales: account("Sales", AccountType.Revenue),
    bank: account("Maybank", AccountType.Asset, AccountSubType.Bank),
  };
  db.insert(accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Payable, accountId: ids.payable },
      { purpose: DefaultAccountPurpose.Receivable, accountId: ids.receivable },
      {
        purpose: DefaultAccountPurpose.UncategorisedExpense,
        accountId: ids.uncategorised,
      },
      {
        purpose: DefaultAccountPurpose.UncategorisedIncome,
        accountId: ids.uncategorisedIncome,
      },
    ])
    .run();

  emitted = [];
  for (const event of [
    "job-update",
    "job-deleted",
    "item-update",
    "item-deleted",
  ]) {
    const handler = (payload: unknown) =>
      emitted.push({ event, inTransaction: sqlite.inTransaction, payload });
    importEvents.on(event, handler);
    stopListening.push(() => importEvents.off(event, handler));
  }
});

afterEach(() => {
  for (const stop of stopListening.splice(0)) stop();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const jobId = "6a1f0c52-0000-4000-8000-000000000001";
const temp = `import/temp/${jobId}_fees.pdf`;
// The document is dated July; its lines carry August dates of their own. The
// shared file is filed under the document's month (see `confirmImportRow`).
const stored = `records/2026/07/${jobId}_fees.pdf`;

function putFile(rel: string) {
  const abs = join(holder.storageRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "%PDF-1.4 test");
}

function has(rel: string): boolean {
  return existsSync(join(holder.storageRoot, rel));
}

/** A group of `count` fee lines waiting for review, with its file in temp. */
function group(count = 3, over: Partial<ItemInsert>[] = []): string[] {
  db.insert(importQueue)
    .values({
      id: jobId,
      createdBy: 1,
      state: ImportState.Grouped,
      tempFilePath: temp,
      originalFilename: "fees.pdf",
      fileHash: "hash-fees",
      readAs: ImportReadAs.SeveralItems,
      profileId: "builtin:items@1",
      date: "2026-07-31",
      supplier: "Shopee Malaysia",
      currency: "MYR",
    })
    .run();
  putFile(temp);
  const itemIds: string[] = [];
  for (let position = 0; position < count; position++) {
    const id = `item-${position}`;
    itemIds.push(id);
    db.insert(importItems)
      .values({
        id,
        jobId,
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
        reference: "FN-2026-07",
        category: "Marketplace Fees",
        categoryAccountId: ids.fees,
        accountId: ids.payable,
        ...over[position],
      })
      .run();
  }
  return itemIds;
}

function jobRow() {
  return db.select().from(importQueue).where(eq(importQueue.id, jobId)).get();
}

function item(id: string) {
  return db.select().from(importItems).where(eq(importItems.id, id)).get();
}

function records() {
  return db.select().from(ledgerRecords).all();
}

function attachments() {
  return db.select().from(recordAttachments).all();
}

const locals = { user: { id: 1 } } as never;
type Handler = (event: never) => Promise<Response> | Response;

function jsonRequest(body: unknown, method = "POST") {
  return new Request("http://test.local/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routes = {
  async list() {
    const { GET } = await import("./[jobId]/items/+server.js");
    return (GET as Handler)({ locals, params: { jobId } } as never);
  },
  async patch(itemId: string, body: unknown) {
    const { PATCH } = await import("./[jobId]/items/[itemId]/+server.js");
    return (PATCH as Handler)({
      locals,
      params: { jobId, itemId },
      request: jsonRequest(body, "PATCH"),
    } as never);
  },
  async confirmReceipt(body?: unknown) {
    const { POST } = await import("./[jobId]/confirm/+server.js");
    return (POST as Handler)({
      locals,
      params: { jobId },
      request:
        body === undefined
          ? new Request("http://test.local/", { method: "POST" })
          : jsonRequest(body),
    } as never);
  },
  async confirm(itemId: string) {
    const { POST } =
      await import("./[jobId]/items/[itemId]/confirm/+server.js");
    return (POST as Handler)({ locals, params: { jobId, itemId } } as never);
  },
  async skip(itemId: string) {
    const { POST } = await import("./[jobId]/items/[itemId]/skip/+server.js");
    return (POST as Handler)({ locals, params: { jobId, itemId } } as never);
  },
  async bulk(body: unknown) {
    const { POST } = await import("./[jobId]/items/bulk/+server.js");
    return (POST as Handler)({
      locals,
      params: { jobId },
      request: jsonRequest(body),
    } as never);
  },
  async setGroupAccount(groupAccountId: number | null) {
    const { PATCH } = await import("./[jobId]/+server.js");
    return (PATCH as Handler)({
      locals,
      params: { jobId },
      request: jsonRequest({ groupAccountId }, "PATCH"),
    } as never);
  },
  async discard() {
    const { DELETE } = await import("./[jobId]/+server.js");
    return (DELETE as Handler)({ locals, params: { jobId } } as never);
  },
  async skipJob() {
    const { POST } = await import("./[jobId]/skip/+server.js");
    return (POST as Handler)({ locals, params: { jobId } } as never);
  },
  async clearHistory() {
    const { DELETE } = await import("./history/+server.js");
    return (DELETE as Handler)({ locals } as never);
  },
  async listJobs() {
    const { GET } = await import("./+server.js");
    return (GET as Handler)({
      locals,
      url: new URL("http://test.local/api/import"),
    } as never);
  },
  async deleteAttachment(recordId: number, attachmentId: number) {
    const { DELETE } =
      await import("../records/[id]/attachments/[attachmentId]/+server.js");
    return (DELETE as Handler)({
      locals,
      params: { id: String(recordId), attachmentId: String(attachmentId) },
    } as never);
  },
  async addAttachment(recordId: number) {
    const { POST } = await import("../records/[id]/attachments/+server.js");
    const form = new FormData();
    form.append(
      "file",
      new File([new TextEncoder().encode("%PDF-1.4 own")], "own.pdf", {
        type: "application/pdf",
      }),
    );
    return (POST as Handler)({
      locals,
      params: { id: String(recordId) },
      request: { formData: async () => form },
    } as never);
  },
};

// Load every route once, before any test's clock starts: the first load of the
// import and ledger code can take longer than one test is given on a busy run.
beforeAll(async () => {
  await Promise.all([
    import("./[jobId]/items/+server.js"),
    import("./[jobId]/items/[itemId]/+server.js"),
    import("./[jobId]/items/[itemId]/confirm/+server.js"),
    import("./[jobId]/confirm/+server.js"),
    import("./[jobId]/items/[itemId]/skip/+server.js"),
    import("./[jobId]/items/bulk/+server.js"),
    import("./[jobId]/+server.js"),
    import("./[jobId]/skip/+server.js"),
    import("./history/+server.js"),
    import("./+server.js"),
    import("../records/[id]/attachments/[attachmentId]/+server.js"),
    import("../records/[id]/attachments/+server.js"),
    import("$lib/server/search-rebuild/worker.js"),
  ]);
}, 60_000);

type Outcome = { id: string; ok: boolean; reason?: string; recordId?: number };

async function bulkResults(body: unknown): Promise<Outcome[]> {
  const res = await routes.bulk(body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Outcome[] }).results;
}

// ── Confirming ──────────────────────────────────────────────────────────────

describe("confirming every item", () => {
  it("makes one record per item, all sharing one stored file (SC-006)", async () => {
    const itemIds = group(3);

    const results = await bulkResults({ action: "confirm", all: true });
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);

    const made = records();
    expect(made).toHaveLength(3);
    expect(made.map((r) => r.description).sort()).toEqual([
      "Fee 1",
      "Fee 2",
      "Fee 3",
    ]);
    // A group's records carry no document text (FR-029).
    expect(made.every((r) => r.extractedText === null)).toBe(true);

    // One stored file, in the document's month, and every record shows it.
    const files = attachments();
    expect(files).toHaveLength(3);
    expect(new Set(files.map((a) => a.filename))).toEqual(new Set([stored]));
    expect(files.every((a) => a.displayName === "fees.pdf")).toBe(true);
    expect(has(stored)).toBe(true);
    expect(has(temp)).toBe(false);

    // Each item links to its record; the group is finished and in history.
    for (const [index, id] of itemIds.entries()) {
      const row = item(id)!;
      expect(row.state).toBe(ImportState.Imported);
      expect(row.resultId).toBe(results[index].recordId);
      expect(row.resultType).toBe(DocumentType.Expense);
    }
    const job = jobRow()!;
    expect(job.state).toBe(ImportState.Imported);
    expect(job.tempFilePath).toBe(stored);
    expect(job.completedAt).not.toBeNull();

    // Each record's creation is audited, as for a receipt (FR-046).
    const created = db
      .select()
      .from(auditLog)
      .all()
      .filter((row) => row.action === "create" && row.recordType === "record");
    expect(created.map((row) => row.recordId).sort()).toEqual(
      made.map((r) => String(r.id)).sort(),
    );
  });

  it("counts how many of the records made are income, for the history row", async () => {
    group(3, [
      {
        documentType: DocumentType.Income,
        itemName: "Sale",
        category: "Sales",
        categoryAccountId: ids.sales,
        accountId: ids.receivable,
      },
    ]);
    await bulkResults({ action: "confirm", all: true });

    const jobs = await (await routes.listJobs()).json();
    expect(jobs[0].itemCounts).toMatchObject({
      confirmed: 3,
      confirmedIncome: 1,
      skipped: 0,
    });
  });

  it("announces each item and the group's counts only after commit", async () => {
    const [first] = group(2);

    expect((await routes.confirm(first)).status).toBe(201);

    expect(emitted.every((e) => !e.inTransaction)).toBe(true);
    expect(emitted.map((e) => e.event)).toEqual(["item-update", "job-update"]);
    const sentItem = (emitted[0].payload as { item: Record<string, unknown> })
      .item;
    expect(sentItem.id).toBe(first);
    expect(sentItem.state).toBe(ImportState.Imported);
    const sentJob = (emitted[1].payload as { job: Record<string, unknown> })
      .job;
    expect(sentJob.state).toBe(ImportState.Grouped);
    expect(sentJob.itemCounts).toEqual({
      ready: 1,
      needsAttention: 0,
      confirmed: 1,
      confirmedIncome: 0,
      confirmedTransfer: 0,
      skipped: 0,
    });
    expect(sentJob).not.toHaveProperty("extractedText");
  });

  it("leaves nothing behind when the books refuse an item, and keeps it ready (FR-044)", async () => {
    const [refusedId, other] = group(2, [{ amount: 0 }]);
    // A name typed by hand would become a new contact on confirm.
    expect(
      (await routes.patch(refusedId, { newContactName: "Brand New Co" }))
        .status,
    ).toBe(200);
    const contactsBefore = db.select().from(contacts).all().length;

    const res = await routes.confirm(refusedId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Enter an amount greater than nothing.",
    );

    expect(records()).toHaveLength(0);
    expect(attachments()).toHaveLength(0);
    expect(db.select().from(contacts).all()).toHaveLength(contactsBefore);
    expect(item(refusedId)!.state).toBe(ImportState.PendingReview);
    expect(item(refusedId)!.resultId).toBeNull();
    // The file never moved, and the group still points at it.
    expect(has(temp)).toBe(true);
    expect(jobRow()!.tempFilePath).toBe(temp);
    expect(item(other)!.state).toBe(ImportState.PendingReview);
  });

  it("makes one record when the same item is confirmed twice at once", async () => {
    const [first] = group(2);

    const [a, b] = await Promise.all([
      routes.confirm(first),
      routes.confirm(first),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(records()).toHaveLength(1);
    expect(attachments()).toHaveLength(1);
    expect(item(first)!.state).toBe(ImportState.Imported);
  });

  it("refuses an item that is no longer waiting, without a second record", async () => {
    const [first] = group(2);
    expect(
      (await confirmGroupItem(db, jobId, first, { actingUserId: 1 })).ok,
    ).toBe(true);

    const again = await confirmGroupItem(db, jobId, first, { actingUserId: 1 });
    expect(again).toMatchObject({ ok: false });
    expect(records()).toHaveLength(1);
  });

  it("confirm-all leaves behind each item that needs attention, with its reason (FR-019)", async () => {
    const itemIds = group(5, [
      {},
      { duplicateOf: 99, duplicateConfidence: 80 },
      { currency: "USD", exchangeRate: null },
      { accountId: null },
      {},
    ]);

    const results = await bulkResults({ action: "confirm", all: true });

    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(itemIds[0])!.ok).toBe(true);
    expect(byId.get(itemIds[4])!.ok).toBe(true);
    expect(byId.get(itemIds[1])).toMatchObject({ ok: false });
    expect(byId.get(itemIds[1])!.reason).toMatch(/already be in the books/);
    expect(byId.get(itemIds[2])!.reason).toBe(
      "It needs an exchange rate for USD.",
    );
    expect(byId.get(itemIds[3])!.reason).toBe("Say which account paid for it.");

    expect(records()).toHaveLength(2);
    for (const id of itemIds.slice(1, 4)) {
      expect(item(id)!.state).toBe(ImportState.PendingReview);
    }
    // The group waits on the three, with the file it needs for them.
    expect(jobRow()!.state).toBe(ImportState.Grouped);
    expect(has(stored)).toBe(true);

    // The duplicate goes through when the reviewer confirms it on its own.
    expect((await routes.confirm(itemIds[1])).status).toBe(201);
    expect(records()).toHaveLength(3);
  });

  it("run again after an interruption, creates no record twice (SC-011)", async () => {
    const itemIds = group(4);
    // The first run got as far as two items before the page closed.
    expect((await routes.confirm(itemIds[0])).status).toBe(201);
    expect((await routes.confirm(itemIds[1])).status).toBe(201);

    const second = await bulkResults({ action: "confirm", itemIds });
    expect(second.every((r) => r.ok)).toBe(true);
    expect(records()).toHaveLength(4);
    // The two done before are reported with the records they already made.
    expect(second[0].recordId).toBe(item(itemIds[0])!.resultId);
    expect(second[1].recordId).toBe(item(itemIds[1])!.resultId);

    const third = await bulkResults({ action: "confirm", itemIds });
    expect(third.every((r) => r.ok)).toBe(true);
    expect(records()).toHaveLength(4);
    expect(attachments()).toHaveLength(4);
    expect(new Set(attachments().map((a) => a.filename)).size).toBe(1);
  });

  it("confirms only the selected items", async () => {
    const itemIds = group(3);

    const results = await bulkResults({
      action: "confirm",
      itemIds: [itemIds[1]],
    });

    expect(results).toEqual([
      { id: itemIds[1], ok: true, recordId: item(itemIds[1])!.resultId },
    ]);
    expect(item(itemIds[0])!.state).toBe(ImportState.PendingReview);
    expect(item(itemIds[2])!.state).toBe(ImportState.PendingReview);
  });
});

// ── The shared file ─────────────────────────────────────────────────────────

describe("the one stored file", () => {
  it("stays while any record shows it, and goes with the last (US5)", async () => {
    group(3);
    await bulkResults({ action: "confirm", all: true });
    const files = attachments();

    expect(
      (await routes.deleteAttachment(files[0].recordId, files[0].id)).status,
    ).toBe(204);
    expect(has(stored)).toBe(true);
    expect(
      (await routes.deleteAttachment(files[1].recordId, files[1].id)).status,
    ).toBe(204);
    expect(has(stored)).toBe(true);
    expect(
      (await routes.deleteAttachment(files[2].recordId, files[2].id)).status,
    ).toBe(204);
    expect(has(stored)).toBe(false);
  });

  it("keeps every record on one path when the first move fails", async () => {
    const itemIds = group(2);
    // The file is missing when the first item is confirmed, so it cannot be
    // moved and the record is attached to the temp path, as for a receipt.
    rmSync(join(holder.storageRoot, temp));
    expect((await routes.confirm(itemIds[0])).status).toBe(201);
    putFile(temp);

    expect((await routes.confirm(itemIds[1])).status).toBe(201);

    expect(new Set(attachments().map((a) => a.filename))).toEqual(
      new Set([temp]),
    );
    expect(has(temp)).toBe(true);
    expect(has(stored)).toBe(false);
  });

  it("skipping one item keeps the file and the other items (US4 scenario 9)", async () => {
    const itemIds = group(3);

    expect((await routes.skip(itemIds[0])).status).toBe(204);

    expect(item(itemIds[0])!.state).toBe(ImportState.Skipped);
    expect(item(itemIds[1])!.state).toBe(ImportState.PendingReview);
    expect(jobRow()!.state).toBe(ImportState.Grouped);
    expect(has(temp)).toBe(true);
  });

  it("skip all skips every waiting item and removes a file no record uses (US4 scenario 8)", async () => {
    const itemIds = group(3);

    expect((await routes.skipJob()).status).toBe(204);

    for (const id of itemIds) expect(item(id)!.state).toBe(ImportState.Skipped);
    expect(records()).toHaveLength(0);
    expect(jobRow()!.state).toBe(ImportState.Skipped);
    expect(has(temp)).toBe(false);
  });

  it("skipping the rest after a confirm keeps the file the record uses", async () => {
    const itemIds = group(3);
    expect((await routes.confirm(itemIds[0])).status).toBe(201);

    await bulkResults({ action: "skip", all: true });

    expect(jobRow()!.state).toBe(ImportState.Imported);
    expect(has(stored)).toBe(true);
  });

  it("discarding keeps the records already made, and their file (US4 scenario 14)", async () => {
    const itemIds = group(3);
    expect((await routes.confirm(itemIds[0])).status).toBe(201);
    expect((await routes.confirm(itemIds[1])).status).toBe(201);
    emitted.length = 0;

    expect((await routes.discard()).status).toBe(204);

    expect(records()).toHaveLength(2);
    expect(item(itemIds[2])).toBeUndefined();
    expect(item(itemIds[0])!.state).toBe(ImportState.Imported);
    expect(jobRow()!.state).toBe(ImportState.Imported);
    expect(has(stored)).toBe(true);
    expect(emitted.map((e) => e.event)).toEqual(["item-deleted", "job-update"]);

    // Clearing the history then removes the group, never the file (FR-028).
    expect((await routes.clearHistory()).status).toBe(204);
    expect(jobRow()).toBeUndefined();
    expect(db.select().from(importItems).all()).toHaveLength(0);
    expect(records()).toHaveLength(2);
    expect(has(stored)).toBe(true);
  });

  it("discarding a group that made no record removes it and its file", async () => {
    group(3);

    expect((await routes.discard()).status).toBe(204);

    expect(jobRow()).toBeUndefined();
    expect(db.select().from(importItems).all()).toHaveLength(0);
    expect(has(temp)).toBe(false);
    expect(emitted.map((e) => e.event)).toEqual(["job-deleted"]);
  });

  it("history clear leaves a group that still has an item waiting", async () => {
    const itemIds = group(2);
    expect((await routes.confirm(itemIds[0])).status).toBe(201);

    expect((await routes.clearHistory()).status).toBe(204);

    expect(jobRow()!.state).toBe(ImportState.Grouped);
    expect(item(itemIds[1])!.state).toBe(ImportState.PendingReview);
    expect(has(stored)).toBe(true);
  });
});

// ── Editing and filling ─────────────────────────────────────────────────────

describe("editing items", () => {
  it("keeps an item's corrections on the server, and confirms with them", async () => {
    const [first] = group(2);

    const res = await routes.patch(first, {
      item_name: "Commission",
      amount: 12.34,
      date: "2026-08-02",
      reference: "C-1",
      remark: "checked",
      fromAccountId: ids.bank,
      toAccountId: ids.uncategorised,
    });
    expect(res.status).toBe(200);
    const sent = await res.json();
    expect(sent).toMatchObject({
      itemName: "Commission",
      amount: 12.34,
      accountId: ids.bank,
      categoryAccountId: ids.uncategorised,
      category: "Uncategorised Expense",
      attention: null,
    });

    expect((await routes.confirm(first)).status).toBe(201);
    const [record] = records();
    expect(record).toMatchObject({
      description: "Commission",
      date: "2026-08-02",
      reference: "C-1",
      remark: "checked",
    });
  });

  it("confirms with the remark the reviewer edited, and the read one when left alone (FR-034, FR-035)", async () => {
    const read = "Line type: commission_fee; order_no: 2408";
    const [edited, untouched] = group(2, [
      {
        feeType: "commission_fee",
        extrasJson: '{"order_no":"2408"}',
        remark: read,
      },
      {
        feeType: "commission_fee",
        extrasJson: '{"order_no":"2409"}',
        remark: read,
      },
    ]);

    // The remark alone: nothing else about the item changes.
    const res = await routes.patch(edited, { remark: `${read}; checked` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      remark: `${read}; checked`,
      extrasJson: '{"order_no":"2408"}',
      categoryAccountId: ids.fees,
      accountId: ids.payable,
    });

    expect((await routes.confirm(edited)).status).toBe(201);
    expect((await routes.confirm(untouched)).status).toBe(201);
    const remarks = new Map(
      records().map((record) => [record.description, record.remark]),
    );
    expect(remarks.get("Fee 1")).toBe(`${read}; checked`);
    expect(remarks.get("Fee 2")).toBe(read);
  });

  it("confirms with an emptied remark as empty, not the one read", async () => {
    const [first] = group(1, [{ remark: "Line type: ads_fee" }]);
    expect((await routes.patch(first, { remark: "" })).status).toBe(200);
    expect((await routes.confirm(first)).status).toBe(201);
    expect(records()[0].remark).toBe("");
  });

  it("asks for a rate again when the currency changes", async () => {
    const [first] = group(1);

    const sent = await (await routes.patch(first, { currency: "usd" })).json();

    expect(sent.currency).toBe("USD");
    expect(sent.exchangeRate).toBeNull();
    expect(sent.attention).toBe("It needs an exchange rate for USD.");

    const rated = await (
      await routes.patch(first, { exchangeRate: "4.2" })
    ).json();
    expect(rated.exchangeRate).toBe(4.2);
    expect(rated.attention).toBeNull();
  });

  it("refuses an edit to an item that is no longer waiting", async () => {
    const [first] = group(2);
    expect((await routes.skip(first)).status).toBe(204);

    expect((await routes.patch(first, { amount: 5 })).status).toBe(409);
  });

  it("an item that changes kind drops the category, account and contact found for the old kind (FR-007)", async () => {
    const [supplier] = db
      .insert(contacts)
      .values({ legalName: "Shopee Seller Centre", entityType: 1 })
      .returning({ id: contacts.id })
      .all();
    const [first] = group(1, [{ matchedContactId: supplier.id }]);

    const sent = await (
      await routes.patch(first, { document_type: "income" })
    ).json();

    // Accounts Payable cannot receive an income, so the item asks again
    // rather than failing later at confirm.
    expect(sent.attention).toBe("Say which account received it.");
    expect(item(first)).toMatchObject({
      documentType: DocumentType.Income,
      accountId: null,
      categoryAccountId: null,
      matchedContactId: null,
    });

    expect((await routes.patch(first, { accountId: ids.bank })).status).toBe(
      200,
    );
    expect((await routes.confirm(first)).status).toBe(201);
    const [record] = records();
    // The fee category is not an income one, and the name matches no income
    // category, so it lands on Uncategorised Income, as a receipt would.
    expect(
      db
        .select()
        .from(schema.ledgerMovements)
        .where(eq(schema.ledgerMovements.recordId, record.id))
        .all()
        .map((m) => m.accountId)
        .sort(),
    ).toEqual([ids.uncategorisedIncome, ids.bank].sort());
    expect(record.contactId).not.toBe(supplier.id);
  });

  it("files an item under Uncategorised when its stored category was archived since", async () => {
    const [first] = group(1);
    db.update(schema.accounts)
      .set({ archivedAt: "2026-08-01T00:00:00.000Z" })
      .where(eq(schema.accounts.id, ids.fees))
      .run();

    expect((await routes.confirm(first)).status).toBe(201);
    const [record] = records();
    expect(
      db
        .select()
        .from(schema.ledgerMovements)
        .where(eq(schema.ledgerMovements.recordId, record.id))
        .all()
        .map((m) => m.accountId)
        .sort(),
    ).toEqual([ids.payable, ids.uncategorised].sort());
  });

  it("refuses an account that is gone or cannot pay for the item", async () => {
    const [first] = group(1);

    expect((await routes.patch(first, { accountId: 99_999 })).status).toBe(409);
    expect(
      (await routes.patch(first, { accountId: ids.receivable })).status,
    ).toBe(409);
    expect(item(first)!.accountId).toBe(ids.payable);
  });

  it("the group's Source account fills every waiting item; one item can still differ (US4 scenario 4)", async () => {
    const itemIds = group(3);
    expect((await routes.confirm(itemIds[0])).status).toBe(201);
    const confirmedAccount = item(itemIds[0])!.accountId;

    expect((await routes.setGroupAccount(ids.bank)).status).toBe(200);

    expect(jobRow()!.groupAccountId).toBe(ids.bank);
    expect(item(itemIds[1])!.accountId).toBe(ids.bank);
    expect(item(itemIds[2])!.accountId).toBe(ids.bank);
    // A confirmed item keeps the account its record was made with.
    expect(item(itemIds[0])!.accountId).toBe(confirmedAccount);

    expect(
      (await routes.patch(itemIds[2], { accountId: ids.payable })).status,
    ).toBe(200);
    expect(item(itemIds[1])!.accountId).toBe(ids.bank);
    expect(item(itemIds[2])!.accountId).toBe(ids.payable);
  });

  it("refuses a Source account no item can use", async () => {
    group(2);

    const res = await routes.setGroupAccount(ids.sales);

    expect(res.status).toBe(409);
    expect(jobRow()!.groupAccountId).toBeNull();
  });

  it("sets a category or an account on the selected items only (US4 scenario 5)", async () => {
    const itemIds = group(3);

    const results = await bulkResults({
      action: "setCategory",
      itemIds: [itemIds[0], itemIds[2]],
      categoryAccountId: ids.uncategorised,
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(item(itemIds[0])!.categoryAccountId).toBe(ids.uncategorised);
    expect(item(itemIds[1])!.categoryAccountId).toBe(ids.fees);
    expect(item(itemIds[2])!.category).toBe("Uncategorised Expense");

    const wrong = await bulkResults({
      action: "setCategory",
      itemIds: [itemIds[1]],
      categoryAccountId: ids.sales,
    });
    expect(wrong[0]).toMatchObject({ ok: false });
    expect(item(itemIds[1])!.categoryAccountId).toBe(ids.fees);

    await bulkResults({
      action: "setAccount",
      itemIds: [itemIds[1]],
      accountId: ids.bank,
    });
    expect(item(itemIds[1])!.accountId).toBe(ids.bank);
    expect(item(itemIds[0])!.accountId).toBe(ids.payable);
  });

  it("holds an item back while the reading's note about its category stands, until a category is chosen (FR-034)", async () => {
    const note =
      "The category “Sales” tied to the line type “ads_fee” is an income category, but this line is printed negative, so it is an expense. It is filed under “Uncategorised Expense” instead: choose its category.";
    const itemIds = group(4, [
      { reviewNote: note, categoryAccountId: ids.uncategorised },
      { reviewNote: note, categoryAccountId: ids.uncategorised },
      { reviewNote: note, categoryAccountId: ids.uncategorised },
      {},
    ]);

    const listed = await (await routes.list()).json();
    expect(listed[0]).toMatchObject({ reviewNote: note, attention: note });
    expect(listed[3].attention).toBeNull();

    // A new paying account alone sends both sides again, with the same
    // category: the note stands.
    const paid = await routes.patch(itemIds[0], {
      fromAccountId: ids.bank,
      toAccountId: ids.uncategorised,
    });
    expect(await paid.json()).toMatchObject({
      accountId: ids.bank,
      reviewNote: note,
      attention: note,
    });

    // Choosing a category answers it: on the card, or on a selection.
    const chosen = await routes.patch(itemIds[1], {
      fromAccountId: ids.payable,
      toAccountId: ids.fees,
    });
    expect(await chosen.json()).toMatchObject({
      categoryAccountId: ids.fees,
      reviewNote: null,
      attention: null,
    });
    await bulkResults({
      action: "setCategory",
      itemIds: [itemIds[2]],
      categoryAccountId: ids.uncategorised,
    });
    expect(item(itemIds[2])!.reviewNote).toBeNull();

    const results = await bulkResults({ action: "confirm", all: true });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(itemIds[0])).toMatchObject({ ok: false, reason: note });
    expect(byId.get(itemIds[1])!.ok).toBe(true);
    expect(byId.get(itemIds[2])!.ok).toBe(true);
    expect(byId.get(itemIds[3])!.ok).toBe(true);
    expect(item(itemIds[0])!.state).toBe(ImportState.PendingReview);

    // The reviewer may still confirm it on its own, as it is.
    expect((await routes.confirm(itemIds[0])).status).toBe(201);
  });

  it("lists every item with its attention, and the queue shows the counts", async () => {
    group(3, [{}, { duplicateOf: 7 }, {}]);
    expect((await routes.skip("item-2")).status).toBe(204);

    const listed = await (await routes.list()).json();
    expect(listed.map((i: { id: string }) => i.id)).toEqual([
      "item-0",
      "item-1",
      "item-2",
    ]);
    expect(listed[0].attention).toBeNull();
    expect(listed[1].attention).toMatch(/already be in the books/);

    const jobs = await (await routes.listJobs()).json();
    expect(jobs[0].itemCounts).toEqual({
      ready: 1,
      needsAttention: 1,
      confirmed: 0,
      confirmedIncome: 0,
      confirmedTransfer: 0,
      skipped: 1,
    });
    expect(jobs[0]).not.toHaveProperty("extractedText");
  });

  it("rejects a bulk request that names no items", async () => {
    group(1);
    expect((await routes.bulk({ action: "confirm" })).status).toBe(400);
    expect(
      (await routes.bulk({ action: "setCategory", all: true })).status,
    ).toBe(400);
  });
});

// ── Permissions (FR-045) ────────────────────────────────────────────────────

describe("permissions", () => {
  it("needs import.change for every write and import.view to list", async () => {
    const [first] = group(2);
    // Someone who may look at imports but not change them.
    holder.allow = (resource, action) =>
      resource === "import" && action === "view";

    expect((await routes.list()).status).toBe(200);
    expect((await routes.confirm(first)).status).toBe(403);
    expect((await routes.skip(first)).status).toBe(403);
    expect((await routes.patch(first, { amount: 1 })).status).toBe(403);
    expect((await routes.bulk({ action: "confirm", all: true })).status).toBe(
      403,
    );
    expect((await routes.setGroupAccount(ids.bank)).status).toBe(403);
    expect((await routes.discard()).status).toBe(403);
    expect((await routes.skipJob()).status).toBe(403);

    holder.allow = () => false;
    expect((await routes.list()).status).toBe(403);

    expect(records()).toHaveLength(0);
    expect(item(first)!.state).toBe(ImportState.PendingReview);
    expect(item(first)!.amount).toBe(10);
  });

  it("confirms with import.change alone, without records.add (design, FR-045)", async () => {
    const [first] = group(1);
    holder.allow = (resource, action) =>
      resource === "import" && action === "change";

    expect((await routes.confirm(first)).status).toBe(201);
  });
});

// ── A document with one item (FR-009) ───────────────────────────────────────

describe("the remark of a document reviewed as a receipt", () => {
  /** A receipt card on the queue row, with `remark` stored as reading left it. */
  function receipt(remark: string | null) {
    db.insert(importQueue)
      .values({
        id: jobId,
        createdBy: 1,
        state: ImportState.PendingReview,
        tempFilePath: temp,
        originalFilename: "fees.pdf",
        documentType: DocumentType.Expense,
        itemName: "Commission fee",
        supplier: "Shopee Malaysia",
        date: "2026-07-31",
        amount: 12.5,
        currency: "MYR",
        exchangeRate: 1,
        category: "Marketplace Fees",
        categoryAccountId: ids.fees,
        accountId: ids.payable,
        remark,
      })
      .run();
    putFile(temp);
  }

  it("keeps the remark the one item was read with when the reviewer sends none", async () => {
    receipt("Commission Fee");
    expect((await routes.confirmReceipt({})).status).toBe(201);
    expect(records()[0].remark).toBe("Commission Fee");
  });

  it("takes the reviewer's remark, even an empty one, over the stored one", async () => {
    receipt("Commission Fee");
    expect((await routes.confirmReceipt({ remark: "" })).status).toBe(201);
    expect(records()[0].remark).toBe("");
  });

  it("leaves a receipt with no stored remark as before", async () => {
    receipt(null);
    expect((await routes.confirmReceipt()).status).toBe(201);
    expect(records()[0].remark).toBe("");
  });
});

// ── Search text (FR-029) ────────────────────────────────────────────────────

describe("the search text of records sharing one file", () => {
  it("never indexes a file another record shares", async () => {
    group(2);
    await bulkResults({ action: "confirm", all: true });
    const [a, b] = records();
    holder.textOf.set(stored, "Fee 1 10.00 Fee 2 11.00 Shopee fee notice");

    expect(searchableAttachmentFilenames(db, a.id)).toEqual([]);

    // Adding a file of its own re-reads the record's attachments, and only
    // that one is indexed.
    const res = await routes.addAttachment(a.id);
    expect(res.status).toBe(201);
    const own = attachments().find(
      (row) => row.recordId === a.id && row.filename !== stored,
    )!;
    holder.textOf.set(own.filename, "own receipt text");
    expect(extractAttachmentsText).toHaveBeenLastCalledWith([own.filename]);
    expect(searchableAttachmentFilenames(db, a.id)).toEqual([own.filename]);

    // The rebuild applies the same rule to every record.
    const { startRebuild, getRebuildStatus } =
      await import("$lib/server/search-rebuild/worker.js");
    extractAttachmentsText.mockClear();
    startRebuild();
    for (let i = 0; i < 100 && getRebuildStatus().running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getRebuildStatus().running).toBe(false);
    const asked = extractAttachmentsText.mock.calls.map((call) => call[0]);
    expect(asked.flat()).not.toContain(stored);
    expect(asked).toContainEqual([own.filename]);

    const after = db.select().from(ledgerRecords).all();
    expect(after.find((r) => r.id === b.id)!.extractedText).toBeNull();
    expect(after.find((r) => r.id === a.id)!.extractedText).toBe(
      "own receipt text",
    );
  });

  it("never indexes the document on the last record that still has it", async () => {
    group(2);
    await bulkResults({ action: "confirm", all: true });
    const [a, b] = records();
    holder.textOf.set(stored, "Fee 1 10.00 Fee 2 11.00 Shopee fee notice");

    // Every attachment made from an item says it is the whole document.
    expect(attachments().map((row) => row.groupDocument)).toEqual([true, true]);

    // Record b lets the file go, so only record a has it now, and the
    // import's own rows are cleared from history.
    const onB = attachments().find((row) => row.recordId === b.id)!;
    expect((await routes.deleteAttachment(b.id, onB.id)).status).toBe(204);
    expect((await routes.clearHistory()).status).toBe(204);
    expect(jobRow()).toBeUndefined();
    expect(attachments().map((row) => row.recordId)).toEqual([a.id]);
    expect(searchableAttachmentFilenames(db, a.id)).toEqual([]);

    // A new attachment indexes only itself.
    expect((await routes.addAttachment(a.id)).status).toBe(201);
    const own = attachments().find((row) => row.filename !== stored)!;
    expect(own.groupDocument).toBe(false);
    expect(extractAttachmentsText).toHaveBeenLastCalledWith([own.filename]);

    // And so does a rebuild.
    const { startRebuild, getRebuildStatus } =
      await import("$lib/server/search-rebuild/worker.js");
    extractAttachmentsText.mockClear();
    startRebuild();
    for (let i = 0; i < 100 && getRebuildStatus().running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(getRebuildStatus().running).toBe(false);
    const asked = extractAttachmentsText.mock.calls.map((call) => call[0]);
    expect(asked.flat()).not.toContain(stored);
    expect(asked).toContainEqual([own.filename]);
  });

  it("indexes a file only one record has", () => {
    group(1);
    const record = db
      .insert(ledgerRecords)
      .values({ kind: 1, date: "2026-08-01", amount: 10 })
      .returning({ id: ledgerRecords.id })
      .get().id;
    db.insert(recordAttachments)
      .values({ recordId: record, filename: "records/a.pdf", displayName: "a" })
      .run();

    expect(searchableAttachmentFilenames(db, record)).toEqual([
      "records/a.pdf",
    ]);
  });
});
