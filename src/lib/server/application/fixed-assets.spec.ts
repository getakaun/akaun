import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import { assetMoneyMinor, assetMoneyInput } from "$lib/fixed-assets.js";
import { applyMigrationRange } from "../db/auto-upgrade.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { createAccount } from "../services/accounts.js";
import { removeAccount } from "../services/accounts.js";
import { getAccount } from "../queries/accounts.js";
import {
  createRecord,
  updateRecord,
  voidRecord,
  deleteRecord,
} from "./records.js";
import { localsFor } from "../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { recordVersion } from "./version.js";
import { assetDetailsSchema } from "$lib/fixed-assets.js";
import {
  readFixedAssets,
  registerFixedAsset,
  updateFixedAsset,
} from "./fixed-assets.js";
import type { AppResult } from "./result.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let equipment: number;
let accumulated: number;
let equity: number;
const permissions = [
  "accounts.read",
  "accounts.update",
  "records.read",
  "records.create",
  "records.update",
  "records.adjust",
  "records.void",
  "records.delete",
];
const ctx = (grants = permissions) => ({ db, locals: localsFor(grants) });
const value = <T>(result: AppResult<T>): T => {
  if (!result.ok) throw Error(result.reason);
  return result.value;
};
const details = {
  name: "Laptop",
  assetType: "Computer equipment",
  inServiceDate: "2026-02-01",
};
function account(name: string, type: 1 | 2 | 3 | 4 | 5, subType?: number) {
  const result = createAccount(db, 1, {
    name,
    type,
    subType: subType as never,
  });
  if (!result.ok) throw Error(result.reason);
  return result.value.id;
}
function purchase(amount = 6000, date = "2026-01-15") {
  return value(
    createRecord(ctx(), {
      kind: "expense",
      description: "Laptop",
      date,
      amount,
      currency: "MYR",
      exchangeRate: 1,
      categoryAccountId: equipment,
      paidFromAccountId: bank,
    }),
  ).record;
}
function registerPurchase() {
  const record = purchase();
  const sourceMovementId = record.movements.find(
    (line) => line.accountId === equipment,
  )!.id;
  return {
    record,
    asset: value(registerFixedAsset(ctx(), { ...details, sourceMovementId })),
  };
}
function register(asAt = "2026-12-31") {
  return value(readFixedAssets(ctx(), asAt));
}
function financialState() {
  return {
    records: db.select().from(schema.ledgerRecords).all(),
    lines: db.select().from(schema.ledgerMovements).all(),
    settlements: db.select().from(schema.settlements).all(),
  };
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({ id: 1, username: "u", email: "u@test", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  equipment = account(
    "Computer equipment",
    AccountType.Asset,
    AccountSubType.FixedAsset,
  );
  accumulated = account(
    "Accumulated depreciation",
    AccountType.Asset,
    AccountSubType.OtherNonCurrentAsset,
  );
  equity = account("Opening equity", AccountType.Equity);
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  const payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  db.insert(schema.accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Receivable, accountId: receivable },
      { purpose: DefaultAccountPurpose.Payable, accountId: payable },
      { purpose: DefaultAccountPurpose.OpeningBalances, accountId: equity },
    ])
    .run();
});
afterEach(() => sqlite.close());

describe("Phase 3 fixed asset register", () => {
  it("upgrades an existing 0042 register without losing evidence and rejects fractional database amounts", () => {
    const old = new Database(":memory:");
    try {
      applyMigrationRange(old, 0, 42);
      old.exec(
        "INSERT INTO accounts(id,role,type,sub_type,name,rank) VALUES(1,1,1,2,'Bank','a'),(2,8,1,8,'Equipment','b'),(3,8,1,15,'Accumulated depreciation','c'); INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(1,1,'2026-01-01','Existing',6000,'MYR'); INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES(1,1,2,600000,0),(2,1,1,-600000,1); INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2026-01-31'); INSERT INTO audit_log(record_type,record_id,action,via) VALUES('record','1','create','system'); INSERT INTO fixed_assets(name,asset_type,acquisition_date,asset_account_id,cost_minor,opening_as_at,brought_forward_dep_minor,accumulated_depreciation_account_id,document_reference,created_by,updated_by) VALUES('Existing laptop','Computer equipment','2024-01-01',2,600000,'2026-01-01',200000,3,'Accountant opening schedule',1,1);",
      );
      const tables = [
        "accounts",
        "ledger_records",
        "ledger_movements",
        "settlements",
        "settings",
        "audit_log",
        "fixed_assets",
      ];
      const before = tables.map((table) =>
        old.query(`SELECT * FROM ${table}`).all(),
      );
      old.exec("PRAGMA foreign_keys=ON");
      applyMigrationRange(old, 43, 43);
      expect(
        tables.map((table) => old.query(`SELECT * FROM ${table}`).all()),
      ).toEqual(before);
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const column of [
        "cost_minor",
        "brought_forward_dep_minor",
        "business_use_bps",
        "residual_minor",
      ])
        expect(() =>
          old.exec(`UPDATE fixed_assets SET ${column} = 0.25 WHERE id = 1`),
        ).toThrow();
      expect(
        old
          .query(
            "SELECT cost_minor, brought_forward_dep_minor FROM fixed_assets",
          )
          .get(),
      ).toEqual({ cost_minor: 600000, brought_forward_dep_minor: 200000 });
    } finally {
      old.close();
    }
  });
  it("keeps a credential's narrower permission ceiling on asset registration", () => {
    const record = purchase();
    const before = financialState();
    const auditBefore = db.select().from(schema.auditLog).all();
    const locals = localsFor(permissions, {
      credential: ["accounts.read", "records.read"],
    });
    expect(
      registerFixedAsset(
        { db, locals },
        {
          ...details,
          sourceMovementId: record.movements.find(
            (line) => line.accountId === equipment,
          )!.id,
        },
      ),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(db.select().from(schema.fixedAssets).all()).toHaveLength(0);
    expect(db.select().from(schema.auditLog).all()).toEqual(auditBefore);
    expect(financialState()).toEqual(before);
  });
  it("surfaces an invalidated accumulated depreciation mapping without losing the legacy evidence", () => {
    value(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: null,
        acquisitionDate: "2024-01-01",
        openingAsAt: "2026-01-01",
        assetAccountId: equipment,
        costMinor: 1200000,
        broughtForwardDepMinor: 400000,
        accumulatedDepreciationAccountId: accumulated,
        documentReference: "Opening schedule",
      }),
    );
    db.update(schema.accounts)
      .set({
        type: AccountType.Expense,
        subType: AccountSubType.OperatingExpense,
      })
      .where(eq(schema.accounts.id, accumulated))
      .run();
    expect(register().assets[0].reviewReason).toContain(
      "Accumulated depreciation account",
    );
    expect(register().assets[0].broughtForwardDepMinor).toBe(400000);
  });
  it("adds migration 0042 without rewriting existing financial rows, closing settings or audit", () => {
    const old = new Database(":memory:");
    try {
      applyMigrationRange(old, 0, 41);
      old.exec(
        "INSERT INTO accounts(id,role,type,name,rank) VALUES(1,1,1,'Bank','a'); INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(1,1,'2026-01-01','Existing',100,'MYR'); INSERT INTO ledger_movements(id,record_id,account_id,amount_minor) VALUES(1,1,1,10000); INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2026-01-31'); INSERT INTO audit_log(record_type,record_id,action,via) VALUES('record','1','create','system');",
      );
      const tables = [
        "accounts",
        "ledger_records",
        "ledger_movements",
        "settlements",
        "settings",
        "audit_log",
      ];
      const before = tables.map((table) =>
        old.query(`SELECT * FROM ${table}`).all(),
      );
      applyMigrationRange(old, 42, 42);
      expect(
        tables.map((table) => old.query(`SELECT * FROM ${table}`).all()),
      ).toEqual(before);
      expect(old.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(assetMoneyInput(Number.MAX_SAFE_INTEGER)).toBe(
        "90071992547409.91",
      );
    } finally {
      old.close();
    }
  });
  it("follows the original movement identity when source lines are reordered", () => {
    const { asset } = registerPurchase();
    db.update(schema.ledgerMovements)
      .set({ sortOrder: asset.sourceSortOrder! + 5 })
      .where(eq(schema.ledgerMovements.id, asset.sourceMovementId!))
      .run();
    const current = register().assets[0];
    expect(current.reviewReason).not.toBeNull();
    expect(register().unregistered).toHaveLength(0);
    value(
      updateFixedAsset(ctx(), asset.id, {
        ...assetDetailsSchema.parse(asset),
        expectedVersion: "1",
        expectedSourceVersion: current.sourceVersion,
        reason: "Reviewed source line ordering",
        acknowledgeSource: true,
      }),
    );
    expect(register().assets[0].reviewReason).toBeNull();
    expect(register().unregistered).toHaveLength(0);
  });
  it("preserves source records and even zero-balance account mappings with readable deletion refusals", () => {
    const { record } = registerPurchase();
    expect(deleteRecord(ctx(), record.id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("fixed asset register"),
    });
    value(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: null,
        acquisitionDate: "2024-01-01",
        openingAsAt: "2026-01-01",
        assetAccountId: equipment,
        costMinor: 100000,
        accumulatedDepreciationAccountId: accumulated,
        documentReference: "Opening evidence",
      }),
    );
    expect(removeAccount(db, accumulated, 1)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("fixed asset register"),
    });
    expect(getAccount(db, accumulated)).toMatchObject({
      canDelete: false,
      cannotDeleteReason: expect.stringContaining("fixed asset register"),
    });
  });
  it("rejects stale source review even when the register itself has not changed", () => {
    const { record, asset } = registerPurchase();
    const sourceVersion = register().assets[0].sourceVersion;
    value(updateRecord(ctx(), record.id, { amount: 7000 }));
    expect(
      updateFixedAsset(ctx(), asset.id, {
        ...assetDetailsSchema.parse(asset),
        expectedVersion: "1",
        expectedSourceVersion: sourceVersion,
        reason: "Review",
        acknowledgeSource: true,
      }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(register().assets[0].costMinor).toBe(600000);
  });
  it("corrects legacy opening metadata with an audit reason while leaving financial rows unchanged", () => {
    const asset = value(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: null,
        acquisitionDate: "2024-01-01",
        openingAsAt: "2026-01-01",
        assetAccountId: equipment,
        costMinor: 1200000,
        broughtForwardDepMinor: 400000,
        accumulatedDepreciationAccountId: accumulated,
        documentReference: "Opening schedule",
      }),
    );
    const before = financialState();
    value(
      updateFixedAsset(ctx(), asset.id, {
        ...assetDetailsSchema.parse(asset),
        expectedVersion: "1",
        reason: "Correct transcribed opening cost",
        legacyOpening: {
          acquisitionDate: "2024-01-01",
          assetAccountId: equipment,
          costMinor: 1300000,
          openingAsAt: "2026-01-01",
          broughtForwardDepMinor: 400000,
          openingRecordId: null,
        },
      }),
    );
    expect(register().assets[0].costMinor).toBe(1300000);
    expect(financialState()).toEqual(before);
  });
  it("flags changed account classification instead of concealing a registered asset", () => {
    registerPurchase();
    db.update(schema.accounts)
      .set({ subType: AccountSubType.OtherCurrentAsset })
      .where(eq(schema.accounts.id, equipment))
      .run();
    expect(register().assets[0].reviewReason).toContain(
      "classification changed",
    );
    expect(
      register().costReconciliation.some((row) => row.accountId === equipment),
    ).toBe(true);
  });
  it("registers a purchase in a closed month without changing any financial rows or saved classifications", () => {
    const record = purchase();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-01-31");
    const before = financialState();
    const line = record.movements.find(
      (movement) => movement.accountId === equipment,
    )!;
    const asset = value(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: line.id,
        businessUseBps: 8000,
      }),
    );
    expect(asset.costMinor).toBe(600000);
    expect(financialState()).toEqual(before);
    expect(register().unregistered).toHaveLength(0);
    expect(
      register().costReconciliation.find((row) => row.accountId === equipment),
    ).toMatchObject({
      ledgerMinor: 600000,
      registerMinor: 600000,
      differenceMinor: 0,
    });
    expect(db.select().from(schema.auditLog).all().at(-1)).toMatchObject({
      recordType: "fixed_asset",
      action: "create",
      userId: 1,
    });
  });
  it("prevents duplicate registrations through the operation and unique database indexes", () => {
    const { asset } = registerPurchase();
    expect(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: asset.sourceMovementId,
      }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(() =>
      db
        .insert(schema.fixedAssets)
        .values({ ...asset, id: undefined })
        .run(),
    ).toThrow();
    expect(register().assets).toHaveLength(1);
  });
  it("keeps missing legacy openings visible, and reconciles cost and brought-forward depreciation independently", () => {
    const before = financialState();
    value(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: null,
        acquisitionDate: "2024-01-01",
        openingAsAt: "2026-01-01",
        assetAccountId: equipment,
        costMinor: 1200000,
        broughtForwardDepMinor: 400000,
        accumulatedDepreciationAccountId: accumulated,
        documentReference: "Accountant opening schedule, row 5",
      }),
    );
    expect(financialState()).toEqual(before);
    expect(
      register().costReconciliation.find((row) => row.accountId === equipment)
        ?.differenceMinor,
    ).toBe(-1200000);
    expect(register().depreciationReconciliation[0].differenceMinor).toBe(
      -400000,
    );
    value(
      createRecord(ctx(), {
        kind: "journal",
        description: "Opening balances",
        date: "2026-01-01",
        amount: 12000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: equipment, amountMinor: 1200000 },
          { accountId: accumulated, amountMinor: -400000 },
          { accountId: equity, amountMinor: -800000 },
        ],
      }),
    );
    expect(
      register().costReconciliation.find((row) => row.accountId === equipment)
        ?.differenceMinor,
    ).toBe(0);
    expect(register().depreciationReconciliation[0]).toMatchObject({
      ledgerMinor: 400000,
      registerMinor: 400000,
      differenceMinor: 0,
    });
    expect(register("2025-12-31").assets).toHaveLength(0);
    expect(register().assets[0]).toMatchObject({
      costMinor: 1200000,
      broughtForwardDepMinor: 400000,
      openingAsAt: "2026-01-01",
    });
  });
  it("flags source edits, reserves their original slot, and accepts new values only after reasoned review", () => {
    const { record, asset } = registerPurchase();
    value(updateRecord(ctx(), record.id, { amount: 7000 }));
    expect(register().assets[0].reviewReason).not.toBeNull();
    expect(register().assets[0].costMinor).toBe(600000);
    expect(register().unregistered).toHaveLength(0);
    const before = financialState();
    const changed = value(
      updateFixedAsset(ctx(), asset.id, {
        ...assetDetailsSchema.parse(asset),
        expectedVersion: "1",
        expectedSourceVersion: register().assets[0].sourceVersion,
        reason: "Reviewed corrected purchase receipt",
        acknowledgeSource: true,
      }),
    );
    expect(changed.costMinor).toBe(700000);
    expect(register().assets[0].reviewReason).toBeNull();
    expect(financialState()).toEqual(before);
  });
  it("retains voided sources as review exceptions without hiding their ledger difference", () => {
    const { record, asset } = registerPurchase();
    value(
      voidRecord(ctx(), record.id, {
        reason: "Duplicate purchase",
        expectedVersion: recordVersion(db, record.id),
      }),
    );
    expect(register().assets[0].reviewReason).toContain("voided");
    expect(
      register().costReconciliation.find((row) => row.accountId === equipment),
    ).toMatchObject({
      ledgerMinor: 0,
      registerMinor: 600000,
      differenceMinor: -600000,
    });
    expect(register().unregistered).toHaveLength(0);
    expect(
      updateFixedAsset(ctx(), asset.id, {
        ...assetDetailsSchema.parse(asset),
        expectedVersion: "1",
        reason: "Review",
        acknowledgeSource: true,
      }).ok,
    ).toBe(false);
  });
  it("enforces read/write grants and optimistic versions without partial writes", () => {
    const record = purchase();
    const sourceMovementId = record.movements.find(
      (line) => line.accountId === equipment,
    )!.id;
    for (const grants of [
      [],
      ["accounts.read"],
      ["records.read"],
      ["accounts.read", "records.read"],
    ]) {
      expect(
        registerFixedAsset(ctx(grants), { ...details, sourceMovementId }),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(readFixedAssets(ctx(["accounts.read"]), "2026-12-31")).toMatchObject(
      { ok: false, code: "FORBIDDEN" },
    );
    const asset = value(
      registerFixedAsset(ctx(), { ...details, sourceMovementId }),
    );
    const update = {
      ...assetDetailsSchema.parse(asset),
      name: "New name",
      expectedVersion: "1",
      reason: "Correct label",
    };
    value(updateFixedAsset(ctx(), asset.id, update));
    expect(updateFixedAsset(ctx(), asset.id, update)).toMatchObject({
      ok: false,
      code: "CONFLICT",
      currentVersion: "2",
    });
    expect(
      updateFixedAsset(ctx(), asset.id, {
        ...update,
        expectedVersion: "2",
        costMinor: 1,
      }).ok,
    ).toBe(false);
    expect(register().assets[0].costMinor).toBe(600000);
  });
  it("validates legacy dates, supporting evidence, accounts, money and source-derived values", () => {
    const base = {
      ...details,
      sourceMovementId: null,
      acquisitionDate: "2024-01-01",
      openingAsAt: "2026-01-01",
      assetAccountId: equipment,
      costMinor: 1200000,
      documentReference: "Opening schedule",
    };
    for (const patch of [
      { acquisitionDate: "2026-02-30" },
      { documentReference: "" },
      { assetAccountId: bank },
      { costMinor: 1.5 },
      { broughtForwardDepMinor: 1200001 },
      { broughtForwardDepMinor: 100 },
      { accumulatedDepreciationAccountId: equipment },
      { inServiceDate: "2023-01-01" },
      { residualMinor: 1200001 },
      { openingRecordId: 99999 },
    ]) {
      expect(registerFixedAsset(ctx(), { ...base, ...patch }).ok).toBe(false);
    }
    const purchaseRecord = purchase();
    const line = purchaseRecord.movements.find(
      (movement) => movement.accountId === equipment,
    )!;
    expect(
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: line.id,
        costMinor: 1,
      }).ok,
    ).toBe(false);
    expect(register().assets).toHaveLength(0);
    expect(readFixedAssets(ctx(), "2026-02-30").ok).toBe(false);
    expect(assetMoneyMinor("0.29")).toBe(29);
    expect(assetMoneyMinor("1.005")).toBeNull();
    expect(assetMoneyMinor("90071992547409.92")).toBeNull();
  });
  it("rolls back registration when its audit cannot be saved", () => {
    const record = purchase();
    const before = financialState();
    sqlite.exec(
      "CREATE TRIGGER refuse_asset_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() =>
      registerFixedAsset(ctx(), {
        ...details,
        sourceMovementId: record.movements.find(
          (line) => line.accountId === equipment,
        )!.id,
      }),
    ).toThrow();
    expect(register().assets).toHaveLength(0);
    expect(financialState()).toEqual(before);
  });
  it("does not expose another book's assets", () => {
    registerPurchase();
    const other = new Database(":memory:");
    try {
      const otherDb = drizzle(other, { schema }) as LedgerDb;
      migrate(otherDb, { migrationsFolder: "drizzle" });
      expect(
        value(readFixedAssets({ ...ctx(), db: otherDb }, "2026-12-31")).assets,
      ).toHaveLength(0);
    } finally {
      other.close();
    }
  });
});
