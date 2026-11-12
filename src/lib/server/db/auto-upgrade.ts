import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  ExpenseSubType,
  LiabilitySubType,
  RevenueSubType,
} from "$lib/enums.js";
import {
  CHART_MIGRATION_VERSION,
  migrateAccountChart,
} from "../services/account-migration.js";
import { convertLegacyLedger } from "../services/legacy-ledger-migration.js";

/**
 * The conversion an installation runs on itself, with no command and no setting.
 *
 * 002 FR-037: "The update MUST complete with no manual step for a self-hosting
 * user, and MUST be safe to run more than once." This was a command for one
 * release — `scripts/migrate-chart-of-accounts.ts` — and a command is a manual
 * step. Worse, the two states it existed for are the two an installation cannot
 * recover from by itself: a book still on migration 0005 cannot start the server
 * at all, because `legacy-drop-guard` refuses rather than let 0015 destroy the
 * records; and a book already converted to double-entry but never standardized
 * starts happily with every `accounts.type` and `accounts.code` null and no
 * saved defaults, and nothing says so.
 *
 * **Nothing here mutates the supplied database.** The whole conversion runs
 * against a consolidated copy in a temporary directory beside it, and the copy is
 * moved into place only after the legacy conversion, the chart standardization,
 * the foreign-key check and the invariant comparison have all passed. The
 * original family is moved aside into a timestamped directory rather than
 * deleted, so the previous data stays recoverable (002 FR-038). A failure at any
 * point removes the temporary copy and leaves the original byte-identical.
 */

type MigrationFile = {
  sql: string[];
  folderMillis: number;
  hash: string;
};

/** What state the file on disk is in, and therefore what has to happen to it. */
export type DatabaseState =
  /** No file yet. A fresh installation seeds itself and needs no conversion. */
  | "fresh"
  /** The verified legacy schema: records still in `expenses`/`incomes`/`claims`. */
  | "legacy_0005"
  /** Double-entry, but the chart is not standardized yet. */
  | "ledger"
  /** Converted and standardized. Nothing to do. */
  | "completed"
  /** A partial schema no conversion path accepts. */
  | "unsupported";

export type UpgradeResult = {
  status: "completed" | "dry_run" | "already_completed";
  inputState: Exclude<DatabaseState, "fresh" | "unsupported">;
  legacy: ReturnType<typeof convertLegacyLedger> | null;
  chart: ReturnType<typeof migrateAccountChart>;
  foreignKeyViolations: number;
  backupPath: string | null;
};

/**
 * Read lazily, not at module load: `db/client.ts` imports this module on every
 * server boot, and an installation with nothing to convert must not read the
 * whole `drizzle/` folder to find that out.
 */
function migrationFiles(): MigrationFile[] {
  return readMigrationFiles({
    migrationsFolder: resolve("drizzle"),
  }) as MigrationFile[];
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function appliedIndex(db: Database, migrations: MigrationFile[]): number {
  if (!tableExists(db, "__drizzle_migrations")) return -1;
  const last = db
    .query(
      "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { created_at: number } | null;
  if (!last) return -1;
  return migrations.findIndex(
    (migration) => migration.folderMillis === Number(last.created_at),
  );
}

export function applyMigrationRange(
  db: Database,
  firstIndex: number,
  lastIndex: number,
  beforeMigrate?: () => void,
  afterMigrate?: () => void,
): void {
  const migrations = migrationFiles();
  db.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  db.exec("PRAGMA foreign_keys = OFF");
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    // Another process may finish the upgrade while we wait for this lock.
    // Reading the receipt earlier can replay destructive migrations on restart.
    const current = appliedIndex(db, migrations);
    if (current < firstIndex - 1) {
      throw new Error(
        `Refusing partial schema: expected migration ${firstIndex - 1}, found ${current}.`,
      );
    }
    beforeMigrate?.();
    for (
      let index = Math.max(firstIndex, current + 1);
      index <= lastIndex;
      index += 1
    ) {
      const migration = migrations[index];
      for (const statement of migration.sql) {
        if (statement.trim()) db.exec(statement);
      }
      db.query(
        "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)",
      ).run(migration.hash, migration.folderMillis);
    }
    afterMigrate?.();
    db.exec("COMMIT");
  } catch (error) {
    if (began) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * One-time classification of every Asset account's `sub_type`, run
 * unconditionally on every boot (005 FR-004).
 *
 * Idempotent by construction rather than by a version marker: every `UPDATE`
 * below is guarded by `sub_type IS NULL`, so an account already classified —
 * by this function on an earlier boot, or by hand — is never touched again.
 * `code` is the stable, unique key `seed-accounts.ts` uses (never the name),
 * so this recognizes only the four everyday defaults; every other Asset
 * account is deliberately left `NULL` ("needs review"), the state a user
 * resolves by hand (data-model.md's backfill table).
 */
export function applySubTypeBackfill(db: Database): void {
  // code -> [type, subType]. Same idempotent code-matched backfill as the
  // original four Asset defaults, extended to the Liability/Expense/Revenue
  // seed codes that are unambiguous from their name (`seed-accounts.ts`
  // mirrors this exact table for a fresh install). "Loans" (2100) is
  // deliberately absent — like "Marketplace Clearing" (1400), its name
  // doesn't say which sub-type it is, so it is left needs-review.
  const CODE_TO_SUB_TYPE: [code: number, type: number, subType: number][] = [
    [1000, AccountType.Asset, AccountSubType.Cash],
    [1100, AccountType.Asset, AccountSubType.Bank],
    [1200, AccountType.Asset, AccountSubType.Receivable],
    [1300, AccountType.Asset, AccountSubType.Inventory],
    [2000, AccountType.Liability, LiabilitySubType.AccountsPayable],
    [4000, AccountType.Revenue, RevenueSubType.OperatingRevenue],
    [4100, AccountType.Revenue, RevenueSubType.OtherRevenue],
    [5000, AccountType.Expense, ExpenseSubType.CostOfGoodsSold],
    [5100, AccountType.Expense, ExpenseSubType.OperatingExpense],
    [5200, AccountType.Expense, ExpenseSubType.OperatingExpense],
    [5300, AccountType.Expense, ExpenseSubType.OperatingExpense],
    [5400, AccountType.Expense, ExpenseSubType.OperatingExpense],
    [5500, AccountType.Expense, ExpenseSubType.OperatingExpense],
    [5900, AccountType.Expense, ExpenseSubType.OtherExpense],
  ];
  db.transaction(() => {
    // Startup repairs must not regroup previously reviewed reports. Older
    // conversion fixtures predate these tables and cannot have a closing boundary.
    const boundary =
      tableExists(db, "settings") &&
      tableExists(db, "ledger_records") &&
      tableExists(db, "ledger_movements")
        ? (
            db
              .query("SELECT value FROM settings WHERE key = ?")
              .get("accounting.closedThrough") as { value: string } | null
          )?.value || null
        : null;
    const protection = boundary
      ? " AND NOT EXISTS (SELECT 1 FROM ledger_movements m JOIN ledger_records r ON r.id = m.record_id WHERE m.account_id = accounts.id AND r.date <= ?)"
      : "";
    for (const [code, type, subType] of CODE_TO_SUB_TYPE) {
      db.query(
        "UPDATE accounts SET sub_type = ? WHERE type = ? AND sub_type IS NULL AND code = ?" +
          protection,
      ).run(subType, type, code, ...(boundary ? [boundary] : []));
    }
    // An account already carrying the legacy Equipment role, from an earlier
    // release's legacy conversion — `subType`, not `role`, is what every live
    // reader checks going forward (005 research.md §12).
    db.query(
      "UPDATE accounts SET sub_type = ? WHERE type = ? AND sub_type IS NULL AND role = ?" +
        protection,
    ).run(
      AccountSubType.Equipment,
      AccountType.Asset,
      AccountRole.Equipment,
      ...(boundary ? [boundary] : []),
    );
  }).immediate();
}

function consolidate(source: string, destination: string): void {
  const sourceDb = new Database(source, { readonly: true });
  try {
    sourceDb.query("VACUUM INTO ?").run(destination);
  } finally {
    sourceDb.close();
  }
}

function classify(db: Database): DatabaseState {
  const index = appliedIndex(db, migrationFiles());
  if (
    index === 5 &&
    tableExists(db, "expenses") &&
    !tableExists(db, "accounts")
  ) {
    return "legacy_0005";
  }
  if (
    index >= 14 &&
    tableExists(db, "accounts") &&
    tableExists(db, "ledger_records")
  ) {
    return index >= 16 && chartStandardized(db) ? "completed" : "ledger";
  }
  return "unsupported";
}

/** Has the composed chart conversion actually finished on this database? */
function chartStandardized(db: Database): boolean {
  if (!tableExists(db, "account_migration_runs")) return false;
  return Boolean(
    db
      .query(
        "SELECT 1 FROM account_migration_runs WHERE version = ? AND status = 'completed'",
      )
      .get(CHART_MIGRATION_VERSION),
  );
}

/**
 * What has to happen to the file at `databasePath`, read without writing to it.
 *
 * Its own read-only connection, for the same reason `readLegacyDropStateAt` has
 * one: a read-write handle sets `journal_mode` and checkpoints the WAL back into
 * the main file on close, so it rewrites the database before any decision about
 * it has been made.
 */
export function classifyDatabaseFile(databasePath: string): DatabaseState {
  if (!existsSync(databasePath)) return "fresh";
  const raw = new Database(databasePath, { readonly: true });
  try {
    return classify(raw);
  } finally {
    raw.close();
  }
}

function databaseFamilyChecksum(path: string): string {
  const digest = createHash("sha256");
  for (const suffix of ["", "-wal", "-shm"]) {
    const member = `${path}${suffix}`;
    digest.update(suffix);
    digest.update(existsSync(member) ? readFileSync(member) : "<absent>");
  }
  return digest.digest("hex");
}

function installResult(source: string, working: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupDir = join(dirname(source), `pre-chart-${stamp}`);
  mkdirSync(backupDir);
  for (const suffix of ["", "-wal", "-shm"]) {
    const original = `${source}${suffix}`;
    if (existsSync(original)) {
      renameSync(original, join(backupDir, `akaun.db${suffix}`));
    }
  }
  try {
    renameSync(working, source);
  } catch (error) {
    const backup = join(backupDir, "akaun.db");
    if (!existsSync(source) && existsSync(backup)) renameSync(backup, source);
    throw error;
  }
  return backupDir;
}

export function upgradeDatabaseFile(options: {
  databasePath: string;
  dryRun?: boolean;
}): UpgradeResult {
  const source = resolve(options.databasePath);
  if (!isAbsolute(source) || !existsSync(source)) {
    throw new Error("The database to upgrade must be an existing SQLite path.");
  }
  const temporaryDir = mkdtempSync(join(dirname(source), ".akaun-chart-"));
  const working = join(temporaryDir, "working.db");
  consolidate(source, working);
  const originalChecksum = databaseFamilyChecksum(source);
  let backupPath: string | null = null;
  try {
    const db = new Database(working);
    db.exec("PRAGMA foreign_keys = ON");
    const inputState = classify(db);
    if (inputState === "unsupported" || inputState === "fresh") {
      throw new Error(
        "Unsupported partial database state. Restore the original backup and retry from migration 0005 or a completed ledger conversion.",
      );
    }
    let legacy: ReturnType<typeof convertLegacyLedger> | null = null;

    if (inputState === "legacy_0005") {
      applyMigrationRange(db, 6, 14);
      legacy = db.transaction(() => convertLegacyLedger(db))();
      applyMigrationRange(db, 15, 16);
    } else if (inputState === "ledger") {
      applyMigrationRange(db, appliedIndex(db, migrationFiles()) + 1, 16);
    }

    const chart = migrateAccountChart(db);
    const foreignKeyViolations = db
      .query("PRAGMA foreign_key_check")
      .all().length;
    if (foreignKeyViolations !== 0) {
      throw new Error(
        `Conversion produced ${foreignKeyViolations} foreign-key violations.`,
      );
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    if (databaseFamilyChecksum(source) !== originalChecksum) {
      throw new Error(
        "The source database changed while conversion was running.",
      );
    }
    if (!options.dryRun && chart.status !== "already_completed") {
      backupPath = installResult(source, working);
    }
    return {
      status: options.dryRun
        ? "dry_run"
        : chart.status === "already_completed"
          ? "already_completed"
          : "completed",
      inputState,
      legacy,
      chart,
      foreignKeyViolations,
      backupPath,
    };
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}
