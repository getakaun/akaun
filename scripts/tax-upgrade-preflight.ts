import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertTaxUpgradeSafe,
  checkTaxUpgradeAt,
} from "../src/lib/server/db/tax-upgrade-guard.js";

// No env/configured client imports, no default database, no write/reset option.
const [flag, input, ...rest] = process.argv.slice(2);
if (
  flag !== "--copy" ||
  !input ||
  rest.length ||
  !isAbsolute(input) ||
  !existsSync(input)
) {
  console.error(
    "Usage: bun scripts/tax-upgrade-preflight.ts --copy /absolute/path/to/isolated-copy.db",
  );
  process.exit(2);
}
const path = realpathSync(input);
const data = resolve(import.meta.dir, "../data");
const within = relative(data, path);
if (
  !within ||
  (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))
) {
  console.error(
    "Refusing the repository data directory. Inspect an isolated backup copy instead.",
  );
  process.exit(2);
}
try {
  const impact = checkTaxUpgradeAt(path);
  console.log(JSON.stringify(impact, null, 2));
  assertTaxUpgradeSafe(impact);
  if (impact.cleanupApplied)
    console.log(
      "0049 is already recorded. This cannot establish whether earlier evidence was lost; compare pre-upgrade backups.",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
