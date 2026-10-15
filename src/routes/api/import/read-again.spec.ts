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
import {
  mockModel,
  type Reply,
} from "$lib/server/llm/__fixtures__/mock-model.js";

/**
 * "Read again" through its route (006 FR-023, US9 AS6-7): a document is read
 * once more from its own file, the way the user now names, and what the last
 * reading proposed is replaced. Then the worker's own `processImportJob` reads
 * it, so each test follows the document to its new reading.
 *
 * The routes import the singleton `db`, so that module is mocked with a
 * database file under `os.tmpdir()`, migrated from `drizzle/`, and the storage
 * path with a folder there too: nothing under `data/` is touched. No AI
 * provider is called: the one provider gets a mock model that plays back fixed
 * answers. Reading a file's text is mocked as well, so a test can count how
 * often OCR would run.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-read-again-spec-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
  allow: (() => true) as (resource: string, action: string) => boolean,
  models: new Map<string, unknown>(),
  // What reading a file gives, and how often it was asked.
  ocrText: "",
  ocrCalls: 0,
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

vi.mock("$lib/server/llm/model-factory.js", () => ({
  createModel: vi.fn((config: { name: string }) => {
    const model = holder.models.get(config.name);
    if (!model) throw new Error(`No mock model for ${config.name}`);
    return model;
  }),
}));

vi.mock("$lib/server/llm/rate-limiter.js", () => ({
  throttleLLMCall: vi.fn(async () => {}),
}));

vi.mock("$lib/server/currency/rates.js", () => ({
  getExchangeRate: vi.fn(async () => ({ rate: null, source: "api" })),
}));

vi.mock("$lib/server/extraction/attachment-text.js", () => ({
  extractAttachmentsText: vi.fn(async () => null),
}));

// Reading a file stands in for OCR: it counts each read and gives the same
// text whichever form is asked for, as an image's OCR does.
vi.mock("$lib/server/extraction/document-text.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("$lib/server/extraction/document-text.js")
    >();
  const read = () => {
    holder.ocrCalls++;
    return holder.ocrText;
  };
  return {
    ...real,
    extractText: async () => read(),
    extractNumberedText: async () => real.numberDocumentLines([read()]),
    extractPlainAndNumberedText: async () => {
      const text = read();
      return { plain: text, numbered: real.numberDocumentLines([text]) };
    },
  };
});

const {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
} = await import("$lib/enums.js");
const { ImportMode, ImportReadAs, ImportReadHow, profileReadAsValue } =
  await import("$lib/import-reading.js");
const schema = await import("$lib/server/db/schema.js");
const {
  accountDefaults,
  importItems,
  importQueue,
  ledgerMovements,
  ledgerRecords,
  users,
} = schema;
const { createAccount } = await import("$lib/server/services/accounts.js");
const { createImportProfile, setImportProfileEnabled } =
  await import("$lib/server/services/import-profiles.js");
const { confirmGroupItem } =
  await import("$lib/server/services/import-items.js");
const { confirmReviewed, RECEIPT_NOT_AS_SHOWN } =
  await import("$lib/server/services/import.js");
const { SKIPPED_FILE_GONE } = await import("$lib/server/import/read-again.js");
const { insertProvider } = await import("$lib/server/llmProviders.js");
const { setSetting, SETTING_KEYS } = await import("$lib/server/settings.js");
const { importEvents } = await import("$lib/server/import/events.js");
const { alreadyImported, processImportJob } =
  await import("$lib/server/import/process-job.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;
type JobInsert = typeof importQueue.$inferInsert;
type ItemInsert = typeof importItems.$inferInsert;
type ProfileInput = import("$lib/import-profile-schema.js").ImportProfileDraft;

let dir: string;
let sqlite: Database;
let db: LedgerDb;
let ids: {
  payable: number;
  receivable: number;
  fees: number;
  sales: number;
};

type Emitted = {
  event: string;
  inTransaction: boolean;
  payload: Record<string, unknown>;
};
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
  holder.models.clear();
  holder.ocrText = "";
  holder.ocrCalls = 0;
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
    fees: account("Marketplace Fees", AccountType.Expense),
    sales: account("Sales", AccountType.Revenue),
  };
  const uncategorised = account("Uncategorised Expense", AccountType.Expense);
  const uncategorisedIncome = account(
    "Uncategorised Income",
    AccountType.Revenue,
  );
  db.insert(accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Payable, accountId: ids.payable },
      { purpose: DefaultAccountPurpose.Receivable, accountId: ids.receivable },
      {
        purpose: DefaultAccountPurpose.UncategorisedExpense,
        accountId: uncategorised,
      },
      {
        purpose: DefaultAccountPurpose.UncategorisedIncome,
        accountId: uncategorisedIncome,
      },
    ])
    .run();

  insertProvider(db, {
    type: "groq",
    name: "main",
    apiKey: "test-key",
    model: "main-model",
  });

  emitted = [];
  for (const event of [
    "job-update",
    "job-deleted",
    "item-update",
    "item-deleted",
  ]) {
    const handler = (payload: Record<string, unknown>) =>
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

const jobId = "7b2e1d63-0000-4000-8000-000000000001";
const statementText =
  "Shopee Malaysia fee notice\nCommission 12.50\nService fee 30.00\nTotal 42.50";

function putFile(rel: string) {
  const abs = join(holder.storageRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "%PDF-1.4 test");
}

function has(rel: string): boolean {
  return existsSync(join(holder.storageRoot, rel));
}

/** A queue row with its file stored, as an upload leaves it. */
function queueRow(over: Partial<JobInsert> = {}, id = jobId) {
  const tempFilePath = over.tempFilePath ?? `import/temp/${id}_fees.pdf`;
  db.insert(importQueue)
    .values({
      id,
      createdBy: 1,
      state: ImportState.Queued,
      tempFilePath,
      originalFilename: "fees.pdf",
      fileHash: "hash-fees",
      preExtractedText: statementText,
      ...over,
    })
    .run();
  putFile(tempFilePath);
  return id;
}

/** A group of fee lines waiting for review, read as several items. */
function group(states: number[] = [4, 4, 4], over: Partial<ItemInsert> = {}) {
  queueRow({
    state: ImportState.Grouped,
    readAs: ImportReadAs.SeveralItems,
    readHow: ImportReadHow.Chosen,
    profileId: "builtin:items@1",
    extractionNotes: JSON.stringify({
      statedTotal: null,
      itemsTotalMinor: -4250,
      ignored: [],
    }),
    date: "2026-07-31",
    supplier: "Shopee Malaysia",
    currency: "MYR",
    groupAccountId: ids.payable,
    processedAt: "2026-08-01T00:00:00.000Z",
  });
  return states.map((state, position) => {
    const id = `item-${position}`;
    db.insert(importItems)
      .values({
        id,
        jobId,
        state,
        position,
        sourceLine: 2 + position,
        sectionKey: "items",
        documentType: DocumentType.Expense,
        itemName: `Fee ${position + 1}`,
        supplier: "Shopee Malaysia",
        date: "2026-07-31",
        amount: 10 + position,
        currency: "MYR",
        exchangeRate: 1,
        category: "Marketplace Fees",
        categoryAccountId: ids.fees,
        accountId: ids.payable,
        ...over,
      })
      .run();
    return id;
  });
}

/** A receipt waiting for review on its one card. */
function receiptCard(over: Partial<JobInsert> = {}) {
  return queueRow({
    state: ImportState.PendingReview,
    readAs: ImportReadAs.Auto,
    readHow: ImportReadHow.Standard,
    extractedText: statementText,
    documentType: DocumentType.Expense,
    itemName: "Shopee fees",
    supplier: "Shopee Malaysia",
    amount: 42.5,
    date: "2026-07-31",
    currency: "MYR",
    exchangeRate: 1,
    category: "Marketplace Fees",
    categoryAccountId: ids.fees,
    accountId: ids.payable,
    duplicateOf: 99,
    duplicateConfidence: 80,
    remark: "my note",
    processedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });
}

function jobRow(id = jobId) {
  return db.select().from(importQueue).where(eq(importQueue.id, id)).get()!;
}

function itemsOf(id = jobId) {
  return db
    .select()
    .from(importItems)
    .where(eq(importItems.jobId, id))
    .all()
    .sort((a, b) => a.position - b.position);
}

function recordCount() {
  return {
    records: db.select().from(ledgerRecords).all().length,
    movements: db.select().from(ledgerMovements).all().length,
  };
}

function serve(replies: Reply[]) {
  const model = mockModel(replies);
  holder.models.set("main", model);
  return model;
}

const json = (value: unknown): Reply => ({ text: JSON.stringify(value) });

function receiptAnswer(over: Record<string, unknown> = {}) {
  return {
    document_type: "expense",
    item_name: "Shopee fees",
    supplier: "Shopee Malaysia",
    date: "2026-07-31",
    amount: 42.5,
    currency: "MYR",
    reference: "FN-2026-07",
    category_account_id: null,
    ...over,
  };
}

function itemsAnswer(amounts: number[]) {
  return {
    header: {
      document_type: "expense",
      counterparty: "Shopee Malaysia",
      date: "2026-07-31",
      reference: "FN-2026-07",
      currency: "MYR",
    },
    stated_total: null,
    sections: {
      items: amounts.map((amount, index) => ({
        description: `Line ${index + 1}`,
        amount,
        date: null,
        reference: null,
        source_line: index + 2,
        category_account_id: null,
      })),
    },
    ignored: [],
  };
}

/** A one-section fee notice profile, read in summary. */
function feeProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "Shopee fee notice",
    description: "Shopee's monthly fee notice.",
    phrases: [],
    instructions: "",
    mode: "summary",
    statedTotalLabels: { summary: "Total" },
    sections: [
      {
        key: "fees",
        name: "Fees",
        description: "Every fee line.",
        kind: "expense",
        fixedCategoryAccountId: ids.fees,
        feeTypes: [],
        extras: null,
      },
    ],
    ...over,
  };
}

function saveProfile(input: ProfileInput): number {
  const created = createImportProfile(db, 1, input);
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

function profileAnswer(amounts: number[]) {
  return {
    header: {
      counterparty: "Shopee Malaysia",
      date: "2026-07-31",
      reference: "FN-2026-07",
      currency: "MYR",
    },
    stated_total: null,
    sections: {
      fees: amounts.map((amount, index) => ({
        description: `Fee ${index + 1}`,
        amount,
        date: null,
        reference: null,
        source_line: index + 2,
      })),
    },
    ignored: [],
  };
}

async function runWorker(id = jobId) {
  await processImportJob(db, jobRow(id), { storageRoot: holder.storageRoot });
  return jobRow(id);
}

const locals = { user: { id: 1 } } as never;
type Handler = (event: never) => Promise<Response> | Response;

const routes = {
  /**
   * `importMode` is sent only to play an older screen, which still sent the
   * removed "Import" choice; the route must not read it.
   */
  async readAgain(readAs: unknown, id = jobId, importMode?: unknown) {
    const { POST } = await import("./[jobId]/reread/+server.js");
    return (POST as Handler)({
      locals,
      params: { jobId: id },
      request: new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          importMode === undefined ? { readAs } : { readAs, importMode },
        ),
      }),
    } as never);
  },
  async getJob(id = jobId) {
    const { GET } = await import("./[jobId]/+server.js");
    return (GET as Handler)({ locals, params: { jobId: id } } as never);
  },
  async confirmReceipt(body: unknown) {
    const { POST } = await import("./[jobId]/confirm/+server.js");
    return (POST as Handler)({
      locals,
      params: { jobId },
      request: new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    } as never);
  },
  async bulk(body: unknown, id = jobId) {
    const { POST } = await import("./[jobId]/items/bulk/+server.js");
    return (POST as Handler)({
      locals,
      params: { jobId: id },
      request: new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    } as never);
  },
};

beforeAll(async () => {
  await Promise.all([
    import("./[jobId]/reread/+server.js"),
    import("./[jobId]/+server.js"),
    import("./[jobId]/confirm/+server.js"),
    import("./[jobId]/items/bulk/+server.js"),
  ]);
}, 60_000);

// ── A group ──────────────────────────────────────────────────────────────────

describe("reading a group again", () => {
  it("says on the job that it can be read again while no item is confirmed", async () => {
    group([ImportState.PendingReview, ImportState.Skipped]);
    const sent = await (await routes.getJob()).json();
    expect(sent.canReadAgain).toBe(true);
    expect(sent.readAgainReason).toBeNull();
  });

  it("replaces the waiting and skipped items with a receipt reading, touching no record", async () => {
    const itemIds = group([
      ImportState.PendingReview,
      ImportState.Skipped,
      ImportState.PendingReview,
    ]);
    const before = recordCount();

    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId, removedItems: 3 });

    // The old reading is gone, and the job waits to be read the new way.
    expect(itemsOf()).toEqual([]);
    const queued = jobRow();
    expect(queued).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Receipt,
      readHow: ImportReadHow.Chosen,
      profileId: null,
      profileSnapshot: null,
      importMode: null,
      extractionNotes: null,
      groupAccountId: null,
      date: null,
      supplier: null,
      currency: null,
      processedAt: null,
      error: null,
      // The file and the upload's own text stay.
      tempFilePath: `import/temp/${jobId}_fees.pdf`,
      fileHash: "hash-fees",
      preExtractedText: statementText,
    });
    expect(has(queued.tempFilePath)).toBe(true);
    expect(recordCount()).toEqual(before);

    // Announced after the commit: each item removed, then the job once.
    expect(emitted.map((e) => e.event)).toEqual([
      "item-deleted",
      "item-deleted",
      "item-deleted",
      "job-update",
    ]);
    expect(emitted.every((e) => !e.inTransaction)).toBe(true);
    expect(emitted.slice(0, 3).map((e) => e.payload.itemId)).toEqual(itemIds);
    const job = emitted[3].payload.job as Record<string, unknown>;
    expect(job).toMatchObject({
      id: jobId,
      state: ImportState.Queued,
      canReadAgain: false,
    });
    expect(job).not.toHaveProperty("preExtractedText");

    // The worker reads it as a receipt: one card, no group, no record.
    serve([json(receiptAnswer())]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.PendingReview,
      amount: 42.5,
      itemName: "Shopee fees",
      readHow: ImportReadHow.Chosen,
    });
    expect(itemsOf()).toEqual([]);
    expect(recordCount()).toEqual(before);
  });

  it("is refused once an item is confirmed, and the group says why", async () => {
    const [first] = group();
    const confirmed = await confirmGroupItem(db, jobId, first, {
      actingUserId: 1,
      storageRoot: holder.storageRoot,
    });
    expect(confirmed.ok).toBe(true);
    const before = recordCount();
    const itemsBefore = itemsOf();
    emitted = [];

    const sent = await (await routes.getJob()).json();
    const reason =
      "1 item is already confirmed, so this document can no longer be read again. Reading it again would replace items that are already in the books.";
    expect(sent.canReadAgain).toBe(false);
    expect(sent.readAgainReason).toBe(reason);

    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe(reason);
    expect(itemsOf()).toEqual(itemsBefore);
    expect(jobRow().state).toBe(ImportState.Grouped);
    expect(recordCount()).toEqual(before);
    expect(emitted).toEqual([]);
  });

  it("says a finished group is already imported, not only confirmed", async () => {
    group([ImportState.Imported, ImportState.Imported]);
    db.update(importQueue)
      .set({ state: ImportState.Imported })
      .where(eq(importQueue.id, jobId))
      .run();
    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(
      /^This document is already imported/,
    );
  });

  it("counts every confirmed item in the reason", async () => {
    group([ImportState.Imported, ImportState.Confirmed, 4]);
    const res = await routes.readAgain(ImportReadAs.Auto);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(
      /^2 items are already confirmed, so/,
    );
  });
});

// ── A receipt card ──────────────────────────────────────────────────────────

describe("reading a receipt card again", () => {
  it("reads it with a profile, which turns it into a group", async () => {
    receiptCard();
    const profileId = saveProfile(feeProfile());

    const res = await routes.readAgain(profileReadAsValue(profileId));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId, removedItems: 0 });

    const queued = jobRow();
    expect(queued).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Profile,
      readHow: ImportReadHow.Chosen,
      profileId: String(profileId),
      importMode: ImportMode.Summary,
      // Every column the receipt reading wrote is emptied.
      documentType: null,
      itemName: null,
      amount: null,
      categoryAccountId: null,
      accountId: null,
      duplicateOf: null,
      duplicateConfidence: null,
      remark: null,
      // A PDF's text is read again; only an image's is kept.
      extractedText: null,
    });
    // The queue names the profile while the document waits (FR-041).
    expect(emitted.at(-1)!.payload.job).toMatchObject({
      profile: { name: "Shopee fee notice", mode: ImportMode.Summary },
    });

    serve([json(profileAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);
    expect(read.readHow).toBe(ImportReadHow.Chosen);
    expect(itemsOf().map((item) => item.amount)).toEqual([12.5, 30]);
    expect(itemsOf().every((item) => item.categoryAccountId === ids.fees)).toBe(
      true,
    );
  });

  it("refuses a profile that is turned off, by name, and changes nothing", async () => {
    receiptCard();
    const profileId = saveProfile(feeProfile());
    setImportProfileEnabled(db, 1, profileId, false);

    const res = await routes.readAgain(profileReadAsValue(profileId));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('"Shopee fee notice"');
    expect(jobRow()).toMatchObject({
      state: ImportState.PendingReview,
      amount: 42.5,
    });
    expect(emitted).toEqual([]);
  });

  it("reads it as Auto-detect when no choice is named", async () => {
    receiptCard({
      readAs: ImportReadAs.Receipt,
      readHow: ImportReadHow.Chosen,
    });
    expect((await routes.readAgain("")).status).toBe(202);
    expect(jobRow()).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Auto,
      readHow: ImportReadHow.Standard,
    });
  });

  it("makes no record from the old reading when a confirm lands after it was read again", async () => {
    receiptCard({
      readAs: ImportReadAs.Receipt,
      readHow: ImportReadHow.Chosen,
    });
    // What the confirm route read before it waited on an exchange rate.
    const seen = jobRow();
    const before = recordCount();

    expect((await routes.readAgain(ImportReadAs.Receipt)).status).toBe(202);
    serve([json(receiptAnswer({ amount: 99, item_name: "New reading" }))]);
    expect((await runWorker()).state).toBe(ImportState.PendingReview);

    const late = await confirmReviewed(
      db,
      {
        jobId,
        uploadedBy: seen.createdBy,
        tempFilePath: seen.tempFilePath,
        extractedText: seen.extractedText,
        readAt: seen.processedAt,
      },
      seen,
      {},
      { actingUserId: 1, storageRoot: holder.storageRoot },
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toMatch(/read again/);
    expect(recordCount()).toEqual(before);
    // The new reading still waits for review, untouched.
    expect(jobRow()).toMatchObject({
      state: ImportState.PendingReview,
      amount: 99,
      itemName: "New reading",
    });
  });

  it("refuses a confirm made from the reading shown before it was read again", async () => {
    receiptCard({
      readAs: ImportReadAs.Receipt,
      readHow: ImportReadHow.Chosen,
    });
    // The reading the reviewer's card shows, and the edits they made to it.
    const shown = jobRow().processedAt;
    const edits = { item_name: "Typed for the old reading", amount: 42.5 };
    const before = recordCount();

    expect((await routes.readAgain(ImportReadAs.Receipt)).status).toBe(202);
    serve([json(receiptAnswer({ amount: 99, item_name: "New reading" }))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.PendingReview);
    expect(read.processedAt).not.toBe(shown);

    const late = await routes.confirmReceipt({ ...edits, readAt: shown });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe(RECEIPT_NOT_AS_SHOWN);
    expect(recordCount()).toEqual(before);
    expect(jobRow()).toMatchObject({
      state: ImportState.PendingReview,
      amount: 99,
      itemName: "New reading",
    });

    // Confirmed from the reading now on the card, it goes through.
    const current = await routes.confirmReceipt({ readAt: read.processedAt });
    expect(current.status).toBe(201);
    expect(recordCount().records).toBe(before.records + 1);
  });

  it("refuses a way of reading it does not know", async () => {
    receiptCard();
    const res = await routes.readAgain("statement");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown way to read");
    expect(jobRow().state).toBe(ImportState.PendingReview);
  });
});

// ── Auto-detect ─────────────────────────────────────────────────────────────

describe("reading it again with Auto-detect", () => {
  const phrase = "Shopee Malaysia fee notice";

  it("detects an enabled profile by its phrases, with no detection call", async () => {
    receiptCard();
    const profileId = saveProfile(feeProfile({ phrases: [phrase] }));

    expect((await routes.readAgain(ImportReadAs.Auto)).status).toBe(202);
    // Waiting, it says Standard; the worker decides (see `readingForUpload`).
    expect(jobRow()).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Auto,
      readHow: ImportReadHow.Standard,
      profileId: null,
      profileSnapshot: null,
    });

    const model = serve([json(profileAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.Grouped,
      readAs: ImportReadAs.Auto,
      readHow: ImportReadHow.Detected,
      profileId: String(profileId),
    });
    // The phrases decided: the one call is the profile reading.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(itemsOf().map((item) => item.amount)).toEqual([12.5, 30]);
  });

  it("drops the profile it once detected, and reads the standard way when none is on", async () => {
    receiptCard();
    const profileId = saveProfile(feeProfile({ phrases: [phrase] }));
    expect((await routes.readAgain(ImportReadAs.Auto)).status).toBe(202);
    serve([json(profileAnswer([12.5, 30]))]);
    expect((await runWorker()).readHow).toBe(ImportReadHow.Detected);

    setImportProfileEnabled(db, 1, profileId, false);
    emitted = [];
    expect((await routes.readAgain(ImportReadAs.Auto)).status).toBe(202);
    expect(itemsOf()).toEqual([]);
    // The mode went with the profile: it belongs to the profile that reads
    // the document, and Auto-detect has found none yet.
    expect(jobRow()).toMatchObject({
      readHow: ImportReadHow.Standard,
      profileId: null,
      profileSnapshot: null,
      importMode: null,
    });
    const sent = emitted.at(-1)!.payload.job as Record<string, unknown>;
    expect(sent).not.toHaveProperty("profile");

    // No enabled profile: no detection step, the receipt reading only.
    const model = serve([json(receiptAnswer())]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.PendingReview,
      readHow: ImportReadHow.Standard,
      profileId: null,
      profileSnapshot: null,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

// ── A failed document ───────────────────────────────────────────────────────

describe("reading a failed document again", () => {
  it("reads it as several items, with the error gone", async () => {
    queueRow({
      state: ImportState.Failed,
      readAs: ImportReadAs.Receipt,
      readHow: ImportReadHow.Chosen,
      error: "AI extraction failed: provider down",
    });
    expect((await (await routes.getJob()).json()).canReadAgain).toBe(true);

    const res = await routes.readAgain(ImportReadAs.SeveralItems);
    expect(res.status).toBe(202);
    expect(jobRow()).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.SeveralItems,
      error: null,
    });

    serve([json(itemsAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);
    expect(read.error).toBeNull();
    expect(itemsOf()).toHaveLength(2);
  });
});

// ── The repeat-file stop ────────────────────────────────────────────────────

describe("the repeat-file stop (FR-026)", () => {
  it("never counts the document's own row", () => {
    // A job that may be read again has made no record (that is the rule), so
    // through the route its own row could not stop it anyway. Asked directly,
    // its own row is left out even when it says Imported.
    receiptCard({ state: ImportState.Imported });
    expect(alreadyImported(db, jobRow())).toBeNull();
  });

  it("lets a document be read again past an upload of the same file that made nothing", async () => {
    receiptCard({ readAs: ImportReadAs.Receipt });
    // An earlier upload of the same file that made nothing.
    queueRow(
      { state: ImportState.Skipped },
      "7b2e1d63-0000-4000-8000-000000000002",
    );

    expect((await routes.readAgain(ImportReadAs.SeveralItems)).status).toBe(
      202,
    );
    serve([json(itemsAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);
    expect(read.error).toBeNull();
  });

  it("still stops it when another upload of the same file made a record", async () => {
    receiptCard({ readAs: ImportReadAs.Receipt });
    queueRow(
      { state: ImportState.Imported, readAs: ImportReadAs.Receipt },
      "7b2e1d63-0000-4000-8000-000000000002",
    );

    expect((await routes.readAgain(ImportReadAs.SeveralItems)).status).toBe(
      202,
    );
    const model = serve([json(itemsAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Failed);
    expect(read.error).toMatch(/^This file was already imported/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

// ── The import mode ─────────────────────────────────────────────────────────

/**
 * A profile that reads every row of a statement's transaction table, the
 * other way to read the document `feeProfile` reads as its summary. One kind
 * of document read two ways is two profiles (FR-033).
 */
function everyProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  return feeProfile({
    name: "Shopee transactions",
    mode: "every_transaction",
    statedTotalLabels: { every_transaction: "Total in" },
    sections: [
      {
        ...feeProfile().sections[0],
        key: "rows",
        name: "Transactions",
        description: "Each row of the transaction table.",
      },
    ],
    ...over,
  });
}

/** What the model answers for one section's lines. */
function sectionAnswer(key: string, amounts: number[]) {
  const answer = profileAnswer([]) as unknown as {
    sections: Record<string, unknown>;
  };
  answer.sections = {
    [key]: amounts.map((amount, index) => ({
      description: `Row ${index + 1}`,
      amount,
      date: null,
      reference: null,
      source_line: index + 2,
    })),
  };
  return answer;
}

/** What the model answers for the transaction table's rows. */
const rowsAnswer = (amounts: number[]) => sectionAnswer("rows", amounts);

describe("reading it again with another profile (FR-023)", () => {
  it("reads a summary group again with an Every transaction profile, in that profile's mode", async () => {
    const summaryId = saveProfile(feeProfile());
    const everyId = saveProfile(everyProfile());
    receiptCard();
    expect((await routes.readAgain(profileReadAsValue(summaryId))).status).toBe(
      202,
    );
    serve([json(profileAnswer([12.5, 30]))]);
    expect(await runWorker()).toMatchObject({
      state: ImportState.Grouped,
      importMode: ImportMode.Summary,
    });

    emitted = [];
    const res = await routes.readAgain(profileReadAsValue(everyId));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId, removedItems: 2 });
    expect(itemsOf()).toEqual([]);
    expect(jobRow()).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Profile,
      profileId: String(everyId),
      importMode: ImportMode.EveryTransaction,
    });
    // The copy kept while it waits is of the new profile, in its mode, and
    // the queue says both (FR-041).
    const waiting = JSON.parse(jobRow().profileSnapshot!) as {
      id: number;
      mode: string;
    };
    expect(waiting).toMatchObject({
      id: everyId,
      mode: ImportMode.EveryTransaction,
    });
    expect(emitted.at(-1)!.payload.job).toMatchObject({
      profile: {
        name: "Shopee transactions",
        mode: ImportMode.EveryTransaction,
      },
    });

    const model = serve([json(rowsAnswer([1, 2, 3]))]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.Grouped,
      profileId: String(everyId),
      importMode: ImportMode.EveryTransaction,
    });
    expect(itemsOf().map((item) => [item.sectionKey, item.amount])).toEqual([
      ["rows", 1],
      ["rows", 2],
      ["rows", 3],
    ]);
    // Only the new profile's section is asked of the model.
    const sent = JSON.stringify(model.doGenerateCalls[0].responseFormat);
    expect(sent).toContain("rows");
    expect(sent).not.toContain('"fees"');
  });

  it("ignores an import mode an older screen still sends", async () => {
    const profileId = saveProfile(feeProfile());
    receiptCard();
    // Neither a known mode nor an unknown one changes anything: the field is
    // not read, and the profile's own mode is stored.
    for (const sentMode of [ImportMode.EveryTransaction, "transactions"]) {
      // Back to a card waiting for review, so it may be read again.
      db.update(importQueue)
        .set({ state: ImportState.PendingReview })
        .where(eq(importQueue.id, jobId))
        .run();
      const res = await routes.readAgain(
        profileReadAsValue(profileId),
        jobId,
        sentMode,
      );
      expect(res.status).toBe(202);
      expect(jobRow()).toMatchObject({
        readAs: ImportReadAs.Profile,
        importMode: ImportMode.Summary,
      });
    }
  });

  it("reads a detected profile in its own mode", async () => {
    const phrase = "Shopee Malaysia fee notice";
    const profileId = saveProfile(everyProfile({ phrases: [phrase] }));
    receiptCard();
    expect((await routes.readAgain(ImportReadAs.Auto)).status).toBe(202);
    // No mode until a profile is found: it is the profile's.
    expect(jobRow().importMode).toBeNull();

    serve([json(rowsAnswer([7, 8]))]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.Grouped,
      readHow: ImportReadHow.Detected,
      profileId: String(profileId),
      importMode: ImportMode.EveryTransaction,
    });
    expect(itemsOf().map((item) => item.sectionKey)).toEqual(["rows", "rows"]);
  });

  it("reads a detected Summary profile as Summary, whatever an older screen sent (FR-002)", async () => {
    const phrase = "Shopee Malaysia fee notice";
    const profileId = saveProfile(feeProfile({ phrases: [phrase] }));
    receiptCard();
    expect(
      (
        await routes.readAgain(
          ImportReadAs.Auto,
          jobId,
          ImportMode.EveryTransaction,
        )
      ).status,
    ).toBe(202);
    expect(jobRow().importMode).toBeNull();
    const model = serve([json(profileAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read).toMatchObject({
      state: ImportState.Grouped,
      readHow: ImportReadHow.Detected,
      profileId: String(profileId),
      importMode: ImportMode.Summary,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(itemsOf().map((item) => item.sectionKey)).toEqual(["fees", "fees"]);
  });
});

// ── One file, one import (FR-064) ───────────────────────────────────────────

describe("the repeat-file guard at confirm (FR-033, FR-064)", () => {
  const otherId = "7b2e1d63-0000-4000-8000-000000000002";

  it("refuses the copy read with one profile once the copy read with another made records", async () => {
    // The same wallet report uploaded twice before either was confirmed:
    // once with the withdrawals-only profile, once with the every-transaction
    // one. Both pass the upload stop, since neither has made a record yet.
    const withdrawalsId = saveProfile(
      everyProfile({
        name: "Wallet report — withdrawals only",
        sections: [
          {
            ...everyProfile().sections[0],
            key: "withdrawals",
            name: "Withdrawals",
            description: "Each withdrawal to the bank.",
          },
        ],
      }),
    );
    const everyId = saveProfile(
      everyProfile({ name: "Wallet report — every transaction" }),
    );
    const chosen = {
      state: ImportState.Queued,
      readAs: ImportReadAs.Profile,
      readHow: ImportReadHow.Chosen,
      importMode: ImportMode.EveryTransaction,
    };
    queueRow({ ...chosen, profileId: String(withdrawalsId) }, otherId);
    queueRow({ ...chosen, profileId: String(everyId) });
    serve([json(sectionAnswer("withdrawals", [12.5, 30]))]);
    expect((await runWorker(otherId)).state).toBe(ImportState.Grouped);
    serve([json(rowsAnswer([1, 2, 3]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);

    const first = await routes.bulk(
      { action: "confirm", all: true, readAt: jobRow(otherId).processedAt },
      otherId,
    );
    expect(first.status).toBe(200);
    const before = recordCount();
    expect(before.records).toBe(2);

    const second = await routes.bulk({
      action: "confirm",
      all: true,
      readAt: read.processedAt,
    });
    expect(second.status).toBe(200);
    const { results } = (await second.json()) as {
      results: { ok: boolean; reason?: string }[];
    };
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(
        'This file was already imported with the import profile "Wallet report — withdrawals only" (Every transaction), which made 2 records. One file is imported one way only, so nothing was imported from this copy.',
      );
    }
    // Nothing was written, and every item is still waiting.
    expect(recordCount()).toEqual(before);
    expect(itemsOf().every((i) => i.state === ImportState.PendingReview)).toBe(
      true,
    );
    expect(jobRow().state).toBe(ImportState.Grouped);
  });

  it("refuses the one card of a profile reading once another copy made a record", async () => {
    receiptCard({
      readAs: ImportReadAs.Profile,
      readHow: ImportReadHow.Chosen,
      profileId: "5",
      importMode: ImportMode.Summary,
    });
    queueRow(
      { state: ImportState.Imported, readAs: ImportReadAs.Receipt },
      otherId,
    );
    const before = recordCount();
    const res = await routes.confirmReceipt({ readAt: jobRow().processedAt });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This file was already imported as a receipt or invoice, which made 1 record. One file is imported one way only, so nothing was imported from this copy.",
    );
    expect(recordCount()).toEqual(before);
    expect(jobRow().state).toBe(ImportState.PendingReview);
  });

  it("leaves a receipt read the standard way as it was (FR-004)", async () => {
    receiptCard();
    queueRow(
      { state: ImportState.Imported, readAs: ImportReadAs.Receipt },
      otherId,
    );
    const before = recordCount();
    const res = await routes.confirmReceipt({ readAt: jobRow().processedAt });
    expect(res.status).toBe(201);
    expect(recordCount().records).toBe(before.records + 1);
  });

  it("leaves the Auto-detect fallback to a receipt as it was (FR-004)", async () => {
    // No profile fitted, so it was read the standard way: a receipt, even
    // on a row from before the "Import" choice was removed, which still
    // carries the mode it stored.
    receiptCard({
      readAs: ImportReadAs.Auto,
      readHow: ImportReadHow.Standard,
      importMode: ImportMode.EveryTransaction,
    });
    queueRow(
      { state: ImportState.Imported, readAs: ImportReadAs.Receipt },
      otherId,
    );
    const before = recordCount();
    const res = await routes.confirmReceipt({ readAt: jobRow().processedAt });
    expect(res.status).toBe(201);
    expect(recordCount().records).toBe(before.records + 1);
  });

  it("lets a copy be confirmed when the other made no record", async () => {
    group([ImportState.PendingReview]);
    queueRow({ state: ImportState.Skipped }, otherId);
    const res = await routes.bulk({
      action: "confirm",
      all: true,
      readAt: jobRow().processedAt,
    });
    const { results } = (await res.json()) as { results: { ok: boolean }[] };
    expect(results.map((r) => r.ok)).toEqual([true]);
  });
});

// ── Text read from an image ─────────────────────────────────────────────────

describe("the text of an image", () => {
  const image = {
    tempFilePath: `import/temp/${jobId}_fees.jpg`,
    originalFilename: "fees.jpg",
    preExtractedText: null,
  };

  it("is kept when the reading fails, and read again without OCR", async () => {
    holder.ocrText = statementText;
    queueRow({ ...image, readAs: ImportReadAs.Receipt });
    serve([{ error: new Error("provider down") }]);
    const failed = await runWorker();
    expect(failed.state).toBe(ImportState.Failed);
    expect(holder.ocrCalls).toBe(1);
    expect(failed.extractedText).toBe(statementText);

    expect((await routes.readAgain(ImportReadAs.SeveralItems)).status).toBe(
      202,
    );
    expect(jobRow().extractedText).toBe(statementText);
    const model = serve([json(itemsAnswer([12.5, 30]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);
    expect(holder.ocrCalls).toBe(1);
    // The reading got the image's lines, numbered as a fresh read numbers them.
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain(
      "L0002│Commission 12.50",
    );
  });

  it("is read by OCR again for a PDF", async () => {
    holder.ocrText = statementText;
    queueRow({ preExtractedText: null, readAs: ImportReadAs.Receipt });
    serve([json(receiptAnswer())]);
    expect((await runWorker()).state).toBe(ImportState.PendingReview);
    expect(holder.ocrCalls).toBe(1);

    expect((await routes.readAgain(ImportReadAs.Receipt)).status).toBe(202);
    serve([json(receiptAnswer())]);
    expect((await runWorker()).state).toBe(ImportState.PendingReview);
    expect(holder.ocrCalls).toBe(2);
  });
});

// ── A skipped document ──────────────────────────────────────────────────────

describe("reading a skipped document again", () => {
  it("reads a skipped receipt again while its file is stored", async () => {
    receiptCard({ state: ImportState.Skipped });
    const sent = await (await routes.getJob()).json();
    expect(sent.canReadAgain).toBe(true);
    expect(sent.readAgainReason).toBeNull();

    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(202);
    expect(jobRow()).toMatchObject({
      state: ImportState.Queued,
      readAs: ImportReadAs.Receipt,
      processedAt: null,
    });

    serve([json(receiptAnswer({ amount: 77 }))]);
    expect(await runWorker()).toMatchObject({
      state: ImportState.PendingReview,
      amount: 77,
    });
  });

  it("reads a group whose items were all skipped again, replacing them", async () => {
    group([ImportState.Skipped, ImportState.Skipped]);
    db.update(importQueue)
      .set({ state: ImportState.Skipped })
      .where(eq(importQueue.id, jobId))
      .run();
    const before = recordCount();
    const sent = await (await routes.getJob()).json();
    expect(sent.canReadAgain).toBe(true);

    const res = await routes.readAgain(ImportReadAs.SeveralItems);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId, removedItems: 2 });
    expect(itemsOf()).toEqual([]);
    expect(jobRow().state).toBe(ImportState.Queued);

    serve([json(itemsAnswer([5, 6, 7]))]);
    expect((await runWorker()).state).toBe(ImportState.Grouped);
    expect(itemsOf().map((item) => item.state)).toEqual([
      ImportState.PendingReview,
      ImportState.PendingReview,
      ImportState.PendingReview,
    ]);
    expect(recordCount()).toEqual(before);
  });

  it("refuses once its file was released, and says to upload it again", async () => {
    receiptCard({ state: ImportState.Skipped });
    rmSync(join(holder.storageRoot, jobRow().tempFilePath));
    emitted = [];

    const sent = await (await routes.getJob()).json();
    expect(sent.canReadAgain).toBe(false);
    expect(sent.readAgainReason).toBe(SKIPPED_FILE_GONE);

    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe(SKIPPED_FILE_GONE);
    expect(SKIPPED_FILE_GONE).toMatch(/Upload it again/);
    expect(jobRow().state).toBe(ImportState.Skipped);
    expect(emitted).toEqual([]);
  });

  it("still refuses a skipped document that made a record", async () => {
    group([ImportState.Imported, ImportState.Skipped]);
    db.update(importQueue)
      .set({ state: ImportState.Skipped })
      .where(eq(importQueue.id, jobId))
      .run();
    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(/^1 item is already confirmed/);
    expect(itemsOf()).toHaveLength(2);
    expect(jobRow().state).toBe(ImportState.Skipped);
  });
});

// ── Many items at once, after a Read again ──────────────────────────────────

describe("acting on every item after a Read again", () => {
  it("refuses an action on all items when the page shows another reading", async () => {
    group([ImportState.PendingReview, ImportState.PendingReview]);
    const shown = jobRow().processedAt;
    const before = recordCount();

    expect((await routes.readAgain(ImportReadAs.SeveralItems)).status).toBe(
      202,
    );
    serve([json(itemsAnswer([5, 6, 7]))]);
    const read = await runWorker();
    expect(read.state).toBe(ImportState.Grouped);

    for (const action of ["confirm", "skip"]) {
      const res = await routes.bulk({ action, all: true, readAt: shown });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toMatch(/was read again/);
    }
    // None of the new reading's items was touched.
    expect(recordCount()).toEqual(before);
    expect(itemsOf().every((i) => i.state === ImportState.PendingReview)).toBe(
      true,
    );

    // From the reading on the page, it goes through.
    const res = await routes.bulk({
      action: "confirm",
      all: true,
      readAt: read.processedAt,
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { ok: boolean }[] };
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(recordCount().records).toBe(before.records + 3);
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("refusals", () => {
  it("needs both the upload and the change permission", async () => {
    group();
    for (const missing of ["add", "change"]) {
      holder.allow = (resource, action) =>
        resource === "import" && action !== missing;
      const res = await routes.readAgain(ImportReadAs.Receipt);
      expect(res.status).toBe(403);
    }
    expect(itemsOf()).toHaveLength(3);
    expect(jobRow().state).toBe(ImportState.Grouped);
    expect(emitted).toEqual([]);
  });

  it("refuses a document still being read, or already imported", async () => {
    queueRow({ state: ImportState.Processing });
    let res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(/still being read/);

    db.update(importQueue)
      .set({ state: ImportState.Imported })
      .where(eq(importQueue.id, jobId))
      .run();
    res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(/already imported/);
    const sent = await (await routes.getJob()).json();
    expect(sent.canReadAgain).toBe(false);
    expect(sent.readAgainReason).toMatch(/already imported/);
  });

  it("refuses when the file is gone", async () => {
    receiptCard();
    rmSync(join(holder.storageRoot, jobRow().tempFilePath));
    const res = await routes.readAgain(ImportReadAs.Receipt);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toMatch(/no longer stored/);
    expect(jobRow().state).toBe(ImportState.PendingReview);
  });

  it("answers 404 for a job that is not there, and 400 for no choice", async () => {
    expect((await routes.readAgain(ImportReadAs.Receipt, "nope")).status).toBe(
      404,
    );
    receiptCard();
    expect((await routes.readAgain(undefined)).status).toBe(400);
  });
});
