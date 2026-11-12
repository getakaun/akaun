import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrationRange } from "./auto-upgrade.js";
import { migrateBook } from "./migrate-book.js";
import {
  assertTaxUpgradeSafe,
  checkTaxUpgradeAt,
  SCHEME_ONLY_MIGRATION,
  taxUpgradeImpact,
} from "./tax-upgrade-guard.js";

function worksheet(raw: Database) {
  raw.exec(`INSERT INTO tax_worksheets(id,ya,date_from,date_to,request_key,created_at)
    VALUES(1,2025,'2025-01-01','2025-12-31','w','2026-01-01');
    INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,snapshot,source_hash,captured_at,request_key)
    VALUES(1,1,1,'{}','h','2026-01-01','r');`);
}
function allowance(raw: Database, withdrawn = false) {
  raw.exec(`INSERT INTO tax_worksheet_adjustments(revision_id,kind,amount_minor,reason,evidence,request_key,actor_name,created_at,withdrawn_at)
    VALUES(1,'capital_allowance',123,'Reviewed allowance','Evidence','a','Accountant','2026-01-01',${withdrawn ? "'2026-01-02'" : "NULL"});`);
}
const hash = (path: string) =>
  existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : null;
const snapshot = (raw: Database) =>
  raw.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();

describe("release tax upgrade protection", () => {
  it("tracks the exact destructive migration journal entry", () => {
    const files = readMigrationFiles({ migrationsFolder: "drizzle" });
    expect(files[49].folderMillis).toBe(SCHEME_ONLY_MIGRATION);
  });

  for (const last of [40, 45, 46, 47, 48, 49])
    it(`migrates a book without affected evidence from ${last}, and restarts safely`, () => {
      const raw = new Database(":memory:");
      try {
        applyMigrationRange(raw, 0, last);
        raw.exec(`INSERT INTO accounts(id,role,type,name,rank) VALUES(1,1,1,'Bank','a'),(2,6,5,'Fuel','b');
          INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(1,1,'2025-01-01','Historical expense',1000,'MYR');
          INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES(1,1,2,100000,0),(2,1,1,-100000,1);
          INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2025-01-31');`);
        if (last >= 46) {
          worksheet(raw);
          raw.exec(
            "UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-02',finalised_at='2026-01-03' WHERE id=1",
          );
        }
        const tables = [
          "accounts",
          "ledger_records",
          "ledger_movements",
          "settings",
          "audit_log",
        ];
        if (last >= 46)
          tables.push("tax_worksheets", "tax_worksheet_revisions");
        const columns = tables.map((t) =>
          (raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[])
            .map((c) => c.name)
            .join(","),
        );
        const data = () =>
          tables.map((t, i) =>
            raw.query(`SELECT ${columns[i]} FROM ${t} ORDER BY rowid`).all(),
          );
        const before = data();
        migrateBook(raw);
        expect(data()).toEqual(before);
        const schema = snapshot(raw);
        migrateBook(raw);
        expect(data()).toEqual(before);
        expect(snapshot(raw)).toEqual(schema);
        expect(raw.query("PRAGMA integrity_check").all()).toEqual([
          { integrity_check: "ok" },
        ]);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        raw.close();
      }
    });

  for (const withdrawn of [false, true])
    it(`refuses phase 5 allowance evidence including withdrawn=${withdrawn}, atomically`, () => {
      const raw = new Database(":memory:");
      try {
        applyMigrationRange(raw, 0, 46);
        worksheet(raw);
        allowance(raw, withdrawn);
        raw.exec(
          "UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-02',finalised_at='2026-01-03' WHERE id=1",
        );
        const before = raw.serialize();
        expect(taxUpgradeImpact(raw)).toEqual({
          cleanupApplied: false,
          schedules: 0,
          manualAdjustments: 1,
          affectedRevisions: 1,
          finalisedRevisions: 1,
        });
        expect(() => migrateBook(raw)).toThrow(
          "Upgrade blocked before migration 0049",
        );
        expect(raw.serialize()).toEqual(before);
        expect(raw.query("PRAGMA foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
      } finally {
        raw.close();
      }
    });

  it("includes inactive schedules and older retained revisions, deduplicating affected revisions", () => {
    const raw = new Database(":memory:");
    try {
      applyMigrationRange(raw, 0, 48);
      worksheet(raw);
      allowance(raw);
      const evidence = JSON.stringify({
        calculationVersion: 2,
        currency: "MYR",
        rows: [],
        assets: [],
        utilisation: [],
      });
      raw
        .query(
          "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(1,0,?)",
        )
        .run(evidence);
      raw.exec(`UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-02',finalised_at='2026-01-03' WHERE id=1;
        INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,snapshot,source_hash,captured_at,request_key) VALUES(2,1,2,'{}','h2','2026-01-02','r2');`);
      expect(taxUpgradeImpact(raw)).toEqual({
        cleanupApplied: false,
        schedules: 1,
        manualAdjustments: 1,
        affectedRevisions: 1,
        finalisedRevisions: 1,
      });
      expect(() => migrateBook(raw)).toThrow("1 finalised");
    } finally {
      raw.close();
    }
  });

  it("permits existing current-format scheme evidence on a current book", () => {
    const raw = new Database(":memory:");
    try {
      migrateBook(raw);
      worksheet(raw);
      raw
        .query(
          "INSERT INTO tax_capital_schedules(revision_id,evidence) VALUES(1,?)",
        )
        .run(
          JSON.stringify({
            calculationVersion: 2,
            currency: "MYR",
            rows: [],
            assets: [],
            utilisation: [],
          }),
        );
      expect(taxUpgradeImpact(raw).cleanupApplied).toBe(true);
      expect(() => migrateBook(raw)).not.toThrow();
      expect(
        raw.query("SELECT count(*) AS n FROM tax_capital_schedules").get(),
      ).toEqual({ n: 1 });
    } finally {
      raw.close();
    }
  });

  it("checks a pending WAL book read-only without changing its database or WAL bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-tax-preflight-"));
    const path = join(dir, "copy.db");
    const raw = new Database(path);
    try {
      applyMigrationRange(raw, 0, 46);
      raw.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      worksheet(raw);
      allowance(raw);
      const before = [hash(path), hash(`${path}-wal`)];
      expect(() => assertTaxUpgradeSafe(checkTaxUpgradeAt(path))).toThrow(
        "1 allowance adjustments",
      );
      expect([hash(path), hash(`${path}-wal`)]).toEqual(before);
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create a missing database during preflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-tax-missing-"));
    try {
      const path = join(dir, "missing.db");
      expect(() => assertTaxUpgradeSafe(checkTaxUpgradeAt(path))).not.toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports and refuses affected evidence through the standalone copy preflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-tax-cli-"));
    const path = join(dir, "copy.db");
    const raw = new Database(path);
    try {
      applyMigrationRange(raw, 0, 46);
      worksheet(raw);
      allowance(raw, true);
    } finally {
      raw.close();
    }
    try {
      const before = hash(path);
      const command = Bun.spawnSync([
        process.execPath,
        "scripts/tax-upgrade-preflight.ts",
        "--copy",
        path,
      ]);
      expect(command.exitCode).toBe(1);
      expect(JSON.parse(command.stdout.toString())).toMatchObject({
        manualAdjustments: 1,
        affectedRevisions: 1,
        cleanupApplied: false,
      });
      expect(command.stderr.toString()).toContain(
        "Upgrade blocked before migration 0049",
      );
      expect(hash(path)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back pending schema changes when foreign-key validation fails", () => {
    const raw = new Database(":memory:");
    try {
      applyMigrationRange(raw, 0, 45);
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec(
        "INSERT INTO ledger_movements(record_id,account_id,amount_minor,sort_order) VALUES(999,999,100,0)",
      );
      const before = raw.serialize();
      expect(() => migrateBook(raw)).toThrow("foreign-key validation");
      expect(raw.serialize()).toEqual(before);
      expect(
        raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: 46 });
    } finally {
      raw.close();
    }
  });

  it("restores foreign-key enforcement when a competing writer prevents migration startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-migration-busy-"));
    const path = join(dir, "copy.db");
    const writer = new Database(path);
    let contender: Database | undefined;
    try {
      applyMigrationRange(writer, 0, 48);
      writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
      contender = new Database(path);
      contender.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
      expect(() => migrateBook(contender!)).toThrow();
      expect(contender.query("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(
        contender.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: 49 });
    } finally {
      writer.exec("ROLLBACK");
      contender?.close();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
