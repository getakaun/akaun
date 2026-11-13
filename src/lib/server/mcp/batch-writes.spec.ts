import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { LocalBlobStore } from "../storage/blob-store.js";
import { localsFor } from "../permissions/test-locals.js";
import { releaseBook } from "../application/__fixtures__/release-book.js";
import { createRecord } from "../application/records.js";
import { hashInput, runBatch } from "../application/batch.js";
import { batchToolResult } from "./batch-result.js";
import { createServerV2, defineWriteTool } from "./registry.js";

/**
 * The batch executor driven end to end: a test-only v2 write tool, built with
 * `defineWriteTool` and served by `createServerV2` over `InMemoryTransport`,
 * runs `createRecord` items through `runBatch` and answers with
 * `batchToolResult`. The book is a migrated in-memory one (`releaseBook`) and
 * files go to a folder under `os.tmpdir()`; never `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;

const RECORDS_WRITE = [
  {
    scopes: ["records:write" as const],
    permissions: ["records.create" as const],
  },
];

function createTestRecords(b: Book) {
  return defineWriteTool({
    base: "create_test_records",
    title: "Create test records",
    description: "Creates expense records in one atomic batch. Test only.",
    input: z.object({
      records: z
        .array(
          z.object({
            amount: z.number().positive(),
            date: z.string().optional(),
            category: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(60),
      dry_run: z.boolean().optional(),
      idempotency_key: z.string().min(1).max(200).optional(),
    }),
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    requirements: RECORDS_WRITE,
    handler: async (ctx, args, meta) => {
      const result = await runBatch(ctx, {
        tool: meta.name,
        dryRun: args.dry_run ?? false,
        items: args.records.map((record, i) => ({
          action: "create",
          label: `records[${i}]`,
          run: (c) =>
            createRecord(c, {
              kind: "expense",
              date: record.date ?? "2026-09-02",
              amount: record.amount,
              currency: "MYR",
              exchangeRate: 1,
              description: `Tool expense ${record.amount}`,
              categoryAccountId: record.category ?? b.expense,
              paidFromAccountId: b.bank,
            }),
        })),
        // The input without the key itself and without dry_run.
        idempotency: args.idempotency_key
          ? {
              key: args.idempotency_key,
              inputHash: hashInput({ records: args.records }),
            }
          : undefined,
      });
      return batchToolResult(result, {
        requestId: meta.requestId,
        formatValue: (value) => ({
          id: value.record.id,
          number: value.record.recordNumber,
          v: value.version,
        }),
      });
    },
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect() {
  const b = releaseBook();
  const storageRoot = mkdtempSync(join(tmpdir(), "akaun-batch-writes-"));
  const server = createServerV2({
    db: b.db,
    store: new LocalBlobStore(storageRoot),
    storageRoot,
    locals: localsFor([], { superuser: true }),
    tools: { reads: [], writes: [createTestRecords(b)] },
  });
  const client = new Client({ name: "batch-writes-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    b.raw.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "akaun_create_test_records",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, body: JSON.parse(text) };
  };
  return { b, call };
}

const records = (b: Book) =>
  (
    b.raw.query("SELECT COUNT(*) AS n FROM ledger_records").get() as {
      n: number;
    }
  ).n;

describe("a batch write tool", () => {
  it("answers a saved batch with every item and the request_id", async () => {
    const { b, call } = await connect();
    const { isError, body } = await call({
      records: [{ amount: 10 }, { amount: 20.5 }],
    });
    expect(isError).toBe(false);
    expect(body.saved).toBe(true);
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.items).toEqual([
      {
        n: 1,
        action: "create",
        label: "records[0]",
        id: expect.any(Number),
        number: expect.any(String),
        v: expect.any(String),
      },
      {
        n: 2,
        action: "create",
        label: "records[1]",
        id: expect.any(Number),
        number: expect.any(String),
        v: expect.any(String),
      },
    ]);
    expect(records(b)).toBe(2);
    // One request id groups the whole batch in the audit log.
    expect(
      b.raw
        .query(
          "SELECT DISTINCT request_id FROM audit_log WHERE request_id IS NOT NULL AND operation LIKE 'mcp:%'",
        )
        .all(),
    ).toEqual([{ request_id: body.request_id }]);
  });

  it("answers a dry run with the same item shape and saves nothing", async () => {
    const { b, call } = await connect();
    const { isError, body } = await call({
      records: [{ amount: 10 }, { amount: 20.5 }],
      dry_run: true,
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ saved: false, dry_run: true });
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "action",
      "id",
      "label",
      "n",
      "number",
      "v",
    ]);
    expect(records(b)).toBe(0);

    // The committed call reports the same records the dry run described.
    const saved = await call({ records: [{ amount: 10 }, { amount: 20.5 }] });
    expect(
      saved.body.items.map((i: { id: number; number: string }) => [
        i.id,
        i.number,
      ]),
    ).toEqual(
      body.items.map((i: { id: number; number: string }) => [i.id, i.number]),
    );
  });

  it("answers a failed batch with every item's outcome, and saves nothing", async () => {
    const { b, call } = await connect();
    const { isError, body } = await call({
      records: [
        { amount: 10 },
        { amount: 11, category: 99999 },
        { amount: 12, category: 99998 },
      ],
    });
    expect(isError).toBe(true);
    expect(body.error.message).toBe("Nothing was saved: 2 of 3 items failed.");
    expect(body.error.fix).toBeTruthy();
    expect(body.error.items).toHaveLength(3);
    expect(body.error.items[0]).toEqual({
      n: 1,
      action: "create",
      label: "records[0]",
      ok: true,
    });
    for (const item of body.error.items.slice(1)) {
      expect(item.error.code).toBe(body.error.code);
      expect(item.error.message).toBeTruthy();
    }
    expect(body.error.items.map((i: { n: number }) => i.n)).toEqual([1, 2, 3]);
    expect(records(b)).toBe(0);
  });

  it("replays a call with the same idempotency_key and refuses one with other input", async () => {
    const { b, call } = await connect();
    const first = await call({
      records: [{ amount: 7 }],
      idempotency_key: "spec-key",
    });
    const again = await call({
      records: [{ amount: 7 }],
      idempotency_key: "spec-key",
    });
    expect(again.isError).toBe(false);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(records(b)).toBe(1);

    const other = await call({
      records: [{ amount: 8 }],
      idempotency_key: "spec-key",
    });
    expect(other.isError).toBe(true);
    expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(records(b)).toBe(1);
  });

  it("refuses more items than one call takes", async () => {
    const { b, call } = await connect();
    const { isError, body } = await call({
      records: Array.from({ length: 51 }, (_, i) => ({ amount: i + 1 })),
    });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toMatch(/at most 50 items/);
    expect(records(b)).toBe(0);
  });
});
