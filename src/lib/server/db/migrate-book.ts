import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrationRange } from "./auto-upgrade.js";
import { assertTaxUpgradeSafe, taxUpgradeImpact } from "./tax-upgrade-guard.js";

/** Recheck after acquiring the migration writer lock, before applying any SQL. */
export function migrateBook(raw: Database): void {
  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
  applyMigrationRange(
    raw,
    0,
    migrations.length - 1,
    () => assertTaxUpgradeSafe(taxUpgradeImpact(raw)),
    () => {
      if (raw.query("PRAGMA foreign_key_check").all().length)
        throw new Error(
          "Database migration failed foreign-key validation; migration changes were rolled back.",
        );
    },
  );
}
