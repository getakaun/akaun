import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";

describe("additive expense tax migration 0041", () => {
  it("keeps historical amounts, IDs, allocation history, audit and closed settings byte-for-byte at row level", () => {
    const raw = new Database(":memory:");
    try {
      applyMigrationRange(raw, 0, 40);
      raw.exec(`
        INSERT INTO accounts(id, role, type, name, rank) VALUES (1, 1, 1, 'Bank', 'a'), (2, 6, 5, 'Fuel', 'b');
        INSERT INTO ledger_records(id, kind, date, description, amount, currency, exchange_rate) VALUES (1, 1, '2026-01-01', 'Historical expense', 1000, 'MYR', 1);
        INSERT INTO ledger_movements(id, record_id, account_id, amount_minor, sort_order) VALUES (1, 1, 2, 100000, 0), (2, 1, 1, -100000, 1);
        INSERT INTO accounts(id, role, type, name, rank) VALUES (3, 2, 2, 'Payable', 'c');
        INSERT INTO ledger_records(id, kind, date, description, amount, currency) VALUES (2, 1, '2026-01-02', 'Bill', 50, 'MYR'), (3, 4, '2026-01-03', 'Payment', 50, 'MYR');
        INSERT INTO ledger_movements(id, record_id, account_id, amount_minor, sort_order) VALUES (3, 2, 2, 5000, 0), (4, 2, 3, -5000, 1), (5, 3, 3, 5000, 0), (6, 3, 1, -5000, 1);
        INSERT INTO settlements(id, payment_movement_id, owed_movement_id, amount_minor) VALUES (42, 5, 4, 5000);
        INSERT INTO settings(key, value) VALUES ('accounting.closedThrough', '2026-01-31');
        INSERT INTO audit_log(record_type, record_id, action, via) VALUES ('record', '1', 'create', 'system');
      `);
      const records = raw.query("SELECT * FROM ledger_records").all();
      const movements = raw.query("SELECT * FROM ledger_movements").all();
      const accounts = raw.query("SELECT * FROM accounts").all();
      const allocations = raw.query("SELECT * FROM settlements").all();
      const audit = raw.query("SELECT * FROM audit_log").all();
      raw.exec("PRAGMA foreign_keys = ON");
      applyMigrationRange(raw, 41, 41);
      expect(raw.query("SELECT * FROM ledger_records").all()).toEqual(records);
      expect(raw.query("SELECT * FROM ledger_movements").all()).toEqual(
        movements.map((m) => ({ ...(m as object), tax_classification: null })),
      );
      expect(raw.query("SELECT * FROM accounts").all()).toEqual(
        accounts.map((a) => ({
          ...(a as object),
          default_tax_percentage_bps: null,
          default_tax_treatment: null,
        })),
      );
      expect(raw.query("SELECT * FROM audit_log").all()).toEqual(audit);
      expect(raw.query("SELECT * FROM settlements").all()).toEqual(allocations);
      expect(
        raw
          .query(
            "SELECT value FROM settings WHERE key = 'accounting.closedThrough'",
          )
          .get(),
      ).toEqual({ value: "2026-01-31" });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() =>
        raw.exec(
          "UPDATE accounts SET default_tax_percentage_bps = 1.5 WHERE id = 2",
        ),
      ).toThrow();
      expect(() =>
        raw.exec(
          "UPDATE accounts SET default_tax_percentage_bps = 10000 WHERE id = 1",
        ),
      ).toThrow();
      for (const invalid of [
        "{}",
        '{"percentageBps":10001,"source":"override","treatment":"partial"}',
        "not json",
      ]) {
        expect(() =>
          raw
            .query(
              "UPDATE ledger_movements SET tax_classification = ? WHERE id = 1",
            )
            .run(invalid),
        ).toThrow();
      }
    } finally {
      raw.close();
    }
  });
});
