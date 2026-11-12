import { Database } from "bun:sqlite";
import { describe, it, expect } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";
describe("asset tax schemes migration 0048", () => {
  for (const legacy of [false, true])
    it(`preserves original finalised evidence and restores all guards (legacy rename ${legacy})`, () => {
      const db = new Database(":memory:");
      try {
        db.exec(`PRAGMA legacy_alter_table=${legacy ? "ON" : "OFF"}`);
        applyMigrationRange(db, 0, 47);
        db.exec(`INSERT INTO tax_worksheets(id,ya,date_from,date_to,request_key,created_at) VALUES(1,2025,'2025-01-01','2025-12-31','worksheet','2026-01-01');
    INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,status,snapshot,source_hash,captured_at,request_key) VALUES(1,1,1,'draft','{"calculationVersion":1}','hash','2026-01-01','revision');`);
        const evidence =
          '{"calculationVersion":1,"currency":"MYR","assets":[],"rows":[],"utilisation":[],"evidence":"Existing manual schedule","predecessor":null}';
        db.query(
          "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(1,1,?)",
        ).run(evidence);
        db.exec(
          "UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-02',finalised_at='2026-01-03' WHERE id=1",
        );
        const tables = [
          "accounts",
          "ledger_records",
          "ledger_movements",
          "fixed_assets",
          "depreciation_profiles",
          "depreciation_postings",
          "tax_worksheets",
          "tax_worksheet_revisions",
          "tax_worksheet_adjustments",
          "tax_capital_schedules",
          "tax_capital_commands",
          "audit_log",
          "settings",
        ];
        const before = tables.map((table) =>
          db.query(`SELECT * FROM ${table}`).all(),
        );
        db.exec("PRAGMA foreign_keys=ON");
        applyMigrationRange(db, 48, 48);
        expect(
          tables.map((table) => db.query(`SELECT * FROM ${table}`).all()),
        ).toEqual(before);
        expect(
          db
            .query(
              "SELECT evidence FROM tax_capital_schedules WHERE revision_id=1",
            )
            .get(),
        ).toEqual({ evidence });
        expect(db.query("SELECT * FROM asset_tax_schemes").all()).toEqual([]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(() =>
          db.exec(
            "UPDATE tax_capital_schedules SET active=0 WHERE revision_id=1",
          ),
        ).toThrow("immutable");
        expect(() =>
          db.exec("DELETE FROM tax_capital_schedules WHERE revision_id=1"),
        ).toThrow("retained");
        db.exec(
          `INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,status,snapshot,source_hash,captured_at,request_key) VALUES(2,1,2,'draft','{}','hash','2026-01-04','revision-2');`,
        );
        const v2 = JSON.stringify({
          calculationVersion: 2,
          currency: "USD",
          jurisdiction: "GB",
          assets: [],
          rows: [],
          utilisation: [],
          evidence: "Custom unverified",
          predecessor: null,
        });
        db.query(
          "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(2,1,?)",
        ).run(v2);
        expect(() =>
          db.exec(
            "INSERT INTO tax_worksheet_adjustments(revision_id,kind,amount_minor,direction,reason,evidence,request_key,actor_name,created_at) VALUES(2,'capital_allowance',100,'decrease','Duplicate claim','x','dup','x','2026-01-04')",
          ),
        ).toThrow("supplies allowance");
        expect(() =>
          db.exec(
            "UPDATE tax_capital_schedules SET evidence='{}' WHERE revision_id=2",
          ),
        ).toThrow();
        applyMigrationRange(db, 49, 48);
        expect(
          db.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
        ).toEqual({ n: 49 });
      } finally {
        db.close();
      }
    });
});
