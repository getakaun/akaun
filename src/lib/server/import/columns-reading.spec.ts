import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
import { mockModel, type Reply } from "../llm/__fixtures__/mock-model.js";
import { walletReportFixture } from "../extraction/spreadsheet/__fixtures__/build-xlsx.js";
import {
  orderSections,
  walletLayout,
  walletWorkbook,
  withdrawalSection,
} from "./__fixtures__/wallet-table.js";

/**
 * A spreadsheet read from its columns, end to end (006 S4.5, US10, FR-053 to
 * FR-057, FR-062 to FR-063): the routing in `processImportJob` that reads it
 * by code with no AI provider, Auto-detect by the table's headings, the group
 * it leaves for review, and confirming imported withdrawals.
 *
 * The database is a file under `os.tmpdir()`, migrated from `drizzle/`, and
 * the job's storage folder is there too. No AI provider is set up unless a
 * test adds one, and then it is a mock model that plays back fixed answers.
 * Every workbook is built in memory, with made-up values.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-columns-reading-spec-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  models: new Map<string, unknown>(),
}));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return join(sandbox, "default-root");
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

vi.mock("$lib/server/currency/rates.js", () => ({
  getExchangeRate: vi.fn(async () => ({ rate: 4.5, source: "api" })),
}));

vi.mock("$lib/server/extraction/attachment-text.js", () => ({
  extractAttachmentsText: vi.fn(async () => null),
}));

const {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  DocumentType,
  EntityType,
  ImportState,
  LedgerRecordKind,
} = await import("$lib/enums.js");
const {
  ImportMode,
  ImportReadAs,
  ImportReadHow,
  ignoredSummary,
  parseExtractionNotes,
} = await import("$lib/import-reading.js");
const schema = await import("../db/schema.js");
const {
  accountDefaults,
  contacts,
  importItems,
  importQueue,
  importRecordProfiles,
  ledgerRecords,
  users,
} = schema;
const { createAccount } = await import("../services/accounts.js");
const { createRecord } = await import("../services/ledger.js");
const { createImportProfile, updateImportProfile } =
  await import("../services/import-profiles.js");
const { profileDraft } =
  await import("$lib/server/import/__fixtures__/profile-drafts.js");
const { confirmGroupItems, setGroupItemsCategory, skipGroupItems } =
  await import("../services/import-items.js");
const { monthsCoveredBy } = await import("./same-money.js");
const { insertProvider } = await import("../llmProviders.js");
const { setSetting, SETTING_KEYS } = await import("../settings.js");
const { NO_PROVIDERS, processImportJob, severalLayoutsFit } =
  await import("./process-job.js");
const { itemAttention } = await import("./group-state.js");
const { needsAi, needsCells, planForProfile } =
  await import("./reading-plan.js");
const { parseProfileSnapshot } = await import("./profile-snapshot.js");
const { describeReading } =
  await import("$lib/components/import/review-card.js");
type LedgerDb = import("../ledger/types.js").LedgerDb;
type ProfileInput = import("$lib/import-profile-schema.js").ImportProfileDraft;

let dir: string;
let storageRoot: string;
let sqlite: Database;
let db: LedgerDb;
let ids: {
  payable: number;
  receivable: number;
  uncategorised: number;
  uncategorisedIncome: number;
  sales: number;
  wallet: number;
  bank: number;
};

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
  dir = mkdtempSync(join(sandbox, "db-"));
  storageRoot = join(dir, "storage");
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  holder.db = db;
  migrate(db as never, { migrationsFolder: "drizzle" });
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
    sales: account("Sales", AccountType.Revenue),
    wallet: account(
      "Marketplace wallet",
      AccountType.Asset,
      AccountSubType.Wallet,
    ),
    bank: account("Current account", AccountType.Asset, AccountSubType.Bank),
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
  holder.models.clear();
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Every row: order income and adjustments by sign, withdrawals as transfers. */
function fullProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "Wallet report, every transaction",
    description: "A marketplace wallet's list of money in and out.",
    phrases: [],
    instructions: "",
    mode: ImportMode.EveryTransaction,
    statedTotalLabels: {},
    accountId: ids.wallet,
    layout: walletLayout(),
    sections: [
      ...orderSections({ orders: ids.sales }),
      withdrawalSection(ids.bank),
    ],
    ...over,
  };
}

/** Only the withdrawals; every other row is left out. */
function withdrawalsProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  return fullProfile({
    name: "Wallet report, withdrawals only",
    layout: walletLayout({ statedTotalLabels: {} }),
    sections: [withdrawalSection(ids.bank)],
    ...over,
  });
}

/** Read from columns, with headings the wallet report does not have. */
function otherLayoutProfile(): ProfileInput {
  return {
    ...fullProfile({ name: "Other layout" }),
    layout: walletLayout({
      headers: ["Date", "Amount", "Fee"],
      columns: {
        date: "Date",
        description: "Fee",
        amount: "Amount",
        reference: null,
      },
      direction: null,
    }),
    sections: [
      {
        ...orderSections()[0],
        rows: { where: [], feeTypeColumn: null },
      },
    ],
  };
}

/** Read by the AI: no layout, and no row rules. */
function aiProfile(): ProfileInput {
  const { rows: _rows, ...section } = withdrawalSection(ids.bank);
  void _rows;
  return fullProfile({
    name: "Statement read by the AI",
    layout: null,
    sections: [section],
  });
}

function saveProfile(input: ProfileInput): number {
  const created = createImportProfile(db, 1, input);
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

function addProvider() {
  insertProvider(db, {
    type: "groq",
    name: "main",
    apiKey: "test-key",
    model: "main-model",
  });
}

function serve(replies: Reply[]) {
  const model = mockModel(replies);
  holder.models.set("main", model);
  return model;
}

let jobCount = 0;

function queueFile(
  filename: string,
  data: Buffer | string,
  over: Partial<typeof importQueue.$inferInsert> = {},
) {
  const id = `00000000-0000-4000-9200-${String(++jobCount).padStart(12, "0")}`;
  const tempFilePath = `import/temp/${id}_${filename}`;
  db.insert(importQueue)
    .values({
      id,
      createdBy: 1,
      state: ImportState.Queued,
      tempFilePath,
      originalFilename: filename,
      fileHash: `hash-${id}`,
      ...over,
    })
    .run();
  const abs = join(storageRoot, tempFilePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return job(id);
}

function withProfile(
  profileId: number,
  data: Buffer | string = walletReportFixture().xlsx,
  filename = "wallet.xlsx",
) {
  return queueFile(filename, data, {
    readAs: ImportReadAs.Profile,
    profileId: String(profileId),
  });
}

function job(id: string) {
  return db.select().from(importQueue).where(eq(importQueue.id, id)).get()!;
}

function itemsOf(jobId: string) {
  return db
    .select()
    .from(importItems)
    .where(eq(importItems.jobId, jobId))
    .all()
    .sort((a, b) => a.position - b.position);
}

async function run(row: typeof importQueue.$inferSelect) {
  await processImportJob(db, row, { storageRoot });
  return job(row.id);
}

// ── Reading from columns ────────────────────────────────────────────────────

describe("reading a spreadsheet from its columns", () => {
  it("reads every row by code, with no AI provider set up (FR-055)", async () => {
    const profileId = saveProfile(fullProfile());
    const row = await run(withProfile(profileId));

    expect(row.state).toBe(ImportState.Grouped);
    expect(row.error).toBeNull();
    const items = itemsOf(row.id);
    expect(items.map((item) => item.documentType)).toEqual([
      DocumentType.Income,
      DocumentType.Income,
      DocumentType.TransferOut,
      DocumentType.Expense,
      DocumentType.Expense,
      DocumentType.Income,
      DocumentType.TransferOut,
      DocumentType.Income,
    ]);
    // Every item starts on the wallet; a transfer goes to the bank.
    expect(new Set(items.map((item) => item.accountId))).toEqual(
      new Set([ids.wallet]),
    );
    expect(
      items
        .filter((item) => item.documentType === DocumentType.TransferOut)
        .map((item) => [item.counterAccountId, item.amount, item.reference]),
    ).toEqual([
      [ids.bank, 100, ""],
      [ids.bank, 200, ""],
    ]);
    expect(items[0]).toMatchObject({
      itemName: "Income from Order #A1",
      reference: "A1",
      date: "2026-03-29",
      categoryAccountId: ids.sales,
      // An import never fills the remark: it is the reviewer's.
      remark: null,
      supplier: "Example Marketplace",
      sectionKey: "orders",
    });

    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes).toMatchObject({ method: "columns", ignoredCount: 0 });
    expect(notes.statedTotal?.minor).toBe(notes.itemsTotalMinor);
    // The group's document date is the one printed beside "To".
    expect(row.date).toBe("2026-03-29");

    // The copy names what was read: the layout, not a schema sent to an AI.
    const snapshot = parseProfileSnapshot(row.profileSnapshot)!;
    expect(snapshot.schemaId).toMatch(
      new RegExp(`^columns:${profileId}:[0-9a-f]{64}$`),
    );
    expect(snapshot.profile.layout).toEqual(walletLayout());
    expect(describeReading({ ...row, profile: snapshot })).toBe(
      "Read with “Wallet report, every transaction” (chosen) · Every transaction · read from columns",
    );
  });

  it("imports both processing and completed withdrawals without profile review flags", async () => {
    const profileId = saveProfile(withdrawalsProfile());
    const row = await run(withProfile(profileId));
    const items = itemsOf(row.id);
    expect(items).toHaveLength(2);
    const [processing, completed] = items;
    expect(processing.checkNote).toBeNull();
    expect(itemAttention(processing, "MYR")).toBeNull();
    expect(completed.checkNote).toBeNull();

    const outcomes = await confirmGroupItems(db, row.id, "all", {
      actingUserId: 1,
      storageRoot,
    });
    expect(outcomes.ok).toBe(true);
    if (!outcomes.ok) return;
    expect(outcomes.value.map((outcome) => [outcome.id, outcome.ok])).toEqual([
      [processing.id, true],
      [completed.id, true],
    ]);
    const records = db
      .select()
      .from(ledgerRecords)
      .where(eq(ledgerRecords.kind, LedgerRecordKind.Transfer))
      .all();
    expect(records).toHaveLength(2);
  });

  it("reads a report the size of the real one: 10 withdrawals, 726 rows left out", async () => {
    const report = walletWorkbook();
    const profileId = saveProfile(withdrawalsProfile());
    const row = await run(withProfile(profileId, report.xlsx));

    const items = itemsOf(row.id);
    expect(items).toHaveLength(10);
    expect(
      items.every((i) => i.documentType === DocumentType.TransferOut),
    ).toBe(true);
    expect(items.filter((item) => item.checkNote)).toHaveLength(0);
    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.statedTotal).toBeNull();
    expect(ignoredSummary(notes)).toBe("Ignored 726 lines (20 shown)");
  });

  // Each of the 736 items goes through the duplicate check, which is slow
  // when the whole suite runs at once, so this test has room for it.
  it("reads every row of a report the size of the real one, with a matching control total", async () => {
    const report = walletWorkbook();
    const all = await run(withProfile(saveProfile(fullProfile()), report.xlsx));
    const items = itemsOf(all.id);
    expect(items).toHaveLength(736);
    expect(
      items.filter((item) => item.documentType === DocumentType.TransferOut),
    ).toHaveLength(10);
    const allNotes = parseExtractionNotes(all.extractionNotes)!;
    expect(allNotes.statedTotal?.minor).toBe(
      report.moneyInMinor + report.moneyOutMinor,
    );
    expect(allNotes.itemsTotalMinor).toBe(allNotes.statedTotal?.minor);
  }, 60_000);

  it("fails, naming the row and column, with no partial group (FR-011)", async () => {
    const profileId = saveProfile(
      fullProfile({ layout: walletLayout({ dateFormat: "DD/MM/YYYY" }) }),
    );
    const row = await run(withProfile(profileId));
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(
      'Row 19, column A ("Date"): "2026-03-29 10:15:02" is not a date written as DD/MM/YYYY.',
    );
    expect(itemsOf(row.id)).toEqual([]);
  });

  it("reads a CSV file by the separator its layout names", async () => {
    const csv = [
      "Date|Transaction Type|Description|Order ID|Money Direction|Amount|Status|Balance After Transactions",
      "2026-03-29|Order Income|Order 1|A1|Money In|12.50|Transaction Completed|0",
      "2026-03-28|Withdrawals|Withdrawal to bank||Money Out|-5.00|Transaction Completed|0",
    ].join("\n");
    const layout = walletLayout({
      documentDateLabel: null,
      statedTotalLabels: {},
      csvDelimiter: "|",
    });
    const good = await run(
      withProfile(saveProfile(fullProfile({ layout })), csv, "wallet.csv"),
    );
    expect(good.state).toBe(ImportState.Grouped);
    expect(itemsOf(good.id).map((item) => item.amount)).toEqual([12.5, 5]);

    // A profile that names a sheet, as one made from a workbook does, reads
    // the CSV file's one sheet all the same (FR-069).
    const named = await run(
      withProfile(
        saveProfile(
          fullProfile({ name: "From a workbook", sheet: "Orders", layout }),
        ),
        csv,
        "wallet-copy.csv",
      ),
    );
    expect(named.error).toBeNull();
    expect(itemsOf(named.id)).toHaveLength(2);

    // Read with another separator, no row has the headings.
    const wrong = await run(
      withProfile(
        saveProfile(
          fullProfile({
            name: "Wrong",
            layout: { ...layout, csvDelimiter: ";" },
          }),
        ),
        csv,
        "wallet.csv",
      ),
    );
    expect(wrong.state).toBe(ImportState.Failed);
    expect(wrong.error).toMatch(
      /^The table of the import profile "Wrong" was not found/,
    );
  });

  it("still asks the AI when a section has no row rules, and needs a provider for it (FR-057)", async () => {
    // One section without row rules is enough: the table layout alone does
    // not say which rows it takes.
    const [first, ...rest] = fullProfile().sections;
    const { rows: _rows, ...withoutRules } = first;
    void _rows;
    const profileId = saveProfile(
      fullProfile({ sections: [withoutRules, ...rest] }),
    );
    const row = await run(
      queueFile("wallet.xlsx", walletReportFixture().xlsx, {
        readAs: ImportReadAs.Profile,
        profileId: String(profileId),
      }),
    );
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(NO_PROVIDERS);
  });

  it("refuses a PDF read with a profile that reads a table, naming why (FR-057)", async () => {
    const profileId = saveProfile(fullProfile());
    const row = await run(
      queueFile("wallet.pdf", "%PDF-1.4 not really", {
        readAs: ImportReadAs.Profile,
        profileId: String(profileId),
      }),
    );
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toContain("reads a spreadsheet's table");
    expect(row.error).toContain("not a spreadsheet");
  });

  it("does not take an item as a duplicate of a record with another reference (FR-063)", async () => {
    // Orders already in the books, on the same day, for the same amounts,
    // from the same marketplace: one is another order, one is this one.
    const marketplace = db
      .insert(contacts)
      .values({
        legalName: "Example Marketplace",
        entityType: EntityType.Business,
      })
      .returning({ id: contacts.id })
      .get().id;
    const order = (reference: string, amount: number) => {
      const created = createRecord(db, 1, {
        kind: "income",
        date: "2026-03-29",
        description: "Earlier order",
        amount,
        currency: "MYR",
        exchangeRate: 1,
        reference,
        contactId: marketplace,
        receivedIntoAccountId: ids.wallet,
        categoryAccountId: ids.sales,
      });
      if (!created.ok) throw new Error(created.reason);
      return created.value.id;
    };
    order("A9", 12.5);
    const same = order("A2", 7.25);
    const profileId = saveProfile(fullProfile());
    const row = await run(withProfile(profileId));
    const [first, second] = itemsOf(row.id);
    expect(first).toMatchObject({ reference: "A1", duplicateOf: null });
    expect(second).toMatchObject({ reference: "A2", duplicateOf: same });
  });
});

// ── Auto-detect ─────────────────────────────────────────────────────────────

describe("Auto-detect on a spreadsheet", () => {
  function auto(data: Buffer = walletReportFixture().xlsx) {
    return queueFile("wallet.xlsx", data, {
      readAs: ImportReadAs.Auto,
      readHow: ImportReadHow.Standard,
    });
  }

  it("uses the one profile whose headings the table has, with no AI (US10 AS12)", async () => {
    const profileId = saveProfile(withdrawalsProfile());
    saveProfile(otherLayoutProfile());
    const row = await run(auto());

    expect(row.state).toBe(ImportState.Grouped);
    expect(row).toMatchObject({
      readHow: ImportReadHow.Detected,
      profileId: String(profileId),
    });
    expect(itemsOf(row.id)).toHaveLength(2);
    expect(parseExtractionNotes(row.extractionNotes)?.method).toBe("columns");
  });

  it("checks fixed phrases across AI profiles before selecting a unique table layout", async () => {
    saveProfile(withdrawalsProfile());
    const chosen = saveProfile({
      ...aiProfile(),
      phrases: ["Transaction Details", "Total Money Out"],
    });
    addProvider();
    const model = serve([
      {
        text: JSON.stringify({
          header: {
            counterparty: "Marketplace",
            date: "2026-03-31",
            reference: null,
            currency: "MYR",
          },
          stated_total: null,
          sections: { withdrawals: [] },
          ignored: [],
        }),
      },
    ]);
    const row = await run(auto());
    expect(row.profileId).toBe(String(chosen));
    expect(row.readHow).toBe(ImportReadHow.Detected);
    // Only extraction uses AI: the fixed phrases decided the profile.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).not.toContain(
      "saved import profiles",
    );
  });

  it("does not let a unique layout bypass ambiguous fixed phrases", async () => {
    saveProfile(withdrawalsProfile({ phrases: ["Total Money In"] }));
    saveProfile({ ...aiProfile(), phrases: ["Total Money In"] });
    const row = await run(auto());
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toMatch(/fixed phrases of several import profiles/);
    expect(itemsOf(row.id)).toEqual([]);
  });

  it("uses AI only among fixed-phrase matches when phrases are ambiguous", async () => {
    const chosen = saveProfile(
      withdrawalsProfile({ phrases: ["Total Money In"] }),
    );
    saveProfile({ ...aiProfile(), phrases: ["Total Money In"] });
    saveProfile(fullProfile({ name: "Unrelated table profile" }));
    addProvider();
    const model = serve([
      { text: JSON.stringify({ profile: String(chosen) }) },
    ]);
    const row = await run(auto());
    expect(row.profileId).toBe(String(chosen));
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Statement read by the AI");
    expect(prompt).not.toContain("Unrelated table profile");
  });

  it("goes on to the recognition phrases when several profiles' headings match", async () => {
    saveProfile(withdrawalsProfile({ phrases: ["Lazada"] }));
    const chosen = saveProfile(
      fullProfile({ phrases: ["Transaction Details", "Total Money Out"] }),
    );
    const row = await run(auto());
    expect(row).toMatchObject({
      state: ImportState.Grouped,
      readHow: ImportReadHow.Detected,
      profileId: String(chosen),
    });
    expect(itemsOf(row.id)).toHaveLength(8);
  });

  it("matches phrases in the cells' words, across two cells", async () => {
    saveProfile(withdrawalsProfile());
    // The phrase spans the label and its figure, two cells apart.
    const chosen = saveProfile(
      fullProfile({ phrases: ["Total Money In 54.15"] }),
    );
    const row = await run(auto());
    expect(row.profileId).toBe(String(chosen));
  });

  it("asks the AI only when headings and phrases do not decide, and a provider is set up", async () => {
    saveProfile(withdrawalsProfile());
    const second = saveProfile(fullProfile());
    addProvider();
    const model = serve([
      { text: JSON.stringify({ profile: String(second) }) },
    ]);
    const row = await run(auto());
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(row.profileId).toBe(String(second));
    // Detected by the AI, read from columns all the same.
    expect(parseExtractionNotes(row.extractionNotes)?.method).toBe("columns");
  });

  it("with no provider, names the profiles whose headings fit rather than read it as a receipt", async () => {
    saveProfile(withdrawalsProfile());
    saveProfile(fullProfile());
    const row = await run(auto());
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(
      // In the order "Read as" lists them: by name.
      severalLayoutsFit([
        { name: "Wallet report, every transaction" },
        { name: "Wallet report, withdrawals only" },
      ]),
    );
  });

  it("with no provider and no headings found, falls to the standard reading, which then needs one", async () => {
    saveProfile(otherLayoutProfile());
    const row = await run(auto());
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(NO_PROVIDERS);
    expect(row.readHow).toBe(ImportReadHow.Standard);
  });

  it("asks the AI among the profiles whose headings fit, even for a spreadsheet too long for a receipt", async () => {
    saveProfile(withdrawalsProfile());
    const second = saveProfile(fullProfile());
    // Read by the AI: no layout, so its headings cannot match.
    saveProfile(aiProfile());
    addProvider();
    const model = serve([
      { text: JSON.stringify({ profile: String(second) }) },
    ]);
    // Past the receipt reading's 6,000 characters, and quick to read.
    const counts = {
      orderIn: 120,
      orderOut: 2,
      adjustIn: 2,
      adjustOut: 1,
      withdrawals: 2,
      processing: 1,
    };
    const row = await run(auto(walletWorkbook(counts).xlsx));

    expect(model.doGenerateCalls).toHaveLength(1);
    const asked = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(asked).toContain("Wallet report, withdrawals only");
    expect(asked).not.toContain("Statement read by the AI");
    expect(row).toMatchObject({
      state: ImportState.Grouped,
      profileId: String(second),
    });
    expect(itemsOf(row.id)).toHaveLength(128);
  });

  it("refuses a long spreadsheet with no AI call when nothing but the standard reading could read it (FR-052)", async () => {
    // A profile read from columns whose headings are not in the file could
    // not read it, so detection has nothing to ask the AI about.
    saveProfile(otherLayoutProfile());
    addProvider();
    const model = serve([{ text: JSON.stringify({ profile: "none" }) }]);
    const row = await run(auto(walletWorkbook().xlsx));
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toMatch(
      /^This spreadsheet is too long to be read as a receipt or invoice/,
    );
  });

  it("detects an Every transaction profile and reads it in its own mode from columns, with no provider (FR-002)", async () => {
    // Auto-detect stores no mode until it finds a profile; the profile's own
    // mode is then stored, and no AI is needed at any step.
    const profileId = saveProfile(withdrawalsProfile());
    const row = await run(
      queueFile("wallet.xlsx", walletReportFixture().xlsx, {
        readAs: ImportReadAs.Auto,
        readHow: ImportReadHow.Standard,
      }),
    );
    expect(row).toMatchObject({
      state: ImportState.Grouped,
      error: null,
      readHow: ImportReadHow.Detected,
      profileId: String(profileId),
      importMode: ImportMode.EveryTransaction,
    });
    expect(itemsOf(row.id)).toHaveLength(2);
    const snapshot = parseProfileSnapshot(row.profileSnapshot)!;
    expect(snapshot.mode).toBe(ImportMode.EveryTransaction);
    expect(describeReading({ ...row, profile: snapshot })).toBe(
      "Read with “Wallet report, withdrawals only” (detected) · Every transaction · read from columns",
    );
  });

  it("never picks by phrases a profile that reads from columns when its headings are not in the sheet", async () => {
    // Both have every phrase in the sheet, but only one could read it: the
    // other's table is not there, and would fail "not found".
    saveProfile({ ...otherLayoutProfile(), phrases: ["Total Money In"] });
    const readable = saveProfile({
      ...aiProfile(),
      phrases: ["Total Money In"],
    });
    const row = await run(auto());
    expect(row).toMatchObject({
      readHow: ImportReadHow.Detected,
      profileId: String(readable),
    });
    // Read by the AI, which is not set up: that, not a missing table, is
    // why it stops.
    expect(row.error).toBe(NO_PROVIDERS);
  });

  it("falls to the standard reading when the only phrase match reads from columns it cannot find", async () => {
    saveProfile({ ...otherLayoutProfile(), phrases: ["Total Money In"] });
    const row = await run(auto());
    expect(row).toMatchObject({
      state: ImportState.Failed,
      readHow: ImportReadHow.Standard,
      profileId: null,
      error: NO_PROVIDERS,
    });
  });

  it("never detects a profile that reads from columns only for a PDF", async () => {
    const pdfText =
      "Wallet report\nTotal Money In 54.15\nTotal Money Out -300.00";
    saveProfile(withdrawalsProfile({ phrases: ["Total Money In"] }));
    const readable = saveProfile({
      ...aiProfile(),
      phrases: ["Total Money In"],
    });
    addProvider();
    const model = serve([
      {
        text: JSON.stringify({
          header: {
            counterparty: "Example Marketplace",
            date: "2026-03-31",
            reference: null,
            currency: "MYR",
          },
          stated_total: null,
          sections: { withdrawals: [] },
          ignored: [],
        }),
      },
    ]);
    const row = await run(
      queueFile("wallet.pdf", "%PDF-1.4 not really", {
        readAs: ImportReadAs.Auto,
        readHow: ImportReadHow.Standard,
        preExtractedText: pdfText,
      }),
    );
    // Found by its phrases alone, with no detection call: the reading is
    // the only call made.
    expect(row).toMatchObject({
      readHow: ImportReadHow.Detected,
      profileId: String(readable),
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).not.toContain(
      "saved import profiles",
    );
  });

  it("refuses a long spreadsheet after the AI finds no profile fits (FR-052)", async () => {
    saveProfile(aiProfile());
    addProvider();
    const model = serve([{ text: JSON.stringify({ profile: "none" }) }]);
    const row = await run(auto(walletWorkbook().xlsx));
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toMatch(
      /^This spreadsheet is too long to be read as a receipt or invoice/,
    );
  });
});

// ── The wallet report profiles and the overlap guard (006 S4.7) ─────────────

describe("the wallet report profiles", () => {
  /** A wallet report draft as the user saves it: both accounts chosen (FR-030). */
  function savedWallet(
    id: "wallet_withdrawals" | "wallet_every_transaction",
    edit: (draft: ProfileInput) => void = () => {},
  ): number {
    const draft = profileDraft(id);
    draft.accountId = ids.wallet;
    for (const section of draft.sections) {
      if (section.kind === "transfer") section.counterAccountId = ids.bank;
    }
    edit(draft);
    return saveProfile(draft);
  }

  it("read in their own mode, Every transaction, with no provider (FR-002)", async () => {
    const profileId = savedWallet("wallet_withdrawals");
    const row = await run(
      queueFile("wallet.xlsx", walletReportFixture().xlsx, {
        readAs: ImportReadAs.Profile,
        profileId: String(profileId),
        // A row queued by a screen from before the mode moved to the
        // profile may still say Summary; the profile's own mode decides.
        importMode: ImportMode.Summary,
      }),
    );
    expect(row).toMatchObject({
      state: ImportState.Grouped,
      error: null,
      importMode: ImportMode.EveryTransaction,
    });
    expect(parseExtractionNotes(row.extractionNotes)?.method).toBe("columns");
  });

  it("both turned on, with no provider, fail naming both and saying to turn one off", async () => {
    savedWallet("wallet_withdrawals");
    savedWallet("wallet_every_transaction");
    const row = await run(
      queueFile("wallet.xlsx", walletReportFixture().xlsx, {
        readAs: ImportReadAs.Auto,
        readHow: ImportReadHow.Standard,
      }),
    );
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(
      severalLayoutsFit([
        { name: "Marketplace wallet report — every transaction" },
        { name: "Marketplace wallet report — withdrawals only" },
      ]),
    );
    expect(row.error).toContain("turn off the ones you do not use");
    expect(row.error).not.toBe(NO_PROVIDERS);
  });

  it("cannot be saved before both accounts are chosen", () => {
    const created = createImportProfile(
      db,
      1,
      profileDraft("wallet_withdrawals"),
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.errors.map((error) => error.path).sort()).toEqual([
      "accountId",
      "sections[0].counterAccountId",
    ]);
  });

  it("reads withdrawals only, with no AI: 10 transfers, 726 left out", async () => {
    const report = walletWorkbook();
    const row = await run(
      withProfile(savedWallet("wallet_withdrawals"), report.xlsx),
    );
    expect(row.state).toBe(ImportState.Grouped);
    const items = itemsOf(row.id);
    expect(items).toHaveLength(10);
    expect(
      items.every(
        (item) =>
          item.documentType === DocumentType.TransferOut &&
          item.accountId === ids.wallet &&
          item.counterAccountId === ids.bank,
      ),
    ).toBe(true);
    expect(items.filter((item) => item.checkNote)).toHaveLength(0);
    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.statedTotal).toBeNull();
    expect(ignoredSummary(notes)).toBe("Ignored 726 lines (20 shown)");
    // The running balance is checked over every row, the ones left out too.
    expect(notes.balance?.matches).toBe(true);
  });

  it("reads every transaction, with a matching control total", async () => {
    const row = await run(withProfile(savedWallet("wallet_every_transaction")));
    const items = itemsOf(row.id);
    expect(items).toHaveLength(walletReportFixture().transactions);
    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.statedTotal?.minor).toBe(notes.itemsTotalMinor);
    expect(notes.balance?.matches).toBe(true);
    expect(
      items
        .filter((item) => item.documentType === DocumentType.TransferOut)
        .map((item) => item.checkNote)
        .filter(Boolean),
    ).toEqual([]);
  });

  describe("the overlap guard (FR-066)", () => {
    /**
     * A record made from a document read with `profileId`, as confirming its
     * one review card leaves it: the queue row names the profile and the
     * record.
     */
    function recordReadWith(profileId: number, date: string) {
      const created = createRecord(db, 1, {
        kind: "income",
        date,
        description: "Sales for the month",
        amount: 999.99,
        currency: "MYR",
        exchangeRate: 1,
        reference: "",
        receivedIntoAccountId: ids.wallet,
        categoryAccountId: ids.sales,
      });
      if (!created.ok) throw new Error(created.reason);
      const statement = queueFile("statement.pdf", "%PDF-1.4", {
        readAs: ImportReadAs.Profile,
        profileId: String(profileId),
        importMode: ImportMode.Summary,
        state: ImportState.Imported,
      });
      db.update(importQueue)
        .set({ resultId: created.value.id })
        .where(eq(importQueue.id, statement.id))
        .run();
      return created.value.id;
    }

    function statementProfile(): number {
      return saveProfile({
        ...profileDraft("marketplace_summary"),
        name: "Income statement",
      });
    }

    it("notes order income in a month the statement's records cover, never a transfer", async () => {
      const statement = statementProfile();
      recordReadWith(statement, "2026-03-31");
      const wallet = savedWallet("wallet_every_transaction", (draft) => {
        draft.sections[0].sameMoneyAs = [statement];
      });
      const row = await run(withProfile(wallet));
      const items = itemsOf(row.id);
      const noted = (item: (typeof items)[number]) =>
        item.checkNote?.includes("Income statement") ?? false;

      const orders = items.filter((item) => item.sectionKey === "order_income");
      expect(orders.length).toBeGreaterThan(0);
      expect(orders.every(noted)).toBe(true);
      expect(orders[0].checkNote).toBe(
        "Records imported with “Income statement” already cover March 2026, and that profile describes the same money. Check that this line is not counted twice before you confirm it.",
      );
      expect(itemAttention(orders[0], "MYR")).toBe(orders[0].checkNote);
      // Adjustments name no other profile; withdrawals are transfers.
      expect(
        items.filter((item) => item.sectionKey !== "order_income").some(noted),
      ).toBe(false);
    });

    it("keeps the note when a category is chosen, so Confirm all still leaves the item behind", async () => {
      const statement = statementProfile();
      recordReadWith(statement, "2026-03-31");
      const wallet = savedWallet("wallet_every_transaction", (draft) => {
        draft.sections[0].sameMoneyAs = [statement];
      });
      const row = await run(withProfile(wallet));
      const orders = itemsOf(row.id).filter(
        (item) =>
          item.sectionKey === "order_income" &&
          item.documentType === DocumentType.Income,
      );
      expect(orders.length).toBeGreaterThan(0);
      const options = { actingUserId: 1, storageRoot };

      // The obvious bulk action on order income, which has no fixed category.
      const filed = setGroupItemsCategory(
        db,
        row.id,
        orders.map((item) => item.id),
        ids.sales,
        options,
      );
      expect(filed.ok && filed.value.every((outcome) => outcome.ok)).toBe(true);
      const filedIds = new Set(orders.map((item) => item.id));
      const after = itemsOf(row.id).filter((item) => filedIds.has(item.id));
      expect(after.every((item) => item.categoryAccountId === ids.sales)).toBe(
        true,
      );
      expect(after.every((item) => item.checkNote?.includes("cover"))).toBe(
        true,
      );
      expect(after.every((item) => itemAttention(item, "MYR"))).toBe(true);

      const outcomes = await confirmGroupItems(db, row.id, "all", options);
      expect(outcomes.ok).toBe(true);
      if (!outcomes.ok) return;
      const left = new Set(
        outcomes.value
          .filter((outcome) => !outcome.ok)
          .map((outcome) => outcome.id),
      );
      expect(orders.every((item) => left.has(item.id))).toBe(true);
      expect(
        itemsOf(row.id)
          .filter((item) => filedIds.has(item.id))
          .every((item) => item.state === ImportState.PendingReview),
      ).toBe(true);
    });

    it("still sees records a group made after the import history is cleared", async () => {
      const options = { actingUserId: 1, storageRoot };
      // The first reading, with no guard, confirms three of its order income
      // lines and skips the rest, so the group finishes and joins the history.
      const first = savedWallet("wallet_every_transaction");
      const firstRow = await run(withProfile(first));
      const firstItems = itemsOf(firstRow.id);
      const confirmed = firstItems
        .filter((item) => item.sectionKey === "order_income")
        .slice(0, 3)
        .map((item) => item.id);
      const done = await confirmGroupItems(db, firstRow.id, confirmed, options);
      expect(done.ok && done.value.every((outcome) => outcome.ok)).toBe(true);
      const months = monthsCoveredBy(db, first, "none");
      expect(months.size).toBeGreaterThan(0);
      skipGroupItems(
        db,
        firstRow.id,
        firstItems
          .map((item) => item.id)
          .filter((id) => !confirmed.includes(id)),
        options,
      );
      expect(job(firstRow.id).state).toBe(ImportState.Imported);
      expect(db.select().from(importRecordProfiles).all()).toHaveLength(3);

      const { DELETE } =
        await import("../../../routes/api/import/history/+server.js");
      const cleared = await DELETE({ locals: { user: { id: 1 } } } as never);
      expect(cleared.status).toBe(204);
      expect(db.select().from(importQueue).all()).toHaveLength(0);
      expect(db.select().from(importItems).all()).toHaveLength(0);
      expect(monthsCoveredBy(db, first, "none")).toEqual(months);

      // A second profile that names the first finds its records all the same.
      const second = savedWallet("wallet_every_transaction", (draft) => {
        draft.name = "Wallet report, read again";
        draft.sections[0].sameMoneyAs = [first];
      });
      const row = await run(withProfile(second));
      const orders = itemsOf(row.id).filter(
        (item) => item.sectionKey === "order_income",
      );
      expect(orders.length).toBeGreaterThan(0);
      expect(
        orders.every((item) => item.checkNote?.includes("already cover")),
      ).toBe(true);
    });

    it("says nothing when the statement's records cover another month, or none exist", async () => {
      const statement = statementProfile();
      recordReadWith(statement, "2026-02-28");
      const wallet = savedWallet("wallet_every_transaction", (draft) => {
        draft.sections[0].sameMoneyAs = [statement];
      });
      const row = await run(withProfile(wallet));
      expect(
        itemsOf(row.id).some((item) =>
          item.checkNote?.includes("Income statement"),
        ),
      ).toBe(false);
    });

    it("leaves out a record deleted since, and one from a document read another way", async () => {
      const statement = statementProfile();
      // Read as a plain receipt: not a reading with the profile.
      const created = createRecord(db, 1, {
        kind: "income",
        date: "2026-03-31",
        description: "Sales",
        amount: 999.99,
        currency: "MYR",
        exchangeRate: 1,
        reference: "",
        receivedIntoAccountId: ids.wallet,
        categoryAccountId: ids.sales,
      });
      if (!created.ok) throw new Error(created.reason);
      const receipt = queueFile("statement.pdf", "%PDF-1.4", {
        readAs: ImportReadAs.Receipt,
        profileId: String(statement),
        state: ImportState.Imported,
      });
      db.update(importQueue)
        .set({ resultId: created.value.id })
        .where(eq(importQueue.id, receipt.id))
        .run();
      const gone = recordReadWith(statement, "2026-03-30");
      db.delete(ledgerRecords).where(eq(ledgerRecords.id, gone)).run();

      const wallet = savedWallet("wallet_every_transaction", (draft) => {
        draft.sections[0].sameMoneyAs = [statement];
      });
      const row = await run(withProfile(wallet));
      expect(
        itemsOf(row.id).some((item) => item.checkNote?.includes("cover")),
      ).toBe(false);
    });

    it("refuses to save a section naming a profile that is gone, or itself", () => {
      const statement = statementProfile();
      const draft = profileDraft("wallet_every_transaction");
      draft.accountId = ids.wallet;
      draft.sections[2].counterAccountId = ids.bank;
      draft.sections[0].sameMoneyAs = [statement + 100];
      const created = createImportProfile(db, 1, draft);
      expect(created.ok === false && created.errors).toEqual([
        {
          path: "sections[0].sameMoneyAs[0]",
          message: "That import profile no longer exists. Remove it.",
        },
      ]);

      draft.sections[0].sameMoneyAs = [statement];
      const saved = createImportProfile(db, 1, draft);
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      draft.sections[0].sameMoneyAs = [saved.value.id];
      const self = updateImportProfile(db, 1, saved.value.id, draft);
      expect(
        self.ok === false && self.errors.map((error) => error.path),
      ).toEqual(["sections[0].sameMoneyAs[0]"]);
    });
  });
});

// ── The table by code, the rest by the AI (006 FR-057) ──────────────────────

describe("reading the table by code and the rest by the AI", () => {
  /** Order rows from the table; a fee printed beside it, by the AI. */
  function hybridProfile(): ProfileInput {
    return fullProfile({
      name: "Wallet report, with its fee",
      sections: [
        ...orderSections({ orders: ids.sales }),
        {
          key: "fees",
          name: "Service fee",
          description: "The monthly service fee printed above the table.",
          kind: "expense",
          fixedCategoryAccountId: null,
          feeTypes: [],
          extras: null,
        },
      ],
    });
  }

  const feeAnswer = {
    header: {
      counterparty: "Someone else",
      date: "2026-03-31",
      reference: "WR-03",
      currency: "MYR",
    },
    stated_total: null,
    sections: {
      fees: [
        {
          description: "Monthly service fee",
          amount: 5,
          date: null,
          reference: null,
          source_line: 2,
        },
      ],
    },
    ignored: [],
  };

  it("never sends the table's rows to the AI, and joins both readings", async () => {
    const profileId = saveProfile(hybridProfile());
    addProvider();
    const model = serve([{ text: JSON.stringify(feeAnswer) }]);
    const row = await run(withProfile(profileId));

    expect(row.error).toBeNull();
    expect(row.state).toBe(ImportState.Grouped);
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).not.toContain("Income from Order #A1");
    expect(prompt).not.toContain("Withdrawal to bank");
    expect(prompt).toContain("Transaction Type");
    expect(prompt).toContain("of the table, read by code, left out here");

    const items = itemsOf(row.id);
    const fee = items.find((item) => item.sectionKey === "fees")!;
    expect(fee).toMatchObject({
      documentType: DocumentType.Expense,
      itemName: "Monthly service fee",
      amount: 5,
    });
    expect(items.filter((item) => item.sectionKey !== "fees")).toHaveLength(6);
    // The layout's other party wins over the AI's.
    expect(fee.supplier).toBe("Example Marketplace");

    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.method).toBe("columns_ai");
    const snapshot = parseProfileSnapshot(row.profileSnapshot)!;
    expect(describeReading({ ...row, profile: snapshot })).toBe(
      "Read with “Wallet report, with its fee” (chosen) · Every transaction · table read from columns, the rest by AI",
    );
  });

  it("sends the AI only the table's own sheet of a workbook with several (FR-069)", async () => {
    const profileId = saveProfile(hybridProfile());
    addProvider();
    const model = serve([{ text: JSON.stringify(feeAnswer) }]);
    const workbook = walletReportFixture([
      { name: "Payout summary", rows: [["OTHER-SHEET-TEXT", { raw: "9.99" }]] },
    ]).xlsx;
    const row = await run(withProfile(profileId, workbook));

    expect(row.state).toBe(ImportState.Grouped);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).not.toContain("OTHER-SHEET-TEXT");
    expect(prompt).toContain("L0001│Sheet: Transaction Report");
    expect(
      itemsOf(row.id).filter((item) => item.sectionKey !== "fees"),
    ).toHaveLength(6);

    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.sheet).toBe("Transaction Report");
    const snapshot = parseProfileSnapshot(row.profileSnapshot)!;
    expect(describeReading({ ...row, profile: snapshot })).toBe(
      "Read with “Wallet report, with its fee” (chosen) · Every transaction · sheet “Transaction Report” · table read from columns, the rest by AI",
    );
  });

  it("needs an AI provider, since the AI reads part of it", async () => {
    const profileId = saveProfile(hybridProfile());
    const row = await run(withProfile(profileId));
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toBe(NO_PROVIDERS);
  });

  it("refuses a PDF, which has no table to read", async () => {
    const profileId = saveProfile(hybridProfile());
    addProvider();
    const model = serve([{ text: JSON.stringify(feeAnswer) }]);
    const row = await run(
      queueFile("wallet.pdf", "%PDF-1.4 not really", {
        readAs: ImportReadAs.Profile,
        profileId: String(profileId),
        preExtractedText: "Wallet report\nMonthly service fee 5.00",
      }),
    );
    expect(row.state).toBe(ImportState.Failed);
    expect(row.error).toContain("not a spreadsheet");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

// ── The reading plan of each kind of profile ────────────────────────────────

describe("the reading plan of each kind", () => {
  /** The order rows from the table, and a fee beside it by the AI. */
  const feeSection = {
    key: "fees",
    name: "Service fee",
    description: "The monthly service fee printed above the table.",
    kind: "expense" as const,
    fixedCategoryAccountId: null,
    feeTypes: [],
    extras: null,
  };

  function planOf(input: ProfileInput, filename = "wallet.xlsx") {
    const id = saveProfile(input);
    const row = queueFile(filename, walletReportFixture().xlsx, {
      readAs: ImportReadAs.Profile,
      profileId: String(id),
    });
    return planForProfile(db, row, id, "chosen");
  }

  it("reads a table by code only, with no AI", () => {
    const planned = planOf(fullProfile({ kind: "table" }));
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.table).not.toBeNull();
    expect(planned.plan.ai).toBeNull();
    expect(needsAi(planned.plan)).toBe(false);
    expect(needsCells(planned.plan)).toBe(true);
  });

  it("reads summary lines by the AI in one call, and transaction lines in pieces", () => {
    const summary = planOf({
      ...aiProfile(),
      name: "Summary",
      kind: "summary",
    });
    const lines = planOf({
      ...aiProfile(),
      name: "Lines",
      kind: "transactions",
    });
    if (!summary.ok || !lines.ok) throw new Error("not planned");
    expect(summary.plan).toMatchObject({ table: null, mode: "summary" });
    expect(summary.plan.ai?.pieces).toBe(false);
    expect(lines.plan.ai?.pieces).toBe(true);
    expect(needsCells(lines.plan)).toBe(false);
  });

  it("reads a mixed profile's table by code and only its other sections by the AI", () => {
    const planned = planOf(
      fullProfile({
        name: "Wallet with fee",
        kind: "mixed",
        // A mixed profile reads in Summary, so its totals are kept there.
        layout: walletLayout({
          statedTotalLabels: { summary: ["Total Money In", "Total Money Out"] },
        }),
        sections: [...orderSections({ orders: ids.sales }), feeSection],
      }),
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.mode).toBe("summary");
    expect(planned.plan.table).not.toBeNull();
    expect(planned.plan.ai?.pieces).toBe(false);
    expect(planned.plan.ai?.reading.sections.map((s) => s.key)).toEqual([
      "fees",
    ]);
    // Every section is made into items, those from the table marked so.
    expect(
      planned.plan.reading.sections.map((s) => [s.key, s.fromTable ?? false]),
    ).toEqual([
      ["orders", true],
      ["adjustments", true],
      ["fees", false],
    ]);
  });

  it("refuses a PDF for a kind that reads a table", () => {
    const planned = planOf(fullProfile({ kind: "table" }), "wallet.pdf");
    expect(planned.ok).toBe(false);
    expect(!planned.ok && planned.reason).toContain("not a spreadsheet");
  });
});
