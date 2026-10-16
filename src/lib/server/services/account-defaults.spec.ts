import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  type AccountTypeCode,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import {
  getAccountDefaults,
  replaceAccountDefaults,
  requireAccountDefault,
} from "./account-defaults.js";

let sqlite: Database;
let db: LedgerDb;

const PURPOSES: readonly [DefaultAccountPurposeCode, AccountTypeCode][] = [
  [DefaultAccountPurpose.Receivable, AccountType.Asset],
  [DefaultAccountPurpose.Payable, AccountType.Liability],
  [DefaultAccountPurpose.OpeningBalances, AccountType.Equity],
  [DefaultAccountPurpose.SalesRevenue, AccountType.Revenue],
  [DefaultAccountPurpose.UncategorisedExpense, AccountType.Expense],
  [DefaultAccountPurpose.EverydayTransaction, AccountType.Asset],
  [DefaultAccountPurpose.UncategorisedIncome, AccountType.Revenue],
];

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, name TEXT);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role INTEGER NOT NULL,
      type INTEGER,
      sub_type INTEGER,
      code INTEGER,
      name TEXT NOT NULL,
      merged_into_account_id INTEGER REFERENCES accounts(id),
      contact_id INTEGER,
      is_system INTEGER NOT NULL DEFAULT 0,
      rank TEXT NOT NULL,
      archived_at TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE account_defaults (
      purpose INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_label TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT,
      via TEXT NOT NULL,
      credential_id TEXT,
      client_id TEXT,
      credential_label TEXT,
      request_id TEXT,
      operation TEXT,
      action TEXT NOT NULL,
      changes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE ledger_movements (
      id INTEGER PRIMARY KEY,
      record_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      amount_minor INTEGER NOT NULL,
      sort_order INTEGER NOT NULL
    );
  `);
  db = drizzle(sqlite, { schema });
  sqlite.run("INSERT INTO users (id) VALUES (7)");
});

function account(
  type: AccountTypeCode,
  name: string,
  extra = "",
  subType: number | null = null,
): number {
  const count = sqlite
    .query<{ n: number }, []>("SELECT count(*) AS n FROM accounts")
    .get()!.n;
  sqlite.run(
    `INSERT INTO accounts (role, type, sub_type, code, name, rank ${extra ? ", archived_at" : ""}) VALUES (1, ?, ?, ?, ?, ? ${extra ? ", ?" : ""})`,
    extra
      ? [type, subType, 1000 + count, name, name, extra]
      : [type, subType, 1000 + count, name, name],
  );
  return Number(
    sqlite.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!
      .id,
  );
}

function validInputs() {
  return PURPOSES.map(([purpose, type], index) => ({
    purpose,
    accountId: account(
      type,
      `Account ${index}`,
      "",
      purpose === DefaultAccountPurpose.Receivable
        ? AccountSubType.Receivable
        : purpose === DefaultAccountPurpose.Payable
          ? AccountSubType.AccountsPayable
          : purpose === DefaultAccountPurpose.EverydayTransaction
            ? AccountSubType.Bank
            : null,
    ),
  }));
}

describe("saved account defaults", () => {
  it("atomically saves and returns all seven compatible active leaves", () => {
    const inputs = validInputs();
    expect(replaceAccountDefaults(db, 7, inputs).ok).toBe(true);
    expect(
      getAccountDefaults(db).map((item) => [
        item.purpose,
        item.account?.id,
        item.valid,
      ]),
    ).toEqual(inputs.map((item) => [item.purpose, item.accountId, true]));
    expect(
      sqlite
        .query<
          { n: number },
          []
        >("SELECT count(*) AS n FROM audit_log WHERE record_type = 'account' AND action = 'update'")
        .get()!.n,
    ).toBe(7);
  });

  it("refuses a missing purpose without changing existing defaults", () => {
    const initial = validInputs();
    expect(replaceAccountDefaults(db, 7, initial).ok).toBe(true);
    const result = replaceAccountDefaults(db, 7, initial.slice(0, 6));
    expect(result.ok).toBe(false);
    expect(getAccountDefaults(db).map((item) => item.account?.id)).toEqual(
      initial.map((item) => item.accountId),
    );
    expect(
      sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM audit_log")
        .get()!.n,
    ).toBe(7);
  });

  it("refuses the wrong type and inactive accounts", () => {
    const base = validInputs();
    const wrongType = account(AccountType.Expense, "Wrong type");
    expect(
      replaceAccountDefaults(db, 7, [
        { ...base[0], accountId: wrongType },
        ...base.slice(1),
      ]).ok,
    ).toBe(false);

    const inactive = account(AccountType.Asset, "Inactive", "2026-01-01");
    expect(
      replaceAccountDefaults(db, 7, [
        { ...base[0], accountId: inactive },
        ...base.slice(1),
      ]).ok,
    ).toBe(false);
  });

  it("refuses semantically wrong owed and transaction defaults", () => {
    const base = validInputs();
    const loan = account(
      AccountType.Liability,
      "Loan",
      "",
      AccountSubType.ShortTermLoan,
    );
    expect(
      replaceAccountDefaults(db, 7, [
        base[0],
        { ...base[1], accountId: loan },
        ...base.slice(2),
      ]).ok,
    ).toBe(false);

    const inventory = account(
      AccountType.Asset,
      "Inventory",
      "",
      AccountSubType.Inventory,
    );
    expect(
      replaceAccountDefaults(db, 7, [
        ...base.slice(0, 5),
        { ...base[5], accountId: inventory },
        ...base.slice(6),
      ]).ok,
    ).toBe(false);
  });

  it("revalidates a default immediately before automatic use", () => {
    const inputs = validInputs();
    expect(replaceAccountDefaults(db, 7, inputs).ok).toBe(true);
    for (const [index, [purpose]] of PURPOSES.entries()) {
      expect(requireAccountDefault(db, purpose)).toEqual({
        ok: true,
        value: inputs[index].accountId,
      });
    }

    sqlite.run("UPDATE accounts SET archived_at = '2026-01-01' WHERE id = ?", [
      inputs[1].accountId,
    ]);
    const after = requireAccountDefault(db, DefaultAccountPurpose.Payable);
    expect(after.ok).toBe(false);
  });
});
