import { Database } from "bun:sqlite";
import { describe, it, expect } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";

function seed(db: Database) {
  applyMigrationRange(db, 0, 48);
  db.exec(`
    INSERT INTO accounts(id,role,type,name,rank) VALUES(1,1,1,'Bank','a'),(2,6,5,'Expense','b');
    INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(1,1,'2025-01-01','Expense',1000,'MYR');
    INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order) VALUES(1,1,2,100000,0),(2,1,1,-100000,1);
    INSERT INTO settings(key,value) VALUES('tax.jurisdiction','MY');
    INSERT INTO audit_log(record_type,record_id,action,via) VALUES('record','1','create','system');
    INSERT INTO tax_worksheets(id,ya,date_from,date_to,request_key,created_at) VALUES
      (1,2025,'2025-01-01','2025-12-31','w1','2026-01-01'),
      (2,2024,'2024-01-01','2024-12-31','w2','2026-01-01'),
      (3,2023,'2023-01-01','2023-12-31','w3','2026-01-01'),
      (4,2022,'2022-01-01','2022-12-31','w4','2026-01-01');
    INSERT INTO tax_worksheet_revisions(id,worksheet_id,revision,snapshot,source_hash,captured_at,request_key) VALUES
      (1,1,1,'{"calculationVersion":1,"profitMinor":12345}','h1','2026-01-01','r1'),
      (2,1,2,'{"calculationVersion":1,"profitMinor":12345}','h2','2026-01-02','r2'),
      (3,2,1,'{"calculationVersion":1,"profitMinor":23456}','h3','2026-01-01','r3'),
      (4,3,1,'{"calculationVersion":1,"profitMinor":34567}','h4','2026-01-01','r4'),
      (5,4,1,'{"calculationVersion":1,"profitMinor":45678}','h5','2026-01-01','r5');
    INSERT INTO tax_worksheet_adjustments(id,revision_id,kind,amount_minor,balance_minor,origin_ya,reason,evidence,request_key,actor_name,created_at) VALUES
      (1,1,'capital_allowance',400,0,NULL,'Old manual claim','Working paper','a1','Owner','2026-01-01'),
      (2,2,'other',123,0,NULL,'Other adjustment','Working paper','a2','Owner','2026-01-01'),
      (3,2,'loss_brought_forward',100,1000,2024,'Unused business loss','Working paper','a3','Owner','2026-01-01'),
      (4,4,'allowance_brought_forward',200,500,2021,'Old allowance balance','Working paper','a4','Owner','2026-01-01');
    INSERT INTO tax_worksheet_adjustments(id,revision_id,kind,source_movement_id,percentage_bps,treatment,amount_minor,reason,evidence,request_key,actor_name,created_at)
      VALUES(5,2,'source',1,10000,'ordinary_deductible',0,'Annual treatment','Working paper','a5','Owner','2026-01-01');
    INSERT INTO asset_tax_schemes(id,family_key,version,definition,request_key,payload_hash,actor_name,created_at)
      VALUES(1,'scheme',1,'{"name":"Machinery","jurisdiction":"MY"}','scheme-request','scheme-hash','Owner','2026-01-01');
  `);
  const schedule = (version: number) =>
    JSON.stringify({
      calculationVersion: version,
      currency: "MYR",
      jurisdiction: "MY",
      assets: [],
      rows: [],
      utilisation: [],
      evidence: "Saved pre-release workings",
      predecessor: null,
    });
  db.query(
    "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(1,0,?)",
  ).run(schedule(1));
  db.query(
    "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(2,1,?)",
  ).run(schedule(2));
  db.query(
    "INSERT INTO tax_capital_schedules(revision_id,active,evidence) VALUES(5,0,?)",
  ).run(schedule(2));
  db.exec(`
    INSERT INTO tax_capital_commands(request_key,revision_id,payload_hash) VALUES
      ('old-manual',1,'x'),('old-scheme',2,'x'),('unaffected-master',3,'x'),('old-adjustment-master',4,'x'),('old-inactive',5,'x');
    UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-02',finalised_at='2026-01-03' WHERE id IN (1,2,3,5);
    UPDATE tax_worksheet_revisions SET status='reviewed',reviewed_at='2026-01-02' WHERE id=4;
  `);
}

const financialTables = [
  "accounts",
  "ledger_records",
  "ledger_movements",
  "fixed_assets",
  "depreciation_profiles",
  "depreciation_postings",
  "settlements",
  "reconciliation_allocations",
  "settings",
  "asset_tax_schemes",
  "tax_worksheets",
];
function financial(db: Database) {
  return financialTables.map((table) =>
    db.query(`SELECT * FROM ${table}`).all(),
  );
}

describe("scheme-only asset deductions migration 0049", () => {
  for (const legacy of [false, true])
    it(`clears pre-release workings, preserves financial sources and resets affected latest reviews (legacy rename ${legacy})`, () => {
      const db = new Database(":memory:");
      try {
        db.exec(`PRAGMA legacy_alter_table=${legacy ? "ON" : "OFF"}`);
        seed(db);
        const before = financial(db);
        const sourceSnapshots = db
          .query(
            "SELECT id,snapshot,source_hash,captured_at FROM tax_worksheet_revisions ORDER BY id",
          )
          .all();
        const oldAudit = db.query("SELECT * FROM audit_log WHERE id=1").get();
        applyMigrationRange(db, 49, 49);
        expect(financial(db)).toEqual(before);
        expect(
          db
            .query(
              "SELECT id,snapshot,source_hash,captured_at FROM tax_worksheet_revisions ORDER BY id",
            )
            .all(),
        ).toEqual(sourceSnapshots);
        expect(db.query("SELECT * FROM tax_capital_schedules").all()).toEqual(
          [],
        );
        expect(
          db.query("SELECT request_key FROM tax_capital_commands").all(),
        ).toEqual([{ request_key: "unaffected-master" }]);
        expect(
          db
            .query("SELECT id,kind FROM tax_worksheet_adjustments ORDER BY id")
            .all(),
        ).toEqual([
          { id: 2, kind: "other" },
          { id: 3, kind: "loss_brought_forward" },
          { id: 5, kind: "source" },
        ]);
        expect(
          db
            .query(
              "SELECT id,status,version,reviewed_at,finalised_at FROM tax_worksheet_revisions ORDER BY id",
            )
            .all(),
        ).toEqual([
          {
            id: 1,
            status: "finalised",
            version: 1,
            reviewed_at: "2026-01-02",
            finalised_at: "2026-01-03",
          },
          {
            id: 2,
            status: "draft",
            version: 2,
            reviewed_at: null,
            finalised_at: null,
          },
          {
            id: 3,
            status: "finalised",
            version: 1,
            reviewed_at: "2026-01-02",
            finalised_at: "2026-01-03",
          },
          {
            id: 4,
            status: "draft",
            version: 2,
            reviewed_at: null,
            finalised_at: null,
          },
          {
            id: 5,
            status: "draft",
            version: 2,
            reviewed_at: null,
            finalised_at: null,
          },
        ]);
        expect(db.query("SELECT * FROM audit_log WHERE id=1").get()).toEqual(
          oldAudit,
        );
        expect(
          db
            .query(
              "SELECT record_id FROM audit_log WHERE operation='migration:scheme-only-tax' ORDER BY record_id",
            )
            .all(),
        ).toEqual([{ record_id: "1" }, { record_id: "3" }, { record_id: "4" }]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          (
            db.query("PRAGMA table_info(tax_capital_schedules)").all() as {
              name: string;
            }[]
          ).map((column) => column.name),
        ).toEqual(["revision_id", "evidence"]);
        for (const kind of ["capital_allowance", "allowance_brought_forward"])
          expect(() =>
            db
              .query(
                "INSERT INTO tax_worksheet_adjustments(revision_id,kind,amount_minor,reason,evidence,request_key,actor_name,created_at) VALUES(2,?,100,'Disallowed manual claim','x',?,'x','2026-01-04')",
              )
              .run(kind, kind),
          ).toThrow();
        const evidence = {
          calculationVersion: 2,
          currency: "MYR",
          assets: [],
          rows: [],
          utilisation: [],
          predecessor: null,
          evidence: "",
        };
        expect(() =>
          db
            .query(
              "INSERT INTO tax_capital_schedules(revision_id,evidence) VALUES(2,?)",
            )
            .run(JSON.stringify({ ...evidence, calculationVersion: 1 })),
        ).toThrow();
        expect(() =>
          db
            .query(
              "INSERT INTO tax_capital_schedules(revision_id,evidence) VALUES(2,?)",
            )
            .run(
              JSON.stringify({
                ...evidence,
                rows: [{ treatment: "claim", initialMinor: 100 }],
              }),
            ),
        ).toThrow("require scheme");
        db.query(
          "INSERT INTO tax_capital_schedules(revision_id,evidence) VALUES(2,?)",
        ).run(JSON.stringify(evidence));
        expect(() =>
          db.exec(
            "UPDATE tax_worksheet_adjustments SET amount_minor=124 WHERE id=2",
          ),
        ).toThrow("instead of editing");
        expect(() =>
          db.exec("DELETE FROM tax_worksheet_adjustments WHERE id=2"),
        ).toThrow("retained");
        expect(() =>
          db.exec("UPDATE tax_worksheet_revisions SET version=2 WHERE id=3"),
        ).toThrow("immutable");
        db.exec(
          "UPDATE tax_worksheet_revisions SET status='finalised',reviewed_at='2026-01-04',finalised_at='2026-01-05' WHERE id=2",
        );
        expect(() =>
          db.exec(
            "UPDATE tax_capital_schedules SET evidence='{}' WHERE revision_id=2",
          ),
        ).toThrow();
        expect(() =>
          db.exec("DELETE FROM tax_capital_schedules WHERE revision_id=2"),
        ).toThrow("retained");
        const after = financial(db);
        applyMigrationRange(db, 49, 49);
        expect(financial(db)).toEqual(after);
        expect(
          db.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
        ).toEqual({ n: 50 });
      } finally {
        db.close();
      }
    });

  it("rolls the cleanup and review resets back if rebuilding fails", () => {
    const db = new Database(":memory:");
    try {
      seed(db);
      const tables = [
        "tax_worksheet_revisions",
        "tax_worksheet_adjustments",
        "tax_capital_schedules",
        "tax_capital_commands",
        "audit_log",
      ];
      const snapshot = () =>
        tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
      const before = snapshot();
      db.exec("CREATE TABLE __new_tax_worksheet_adjustments(id integer)");
      expect(() => applyMigrationRange(db, 49, 49)).toThrow();
      expect(snapshot()).toEqual(before);
      expect(
        db.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: 49 });
      expect(() =>
        db.exec("UPDATE tax_worksheet_revisions SET version=2 WHERE id=2"),
      ).toThrow("immutable");
      expect(() =>
        db.exec(
          "DELETE FROM tax_capital_commands WHERE request_key='old-manual'",
        ),
      ).toThrow("retained");
    } finally {
      db.close();
    }
  });
});
