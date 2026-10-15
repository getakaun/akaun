import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
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

/**
 * Transfer items, end to end (006 US11, FR-058 to FR-060): a profile's
 * transfer section, the reading that turns each line into a transfer out of
 * or into the account the document is about, the duplicate check against
 * transfers already in the books, the group's actions, and the confirm that
 * makes one Transfer record per item.
 *
 * The document is a PDF-like text read with a profile, so none of it waits on
 * spreadsheets. The database is a file under `os.tmpdir()`, migrated from
 * `drizzle/`, and the job's storage folder is there too. No AI provider is
 * called: the one provider gets a mock model that plays back fixed answers.
 * Every figure is made up.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-transfer-items-spec-"));

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
  ImportState,
  LedgerRecordKind,
} = await import("$lib/enums.js");
const { ImportMode, ImportReadAs, parseExtractionNotes } =
  await import("$lib/import-reading.js");
const { checkProfile } = await import("$lib/import-profile-schema.js");
const schema = await import("../db/schema.js");
const {
  accountDefaults,
  auditLog,
  importItems,
  importProfiles,
  importQueue,
  ledgerMovements,
  ledgerRecords,
  recordAttachments,
  users,
} = schema;
const { createAccount } = await import("../services/accounts.js");
const { createRecord } = await import("../services/ledger.js");
const { createImportProfile, getImportProfile } =
  await import("../services/import-profiles.js");
const {
  confirmGroupItem,
  confirmGroupItems,
  setGroupItemsAccount,
  setGroupItemsCategory,
  setGroupSourceAccount,
  updateGroupItem,
} = await import("../services/import-items.js");
const { confirmReviewed } = await import("../services/import.js");
const { insertProvider } = await import("../llmProviders.js");
const { setSetting, SETTING_KEYS } = await import("../settings.js");
const { processImportJob } = await import("./process-job.js");
const { savedReadingProfile } = await import("./profile-compiler.js");
const { itemAttention } = await import("./group-state.js");
const { validateImportAccountPair, validateTransferPair } =
  await import("./account-policy.js");
const { getAccount } = await import("../queries/accounts.js");
const { kindChangeRefusal } = await import("./settle-review.js");
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
  cash: number;
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
    cash: account("Petty cash", AccountType.Asset, AccountSubType.Cash),
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

  insertProvider(db, {
    type: "groq",
    name: "main",
    apiKey: "test-key",
    model: "main-model",
  });
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

/** A wallet report profile: the order income, and the withdrawals to the bank. */
function walletProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "Wallet report",
    description: "A marketplace wallet's list of money in and out.",
    phrases: [],
    instructions: "",
    mode: "summary",
    statedTotalLabels: { summary: "Net change" },
    accountId: ids.wallet,
    sections: [
      {
        key: "orders",
        name: "Order income",
        description: "Each order paid into the wallet.",
        kind: "income",
        fixedCategoryAccountId: ids.sales,
        feeTypes: [],
        extras: null,
      },
      {
        key: "withdrawals",
        name: "Withdrawals",
        description: "Each withdrawal to the bank, and any that came back.",
        kind: "transfer",
        fixedCategoryAccountId: null,
        feeTypes: [],
        extras: null,
        counterAccountId: ids.bank,
      },
    ],
    ...over,
  };
}

/** Only the transfer section of the wallet profile. */
function withdrawalsProfile(over: Partial<ProfileInput> = {}): ProfileInput {
  const base = walletProfile();
  return {
    ...base,
    name: "Withdrawals only",
    statedTotalLabels: {},
    sections: [base.sections[1]],
    ...over,
  };
}

function saveProfile(input: ProfileInput): number {
  const created = createImportProfile(db, 1, input);
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

let jobCount = 0;

function profileJob(profileId: number) {
  const id = `00000000-0000-4000-9100-${String(++jobCount).padStart(12, "0")}`;
  db.insert(importQueue)
    .values({
      id,
      createdBy: 1,
      state: ImportState.Queued,
      tempFilePath: `import/temp/${id}_wallet.pdf`,
      originalFilename: "wallet.pdf",
      fileHash: `hash-${id}`,
      preExtractedText: "Wallet report September\nWithdrawal -500.00",
      readAs: ImportReadAs.Profile,
      profileId: String(profileId),
      importMode: ImportMode.Summary,
    })
    .run();
  return job(id);
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

function serve(replies: Reply[]) {
  const model = mockModel(replies);
  holder.models.set("main", model);
  return model;
}

type Line = Record<string, unknown> & { description: string; amount: number };

/** The model's answer to a reading with the wallet profile. */
function answer(
  sections: Record<string, Line[]>,
  over: { stated?: number | null; currency?: string } = {},
): Reply {
  let line = 1;
  return {
    text: JSON.stringify({
      header: {
        counterparty: "Marketplace Sdn Bhd",
        date: "2026-09-30",
        reference: "WR-2026-09",
        currency: over.currency ?? "MYR",
      },
      stated_total: over.stated ?? null,
      sections: Object.fromEntries(
        Object.entries(sections).map(([key, lines]) => [
          key,
          lines.map((entry) => ({
            date: null,
            reference: null,
            source_line: ++line,
            ...entry,
          })),
        ]),
      ),
      ignored: [],
    }),
  };
}

async function read(profileId: number, reply: Reply) {
  serve([reply]);
  const row = profileJob(profileId);
  await processImportJob(db, row, { storageRoot });
  const read = job(row.id);
  // The group's file, so a confirm can move it as it would a real upload.
  const file = join(storageRoot, read.tempFilePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "%PDF-1.4 wallet report");
  return read;
}

/** A transfer already in the books, as Reconciliation or a person made it. */
function existingTransfer(
  from: number,
  to: number,
  amount: number,
  date: string,
): number {
  const created = createRecord(db, 1, {
    kind: "transfer",
    fromAccountId: from,
    toAccountId: to,
    date,
    description: "Withdrawal",
    amount,
    currency: "MYR",
    exchangeRate: 1,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value.id;
}

function movementsOf(recordId: number) {
  return db
    .select({
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .sort((a, b) => a.amountMinor - b.amountMinor);
}

const options = () => ({ actingUserId: 1, storageRoot });

// ── The profile ─────────────────────────────────────────────────────────────

describe("a profile's transfer section", () => {
  it("passes the shared check with its two accounts, and keeps them", () => {
    const result = checkProfile(walletProfile());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.accountId).toBe(ids.wallet);
    expect(result.profile.sections[1].counterAccountId).toBe(ids.bank);
    // Only a transfer names another account.
    expect(result.profile.sections[0]).not.toHaveProperty("counterAccountId");
  });

  it("needs its other account, and the profile's own account", () => {
    const base = withdrawalsProfile();
    const result = checkProfile({
      ...base,
      accountId: null,
      sections: [{ ...base.sections[0], counterAccountId: null }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain("sections[0].counterAccountId");
    expect(paths).toContain("accountId");
  });

  it("refuses the same account on both sides, a category and fee types", () => {
    const base = withdrawalsProfile();
    const result = checkProfile({
      ...base,
      sections: [
        {
          ...base.sections[0],
          counterAccountId: ids.wallet,
          fixedCategoryAccountId: ids.sales,
          feeTypes: [
            { key: "withdrawal", description: "", categoryAccountId: null },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path).sort()).toEqual([
      "sections[0].counterAccountId",
      "sections[0].feeTypes",
      "sections[0].fixedCategoryAccountId",
    ]);
  });

  it("is saved only when both accounts hold money (FR-058, US11 AS7)", () => {
    const refused = createImportProfile(
      db,
      1,
      walletProfile({ accountId: ids.payable }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.map((error) => error.path)).toEqual(["accountId"]);

    const base = withdrawalsProfile();
    const notMoney = createImportProfile(db, 1, {
      ...base,
      sections: [{ ...base.sections[0], counterAccountId: ids.sales }],
    });
    expect(notMoney.ok).toBe(false);
    if (notMoney.ok) return;
    expect(notMoney.errors.map((error) => error.path)).toEqual([
      "sections[0].counterAccountId",
    ]);
  });

  it("keeps the profile's account and mode in its options, and reads them back", () => {
    const id = saveProfile(walletProfile());
    const row = db
      .select({ optionsJson: importProfiles.optionsJson })
      .from(importProfiles)
      .where(eq(importProfiles.id, id))
      .get();
    expect(JSON.parse(row!.optionsJson)).toEqual({
      accountId: ids.wallet,
      mode: "summary",
      kind: "summary",
    });
    const saved = getImportProfile(db, id)!;
    expect(saved.accountId).toBe(ids.wallet);
    expect(saved.mode).toBe("summary");
    expect(saved.sections[1].counterAccountId).toBe(ids.bank);
  });

  it("never asks the model for a category on a transfer line", () => {
    const id = saveProfile(walletProfile());
    const reading = savedReadingProfile(getImportProfile(db, id)!);
    const transfer = reading.sections.find((s) => s.key === "withdrawals")!;
    expect(transfer.categoryFromModel).toBe(false);
    expect(transfer.counterAccountId).toBe(ids.bank);
    expect(reading.documentAccountId).toBe(ids.wallet);
  });
});

describe("the account rule", () => {
  it("takes two different accounts that hold money, and nothing else", () => {
    const wallet = getAccount(db, ids.wallet)!;
    const bank = getAccount(db, ids.bank)!;
    const sales = getAccount(db, ids.sales)!;
    expect(validateTransferPair(wallet, bank)).toEqual({ ok: true });
    expect(validateTransferPair(wallet, wallet).ok).toBe(false);
    expect(validateTransferPair(wallet, sales).ok).toBe(false);
    // The receipt rule never takes two money accounts, so a receipt can never
    // become a transfer (US11 AS8).
    expect(
      validateImportAccountPair(wallet, bank, ids.payable, ids.receivable).ok,
    ).toBe(false);
  });

  it("keeps a transfer's kind and its way round, wherever the kind is chosen", () => {
    const { Expense, Income, TransferIn, TransferOut } = DocumentType;
    expect(kindChangeRefusal(TransferOut, TransferOut)).toBeNull();
    expect(kindChangeRefusal(Expense, Income)).toBeNull();
    expect(kindChangeRefusal(TransferOut, TransferIn)).toMatch(/which way/);
    expect(kindChangeRefusal(TransferIn, TransferOut)).toMatch(/which way/);
    expect(kindChangeRefusal(TransferOut, Expense)).not.toBeNull();
    expect(kindChangeRefusal(Income, TransferIn)).not.toBeNull();
  });
});

// ── Reading ─────────────────────────────────────────────────────────────────

describe("reading a transfer section", () => {
  it("reads a minus as money out of the profile's account and a plus as money into it", async () => {
    const id = saveProfile(
      withdrawalsProfile({ statedTotalLabels: { summary: "Total withdrawn" } }),
    );
    const row = await read(
      id,
      answer(
        {
          withdrawals: [
            {
              description: "Withdrawal to bank",
              amount: -500,
              date: "2026-09-05",
            },
            {
              description: "Withdrawal to bank",
              amount: -250.5,
              date: "2026-09-12",
            },
            {
              description: "Withdrawal returned",
              amount: 100,
              date: "2026-09-13",
            },
          ],
        },
        { stated: -650.5 },
      ),
    );

    expect(row.state).toBe(ImportState.Grouped);
    const items = itemsOf(row.id);
    expect(
      items.map((item) => [
        item.documentType,
        item.amount,
        item.accountId,
        item.counterAccountId,
      ]),
    ).toEqual([
      [DocumentType.TransferOut, 500, ids.wallet, ids.bank],
      [DocumentType.TransferOut, 250.5, ids.wallet, ids.bank],
      [DocumentType.TransferIn, 100, ids.wallet, ids.bank],
    ]);
    // No other party and no category (US11 AS2).
    for (const item of items) {
      expect(item.supplier).toBeNull();
      expect(item.matchedContactId).toBeNull();
      expect(item.category).toBeNull();
      expect(item.categoryAccountId).toBeNull();
      expect(itemAttention(item, "MYR")).toBeNull();
    }
    // Out counts as minus and in as plus, to the cent (FR-013).
    const notes = parseExtractionNotes(row.extractionNotes)!;
    expect(notes.itemsTotalMinor).toBe(-65050);
    expect(notes.statedTotal).toEqual({ minor: -65050, currency: "MYR" });
  });

  it("starts the profile's income items on its account, not on Accounts receivable (US11 AS6)", async () => {
    const id = saveProfile(walletProfile());
    const row = await read(
      id,
      answer({
        orders: [
          { description: "Order 1001", amount: 80 },
          { description: "Order 1002", amount: 45.2 },
        ],
        withdrawals: [{ description: "Withdrawal", amount: -125.2 }],
      }),
    );
    const items = itemsOf(row.id);
    expect(items.map((item) => [item.documentType, item.accountId])).toEqual([
      [DocumentType.Income, ids.wallet],
      [DocumentType.Income, ids.wallet],
      [DocumentType.TransferOut, ids.wallet],
    ]);
    expect(items[0].categoryAccountId).toBe(ids.sales);
  });

  it("reviews a document with one transfer as a card, which confirms as a transfer", async () => {
    const id = saveProfile(withdrawalsProfile());
    const row = await read(
      id,
      answer({ withdrawals: [{ description: "Withdrawal", amount: -300 }] }),
    );
    expect(row.state).toBe(ImportState.PendingReview);
    expect(row.documentType).toBe(DocumentType.TransferOut);
    expect(row.accountId).toBe(ids.wallet);
    expect(row.counterAccountId).toBe(ids.bank);

    // The card sends both sides, the money moving from the first to the second.
    const confirmed = await confirmReviewed(
      db,
      {
        jobId: row.id,
        uploadedBy: 1,
        tempFilePath: row.tempFilePath,
        extractedText: row.extractedText,
        readAt: row.processedAt,
      },
      row,
      { fromAccountId: ids.wallet, toAccountId: ids.cash },
      options(),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const record = confirmed.value.record;
    expect(record.kind).toBe(LedgerRecordKind.Transfer);
    expect(movementsOf(record.id)).toEqual([
      { accountId: ids.wallet, amountMinor: -30000 },
      { accountId: ids.cash, amountMinor: 30000 },
    ]);
    const done = job(row.id);
    expect(done.state).toBe(ImportState.Imported);
    expect(done.resultType).toBe(DocumentType.TransferOut);
    expect(done.counterAccountId).toBe(ids.cash);
  });
});

// ── Duplicates ──────────────────────────────────────────────────────────────

describe("a transfer already in the books (FR-060)", () => {
  it("flags the item it repeats, one item per transfer, the same way round only", async () => {
    // Made earlier, for example in Reconciliation: wallet to bank, 500.00,
    // three days after the first withdrawal of that amount.
    const existing = existingTransfer(ids.wallet, ids.bank, 500, "2026-09-08");
    // Money back into the wallet: the other way round, so it repeats nothing.
    existingTransfer(ids.bank, ids.wallet, 250.5, "2026-09-12");
    // Same accounts and amount, but eight days from any withdrawal.
    existingTransfer(ids.wallet, ids.bank, 75, "2026-09-28");

    const id = saveProfile(withdrawalsProfile());
    const row = await read(
      id,
      answer({
        withdrawals: [
          { description: "Withdrawal A", amount: -500, date: "2026-09-05" },
          { description: "Withdrawal B", amount: -500, date: "2026-09-09" },
          { description: "Withdrawal C", amount: -250.5, date: "2026-09-12" },
          { description: "Withdrawal D", amount: -75, date: "2026-09-20" },
        ],
      }),
    );

    const items = itemsOf(row.id);
    // B is a day from the existing transfer and A three days, so B takes it,
    // and A, a real withdrawal not in the books yet, stays ready.
    expect(items.map((item) => item.duplicateOf)).toEqual([
      null,
      existing,
      null,
      null,
    ]);
    expect(JSON.parse(items[1].duplicateReasons!)).toEqual([
      "amount",
      "accounts",
    ]);
    expect(items[1].duplicateConfidence).toBe(95);
    expect(itemAttention(items[1], "MYR")).toMatch(/already be in the books/);
  });

  it("flags every item an existing transfer can account for, not only the nearest", async () => {
    // A could be T1 (a day) or T2 (six days); B can only be T1, since T2 is
    // eight days from it. Giving T1 to A first would leave B unflagged and
    // T2 unused, so Confirm all would book T1 a second time.
    const t1 = existingTransfer(ids.wallet, ids.bank, 500, "2026-09-11");
    const t2 = existingTransfer(ids.wallet, ids.bank, 500, "2026-09-04");

    const id = saveProfile(withdrawalsProfile());
    const row = await read(
      id,
      answer({
        withdrawals: [
          { description: "Withdrawal A", amount: -500, date: "2026-09-10" },
          { description: "Withdrawal B", amount: -500, date: "2026-09-12" },
        ],
      }),
    );

    const items = itemsOf(row.id);
    expect(items.map((item) => item.duplicateOf)).toEqual([t2, t1]);
    expect(items.map((item) => item.duplicateConfidence)).toEqual([70, 95]);
  });
});

// ── Confirming ──────────────────────────────────────────────────────────────

describe("confirming transfer items", () => {
  it("makes one Transfer record per item, attached and audited, and leaves a possible duplicate", async () => {
    const existing = existingTransfer(ids.wallet, ids.bank, 500, "2026-09-05");
    const id = saveProfile(withdrawalsProfile());
    const row = await read(
      id,
      answer({
        withdrawals: [
          { description: "Withdrawal 1", amount: -500, date: "2026-09-05" },
          { description: "Withdrawal 2", amount: -320, date: "2026-09-15" },
          { description: "Returned", amount: 40, date: "2026-09-16" },
        ],
      }),
    );

    const run = await confirmGroupItems(db, row.id, "all", options());
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.map((outcome) => outcome.ok)).toEqual([false, true, true]);
    expect(run.value[0].reason).toMatch(/already be in the books/);

    const made = db
      .select()
      .from(ledgerRecords)
      .all()
      .filter((record) => record.id !== existing);
    expect(
      made.map((record) => [record.kind, record.amount, record.contactId]),
    ).toEqual([
      [LedgerRecordKind.Transfer, 320, null],
      [LedgerRecordKind.Transfer, 40, null],
    ]);
    expect(movementsOf(made[0].id)).toEqual([
      { accountId: ids.wallet, amountMinor: -32000 },
      { accountId: ids.bank, amountMinor: 32000 },
    ]);
    // Into the wallet, from the bank.
    expect(movementsOf(made[1].id)).toEqual([
      { accountId: ids.bank, amountMinor: -4000 },
      { accountId: ids.wallet, amountMinor: 4000 },
    ]);
    for (const record of made) {
      const attached = db
        .select()
        .from(recordAttachments)
        .where(eq(recordAttachments.recordId, record.id))
        .all();
      expect(attached).toHaveLength(1);
      const audited = db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.recordType, "record"),
            eq(auditLog.recordId, record.id),
          ),
        )
        .all();
      expect(audited.map((entry) => entry.action)).toEqual(["create"]);
    }
    const items = itemsOf(row.id);
    expect(items.map((item) => [item.state, item.resultType])).toEqual([
      [ImportState.PendingReview, null],
      [ImportState.Imported, DocumentType.TransferOut],
      [ImportState.Imported, DocumentType.TransferIn],
    ]);

    // "Import anyway" on the flagged one makes it too.
    const anyway = await confirmGroupItem(db, row.id, items[0].id, options());
    expect(anyway.ok).toBe(true);
    expect(job(row.id).state).toBe(ImportState.Imported);
  });

  it("leaves a transfer in another currency behind, saying why (FR-059, C11)", async () => {
    const id = saveProfile(withdrawalsProfile());
    const row = await read(
      id,
      answer(
        {
          withdrawals: [
            { description: "Withdrawal 1", amount: -100 },
            { description: "Withdrawal 2", amount: -200 },
          ],
        },
        { currency: "USD" },
      ),
    );
    const items = itemsOf(row.id);
    expect(itemAttention(items[0], "MYR")).toMatch(/recorded in MYR only/);

    const run = await confirmGroupItems(db, row.id, "all", options());
    expect(run.ok && run.value.every((outcome) => !outcome.ok)).toBe(true);
    const one = await confirmGroupItem(db, row.id, items[0].id, options());
    expect(one.ok).toBe(false);
    if (one.ok) return;
    expect(one.reason).toMatch(/recorded in MYR only, and this one is in USD/);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);

    // Corrected to the main currency, it goes through.
    const fixed = updateGroupItem(
      db,
      row.id,
      items[0].id,
      { currency: "MYR" },
      options(),
    );
    expect(fixed.ok).toBe(true);
    const again = await confirmGroupItem(db, row.id, items[0].id, options());
    expect(again.ok).toBe(true);
  });
});

// ── The group's actions ─────────────────────────────────────────────────────

describe("the group's actions on transfers", () => {
  async function mixedGroup() {
    const id = saveProfile(walletProfile());
    return read(
      id,
      answer({
        orders: [{ description: "Order 1001", amount: 80 }],
        withdrawals: [
          { description: "Withdrawal", amount: -60 },
          { description: "Returned", amount: 20 },
        ],
      }),
    );
  }

  it("moves the document's side of every transfer with the group's Source account", async () => {
    const row = await mixedGroup();
    const set = setGroupSourceAccount(db, row.id, ids.cash, options());
    expect(set.ok && set.value.every((outcome) => outcome.ok)).toBe(true);
    expect(
      itemsOf(row.id).map((item) => [
        item.documentType,
        item.accountId,
        item.counterAccountId,
      ]),
    ).toEqual([
      [DocumentType.Income, ids.cash, null],
      [DocumentType.TransferOut, ids.cash, ids.bank],
      [DocumentType.TransferIn, ids.cash, ids.bank],
    ]);
  });

  it("keeps a transfer's own side when the group's account is its other account", async () => {
    const row = await mixedGroup();
    const set = setGroupSourceAccount(db, row.id, ids.bank, options());
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.map((outcome) => outcome.ok)).toEqual([
      true,
      false,
      false,
    ]);
    expect(itemsOf(row.id).map((item) => item.accountId)).toEqual([
      ids.bank,
      ids.wallet,
      ids.wallet,
    ]);
    // The bulk "Account" action follows the same rule.
    const bulk = setGroupItemsAccount(
      db,
      row.id,
      "all",
      ids.payable,
      options(),
    );
    expect(bulk.ok && bulk.value.map((outcome) => outcome.ok)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("files no category on a transfer", async () => {
    const row = await mixedGroup();
    const filed = setGroupItemsCategory(
      db,
      row.id,
      "all",
      ids.sales,
      options(),
    );
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    expect(filed.value.map((outcome) => outcome.ok)).toEqual([
      true,
      false,
      false,
    ]);
    expect(filed.value[1].reason).toMatch(/A transfer has no category/);
  });

  it("changes a transfer's accounts within the rule, and never its kind", async () => {
    const row = await mixedGroup();
    const [income, out] = itemsOf(row.id);

    // Both sides, as the card sends them: from the wallet to petty cash.
    const moved = updateGroupItem(
      db,
      row.id,
      out.id,
      { fromAccountId: ids.wallet, toAccountId: ids.cash },
      options(),
    );
    expect(moved.ok).toBe(true);
    expect(itemsOf(row.id)[1].counterAccountId).toBe(ids.cash);

    // One side alone.
    expect(
      updateGroupItem(
        db,
        row.id,
        out.id,
        { counterAccountId: ids.bank },
        options(),
      ).ok,
    ).toBe(true);
    expect(itemsOf(row.id)[1].counterAccountId).toBe(ids.bank);

    const refusals = [
      { counterAccountId: ids.wallet },
      { counterAccountId: ids.sales },
      { fromAccountId: ids.wallet, toAccountId: ids.sales },
      { category: "Sales" },
      { supplier: "Someone" },
      { document_type: "expense" },
      // Nor turned round: the sign on the document says which way it went.
      { document_type: "transfer_in" },
    ];
    for (const overrides of refusals) {
      const result = updateGroupItem(db, row.id, out.id, overrides, options());
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
    }
    // Nor does an income become a transfer, or take another account.
    expect(
      updateGroupItem(
        db,
        row.id,
        income.id,
        { document_type: "transfer_out" },
        options(),
      ).ok,
    ).toBe(false);
    expect(
      updateGroupItem(
        db,
        row.id,
        income.id,
        { counterAccountId: ids.bank },
        options(),
      ).ok,
    ).toBe(false);
  });
});

// ── A receipt ───────────────────────────────────────────────────────────────

describe("a receipt read the standard way (US11 AS8)", () => {
  function receiptRow() {
    const id = "00000000-0000-4000-9200-000000000001";
    db.insert(importQueue)
      .values({
        id,
        createdBy: 1,
        state: ImportState.PendingReview,
        tempFilePath: `import/temp/${id}_receipt.pdf`,
        originalFilename: "receipt.pdf",
        documentType: DocumentType.Expense,
        itemName: "Paper",
        supplier: "Stationery Sdn Bhd",
        amount: 12.5,
        currency: "MYR",
        exchangeRate: 1,
        date: "2026-09-14",
        accountId: ids.payable,
        processedAt: "2026-09-14T10:00:00.000Z",
      })
      .run();
    return job(id);
  }

  it("never becomes a transfer, by its kind or by two money accounts", async () => {
    const row = receiptRow();
    const source = {
      jobId: row.id,
      uploadedBy: 1,
      tempFilePath: row.tempFilePath,
      extractedText: null,
      readAt: row.processedAt,
    };
    const byKind = await confirmReviewed(
      db,
      source,
      row,
      { document_type: "transfer_out" },
      options(),
    );
    expect(byKind.ok).toBe(false);
    const byCode = await confirmReviewed(
      db,
      source,
      row,
      { document_type: DocumentType.TransferIn },
      options(),
    );
    expect(byCode.ok).toBe(false);
    const byAccounts = await confirmReviewed(
      db,
      source,
      row,
      { fromAccountId: ids.wallet, toAccountId: ids.bank },
      options(),
    );
    expect(byAccounts.ok).toBe(false);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(job(row.id).state).toBe(ImportState.PendingReview);
  });
});
