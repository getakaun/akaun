import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema.js";
import type { LedgerDb } from "../../ledger/types.js";
import { localsFor } from "../../permissions/test-locals.js";
import {
  previewDepreciationMonth,
  postDepreciationMonth,
  runAutomaticDepreciation,
} from "../depreciation.js";
import { previewClosing, closeMonth } from "../closing.js";
import { readTaxWorksheet, saveTaxWorksheet } from "../tax-worksheets.js";
import { migrateBook } from "../../db/migrate-book.js";

// Spawned only by release-readiness.spec.ts with an explicit temporary book.
const [path, action] = process.argv.slice(2);
if (!path || !["post", "auto", "close", "tax", "migrate"].includes(action))
  throw Error("Invalid fixture invocation");
const raw = new Database(path);
raw.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const db = drizzle(raw, { schema }) as LedgerDb;
const ctx = { db, locals: localsFor([], { superuser: true }) };
const preview =
  action === "post"
    ? previewDepreciationMonth(ctx, "2025-01")
    : action === "close"
      ? previewClosing(ctx, { monthEnd: "2025-01-31" })
      : action === "tax"
        ? readTaxWorksheet(ctx, 1)
        : null;
console.log("ready");
const input = JSON.parse(await Bun.stdin.text());
try {
  if (preview && !preview.ok) throw Error(preview.reason);
  let result: unknown;
  if (action === "migrate") {
    migrateBook(raw);
    result = { ok: true };
  }
  if (action === "post" && preview?.ok)
    result = postDepreciationMonth(ctx, {
      month: "2025-01",
      expectedVersion: (preview.value as { version: string }).version,
    });
  if (action === "close" && preview?.ok)
    result = closeMonth(ctx, {
      monthEnd: "2025-01-31",
      revision: (preview.value as { revision: string }).revision,
    });
  if (action === "auto")
    result = { ok: true, value: runAutomaticDepreciation({ db }) };
  if (action === "tax" && preview?.ok) {
    const detail = preview.value;
    // The explicit type below also documents exactly what the child stages.
    const staged = detail as unknown as {
      revision: { version: number };
      liveHash: string;
      sourceHashes: Record<string, string>;
    };
    result = saveTaxWorksheet(ctx, 1, {
      action: "save-worksheet",
      target: "finalised",
      expectedVersion: staged.revision.version,
      liveHash: staged.liveHash,
      sourceHashes: staged.sourceHashes,
      requestKey: input.requestKey,
      adjustments: [],
      withdrawals: [],
    });
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  raw.close();
}
