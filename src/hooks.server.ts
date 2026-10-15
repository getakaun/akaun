import { env } from "$env/dynamic/private";
import {
  db,
  ensureDefaultAdmin,
  ensureGroupSeed,
} from "$lib/server/db/client.js";
import { seedAccounts } from "$lib/server/db/seed-accounts.js";
import { setLogLevel } from "$lib/server/logger.js";
import { startImportWorker } from "$lib/server/import/worker.js";

import { createRequestHandle } from "$lib/server/request-hook.js";
import { oauth, config } from "$lib/server/oauth/runtime.js";

if (env.LOG_LEVEL) setLogLevel(env.LOG_LEVEL);

export const init = async () => {
  await ensureDefaultAdmin();
  // `applyRecordsPermission()` ran here, merging the old `expenses` and
  // `income` grid rows into `records`. Migration 0033 now reads those names
  // itself when it converts the grid to permission strings.
  ensureGroupSeed();
  // The chart of accounts a new installation starts with. An installation that
  // had books already has every seeded code by now — `db/auto-upgrade.ts` runs
  // before this, at module load in `createDb()`, and `migrateAccountChart` either
  // renames a legacy account onto each seeded name or creates the seed — so this
  // is a no-op there and only does work on a fresh install (research.md R-06).
  seedAccounts(db);
  // `ensureLedgerUpgrade()` was called here, and the conversion is self-running
  // again — but it cannot run from `init()`. `migrate()` applies 0015, which drops
  // the tables the conversion reads, and that happens at module load in
  // `createDb()`, long before this. So it moved *earlier* rather than away:
  // `db/auto-upgrade.ts`, called before the database is even opened for writing
  // (002 FR-037, research.md R-06).
  startImportWorker();
};

export const handle = createRequestHandle(db, oauth, config);
