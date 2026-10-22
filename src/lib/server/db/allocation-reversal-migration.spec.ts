import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { describe, expect, it } from "vitest";

/** Exercise the actual migration with an allocation predating reversal columns. */
describe("allocation reversal migration", () => {
  it.each([false, true])(
    "preserves allocation IDs and restrictions (all prior rows deleted: %s)",
    (empty) => {
      const sqlite = new Database(":memory:");
      try {
        migrate(drizzle(sqlite), { migrationsFolder: "drizzle" });
        sqlite.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE settlements;
        CREATE TABLE settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          payment_movement_id INTEGER NOT NULL REFERENCES ledger_movements(id) ON DELETE CASCADE,
          owed_movement_id INTEGER NOT NULL REFERENCES ledger_movements(id) ON DELETE CASCADE,
          amount_minor INTEGER NOT NULL,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')) NOT NULL
        );
        CREATE UNIQUE INDEX settlements_pair_idx ON settlements(payment_movement_id, owed_movement_id);
        CREATE INDEX settlements_owed_idx ON settlements(owed_movement_id);
        INSERT INTO accounts(id, name, type, role, rank) VALUES (1, 'Payable', 2, 2, 'a');
        INSERT INTO ledger_records(id, kind, date, description, amount, currency)
          VALUES (1, 4, '2026-03-01', 'Payment', 100, 'MYR'), (2, 1, '2026-03-01', 'Expense', 100, 'MYR');
        INSERT INTO ledger_movements(id, record_id, account_id, amount_minor, sort_order)
          VALUES (1, 1, 1, 10000, 0), (2, 2, 1, -10000, 0);
        INSERT INTO settlements(id, payment_movement_id, owed_movement_id, amount_minor)
          VALUES (99, 1, 2, 10000);
        DELETE FROM settlements WHERE id = 99;
        INSERT INTO settlements(id, payment_movement_id, owed_movement_id, amount_minor, created_at)
          VALUES (42, 1, 2, 10000, '2026-03-01 10:00:00');
        PRAGMA foreign_keys = ON;
      `);
        if (empty) sqlite.exec("DELETE FROM settlements");
        sqlite.exec(readFileSync("drizzle/0038_mysterious_mongu.sql", "utf8"));
        expect(sqlite.query("SELECT * FROM settlements").get()).toEqual(
          empty
            ? null
            : {
                id: 42,
                payment_movement_id: 1,
                owed_movement_id: 2,
                amount_minor: 10000,
                created_by: null,
                created_at: "2026-03-01 10:00:00",
                reversed_at: null,
                reversed_by: null,
                reversal_reason: null,
              },
        );
        expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          sqlite
            .query("PRAGMA foreign_key_list(settlements)")
            .all()
            .filter(
              (r) => (r as { table: string }).table === "ledger_movements",
            ),
        ).toEqual([
          expect.objectContaining({ on_delete: "RESTRICT" }),
          expect.objectContaining({ on_delete: "RESTRICT" }),
        ]);
        const allocate = () =>
          sqlite.exec(
            "INSERT INTO settlements(payment_movement_id, owed_movement_id, amount_minor) VALUES (1, 2, 6000)",
          );
        if (!empty) expect(allocate).toThrow();
        sqlite.exec(
          "UPDATE settlements SET reversed_at = '2026-03-02', reversal_reason = 'Incorrect allocation' WHERE id = 42",
        );
        allocate();
        expect(allocate).toThrow();
        expect(
          sqlite
            .query("SELECT id FROM settlements WHERE reversed_at IS NULL")
            .get(),
        ).toEqual({ id: 100 });
        expect(
          sqlite
            .query(
              "SELECT sum(amount_minor) AS total FROM settlements WHERE reversed_at IS NULL",
            )
            .get(),
        ).toEqual({ total: 6000 });
        for (const id of [1, 2]) {
          expect(() =>
            sqlite.exec(`DELETE FROM ledger_movements WHERE id = ${id}`),
          ).toThrow();
          expect(() =>
            sqlite.exec(`DELETE FROM ledger_records WHERE id = ${id}`),
          ).toThrow();
        }
        expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    },
  );
});
