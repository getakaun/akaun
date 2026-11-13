import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { runInAuditScope, scopeFromLocals } from "../audit-context.js";
import { DeferrableEmitter } from "../unit-of-work.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { localsFor } from "../permissions/test-locals.js";
import { batchToolResult } from "../mcp/batch-result.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import {
  createRecord,
  prepareVoidRecord,
  updateRecord,
  voidRecord,
  type RecordWritten,
} from "./records.js";
import { fail, ok } from "./result.js";
import type { AppContext } from "./context.js";
import {
  bindingOf,
  hashInput,
  MAX_BATCH_ITEMS,
  runBatch,
  type BatchItem,
  type BatchResult,
} from "./batch.js";

/**
 * The batch write executor at application level, against a migrated
 * in-memory book (`releaseBook`) and a storage folder under `os.tmpdir()`.
 * Never `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook> & {
  ctx: AppContext;
  storageRoot: string;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function book(): Book {
  const b = releaseBook();
  const storageRoot = mkdtempSync(join(tmpdir(), "akaun-batch-"));
  cleanups.push(() => {
    b.raw.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });
  return { ...b, ctx: { ...b.ctx, storageRoot }, storageRoot };
}

const expenseInput = (b: Book, amount: number, date = "2026-09-02") => ({
  kind: "expense" as const,
  date,
  amount,
  currency: "MYR",
  exchangeRate: 1,
  description: `Batch expense ${amount}`,
  categoryAccountId: b.expense,
  paidFromAccountId: b.bank,
});

function createItem(
  b: Book,
  amount: number,
  date?: string,
): BatchItem<RecordWritten> {
  return {
    action: "create",
    label: `expense ${amount}`,
    run: (ctx) => createRecord(ctx, expenseInput(b, amount, date)),
  };
}

function value<T>(result: BatchResult<T>) {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.value;
}

// --- snapshots --------------------------------------------------------------

/** A date with a time, also inside JSON text (`classifiedAt`). Plain dates stay. */
const TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g;

/**
 * The clock taken out: timestamps blanked, and `version` digests (which hash
 * them) dropped. Two runs of the same items differ in nothing else.
 */
function normalized(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TIMESTAMP, "<ts>");
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      if (k !== "version") out[k] = normalized(v);
    return out;
  }
  return value;
}

type Snapshot = Record<string, { count: number; digest: string }>;

/** Row count and an order-independent digest of every row, per table. */
function snapshot(b: Book, normalize = false): Snapshot {
  const names = (
    b.raw
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Snapshot = {};
  for (const name of names) {
    const rows = b.raw
      .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) =>
        JSON.stringify(normalize ? normalized(row) : row, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
        ),
      )
      .sort();
    out[name] = {
      count: rows.length,
      digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    };
  }
  return out;
}

const count = (b: Book, table: string) =>
  (b.raw.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number })
    .n;

function changedTables(before: Snapshot, after: Snapshot): string[] {
  return Object.keys(after).filter(
    (t) => after[t].digest !== before[t]?.digest,
  );
}

// --- events -----------------------------------------------------------------

/**
 * Every event an app bus DELIVERS (not merely emits): `DeferrableEmitter`
 * delivers through `super.emit`, which is looked up on the prototype at call
 * time, so wrapping the prototype sees deliveries only. Waits first for the
 * fixture's own `entry-added` microtasks, so they are not counted.
 */
async function deliveries() {
  await tick();
  const delivered: string[] = [];
  const original = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function (
    this: EventEmitter,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (this instanceof DeferrableEmitter) delivered.push(String(event));
    return original.call(this, event, ...args);
  } as typeof original;
  cleanups.push(() => {
    EventEmitter.prototype.emit = original;
  });
  return delivered;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const tally = (events: string[]) =>
  events.reduce<Record<string, number>>((acc, e) => {
    acc[e] = (acc[e] ?? 0) + 1;
    return acc;
  }, {});

// --- specs ------------------------------------------------------------------

describe("runBatch", () => {
  it("1. a dry run reports and writes exactly what the committed call does", async () => {
    const b = book();
    const existing = resultValue(createRecord(b.ctx, expenseInput(b, 40)));
    const voidVersion = resultValue(
      prepareVoidRecord(b.ctx, existing.record.id),
    ).version;
    const inside: Snapshot[] = [];
    const items = (): BatchItem<unknown>[] => [
      createItem(b, 11),
      {
        action: "void",
        label: `record ${existing.record.id}`,
        run: (ctx) =>
          voidRecord(ctx, existing.record.id, {
            reason: "Entered twice by mistake.",
            expectedVersion: voidVersion,
          }),
      },
      createItem(b, 12.5),
      // The book as the transaction sees it, just before it ends.
      {
        action: "probe",
        run: () => {
          inside.push(snapshot(b, true));
          return ok(null);
        },
      },
    ];
    // One audit scope for both calls, so the audit rows' request ids match.
    const scope = scopeFromLocals({}, "spec");
    const before = snapshot(b);
    const dry = value(
      await runInAuditScope(scope, () =>
        runBatch(b.ctx, { tool: "spec", dryRun: true, items: items() }),
      ),
    );
    expect(dry).toMatchObject({ saved: false, dryRun: true });
    expect(snapshot(b)).toEqual(before);

    const saved = value(
      await runInAuditScope(scope, () =>
        runBatch(b.ctx, { tool: "spec", dryRun: false, items: items() }),
      ),
    );
    expect(saved).toMatchObject({ saved: true, dryRun: false });
    expect(saved.requestId).toBe(scope.requestId);
    const after = snapshot(b, true);

    expect(normalized(dry.items)).toEqual(normalized(saved.items));
    expect(inside[0]).toEqual(inside[1]);
    expect(inside[1]).toEqual(after);
    const changed = changedTables(before, snapshot(b));
    expect(changed).toEqual(
      expect.arrayContaining([
        "ledger_records",
        "ledger_movements",
        "audit_log",
      ]),
    );
    console.log(
      `[batch] tables a committed batch changed: ${changed.join(", ")}`,
    );
  });

  it("2. a dry run leaves no rows, events, files or sequence changes behind", async () => {
    const b = book();
    const before = snapshot(b);
    const delivered = await deliveries();
    const dry = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: true,
        items: [createItem(b, 1), createItem(b, 2), createItem(b, 3)],
        idempotency: { key: "dry-key", inputHash: "h" },
      }),
    );
    await tick();
    expect(dry.saved).toBe(false);
    expect(dry.items.every((item) => item.ok)).toBe(true);
    const after = snapshot(b);
    expect(after).toEqual(before);
    expect(after.app_sequences).toEqual(before.app_sequences);
    expect(count(b, "mcp_idempotency")).toBe(0);
    expect(delivered).toEqual([]);
    expect(readdirSync(b.storageRoot)).toEqual([]);

    // The same items committed do write and do emit, so the above is not vacuous.
    value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [createItem(b, 1)],
      }),
    );
    expect(count(b, "ledger_records")).toBe(before.ledger_records.count + 1);
    expect(delivered.length).toBeGreaterThan(0);
  });

  it("3. one failing item rolls the whole call back, and every failure is reported", async () => {
    const b = book();
    const existing = resultValue(createRecord(b.ctx, expenseInput(b, 40)));
    resultValue(
      voidRecord(b.ctx, existing.record.id, {
        reason: "Entered twice by mistake.",
        expectedVersion: resultValue(
          prepareVoidRecord(b.ctx, existing.record.id),
        ).version,
      }),
    );
    const before = snapshot(b);
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          createItem(b, 5),
          {
            action: "void",
            label: `record ${existing.record.id}`,
            run: (ctx) =>
              voidRecord(ctx, existing.record.id, {
                reason: "Entered twice by mistake.",
                expectedVersion: resultValue(
                  prepareVoidRecord(ctx, existing.record.id),
                ).version,
              }),
          },
          {
            action: "create",
            label: "bad category",
            run: (ctx) =>
              createRecord(ctx, {
                ...expenseInput(b, 6),
                categoryAccountId: 99999,
              }),
          },
          createItem(b, 7),
        ],
      }),
    );
    expect(outcome.saved).toBe(false);
    expect(outcome.items.map((item) => item.ok)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(snapshot(b)).toEqual(before);

    const result = batchToolResult(
      { ok: true, value: outcome },
      { requestId: "r", formatValue: () => ({}) },
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text).error;
    expect(body.message).toBe("Nothing was saved: 2 of 4 items failed.");
    expect(body.items).toHaveLength(4);
    expect(body.items[0]).toEqual({
      n: 1,
      action: "create",
      label: "expense 5",
      ok: true,
    });
    expect(body.items[1].error.code).toBeDefined();
    expect(body.items[2].error.code).toBeDefined();
  });

  it("4. an item's partial writes are undone by its own savepoint", async () => {
    const b = book();
    const records = count(b, "ledger_records");
    const contacts = count(b, "contacts");
    const seen: Record<string, number> = {};
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          {
            // Saves a record (its own transaction commits to the savepoint), then refuses.
            action: "create-then-refuse",
            run: (ctx) => {
              resultValue(createRecord(ctx, expenseInput(b, 9)));
              return fail("REFUSED", "Changed my mind.");
            },
          },
          {
            action: "probe",
            run: () => {
              seen.records = count(b, "ledger_records");
              return ok(null);
            },
          },
          {
            // Writes outside any transaction of its own, then throws.
            action: "insert-then-throw",
            run: (ctx) => {
              ctx.db
                .insert(schema.contacts)
                .values({ legalName: "Half Written Sdn Bhd", entityType: 2 })
                .run();
              throw new Error("SQLITE_ERROR at /private/data/akaun.db");
            },
          },
          {
            action: "probe",
            run: () => {
              seen.contacts = count(b, "contacts");
              return ok(null);
            },
          },
          {
            action: "async-run",
            run: (() =>
              Promise.resolve(ok(1))) as unknown as BatchItem<unknown>["run"],
          },
          createItem(b, 10),
        ] as BatchItem<unknown>[],
      }),
    );
    expect(seen).toEqual({ records, contacts });
    expect(outcome.saved).toBe(false);
    const failures = outcome.items.flatMap((item) =>
      item.ok ? [] : [{ action: item.action, ...item.failure }],
    );
    expect(failures).toEqual([
      expect.objectContaining({
        action: "create-then-refuse",
        code: "REFUSED",
        reason: "Changed my mind.",
      }),
      expect.objectContaining({
        action: "insert-then-throw",
        batchCode: "INTERNAL_ERROR",
      }),
      expect.objectContaining({
        action: "async-run",
        batchCode: "INTERNAL_ERROR",
      }),
    ]);
    // Names the action, never the exception's text.
    expect(failures[1].reason).toContain('"insert-then-throw"');
    expect(failures[1].reason).not.toContain("akaun.db");
    expect(failures[2].reason).toContain('"async-run"');
    expect(count(b, "ledger_records")).toBe(records);
    expect(count(b, "contacts")).toBe(contacts);
  });

  it("5. a stale expected version is a CONFLICT and nothing is saved", async () => {
    const b = book();
    const existing = resultValue(createRecord(b.ctx, expenseInput(b, 40)));
    const before = snapshot(b);
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          createItem(b, 3),
          {
            action: "update",
            label: `record ${existing.record.id}`,
            run: (ctx) =>
              updateRecord(
                ctx,
                existing.record.id,
                { description: "Renamed" },
                "0000000000000000",
              ),
          },
        ],
      }),
    );
    expect(outcome.saved).toBe(false);
    const failed = outcome.items[1];
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.code).toBe("CONFLICT");
    expect(failed.failure.currentVersion).toBe(existing.version);
    expect(snapshot(b)).toEqual(before);

    const result = batchToolResult(
      { ok: true, value: outcome },
      { formatValue: () => ({}) },
    );
    const body = JSON.parse((result.content[0] as { text: string }).text).error;
    expect(body.code).toBe("CONFLICT");
    expect(body.items[1].error).toMatchObject({
      code: "CONFLICT",
      current_version: existing.version,
    });
  });

  describe("6. idempotency", () => {
    const counted = (b: Book, runs: { n: number }, amount: number) => ({
      ...createItem(b, amount),
      run: (ctx: AppContext) => {
        runs.n += 1;
        return createRecord(ctx, expenseInput(b, amount));
      },
    });

    it("replays the stored outcome without writing, with the first call's request id", async () => {
      const b = book();
      const runs = { n: 0 };
      const input = { records: [{ amount: 21 }, { amount: 22 }] };
      const call = (scope = scopeFromLocals({}, "spec")) =>
        runInAuditScope(scope, () =>
          runBatch(b.ctx, {
            tool: "create_records",
            dryRun: false,
            items: [counted(b, runs, 21), counted(b, runs, 22)],
            idempotency: { key: "k-1", inputHash: hashInput(input) },
          }),
        );
      const firstScope = scopeFromLocals({}, "spec");
      const first = value(await call(firstScope));
      expect(first.saved).toBe(true);
      expect(first.replayed).toBeUndefined();
      expect(count(b, "mcp_idempotency")).toBe(1);
      const before = snapshot(b);

      const again = value(await call());
      expect(again).toMatchObject({ saved: true, replayed: true });
      expect(again.requestId).toBe(firstScope.requestId);
      expect(again.items).toEqual(JSON.parse(JSON.stringify(first.items)));
      expect(runs.n).toBe(2);
      expect(snapshot(b)).toEqual(before);

      const payload = JSON.parse(
        (
          batchToolResult(
            { ok: true, value: again },
            {
              requestId: "new-request",
              formatValue: (v) => ({ id: v.record.id }),
            },
          ).content[0] as { text: string }
        ).text,
      );
      expect(payload).toMatchObject({
        saved: true,
        replayed: true,
        request_id: firstScope.requestId,
      });
    });

    it("refuses the same key with different input or another tool, and scopes keys to the credential", async () => {
      const b = book();
      const runs = { n: 0 };
      const items = () => [counted(b, runs, 31)];
      value(
        await runBatch(b.ctx, {
          tool: "create_records",
          dryRun: false,
          items: items(),
          idempotency: { key: "k-2", inputHash: hashInput({ a: 1 }) },
        }),
      );
      const before = snapshot(b);
      const differentInput = await runBatch(b.ctx, {
        tool: "create_records",
        dryRun: false,
        items: items(),
        idempotency: { key: "k-2", inputHash: hashInput({ a: 2 }) },
      });
      expect(differentInput).toMatchObject({
        ok: false,
        batchCode: "IDEMPOTENCY_MISMATCH",
      });
      const otherTool = await runBatch(b.ctx, {
        tool: "change_records",
        dryRun: false,
        items: items(),
        idempotency: { key: "k-2", inputHash: hashInput({ a: 1 }) },
      });
      expect(otherTool).toMatchObject({ batchCode: "IDEMPOTENCY_MISMATCH" });
      expect(snapshot(b)).toEqual(before);
      expect(runs.n).toBe(1);
      const error = JSON.parse(
        (
          batchToolResult(differentInput as BatchResult<RecordWritten>, {
            formatValue: () => ({}),
          }).content[0] as { text: string }
        ).text,
      ).error;
      expect(error.code).toBe("IDEMPOTENCY_MISMATCH");

      // The same key through a token is a different key.
      const viaToken: AppContext = {
        ...b.ctx,
        locals: {
          ...localsFor([], { superuser: true }),
          credential: { kind: "pat", tokenId: 7 },
        },
      };
      const throughToken = value(
        await runBatch(viaToken, {
          tool: "create_records",
          dryRun: false,
          items: items(),
          idempotency: { key: "k-2", inputHash: hashInput({ a: 2 }) },
        }),
      );
      expect(throughToken.replayed).toBeUndefined();
      expect(runs.n).toBe(2);
      expect(
        b.raw.query("SELECT binding FROM mcp_idempotency ORDER BY id").all(),
      ).toEqual([{ binding: "session:1" }, { binding: "pat:7" }]);
    });

    it("commits two interleaved calls with one key once", async () => {
      const b = book();
      const runs = { n: 0 };
      const records = count(b, "ledger_records");
      const item = (amount: number): BatchItem<RecordWritten> => ({
        ...counted(b, runs, amount),
        // Yields, so both calls pass the first lookup before either commits.
        prepare: async () => {
          await tick();
          return ok(null);
        },
      });
      const call = () =>
        runBatch(b.ctx, {
          tool: "create_records",
          dryRun: false,
          items: [item(41), item(42)],
          idempotency: { key: "k-3", inputHash: hashInput({ same: true }) },
        });
      const [a, c] = (await Promise.all([call(), call()])).map(value);
      expect(runs.n).toBe(2);
      expect(count(b, "ledger_records")).toBe(records + 2);
      expect(count(b, "mcp_idempotency")).toBe(1);
      expect([a.replayed, c.replayed].filter(Boolean)).toEqual([true]);
      expect(JSON.parse(JSON.stringify(a.items))).toEqual(
        JSON.parse(JSON.stringify(c.items)),
      );
    });

    it("sweeps rows older than 24 hours, and an expired key runs again", async () => {
      const b = book();
      const runs = { n: 0 };
      const old = "datetime('now', '-25 hours')";
      const stored = JSON.stringify({ items: [] });
      const binding = bindingOf(b.ctx.locals);
      for (const [key, at] of [
        ["expired", old],
        ["also-expired", old],
        ["fresh", "datetime('now', '-1 hours')"],
      ])
        b.raw
          .query(
            `INSERT INTO mcp_idempotency (user_id, binding, key, tool, input_hash, result, created_at)
             VALUES (1, ?, ?, 'create_records', ?, ?, ${at})`,
          )
          .run(binding, key, hashInput({ x: 1 }), stored);
      const outcome = value(
        await runBatch(b.ctx, {
          tool: "create_records",
          dryRun: false,
          items: [counted(b, runs, 51)],
          idempotency: { key: "expired", inputHash: hashInput({ x: 1 }) },
        }),
      );
      expect(outcome.replayed).toBeUndefined();
      expect(runs.n).toBe(1);
      expect(
        (
          b.raw.query("SELECT key FROM mcp_idempotency ORDER BY key").all() as {
            key: string;
          }[]
        ).map((r) => r.key),
      ).toEqual(["expired", "fresh"]);
    });

    it("neither stores nor looks up a key on a dry run", async () => {
      const b = book();
      const runs = { n: 0 };
      const idempotency = { key: "k-4", inputHash: hashInput({ y: 1 }) };
      value(
        await runBatch(b.ctx, {
          tool: "create_records",
          dryRun: false,
          items: [counted(b, runs, 61)],
          idempotency,
        }),
      );
      const dry = value(
        await runBatch(b.ctx, {
          tool: "create_records",
          dryRun: true,
          items: [counted(b, runs, 61)],
          idempotency,
        }),
      );
      expect(dry).toMatchObject({ saved: false, dryRun: true });
      expect(dry.replayed).toBeUndefined();
      expect(runs.n).toBe(2);
      expect(count(b, "mcp_idempotency")).toBe(1);
    });
  });

  it("7. a month closed between two calls makes the second refuse as a closed period", async () => {
    const b = book();
    value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [createItem(b, 70, "2026-09-02")],
      }),
    );
    setSetting(b.db, SETTING_KEYS.accountingClosedThrough, "2026-09-30");
    const before = snapshot(b);
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          createItem(b, 71, "2026-09-03"),
          createItem(b, 72, "2026-10-01"),
        ],
      }),
    );
    expect(outcome.saved).toBe(false);
    // Asserted field by field: Bun's toMatchObject writes an asymmetric
    // matcher back into the object it checks.
    const refused = outcome.items[0];
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("REFUSED");
    expect(refused.failure.reason).toMatch(
      /^Accounting is closed through 2026-09-30\./,
    );
    expect(outcome.items[1].ok).toBe(true);
    expect(snapshot(b)).toEqual(before);
    const body = JSON.parse(
      (
        batchToolResult(
          { ok: true, value: outcome },
          { formatValue: () => ({}) },
        ).content[0] as { text: string }
      ).text,
    ).error;
    expect(body.code).toBe("CLOSED_PERIOD");
    expect(body.items[0].error.code).toBe("CLOSED_PERIOD");
    expect(body.fix).toMatch(/reopen the month/);
  });

  it("8. events are delivered after commit, once per operation, and never for a dry run or a failed batch", async () => {
    const b = book();
    const delivered = await deliveries();
    // What one create delivers on its own, outside any batch.
    resultValue(createRecord(b.ctx, expenseInput(b, 1)));
    await tick();
    const one = tally(delivered);
    expect(one["record-update"]).toBe(1);
    delivered.length = 0;

    let duringTransaction = -1;
    const probe: BatchItem<unknown> = {
      action: "probe",
      run: () => {
        duringTransaction = delivered.length;
        return ok(null);
      },
    };
    value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          createItem(b, 2),
          createItem(b, 3),
          createItem(b, 4),
          probe,
        ] as BatchItem<unknown>[],
      }),
    );
    expect(duringTransaction).toBe(0);
    await tick();
    const three = tally(delivered);
    for (const [event, n] of Object.entries(one))
      expect(three[event]).toBe(3 * n);
    expect(Object.keys(three).sort()).toEqual(Object.keys(one).sort());

    delivered.length = 0;
    value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: true,
        items: [createItem(b, 5), createItem(b, 6)],
      }),
    );
    value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          createItem(b, 7),
          { action: "refuse", run: () => fail("REFUSED", "No.") },
        ] as BatchItem<unknown>[],
      }),
    );
    await tick();
    expect(delivered).toEqual([]);
  });

  it("9. fifty trivial creates finish well inside the timing cap", async () => {
    const b = book();
    const items = Array.from({ length: MAX_BATCH_ITEMS }, (_, i) =>
      createItem(b, i + 1),
    );
    const started = performance.now();
    const outcome = value(
      await runBatch(b.ctx, { tool: "spec", dryRun: false, items }),
    );
    const elapsed = performance.now() - started;
    console.log(
      `[batch] ${MAX_BATCH_ITEMS} createRecord items: ${elapsed.toFixed(0)} ms`,
    );
    expect(outcome.saved).toBe(true);
    expect(outcome.items).toHaveLength(MAX_BATCH_ITEMS);
    expect(elapsed).toBeLessThan(2000);
  });

  it("refuses an empty call, one over the cap, and an anonymous caller", async () => {
    const b = book();
    const empty = await runBatch(b.ctx, {
      tool: "spec",
      dryRun: false,
      items: [],
    });
    expect(empty).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const tooMany = await runBatch(b.ctx, {
      tool: "spec",
      dryRun: false,
      items: Array.from({ length: 51 }, () => createItem(b, 1)),
    });
    expect(tooMany).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    if (!tooMany.ok) expect(tooMany.reason).toMatch(/Split it/);
    const capped = await runBatch(b.ctx, {
      tool: "spec",
      dryRun: false,
      maxItems: 2,
      items: [createItem(b, 1), createItem(b, 2), createItem(b, 3)],
    });
    expect(capped).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const anonymous = await runBatch(
      { ...b.ctx, locals: { ...b.ctx.locals, user: null } },
      { tool: "spec", dryRun: false, items: [createItem(b, 1)] },
    );
    expect(anonymous).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(count(b, "ledger_records")).toBe(0);
  });

  it("reports every prepare failure and opens no transaction", async () => {
    const b = book();
    let ran = 0;
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: false,
        items: [
          {
            action: "a",
            prepare: async () => fail("RATE_UNAVAILABLE", "No rate for XYZ."),
            run: () => {
              ran += 1;
              return ok(1);
            },
          },
          {
            action: "b",
            prepare: async () => ok("fine"),
            run: () => {
              ran += 1;
              return ok(2);
            },
          },
          {
            action: "c",
            prepare: async () => {
              throw new Error("socket hang up");
            },
            run: () => {
              ran += 1;
              return ok(3);
            },
          },
        ],
      }),
    );
    expect(ran).toBe(0);
    expect(outcome.saved).toBe(false);
    expect(
      outcome.items.map((i) =>
        i.ok ? "ok" : i.skipped ? "skipped" : i.failure.code,
      ),
    ).toEqual(["RATE_UNAVAILABLE", "skipped", "REFUSED"]);
    const body = JSON.parse(
      (
        batchToolResult(
          { ok: true, value: outcome },
          { formatValue: () => ({}) },
        ).content[0] as { text: string }
      ).text,
    ).error;
    expect(body.message).toBe("Nothing was saved: 2 of 3 items failed.");
    expect(body.items[1]).toEqual({ n: 2, action: "b", skipped: true });
  });

  it("hands each item its prepared value", async () => {
    const b = book();
    const outcome = value(
      await runBatch(b.ctx, {
        tool: "spec",
        dryRun: true,
        items: [
          {
            action: "rate",
            prepare: async () => ok(4.25),
            run: (_ctx, prepared) => ok(prepared as number),
          },
        ],
      }),
    );
    expect(outcome.items[0]).toMatchObject({ ok: true, value: 4.25 });
  });
});

describe("hashInput and bindingOf", () => {
  it("ignores key order and absent fields", () => {
    expect(hashInput({ a: 1, b: [{ y: 2, x: 1 }] })).toBe(
      hashInput({ b: [{ x: 1, y: 2 }], a: 1, c: undefined }),
    );
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
    expect(hashInput([1, 2])).not.toBe(hashInput([2, 1]));
    expect(hashInput({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a key to the token, the app or the session", () => {
    const base = localsFor([], { userId: 4 });
    expect(bindingOf(base)).toBe("session:4");
    expect(
      bindingOf({ ...base, credential: { kind: "pat", tokenId: 9 } }),
    ).toBe("pat:9");
    expect(
      bindingOf({
        ...base,
        credential: { kind: "oauth", grantId: "g", clientId: "client-1" },
      }),
    ).toBe("oauth:client-1");
  });
});
