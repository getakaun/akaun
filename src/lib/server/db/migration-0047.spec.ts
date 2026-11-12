import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";

describe("additive capital allowance migration 0047", () => {
  for (const legacy of [false, true])
    it(`preserves phase 1–5 financial and finalised evidence (legacy rename ${legacy})`, () => {
      const raw = new Database(":memory:");
      try {
        raw.exec(`PRAGMA legacy_alter_table=${legacy ? "ON" : "OFF"}`);
        applyMigrationRange(raw, 0, 46);
        raw.exec(`INSERT INTO accounts(id,role,type,name,rank) VALUES(1,1,1,'Bank','a'),(2,6,5,'Expense','b');
        INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(1,1,'2025-01-01','Expense',1000,'MYR');
        INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES(1,1,2,100000,0),(2,1,1,-100000,1);
        INSERT INTO settings(key,value) VALUES('accounting.closedThrough','2025-12-31');
        INSERT INTO audit_log(record_type,record_id,action,via) VALUES('record','1','create','system');
        INSERT INTO tax_worksheets(id,ya,date_from,date_to,request_key,created_at) VALUES(1,2025,'2025-01-01','2025-12-31','old-worksheet','2026-01-01');
        INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,status,snapshot,source_hash,captured_at,request_key,reviewed_at,finalised_at) VALUES(1,1,1,'finalised','{"calculationVersion":1}','old-hash','2026-01-01','old-revision','2026-01-02','2026-01-03');`);
        const tables = [
          "accounts",
          "ledger_records",
          "ledger_movements",
          "settings",
          "audit_log",
          "fixed_assets",
          "depreciation_profiles",
          "depreciation_runs",
          "depreciation_postings",
          "settlements",
          "reconciliation_allocations",
          "tax_worksheets",
          "tax_worksheet_revisions",
          "tax_worksheet_adjustments",
        ];
        const before = tables.map((t) => raw.query(`SELECT * FROM ${t}`).all());
        raw.exec("PRAGMA foreign_keys=ON");
        applyMigrationRange(raw, 47, 47);
        expect(
          tables.map((t) => raw.query(`SELECT * FROM ${t}`).all()),
        ).toEqual(before);
        expect(raw.query("SELECT * FROM tax_capital_schedules").all()).toEqual(
          [],
        );
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
        const evidence = JSON.stringify({
          calculationVersion: 1,
          currency: "MYR",
          rows: [],
          assets: [],
          utilisation: [],
        });
        expect(() =>
          raw
            .query(
              "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(1,1,?)",
            )
            .run(evidence),
        ).toThrow("immutable");
        raw.exec(
          `INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,status,snapshot,source_hash,captured_at,request_key) VALUES(2,1,2,'draft','{}','x','2026-01-04','new-revision');`,
        );
        expect(() =>
          raw
            .query(
              "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(2,1,?)",
            )
            .run("{}"),
        ).toThrow();
        raw
          .query(
            "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(2,1,?)",
          )
          .run(evidence);
        expect(() =>
          raw.exec(
            "UPDATE tax_capital_schedules SET active=0.5 WHERE revision_id=2",
          ),
        ).toThrow();
        expect(() =>
          raw.exec(
            "UPDATE tax_capital_schedules SET revision_id=1 WHERE revision_id=2",
          ),
        ).toThrow();
        expect(() =>
          raw.exec("DELETE FROM tax_capital_schedules WHERE revision_id=2"),
        ).toThrow("retained");
        applyMigrationRange(raw, 48, 47);
        expect(
          raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
        ).toEqual({ n: 48 });
      } finally {
        raw.close();
      }
    });
});
