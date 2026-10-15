import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { DATABASE_PATH } from "../env.js";
import { createLogger } from "../logger.js";
import * as schema from "./schema.js";
import {
  applySubTypeBackfill,
  classifyDatabaseFile,
  upgradeDatabaseFile,
} from "./auto-upgrade.js";
import {
  legacyDropAllowed,
  readLegacyDropStateAt,
} from "./legacy-drop-guard.js";
import { users } from "./schema.js";
import { seedGroups } from "../admin/seed-groups.js";

const log = createLogger("db");

const DEFAULT_ADMIN_PASSWORD = "akaun-admin";

function createDb() {
  mkdirSync(dirname(DATABASE_PATH), { recursive: true });

  // The installation upgrades itself, with no command and no setting (002
  // FR-037). Both states below are ones it cannot get out of on its own: a book
  // still on migration 0005 cannot start at all, because the guard below refuses
  // rather than let 0015 drop the tables its records are still in; and a book
  // converted to double-entry by an earlier release but never standardized starts
  // with every type and code null, no saved defaults, and the 18 seed accounts
  // inserted beside its own.
  //
  // The conversion runs against a copy and installs it only once every check has
  // passed, so a failure leaves this file byte-identical and the server does not
  // start — a half-standardized chart is worse than a refusal.
  const fileState = classifyDatabaseFile(DATABASE_PATH);
  if (fileState === "legacy_0005" || fileState === "ledger") {
    try {
      const result = upgradeDatabaseFile({ databasePath: DATABASE_PATH });
      log.info(
        {
          inputState: result.inputState,
          status: result.status,
          backupPath: result.backupPath,
          legacy: result.legacy,
          chart: result.chart,
        },
        "Converted the books to the standardized chart of accounts",
      );
      for (const item of result.chart.attentionItems) log.warn(item);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, "Automatic conversion failed");
      console.error(
        `\nThis installation's books could not be converted, so the server has not started. Your database has not been changed.\n\n${reason}\n`,
      );
      process.exit(1);
    }
  }

  // Before the database is opened for writing at all, and deliberately so.
  //
  // Kept as the last line of defence now that the conversion above runs by
  // itself: after a successful conversion this passes, and if the conversion was
  // skipped — an unsupported partial schema — it still refuses. Two independent
  // gates on the one invariant that cannot be undone from inside the app.
  //
  // This release's migration drops the tables an unconverted installation still
  // keeps its records in. If the conversion has not run, the server does not
  // start — and the file has to be left *byte-identical*, which is why the check
  // reads through its own read-only connection: opening this database for
  // writing sets `journal_mode` and checkpoints the WAL on close, which rewrites
  // the main file even when nothing logically changed (FR-037a, research.md
  // R-05).
  const allowed = legacyDropAllowed(readLegacyDropStateAt(DATABASE_PATH));
  if (!allowed.ok) {
    log.error(allowed.reason);
    console.error(`\n${allowed.reason}\n`);
    process.exit(1);
  }

  const raw = new Database(DATABASE_PATH);
  raw.exec("PRAGMA journal_mode = WAL;");

  const db = drizzle(raw, { schema });

  // Foreign keys are OFF for the migration and ON for everything after it, and
  // the order matters.
  //
  // A SQLite table is altered by rebuilding it: create the new shape, copy the
  // rows, drop the original, rename. With enforcement ON, that `DROP TABLE`
  // runs an implicit DELETE of every row first — which fires ON DELETE CASCADE
  // on the children. Rebuilding `invoices` would take its lines with it, and
  // rebuilding `bank_statements` would take every extracted statement line.
  //
  // The PRAGMA cannot go in the migration file: Drizzle wraps each migration in
  // BEGIN … COMMIT, and SQLite ignores `PRAGMA foreign_keys` inside a
  // transaction. So it is set here, on the connection, around the call.
  raw.exec("PRAGMA foreign_keys = OFF;");
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec("PRAGMA foreign_keys = ON;");

  // And then checked, because "off during the migration" is only safe if the
  // migration left the references intact. A violation here means a rebuild
  // above copied a row whose parent no longer exists.
  const violations = raw.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    log.error(
      { violations: violations.length },
      "Foreign key violations after migration",
    );
  }

  // Every boot, not gated on the conversion above: most installations reading
  // this are already past it, and the four seeded defaults still need their
  // sub-type set the first time this schema version runs against them.
  applySubTypeBackfill(raw);

  return { db, raw };
}

const { db } = createDb();
export { db };

export async function ensureDefaultAdmin(): Promise<void> {
  const exists = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, "admin"))
    .get();

  if (!exists) {
    const passwordHash = await hash(DEFAULT_ADMIN_PASSWORD);
    db.insert(users)
      .values({
        email: "admin@localhost",
        username: "admin",
        passwordHash,
        role: "owner",
      })
      .run();
    log.warn(
      `Default admin user created (username: admin, password: ${DEFAULT_ADMIN_PASSWORD}). Log in and change this password immediately.`,
    );
  }
}

/** The default groups, once, and the first superuser. See `admin/seed-groups.ts`. */
export function ensureGroupSeed(): void {
  seedGroups(db, log);
}

// `ensureDefaultCategories()` used to live here and ran on every boot. Its job
// passed to the ledger upgrade's account seeding
// (src/lib/server/ledger/upgrade/accounts.ts), which seeds the same default
// category names as accounts and does it once, so the deprecated `categories`
// table stops being written to (FR-006a, D-06, D-17).
