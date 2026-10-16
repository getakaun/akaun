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
import {
  AccountSubType,
  AccountType,
  DocumentType,
  ImportState,
} from "$lib/enums.js";

/**
 * Confirming a reviewed document (`confirmImportRow`).
 *
 * The database is an in-memory copy migrated from `drizzle/`, and every file
 * lives under a storage root in `os.tmpdir()`. The configured storage path is
 * mocked too, so a call that forgot to pass the root would still land in the
 * sandbox and not in `data/storage`. Nothing in the database layer is mocked.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-import-confirm-spec-"));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return join(sandbox, "default-root");
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

const schema = await import("../db/schema.js");
const { contacts, importQueue, ledgerRecords, recordAttachments, users } =
  schema;
const { createAccount } = await import("./accounts.js");
const { confirmImportRow } = await import("./import.js");
const { fileExists } = await import("../file-storage.js");
const { accountEvents, ledgerEvents } = await import("../ledger/events.js");
const { importEvents } = await import("../import/events.js");
type LedgerDb = import("../ledger/types.js").LedgerDb;
type ImportReviewFields = import("./import.js").ImportReviewFields;

const userId = 1;
const jobId = "5f0c9a52-6f5e-4c1e-9d38-3e1e0b7c2a11";
const temp = `import/temp/${jobId}_receipt.pdf`;
const dest = `records/2026/08/${jobId}_receipt.pdf`;

let sqlite: Database;
let db: LedgerDb;
let root: string;
let bankId: number;
let categoryId: number;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  root = mkdtempSync(join(sandbox, "root-"));

  const bank = createAccount(db, userId, {
    name: "Maybank",
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  });
  const category = createAccount(db, userId, {
    name: "Office Supplies",
    type: AccountType.Expense,
  });
  if (!bank.ok) throw new Error(bank.reason);
  if (!category.ok) throw new Error(category.reason);
  bankId = bank.value.id;
  categoryId = category.value.id;

  queueJob();
  putFile(temp);
});
afterEach(() => {
  for (const stop of stopListening.splice(0)) stop();
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

function queueJob() {
  db.insert(importQueue)
    .values({
      id: jobId,
      createdBy: userId,
      state: ImportState.PendingReview,
      tempFilePath: temp,
      originalFilename: "receipt.pdf",
      documentType: DocumentType.Expense,
      extractedText: "RECEIPT 12.50",
    })
    .run();
}

function fields(over: Partial<ImportReviewFields> = {}): ImportReviewFields {
  return {
    documentType: DocumentType.Expense,
    description: "Printer paper",
    partyName: "Stationery Sdn Bhd",
    partyEdited: false,
    date: "2026-08-14",
    amount: 12.5,
    currency: "MYR",
    exchangeRate: 1,
    reference: "INV-1",
    category: "",
    categoryAccountId: null,
    remark: "",
    accountId: null,
    sides: { fromAccountId: bankId, toAccountId: categoryId },
    matchedContact: null,
    ...over,
  };
}

function confirm(over: Partial<ImportReviewFields> = {}) {
  return confirmImportRow(
    db,
    {
      jobId,
      uploadedBy: userId,
      tempFilePath: temp,
      extractedText: "RECEIPT 12.50",
    },
    fields(over),
    { actingUserId: userId, storageRoot: root },
  );
}

function job() {
  return db.select().from(importQueue).where(eq(importQueue.id, jobId)).get()!;
}

const count = {
  records: () => db.select().from(ledgerRecords).all().length,
  attachments: () => db.select().from(recordAttachments).all().length,
  contacts: () => db.select().from(contacts).all().length,
};

const stopListening: (() => void)[] = [];

/** Every event the confirm sends, and whether a transaction was open then. */
function recordEvents() {
  const seen: { name: string; inTransaction: boolean; payload: unknown }[] = [];
  const pairs = [
    [ledgerEvents, "record-update"],
    [accountEvents, "account-update"],
    [importEvents, "job-update"],
  ] as const;
  for (const [emitter, name] of pairs) {
    const listener = (payload: unknown) => {
      seen.push({ name, inTransaction: sqlite.inTransaction, payload });
    };
    emitter.on(name, listener);
    stopListening.push(() => emitter.off(name, listener));
  }
  return seen;
}

describe("confirmImportRow", () => {
  it("creates the record, attaches the moved file and marks the job Imported", () => {
    const result = confirm();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = db.select().from(ledgerRecords).get()!;
    expect(result.value.record.id).toBe(record.id);
    expect(result.value.uncategorised).toBe(false);
    expect(record.description).toBe("Printer paper");
    expect(record.extractedText).toBe("RECEIPT 12.50");

    const attachment = db.select().from(recordAttachments).get()!;
    expect(attachment.recordId).toBe(record.id);
    expect(attachment.filename).toBe(dest);
    expect(attachment.displayName).toBe("receipt.pdf");
    expect(fileExists(dest, root)).toBe(true);
    expect(fileExists(temp, root)).toBe(false);

    const row = job();
    expect(row.state).toBe(ImportState.Imported);
    expect(row.resultId).toBe(record.id);
    expect(row.resultType).toBe(DocumentType.Expense);
    expect(row.accountId).toBe(bankId);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();

    // The party name as read became the record's contact.
    expect(count.contacts()).toBe(1);
    expect(record.contactId).not.toBeNull();
  });

  it("leaves nothing behind when the record is refused", () => {
    const before = count.contacts();
    const seen = recordEvents();

    // An amount of nothing is refused by the entry builder, which runs after
    // the new contact would have been created.
    const result = confirm({ amount: 0, newContactName: "Brand New Co" });

    expect(result).toEqual({
      ok: false,
      reason: "Enter an amount greater than zero.",
    });
    expect(count.records()).toBe(0);
    expect(count.attachments()).toBe(0);
    expect(count.contacts()).toBe(before);
    const row = job();
    expect(row.state).toBe(ImportState.PendingReview);
    expect(row.confirmedAt).toBeNull();
    expect(row.resultId).toBeNull();
    // The file was never moved, so review can still show it.
    expect(fileExists(temp, root)).toBe(true);
    expect(fileExists(dest, root)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("does not create a second record when the same job is confirmed twice", () => {
    const first = confirm();
    expect(first.ok).toBe(true);

    const second = confirm();
    expect(second.ok).toBe(false);
    expect(count.records()).toBe(1);
    expect(count.attachments()).toBe(1);
    expect(job().state).toBe(ImportState.Imported);
  });

  it("refuses a job another request claimed while this one waited", () => {
    db.update(importQueue)
      .set({ state: ImportState.Confirmed })
      .where(eq(importQueue.id, jobId))
      .run();
    const seen = recordEvents();

    const result = confirm();

    expect(result.ok).toBe(false);
    expect(count.records()).toBe(0);
    expect(count.contacts()).toBe(0);
    expect(fileExists(temp, root)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("sends its events only after the transaction has committed", () => {
    const seen = recordEvents();

    const result = confirm();
    expect(result.ok).toBe(true);

    const names = seen.map((e) => e.name);
    expect(names).toContain("record-update");
    expect(names).toContain("account-update");
    expect(names.at(-1)).toBe("job-update");
    expect(seen.every((e) => !e.inTransaction)).toBe(true);

    // One record-update, sent once the attachment was already on the record.
    const recordUpdates = seen.filter((e) => e.name === "record-update");
    expect(recordUpdates).toHaveLength(1);
    const { record } = recordUpdates[0].payload as {
      record: { attachmentCount: number };
    };
    expect(record.attachmentCount).toBe(1);

    const { job: sent } = seen.at(-1)!.payload as {
      job: { state: number };
    };
    expect(sent.state).toBe(ImportState.Imported);
    // The document text stays in the table and is not sent to every open tab.
    expect(sent).not.toHaveProperty("extractedText");
    expect(sent).not.toHaveProperty("preExtractedText");
  });

  it("puts the file back when the transaction fails after the move", () => {
    // Make the attachment insert fail, which happens after the file is moved.
    sqlite.run(
      `CREATE TRIGGER refuse_attachment BEFORE INSERT ON record_attachments
       BEGIN SELECT RAISE(ABORT, 'attachment refused'); END;`,
    );
    const seen = recordEvents();

    expect(() => confirm()).toThrow("attachment refused");

    expect(count.records()).toBe(0);
    expect(count.contacts()).toBe(0);
    expect(job().state).toBe(ImportState.PendingReview);
    expect(fileExists(temp, root)).toBe(true);
    expect(fileExists(dest, root)).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("contra revenue confirmation", () => {
  it.each([true, false])(
    "posts asset-to-contra and preserves provenance (explicit sides: %s)",
    (explicitSides) => {
      const source = createAccount(db, userId, {
        name: "Shopee clearing",
        type: AccountType.Asset,
        subType: AccountSubType.Clearing,
      });
      const target = createAccount(db, userId, {
        name: "Discounts",
        type: AccountType.Revenue,
        subType: AccountSubType.ContraOperatingRevenue,
      });
      if (!source.ok || !target.ok) throw new Error("Account setup failed");
      const result = confirm({
        documentType: DocumentType.Expense,
        amount: 100,
        sides: explicitSides
          ? { fromAccountId: source.value.id, toAccountId: target.value.id }
          : null,
        categoryAccountId: target.value.id,
        accountId: source.value.id,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(
        result.value.record.movements.map((m) => [m.accountId, m.amountMinor]),
      ).toEqual([
        [target.value.id, 10000],
        [source.value.id, -10000],
      ]);
      expect(job().accountId).toBe(source.value.id);
      expect(job().resultType).toBe(DocumentType.Expense);
      expect(count.attachments()).toBe(1);
      expect(confirm().ok).toBe(false);
      expect(count.records()).toBe(1);
    },
  );

  it.each([true, false])(
    "rejects revenue-to-contra even without explicit sides (%s)",
    (explicitSides) => {
      const source = createAccount(db, userId, {
        name: "Sales",
        type: AccountType.Revenue,
      });
      const target = createAccount(db, userId, {
        name: "Discounts",
        type: AccountType.Revenue,
        subType: AccountSubType.ContraOtherRevenue,
      });
      if (!source.ok || !target.ok) throw new Error("Account setup failed");
      expect(
        confirm({
          documentType: DocumentType.Income,
          amount: 100,
          sides: explicitSides
            ? { fromAccountId: source.value.id, toAccountId: target.value.id }
            : null,
          categoryAccountId: source.value.id,
          accountId: target.value.id,
        }).ok,
      ).toBe(false);
      expect(count.records()).toBe(0);
      expect(job().state).toBe(ImportState.PendingReview);
    },
  );
});
