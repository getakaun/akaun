/**
 * Explicit one-time operator command for the 51 payments approved on 2026-10-21.
 * No configured database import, env lookup, startup hook or implicit path.
 * First preview a copied database, then verify another copy, then apply against
 * the original only after backing up the complete database family.
 *
 * bun --preload ./scripts/mcp-test-preload.ts scripts/repair-approved-payment-recipients.ts preview /absolute/copy.db /absolute/manifest.json
 * ... verify /absolute/second-copy.db /absolute/manifest.json
 * ... apply /absolute/book.db /absolute/manifest.json /absolute/existing-backup.db
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/lib/server/db/schema.js";
import type { LedgerDb } from "../src/lib/server/ledger/types.js";
import { prepareRecipientCorrection } from "../src/lib/server/application/payment-recipient.js";
import {
  repairPaymentRecipients,
  type RecipientRepairManifest,
} from "../src/lib/server/application/repair-payment-recipients.js";
import { LEAF_PERMISSIONS } from "../src/lib/permissions/catalog.js";
import { localsFor } from "../src/lib/server/permissions/test-locals.js";
import { getRecord } from "../src/lib/server/queries/ledger.js";

const approvedIds = [
  203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217,
  218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232,
  233, 234, 235, 236, 237, 253, 254, 268, 269, 275, 282, 291, 292, 294, 304,
  319, 327, 341, 347, 361, 366,
];
const [mode, databasePath, manifestPath, backupPath] = process.argv.slice(2);
if (
  !["preview", "verify", "apply"].includes(mode) ||
  !databasePath ||
  !manifestPath ||
  !isAbsolute(databasePath) ||
  !isAbsolute(manifestPath) ||
  !existsSync(databasePath)
)
  throw new Error(
    "Provide preview|verify|apply, an existing absolute database path and an absolute manifest path.",
  );
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const expectedBaseHash =
  "f5907972ed738079e7a039b877af999bcbcdd4eb9c149ff63778e7077b94fe9f";
if (
  mode === "apply" &&
  (!backupPath ||
    !isAbsolute(backupPath) ||
    !existsSync(backupPath) ||
    hash(backupPath) !== expectedBaseHash ||
    hash(databasePath) !== expectedBaseHash)
)
  throw new Error(
    "The original database and explicit backup must match the approved base snapshot.",
  );
const sqlite = new Database(databasePath, { strict: true });
sqlite.exec("PRAGMA foreign_keys = ON");
const db = drizzle(sqlite, { schema }) as LedgerDb;
migrate(db, { migrationsFolder: "drizzle" });
const admin = db
  .select()
  .from(schema.contacts)
  .where(eq(schema.contacts.id, 90))
  .get();
const user = db
  .select()
  .from(schema.users)
  .where(eq(schema.users.username, "admin"))
  .get();
if (!admin || admin.legalName !== "admin" || !user)
  throw new Error("This is not the approved book.");
const ctx = { db, locals: localsFor(LEAF_PERMISSIONS, { userId: user.id }) };
function snapshot() {
  const records = db.select().from(schema.ledgerRecords).all();
  return {
    records,
    movements: db.select().from(schema.ledgerMovements).all(),
    bank: db.select().from(schema.reconciliationAllocations).all(),
    attachments: db.select().from(schema.recordAttachments).all(),
    settlements: db.select().from(schema.settlements).all(),
  };
}
function same(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Preservation check failed: ${label}`);
}
function verifyPreservation(before: ReturnType<typeof snapshot>) {
  const after = snapshot();
  same(
    after.movements.filter((m) =>
      before.movements.some((old) => old.id === m.id),
    ),
    before.movements,
    "original movement IDs, amounts and accounts",
  );
  same(after.bank, before.bank, "bank allocations");
  same(after.attachments, before.attachments, "attachments");
  for (const old of before.records) {
    const current = after.records.find((r) => r.id === old.id)!;
    if (!approvedIds.includes(old.id))
      same(current, old, `original record #${old.id}`);
    else {
      const immutable = (row: typeof old) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !["contactId", "updatedAt", "updatedBy"].includes(key),
          ),
        );
      same(
        immutable(current),
        immutable(old),
        `payment #${old.id} dates, numbers, amounts and metadata`,
      );
      if (current.contactId !== 90)
        throw new Error(`Payment #${old.id} was not attributed to admin.`);
    }
  }
  // Keep every valid same-contact allocation row (including its ID and timestamp).
  for (const old of before.settlements) {
    const source = before.movements.find(
      (m) => m.id === old.paymentMovementId,
    )!;
    if (!approvedIds.includes(source.recordId)) continue;
    const target = before.movements.find((m) => m.id === old.owedMovementId)!;
    if (before.records.find((r) => r.id === target.recordId)?.contactId === 90)
      same(
        after.settlements.find((s) => s.id === old.id),
        old,
        `valid allocation #${old.id}`,
      );
  }
  const totals = (movements: typeof before.movements) => {
    const sums = new Map<number, number>();
    for (const m of movements)
      sums.set(m.accountId, (sums.get(m.accountId) ?? 0) + m.amountMinor);
    return [...sums]
      .filter(([, total]) => total !== 0)
      .sort(([a], [b]) => a - b);
  };
  same(
    totals(after.movements),
    totals(before.movements),
    "all account balances (including profit and loss)",
  );
  if (sqlite.query("PRAGMA foreign_key_check").all().length)
    throw new Error("Foreign-key check failed.");
  same(
    sqlite.query("PRAGMA integrity_check").get(),
    { integrity_check: "ok" },
    "database integrity",
  );
  for (const record of after.records) {
    if (
      after.movements
        .filter((m) => m.recordId === record.id)
        .reduce((n, m) => n + m.amountMinor, 0) !== 0
    )
      throw new Error(`Unbalanced record #${record.id}`);
  }
}
try {
  if (mode === "preview") {
    if (existsSync(manifestPath))
      throw new Error("Do not overwrite an approved manifest.");
    const manifest: RecipientRepairManifest = {
      recipientId: 90,
      payments: approvedIds.map((recordId) => {
        const preview = prepareRecipientCorrection(ctx, recordId);
        if (!preview.ok) throw new Error(`#${recordId}: ${preview.reason}`);
        if (preview.value.dependencies.length)
          throw new Error(`#${recordId} has dependent allocations.`);
        return { recordId, expectedVersion: preview.value.version };
      }),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        previewed: manifest.payments.length,
        recipientId: 90,
        manifestPath,
      }),
    );
  } else {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as RecipientRepairManifest;
    same(
      manifest.payments.map((p) => p.recordId),
      approvedIds,
      "approved payment allowlist",
    );
    if (manifest.recipientId !== 90)
      throw new Error("Only approved recipient #90 is allowed.");
    const before = snapshot();
    db.transaction(() => {
      const result = repairPaymentRecipients(ctx, manifest, []);
      if (!result.ok) throw new Error(result.reason);
      verifyPreservation(before);
      const count = db.select().from(schema.ledgerRecords).all().length;
      const again = repairPaymentRecipients(ctx, manifest, []);
      if (!again.ok || !again.value.alreadyApplied)
        throw new Error("Idempotency check failed.");
      same(
        db.select().from(schema.ledgerRecords).all().length,
        count,
        "idempotent record count",
      );
      console.log(
        JSON.stringify({
          mode,
          corrected: result.value.correctedIds.length,
          groups: db.select().from(schema.reimbursements).all().length,
          payment219: getRecord(db, 219)?.contactId,
          preservation:
            "original records, movements, bank matches, attachments, valid allocations and account totals preserved",
        }),
      );
    });
  }
} finally {
  sqlite.close();
}
