import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { applyMigrationRange } from "./auto-upgrade.js";

const tables = [
  "accounts",
  "ledger_records",
  "ledger_movements",
  "settlements",
  "settings",
  "audit_log",
  "fixed_assets",
];
function snapshot(raw: Database) {
  return tables.map((table) =>
    raw.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}
function fixture(raw: Database) {
  applyMigrationRange(raw, 0, 42);
  raw.exec(`
    INSERT INTO accounts(id,role,type,sub_type,name,rank) VALUES
      (1,1,1,2,'Bank','a'),(2,8,1,8,'Equipment','b'),(3,8,1,15,'Accumulated depreciation','c');
    INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES
      (1,1,'2026-01-01','Existing purchase',6000,'MYR');
    INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES
      (1,1,2,600000,0),(2,1,1,-600000,1);
    INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2026-01-31');
    INSERT INTO audit_log(record_type,record_id,action,via) VALUES('record','1','create','system');
    INSERT INTO fixed_assets(id,name,asset_type,acquisition_date,asset_account_id,cost_minor,source_record_id,source_movement_id,source_sort_order,source_snapshot,created_by,updated_by)
      VALUES(7,'Purchased laptop','Computer equipment','2026-01-01',2,600000,1,1,0,'{"movementId":1,"recordId":1,"sortOrder":0,"recordDate":"2026-01-01","accountId":2,"amountMinor":600000}',1,1);
    INSERT INTO fixed_assets(id,name,asset_type,acquisition_date,asset_account_id,cost_minor,opening_as_at,brought_forward_dep_minor,accumulated_depreciation_account_id,document_reference,created_by,updated_by)
      VALUES(11,'Legacy laptop','Computer equipment','2024-01-01',2,1200000,'2026-01-01',400000,3,'Accountant opening schedule',1,1);
  `);
}

describe("migration 0043 through the startup Drizzle migrator", () => {
  for (const legacy of [0, 1]) {
    it(`preserves existing books with legacy_alter_table=${legacy} and is safe to retry`, () => {
      const directory = mkdtempSync(join(tmpdir(), "akaun-0043-"));
      const path = join(directory, "book.db");
      let raw: Database | null = new Database(path);
      try {
        fixture(raw);
        const before = snapshot(raw);
        raw.exec(
          `PRAGMA legacy_alter_table=${legacy}; PRAGMA foreign_keys=OFF;`,
        );
        const db = drizzle(raw, { schema });
        // Match client.ts: set foreign keys outside the migrator's transaction.
        migrate(db, { migrationsFolder: "drizzle" });
        raw.exec("PRAGMA foreign_keys=ON");
        expect(snapshot(raw)).toEqual(before);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          raw
            .query(
              "SELECT name FROM sqlite_master WHERE name='__new_fixed_assets'",
            )
            .all(),
        ).toEqual([]);
        for (const column of [
          "cost_minor",
          "brought_forward_dep_minor",
          "business_use_bps",
          "residual_minor",
        ])
          expect(() =>
            raw!.exec(`UPDATE fixed_assets SET ${column}=0.25 WHERE id=11`),
          ).toThrow();
        // Reopen the file, just as a server restart does, and run migrations again.
        const journal = raw
          .query("SELECT * FROM __drizzle_migrations ORDER BY created_at")
          .all();
        raw.close();
        raw = new Database(path);
        raw.exec(
          `PRAGMA legacy_alter_table=${legacy}; PRAGMA foreign_keys=OFF;`,
        );
        migrate(drizzle(raw, { schema }), { migrationsFolder: "drizzle" });
        raw.exec("PRAGMA foreign_keys=ON");
        expect(snapshot(raw)).toEqual(before);
        expect(
          raw
            .query("SELECT * FROM __drizzle_migrations ORDER BY created_at")
            .all(),
        ).toEqual(journal);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        raw?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("rolls back a failed rebuild and retries without resetting the database or migration journal", () => {
    const raw = new Database(":memory:");
    try {
      fixture(raw);
      const before = snapshot(raw);
      const journal = raw
        .query("SELECT * FROM __drizzle_migrations ORDER BY created_at")
        .all();
      const files = readMigrationFiles({ migrationsFolder: "drizzle" });
      const migration = files[43];
      const statements = migration.sql;
      // Replay the original qualified CHECK clauses to reproduce the reported error.
      const broken = statements.map((statement) =>
        statement.includes('CONSTRAINT "fixed_assets_')
          ? statement.replace(
              /(?<!\.)"(cost_minor|brought_forward_dep_minor|business_use_bps|residual_minor|source_record_id|source_movement_id|source_sort_order|source_snapshot|opening_as_at|opening_record_id|accumulated_depreciation_account_id|asset_account_id)"/g,
              '"__new_fixed_assets"."$1"',
            )
          : statement,
      );
      raw.exec("PRAGMA legacy_alter_table=ON; PRAGMA foreign_keys=OFF; BEGIN");
      try {
        expect(() => {
          for (const statement of broken) raw.exec(statement);
        }).toThrow("__new_fixed_assets.cost_minor");
      } finally {
        raw.exec("ROLLBACK");
      }
      expect(snapshot(raw)).toEqual(before);
      expect(
        raw
          .query("SELECT * FROM __drizzle_migrations ORDER BY created_at")
          .all(),
      ).toEqual(journal);
      migrate(drizzle(raw, { schema }), { migrationsFolder: "drizzle" });
      expect(snapshot(raw)).toEqual(before);
    } finally {
      raw.close();
    }
  });
  it("upgrades existing automatic profiles with a separate future boundary without changing history", () => {
    const raw = new Database(":memory:");
    try {
      fixture(raw);
      applyMigrationRange(raw, 43, 44);
      raw.exec(
        "INSERT INTO users(id,username,email,password_hash) VALUES(1,'migration-user','migration@test','fixture'); INSERT INTO accounts(id,role,type,name,rank) VALUES(4,7,5,'Depreciation expense','d');",
      );
      raw.exec(`INSERT INTO depreciation_profiles(id,asset_id,start_month,months,base_nbv_minor,residual_minor,expense_account_id,accumulated_account_id,mode,basis,approved_by,reason)
        VALUES(4,7,'2026-01',36,600000,0,4,3,'auto','original',1,'Original approval');`);
      const profile = raw.query("SELECT * FROM depreciation_profiles").all();
      const before = snapshot(raw);
      const db = drizzle(raw, { schema });
      migrate(db, { migrationsFolder: "drizzle" });
      expect(snapshot(raw)).toEqual(before);
      expect(raw.query("SELECT * FROM depreciation_profiles").all()).toEqual(
        profile,
      );
      const approval = raw.query("SELECT * FROM depreciation_approvals").get();
      const currentMonth = raw
        .query("SELECT strftime('%Y-%m','now','localtime') AS month")
        .get() as { month: string };
      expect(approval).toEqual({
        profile_id: 4,
        future_from_month: currentMonth.month,
      });
      migrate(db, { migrationsFolder: "drizzle" });
      expect(raw.query("SELECT * FROM depreciation_approvals").all()).toEqual([
        approval,
      ]);
      expect(raw.query("SELECT * FROM depreciation_allocations").all()).toEqual(
        [],
      );
    } finally {
      raw.close();
    }
  });
});
