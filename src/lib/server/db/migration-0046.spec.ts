import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";
describe("additive annual tax migration 0046", () => {
  for (const legacy of [false, true])
    it(`preserves financial and closing rows and restarts safely (legacy rename ${legacy})`, () => {
      const raw = new Database(":memory:");
      try {
        raw.exec(`PRAGMA legacy_alter_table = ${legacy ? "ON" : "OFF"}`);
        applyMigrationRange(raw, 0, 45);
        raw.exec(`INSERT INTO accounts(id, role, type, name, rank) VALUES (1, 1, 1, 'Bank', 'a'), (2, 6, 5, 'Fuel', 'b');
        INSERT INTO ledger_records(id, kind, date, description, amount, currency) VALUES (1, 1, '2025-01-01', 'Historical expense', 1000, 'MYR');
        INSERT INTO ledger_movements(id, record_id, account_id, amount_minor, sort_order) VALUES (1, 1, 2, 100000, 0), (2, 1, 1, -100000, 1);
        INSERT INTO settings(key, value) VALUES ('accounting.closedThrough', '2025-01-31');
        INSERT INTO audit_log(record_type, record_id, action, via) VALUES ('record', '1', 'create', 'system');`);
        const tables = [
          "accounts",
          "ledger_records",
          "ledger_movements",
          "settings",
          "audit_log",
          "depreciation_profiles",
          "depreciation_runs",
          "depreciation_postings",
          "settlements",
          "reconciliation_allocations",
        ];
        const before = tables.map((t) => raw.query(`SELECT * FROM ${t}`).all());
        raw.exec("PRAGMA foreign_keys=ON");
        applyMigrationRange(raw, 46, 46);
        expect(
          tables.map((t) => raw.query(`SELECT * FROM ${t}`).all()),
        ).toEqual(before);
        expect(raw.query("SELECT * FROM tax_worksheets").all()).toEqual([]);
        expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
        // Nothing remains to apply on restart; migration remains recorded once.
        applyMigrationRange(raw, 47, 46);
        expect(
          raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
        ).toEqual({ n: 47 });
        expect(
          raw
            .query(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'tax_%'",
            )
            .all().length,
        ).toBeGreaterThan(0);
      } finally {
        raw.close();
      }
    });
});
