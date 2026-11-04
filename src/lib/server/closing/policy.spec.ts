import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType, LedgerRecordKind } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  accounts,
  appSequences,
  ledgerMovements,
  ledgerRecords,
  users,
} from "../db/schema.js";
import type { LedgerDb, MovementDraft } from "../ledger/types.js";
import {
  addAttachment,
  deleteAttachment,
  deleteRecord,
  getRecord,
  insertRecord,
  listAttachments,
  listRecords,
  setExtractedText,
  updateRecord,
} from "../queries/ledger.js";
import { getSetting, SETTING_KEYS, setSetting } from "../settings.js";
import {
  assertDatesOpen,
  assertNoClosedHistory,
  closedThrough,
  ClosedPeriodError,
  closedPeriodReason,
  isClosedPeriodError,
} from "./policy.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let category: number;
let anotherCategory: number;
const closeKey = SETTING_KEYS.accountingClosedThrough;
const sides = (): MovementDraft[] => [
  { accountId: bank, amountMinor: -5000, sortOrder: 0, label: null },
  { accountId: category, amountMinor: 5000, sortOrder: 1, label: null },
];
function add(date = "2026-10-15", movements = sides()) {
  return insertRecord(
    db,
    1,
    {
      kind: LedgerRecordKind.Expense,
      date,
      description: "Stationery",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
    },
    movements,
  );
}
function movements() {
  return db.select().from(ledgerMovements).all();
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(users)
    .values({
      id: 1,
      email: "close@test",
      username: "close",
      passwordHash: "x",
    })
    .run();
  db.insert(schema.contacts)
    .values({ id: 2, legalName: "Another supplier", entityType: 2 })
    .run();
  bank = db
    .insert(accounts)
    .values({
      name: "Bank",
      rank: "a",
      type: AccountType.Asset,
      role: 1,
      subType: AccountSubType.Bank,
    })
    .returning()
    .get()!.id;
  category = db
    .insert(accounts)
    .values({ name: "Office", rank: "b", type: AccountType.Expense, role: 7 })
    .returning()
    .get()!.id;
  anotherCategory = db
    .insert(accounts)
    .values({ name: "Travel", rank: "c", type: AccountType.Expense, role: 7 })
    .returning()
    .get()!.id;
});
afterEach(() => sqlite.close());

describe("accounting close at the shared ledger write boundary", () => {
  it("refuses insert on the inclusive boundary without consuming a number", () => {
    setSetting(db, closeKey, "2026-10-31");
    expect(() => add("2026-10-31")).toThrow(/closed/i);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(db.select().from(appSequences).all()).toHaveLength(0);
  });
  it("allows the first open date", () => {
    setSetting(db, closeKey, "2026-10-31");
    expect(add("2026-11-01").date).toBe("2026-11-01");
    expect(movements()).toHaveLength(2);
  });
  it("checks both original and proposed dates", () => {
    const old = add();
    const next = add("2026-11-01");
    setSetting(db, closeKey, "2026-10-31");
    expect(() => updateRecord(db, old.id, 1, { date: "2026-11-01" })).toThrow(
      /closed/i,
    );
    expect(() => updateRecord(db, next.id, 1, { date: "2026-10-31" })).toThrow(
      /closed/i,
    );
    expect(
      db
        .select()
        .from(ledgerRecords)
        .all()
        .map((r) => r.date),
    ).toEqual(["2026-10-15", "2026-11-01"]);
  });
  it("refuses recategorization even when the entered amount is unchanged", () => {
    const record = add();
    const before = movements();
    setSetting(db, closeKey, "2026-10-31");
    expect(() =>
      updateRecord(db, record.id, 1, { description: "Must roll back" }, [
        sides()[0],
        { ...sides()[1], accountId: anotherCategory },
      ]),
    ).toThrow(/closed/i);
    expect(movements()).toEqual(before);
    expect(db.select().from(ledgerRecords).get()!.description).toBe(
      "Stationery",
    );
  });
  it.each([
    ["amount", 51],
    ["currency", "EUR"],
    ["exchangeRate", 1.1],
    ["contactId", 2],
    ["supplierContactId", 2],
    ["expensePaymentSource", "personal"],
  ] as const)("refuses changed financial field %s", (field, value) => {
    const record = add();
    setSetting(db, closeKey, "2026-10-31");
    expect(() => updateRecord(db, record.id, 1, { [field]: value })).toThrow(
      /closed/i,
    );
  });
  it.each([
    { description: "Paper and pens" },
    { reference: "Receipt 12" },
    { remark: "Reviewed" },
    { extractedText: "New OCR text" },
    { amount: 50, date: "2026-10-15" },
    {},
  ])("freezes every field including unchanged patches: %j", (patch) => {
    const record = add();
    const before = db.select().from(ledgerRecords).all();
    const beforeMovements = movements();
    setSetting(db, closeKey, "2026-10-31");
    expect(() => updateRecord(db, record.id, 1, patch)).toThrow(/closed/i);
    expect(db.select().from(ledgerRecords).all()).toEqual(before);
    expect(movements()).toEqual(beforeMovements);
    setSetting(db, closeKey, "");
    expect(updateRecord(db, record.id, 1, patch)?.id).toBe(record.id);
  });
  it("freezes movement labels until reopening", () => {
    const record = add();
    const before = movements();
    const labeled = sides().map((side) => ({ ...side, label: "Detail" }));
    setSetting(db, closeKey, "2026-10-31");
    expect(() => updateRecord(db, record.id, 1, {}, labeled)).toThrow(
      /closed/i,
    );
    expect(movements()).toEqual(before);
    setSetting(db, closeKey, "");
    updateRecord(db, record.id, 1, {}, labeled);
    expect(movements().map((m) => m.label)).toEqual(["Detail", "Detail"]);
  });
  it("freezes attachment additions and removals until reopening", () => {
    const record = add();
    const attachment = addAttachment(db, record.id, "receipt.pdf", "Receipt");
    setSetting(db, closeKey, "2026-10-31");
    expect(() => addAttachment(db, record.id, "new.pdf", "New")).toThrow(
      /closed/i,
    );
    expect(() => deleteAttachment(db, attachment.id)).toThrow(/closed/i);
    expect(listAttachments(db, record.id)).toEqual([attachment]);
    setSetting(db, closeKey, "");
    expect(deleteAttachment(db, attachment.id)).toBe(true);
    expect(addAttachment(db, record.id, "new.pdf", "New").recordId).toBe(
      record.id,
    );
  });
  it("does not rewrite frozen record text when delayed OCR completes", () => {
    const record = add();
    setExtractedText(db, record.id, "Original text");
    const before = db.select().from(ledgerRecords).all();
    setSetting(db, closeKey, "2026-10-31");
    setExtractedText(db, record.id, "Late text");
    expect(db.select().from(ledgerRecords).all()).toEqual(before);
    setSetting(db, closeKey, "");
    setExtractedText(db, record.id, "Late text");
    expect(getRecord(db, record.id)?.extractedText).toBe("Late text");
  });
  it("derives month closure separately from settlement locks in list and detail", () => {
    const record = add();
    const open = add("2026-11-01");
    setSetting(db, closeKey, "2026-10-31");
    expect(getRecord(db, record.id)).toMatchObject({
      periodClosedThrough: "2026-10-31",
      locked: false,
    });
    expect(getRecord(db, open.id)).toMatchObject({
      periodClosedThrough: null,
      locked: false,
    });
    expect(
      listRecords(db).records.find((r) => r.id === record.id)
        ?.periodClosedThrough,
    ).toBe("2026-10-31");
    setSetting(db, closeKey, "");
    expect(getRecord(db, record.id)?.periodClosedThrough).toBeNull();
  });
  it("refuses removed, added or resized movements", () => {
    const record = add();
    const before = movements();
    setSetting(db, closeKey, "2026-10-31");
    expect(() =>
      updateRecord(db, record.id, 1, {}, sides().slice(0, 1)),
    ).toThrow(/closed/i);
    expect(() =>
      updateRecord(db, record.id, 1, {}, [
        ...sides(),
        {
          accountId: anotherCategory,
          amountMinor: 1,
          sortOrder: 2,
          label: null,
        },
      ]),
    ).toThrow(/closed/i);
    expect(() =>
      updateRecord(
        db,
        record.id,
        1,
        {},
        sides().map((s) => ({ ...s, amountMinor: s.amountMinor * 2 })),
      ),
    ).toThrow(/closed/i);
    expect(movements()).toEqual(before);
  });
  it("refuses deletion of a closed record", () => {
    const record = add();
    setSetting(db, closeKey, "2026-10-31");
    expect(() => deleteRecord(db, record.id)).toThrow(/closed/i);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
    expect(movements()).toHaveLength(2);
  });
  it("rolls back numbering, record and movements if insertion fails midway", () => {
    expect(() =>
      add("2026-11-01", [sides()[0], { ...sides()[1], accountId: 9999 }]),
    ).toThrow();
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(movements()).toHaveLength(0);
    expect(db.select().from(appSequences).all()).toHaveLength(0);
  });
  it("continues to return null/false for a missing record", () => {
    setSetting(db, closeKey, "2026-10-31");
    expect(updateRecord(db, 999, 1, { amount: 5 })).toBeNull();
    expect(deleteRecord(db, 999)).toBe(false);
  });
});

describe("the closing policy", () => {
  it("distinguishes an unset boundary from closed dates", () => {
    expect(closedThrough(db)).toBeNull();
    expect(() => assertDatesOpen(db, ["2000-01-01"])).not.toThrow();
    setSetting(db, closeKey, "2026-10-31");
    expect(closedThrough(db)).toBe("2026-10-31");
    expect(() => assertDatesOpen(db, ["2026-10-30", "2026-11-01"])).toThrow(
      ClosedPeriodError,
    );
    expect(() => assertDatesOpen(db, ["2026-11-01"])).not.toThrow();
    setSetting(db, closeKey, "");
    expect(closedThrough(db)).toBeNull();
  });
  it("blocks global report-membership changes only when actual closed entries exist", () => {
    setSetting(db, closeKey, "2026-10-31");
    expect(() => assertNoClosedHistory(db)).not.toThrow();
    add("2026-11-01");
    expect(() => assertNoClosedHistory(db)).not.toThrow();
    setSetting(db, closeKey, "");
    add();
    setSetting(db, closeKey, "2026-10-31");
    expect(() => assertNoClosedHistory(db)).toThrow(ClosedPeriodError);
  });
  it("finds a typed refusal through wrapped causes without trusting a name string", () => {
    const refusal = new ClosedPeriodError("2026-10-31");
    const wrapped = new Error("Query failed", {
      cause: new Error("Transaction failed", { cause: refusal }),
    });
    expect(isClosedPeriodError(wrapped)).toBe(true);
    expect(closedPeriodReason(wrapped)).toBe(refusal.message);
    expect(isClosedPeriodError({ name: "ClosedPeriodError" })).toBe(false);
    expect(closedPeriodReason(new Error("unrelated"))).toBeNull();
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(closedPeriodReason(cycle)).toBeNull();
  });
});

describe("two SQLite connections closing and posting", () => {
  it("does not let a stale reader post after another connection closes the month", () => {
    const directory = mkdtempSync(join(tmpdir(), "akaun-closing-race-"));
    const path = join(directory, "book.db");
    const first = new Database(path);
    first.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0");
    const a = drizzle(first, { schema });
    migrate(a, { migrationsFolder: "drizzle" });
    // Use real, migrated SQLite tables, independently of the in-memory fixture.
    a.insert(accounts).values(db.select().from(accounts).all()).run();
    const second = new Database(path);
    second.exec("PRAGMA busy_timeout = 0");
    const b = drizzle(second, { schema });
    try {
      first
        .transaction(() => {
          // Establish a read snapshot in the first connection before the close.
          expect(getSetting(a, closeKey)).toBeNull();
          setSetting(b, closeKey, "2026-10-31");
          expect(() =>
            insertRecord(
              a,
              null,
              {
                kind: LedgerRecordKind.Expense,
                date: "2026-10-31",
                description: "Too late",
                amount: 50,
                currency: "USD",
                exchangeRate: 1,
              },
              sides(),
            ),
          ).toThrow(/locked|busy/i);
        })
        .deferred();
      expect(a.select().from(ledgerRecords).all()).toHaveLength(0);
      expect(a.select().from(appSequences).all()).toHaveLength(0);
      // A fresh request sees the committed boundary and the explicit refusal.
      expect(() => assertDatesOpen(a, ["2026-10-31"])).toThrow(
        ClosedPeriodError,
      );
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
