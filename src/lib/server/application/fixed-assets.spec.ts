import { removeAccount } from "../services/accounts.js";
import { getAccount } from "../queries/accounts.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { saveAsset, type AssetInput, type FixedAsset } from "./fixed-assets.js";
import type { AppResult } from "./result.js";
import { assetRegister, sumMinor } from "../queries/fixed-assets.js";
import { localsFor } from "../permissions/test-locals.js";
import { assetUnits, assetDecimal } from "$lib/fixed-assets.js";
import { applyMigrationRange } from "../db/auto-upgrade.js";

let raw: Database;
let db: LedgerDb;
const ctx = (
  permissions = ["accounts.read", "accounts.update", "records.read"],
) => ({ db, locals: localsFor(permissions) });
const input = (patch: Partial<AssetInput> = {}): AssetInput => ({
  assetCode: "PC-001",
  name: "Laptop",
  description: "Development laptop",
  category: "Computer equipment",
  acquisitionDate: "2026-01-15",
  inServiceDate: "2026-02-01",
  costMinor: 1200000,
  accountId: 2,
  origin: "purchase",
  sourceMovementId: 1,
  openingDate: null,
  openingAccumulatedMinor: 0,
  accumulatedAccountId: 3,
  reconciliationNote: "Invoice already capitalised",
  businessUseBps: 8000,
  documentation: "Invoice INV-001, attachment in purchase record",
  method: "straight_line",
  usefulLifeMonths: 36,
  residualMinor: 0,
  expenseAccountId: 4,
  acknowledgedExistingGl: true,
  ...patch,
});
function value(result: AppResult<FixedAsset>) {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const ledger = () => ({
  records: raw.query("SELECT * FROM ledger_records ORDER BY id").all(),
  movements: raw.query("SELECT * FROM ledger_movements ORDER BY id").all(),
  settings: raw.query("SELECT * FROM settings").all(),
  settlements: raw.query("SELECT * FROM settlements").all(),
});
beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec("PRAGMA foreign_keys=ON");
  raw.exec(`INSERT INTO users(id,email,username,password_hash) VALUES(1,'test@example.com','tester','unused');
    INSERT INTO accounts(id,role,type,sub_type,name,rank) VALUES (1,1,1,2,'Bank','a'),(2,8,1,8,'Equipment','b'),(3,8,1,8,'Accumulated depreciation','c'),(4,6,5,17,'Depreciation expense','d');
    INSERT INTO ledger_records(id,kind,date,description,amount,currency,exchange_rate) VALUES(1,1,'2026-01-15','Laptop purchase',12000,'MYR',1);
    INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES(1,1,2,1200000,0),(2,1,1,-1200000,1);`);
});
afterEach(() => raw.close());

describe("phase 3 fixed asset register", () => {
  it("registers a closed-month capital purchase without any financial mutation and reconciles exact cents", () => {
    raw.exec(
      "INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2026-01-31')",
    );
    const before = ledger();
    const a = value(saveAsset(ctx(), input()));
    expect(a.sourceRecordId).toBe(1);
    expect(() =>
      raw.exec("UPDATE fixed_assets SET residual_minor=0.5"),
    ).toThrow();
    expect(ledger()).toEqual(before);
    const report = assetRegister(db, "2026-12-31");
    expect(report.costMinor).toBe(1200000);
    expect(report.reconciliation.every((r) => r.differenceMinor === 0)).toBe(
      true,
    );
    expect(report.unregistered).toHaveLength(0);
    expect(report.rows[0].status).toBe("In service");
    expect(raw.query("SELECT record_type,action FROM audit_log").all()).toEqual(
      [{ record_type: "fixed_asset", action: "create" }],
    );
  });
  it("prevents duplicate source line and identity, including direct SQL duplicate insertion", () => {
    const a = value(saveAsset(ctx(), input()));
    expect(saveAsset(ctx(), input({ assetCode: "PC-002" })).ok).toBe(false);
    expect(
      saveAsset(
        ctx(),
        input({
          origin: "legacy",
          sourceMovementId: null,
          openingDate: "2026-02-01",
        }),
      ).ok,
    ).toBe(false);
    expect(() =>
      db
        .insert(schema.fixedAssets)
        .values({ ...a, id: 50, assetCode: "SQL-duplicate" })
        .run(),
    ).toThrow();
    expect(db.select().from(schema.fixedAssets).all()).toHaveLength(1);
  });
  it("legacy openings reconcile separately against existing gross and contra GL balances; registration never posts opening values", () => {
    raw.exec(`INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(2,5,'2025-12-31','Legacy opening',6000,'MYR');
      INSERT INTO ledger_movements(record_id,account_id,amount_minor,sort_order) VALUES(2,2,1000000,0),(2,3,-400000,1),(2,1,-600000,2);`);
    const before = ledger();
    value(
      saveAsset(
        ctx(),
        input({
          origin: "legacy",
          sourceMovementId: null,
          acquisitionDate: "2024-01-01",
          openingDate: "2025-12-31",
          costMinor: 1000000,
          openingAccumulatedMinor: 400000,
        }),
      ),
    );
    expect(ledger()).toEqual(before);
    const report = assetRegister(db, "2025-12-31");
    expect(report.costMinor).toBe(1000000);
    expect(report.accumulatedMinor).toBe(400000);
    expect(report.openingNetMinor).toBe(600000);
    expect(report.reconciliation.every((r) => r.differenceMinor === 0)).toBe(
      true,
    );
    expect(report.rows[0].exceptions.join()).toContain("Legacy opening");
    expect(assetRegister(db, "2025-12-30").costMinor).toBe(0);
    expect(report.unregistered).toHaveLength(1); // Pooled opening evidence stays explicit until manually reviewed.
  });
  it("exposes unregistered positive fixed-asset lines and excludes cash and expenses", () => {
    const report = assetRegister(db, "2026-12-31");
    expect(report.unregistered.map((m) => m.id)).toEqual([1]);
    expect(
      report.reconciliation.find((r) => r.accountId === 2)?.differenceMinor,
    ).toBe(1200000);
    expect(assetRegister(db, "2026-01-14").unregistered).toHaveLength(0);
  });
  it("enforces read/update/source permissions and credential ceilings at the write boundary", () => {
    for (const p of [
      [],
      ["accounts.update"],
      ["accounts.read"],
      ["accounts.read", "accounts.update"],
    ])
      expect(saveAsset(ctx(p), input()).ok).toBe(false);
    const locals = localsFor(
      ["accounts.read", "accounts.update", "records.read"],
      { credential: ["accounts.read", "records.read"] },
    );
    expect(saveAsset({ db, locals }, input()).ok).toBe(false);
    expect(raw.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
    expect(raw.query("SELECT * FROM audit_log").all()).toHaveLength(0);
  });
  it("rejects expense lines, wrong account/cost/date, void sources, invalid profiles and ambiguous opening values", () => {
    for (const patch of [
      { accountId: 4 },
      { costMinor: 1000 },
      { acquisitionDate: "2026-01-16" },
      { sourceMovementId: 2 },
      { sourceMovementId: 999 },
      { businessUseBps: 10001 },
      { costMinor: 1.5 },
      { residualMinor: 1200001 },
      { openingAccumulatedMinor: 1 },
      { usefulLifeMonths: null },
      { accumulatedAccountId: 2 },
      { expenseAccountId: 1 },
      { inServiceDate: "2020-01-01" },
      { acquisitionDate: "2026-02-30" },
    ])
      expect(saveAsset(ctx(), input(patch)).ok).toBe(false);
    expect(
      saveAsset(ctx(), { ...input(), acknowledgedExistingGl: false }).ok,
    ).toBe(false);
    raw.exec("UPDATE ledger_records SET kind=5 WHERE id=1");
    expect(saveAsset(ctx(), input()).ok).toBe(false);
    raw.exec("UPDATE ledger_records SET kind=1 WHERE id=1");
    raw.exec("UPDATE ledger_records SET kind=5 WHERE id=1");
    expect(saveAsset(ctx(), input()).ok).toBe(false);
    raw.exec("UPDATE ledger_records SET kind=1 WHERE id=1");
    raw.exec(
      "INSERT INTO ledger_records(id,kind,date,description,amount,currency,reverses_record_id) VALUES(2,8,'2026-01-15','Void',12000,'MYR',1)",
    );
    expect(saveAsset(ctx(), input()).ok).toBe(false);
    expect(raw.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
  });
  it("keeps saved evidence and flags later source corrections, voids and deletion", () => {
    value(saveAsset(ctx(), input()));
    raw.exec("UPDATE ledger_movements SET amount_minor=1100000 WHERE id=1");
    expect(assetRegister(db, "2026-12-31").rows[0].exceptions.join()).toContain(
      "changed",
    );
    expect(assetRegister(db, "2026-12-31").costMinor).toBe(1200000);
    raw.exec("DELETE FROM ledger_movements WHERE id=1");
    expect(assetRegister(db, "2026-12-31").rows[0].exceptions.join()).toContain(
      "missing",
    );
    expect(
      raw.query("SELECT source_movement_id FROM fixed_assets").get(),
    ).toEqual({ source_movement_id: 1 });
  });
  it("requires version and reason for correction, audits it, and leaves GL and locks unchanged", () => {
    const a = value(saveAsset(ctx(), input()));
    const before = ledger();
    expect(
      saveAsset(ctx(), input({ name: "Updated" }), {
        id: a.id,
        expectedVersion: 1,
        reason: "",
      }).ok,
    ).toBe(false);
    const updated = value(
      saveAsset(ctx(), input({ name: "Updated" }), {
        id: a.id,
        expectedVersion: 1,
        reason: "Correct manufacturer description",
      }),
    );
    expect(updated.version).toBe(2);
    expect(
      saveAsset(ctx(), input(), {
        id: a.id,
        expectedVersion: 1,
        reason: "Stale edit",
      }).ok,
    ).toBe(false);
    expect(ledger()).toEqual(before);
    expect(
      raw.query("SELECT changes FROM audit_log ORDER BY id DESC LIMIT 1").get(),
    ).toMatchObject({
      changes: expect.stringContaining("Correct manufacturer description"),
    });
  });
  it("rolls registration back when audit insertion fails", () => {
    raw.exec(
      "CREATE TRIGGER fail_asset_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    const before = ledger();
    expect(() => saveAsset(ctx(), input())).toThrow("audit unavailable");
    expect(raw.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
    expect(ledger()).toEqual(before);
  });
  it("isolates books: a source ID from a different database is refused", () => {
    const other = new Database(":memory:");
    try {
      const otherDb = drizzle(other, { schema }) as LedgerDb;
      migrate(otherDb, { migrationsFolder: "drizzle" });
      expect(saveAsset({ ...ctx(), db: otherDb }, input()).ok).toBe(false);
      expect(other.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
    } finally {
      other.close();
    }
  });
  it("protects mapped accounts with no movements from deletion with a useful refusal", () => {
    value(saveAsset(ctx(), input()));
    expect(getAccount(db, 3)?.canDelete).toBe(false);
    expect(removeAccount(db, 3, 1).ok).toBe(false);
    expect(removeAccount(db, 4, 1).ok).toBe(false);
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("uses exact decimal text and checked integer sums", () => {
    expect(assetUnits("12000.01")).toBe(1200001);
    expect(assetDecimal(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(assetDecimal(-29)).toBe("-0.29");
    expect(assetUnits("0.29")).toBe(29);
    expect(assetUnits("80.25", 10000)).toBe(8025);
    for (const s of ["1.005", "-1", "NaN", "1e4", "90071992547409.92"])
      expect(() => assetUnits(s)).toThrow();
    expect(sumMinor([Number.MAX_SAFE_INTEGER, -1])).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow();
  });
  it("migration 0042 adds only empty register storage, preserving financial rows, locks and audit", () => {
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
      const before = tables.map((t) => old.query(`SELECT * FROM ${t}`).all());
      applyMigrationRange(old, 42, 42);
      expect(tables.map((t) => old.query(`SELECT * FROM ${t}`).all())).toEqual(
        before,
      );
      expect(old.query("SELECT * FROM fixed_assets").all()).toHaveLength(0);
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      old.close();
    }
  });
});
