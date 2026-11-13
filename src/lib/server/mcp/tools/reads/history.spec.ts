import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { recordAudit } from "../../../audit.js";
import { runInAuditScope, scopeFromLocals } from "../../../audit-context.js";
import { getRecord } from "../../../queries/ledger.js";
import { historyReadTools } from "./history.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tool in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/history.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-history-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const locals = patLocals(book.db, `Bearer ${token}`)!;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: historyReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-history-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    book.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "akaun_get_change_history",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Loose,
      text,
    };
  };
  return { book, client, call, locals };
}

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

/** One request that changed a record, an invoice, a settlement and a user. */
function plantRequest(book: EvalBook, locals: App.Locals, tag = "new") {
  const scope = scopeFromLocals(locals, "mcp:test");
  const invoice = book.manifest.invoices.overdue.id;
  runInAuditScope(scope, () => {
    recordAudit(book.db, {
      recordType: "invoice",
      recordId: invoice,
      userId: book.agentUserId,
      action: "update",
      changes: [
        { field: "status", before: 2, after: 3 },
        { field: "amountMinor", before: 128500, after: 130000 },
        { field: "paymentMovementId", before: 11, after: 12 },
        { field: "reference", before: "old", after: tag },
      ],
    });
    recordAudit(book.db, {
      recordType: "settlement",
      recordId: 77,
      userId: book.agentUserId,
      action: "update",
      changes: [
        {
          field: "allocation",
          before: { owedMovementId: 5, paymentMovementId: 6 },
          after: null,
        },
      ],
    });
    recordAudit(book.db, {
      recordType: "user",
      recordId: 3,
      userId: book.agentUserId,
      action: "update",
      changes: [{ field: "name", before: "a", after: "b" }],
    });
  });
  return { requestId: scope.requestId, invoice };
}

describe("get_change_history", () => {
  it(
    "lists one tool with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["akaun_get_change_history"]);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[0].description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tools[0].description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
      // Administrative kinds and settlements are not item types an agent can ask for.
      const types = (tools[0].inputSchema.properties as Loose).item.properties
        .type.enum as string[];
      expect(types).toContain("record");
      for (const hidden of ["user", "group", "settings", "settlement"])
        expect(types).not.toContain(hidden);
    },
    SLOW,
  );

  it(
    "reads a record's trail by number or id, newest first, with names for coded values",
    async () => {
      const { book, call } = await open();
      const id = book.manifest.records.canvaPro;
      const number = getRecord(book.db, id)!.recordNumber!;
      const byNumber = await call({ item: { type: "record", id: number } });
      const byId = await call({ item: { type: "record", id } });
      expect(byNumber.isError).toBe(false);
      expect(byNumber.body.item).toEqual({ type: "record", id, label: number });
      expect(byNumber.body.entries).toEqual(byId.body.entries);
      expect(byNumber.body.entries.length).toBeGreaterThan(0);
      // Newest first: the file attached after it was made comes before its creation.
      expect(byNumber.body.entries[0]).toMatchObject({ action: "update" });
      const first = byNumber.body.entries.at(-1);
      expect(first).toMatchObject({ action: "create" });
      expect(typeof first.when).toBe("string");
      expect(first.when).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // A create lists the field names; full adds the values.
      expect(first.fields.length).toBeGreaterThan(0);
      expect(first.changes).toBeUndefined();
      const full = await call({
        item: { type: "record", id },
        detail: "full",
      });
      expect(full.body.entries.at(-1).changes.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "names coded values, shows money as decimal strings and never shows movement or settlement ids",
    async () => {
      const { book, call, locals } = await open();
      const { requestId, invoice } = plantRequest(book, locals);
      const trail = await call({ item: { type: "invoice", id: invoice } });
      expect(trail.isError).toBe(false);
      const update = trail.body.entries.find(
        (e: Loose) => e.action === "update" && e.changes,
      );
      expect(update.changes).toEqual([
        { field: "status", before: "Sent", after: "Paid" },
        { field: "amount", before: "1285.00", after: "1300.00" },
        { field: "reference", before: "old", after: "new" },
      ]);
      expect(update.via).toBe("pat");
      expect(update.who).toBeTypeOf("string");
      expect(update.credential).toBeTypeOf("string");

      const request = await call({ request: requestId });
      expect(request.isError).toBe(false);
      expect(
        [...keysOf(request.body)].filter((k) => /movement|settlement/i.test(k)),
      ).toEqual([]);
      expect(request.text).not.toMatch(/paymentMovementId|owedMovementId/);
    },
    SLOW,
  );

  it(
    "reads a request's entries across items, leaving out administrative kinds and settlement ids",
    async () => {
      const { book, call, locals } = await open();
      const { requestId, invoice } = plantRequest(book, locals);
      const { isError, body } = await call({ request: requestId });
      expect(isError).toBe(false);
      expect(body.request).toBe(requestId);
      const types = body.entries.map((e: Loose) => e.item.type).sort();
      expect(types).toEqual(["allocation", "invoice"]);
      const alloc = body.entries.find(
        (e: Loose) => e.item.type === "allocation",
      );
      expect(alloc.item).toEqual({ type: "allocation" });
      expect(alloc.changes).toBeUndefined();
      const inv = body.entries.find((e: Loose) => e.item.type === "invoice");
      expect(inv.item.id).toBe(invoice);
      expect(inv.changes.map((c: Loose) => c.field)).toEqual([
        "status",
        "amount",
        "reference",
      ]);
      // The administrative entry of the same request is never shown.
      expect(JSON.stringify(body)).not.toContain('"user"');

      // Narrower credentials see fewer kinds: contacts only sees none of these.
      const narrow = await open(["contacts.read"]);
      const none = plantRequest(narrow.book, narrow.locals);
      const refused = await narrow.call({ request: none.requestId });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("NOT_FOUND");
    },
    SLOW,
  );

  it(
    "applies v1's per-type read checks: the type's own read, and accounts read for a fixed asset",
    async () => {
      const contacts = await open(["contacts.read"]);
      const denied = await contacts.call({
        item: { type: "record", id: contacts.book.manifest.records.canvaPro },
      });
      expect(denied.isError).toBe(true);
      expect(denied.body.error.code).toBe("FORBIDDEN");
      const own = await contacts.call({
        item: { type: "contact", id: contacts.book.manifest.contacts.canva },
      });
      expect(own.isError).toBe(false);

      const records = await open(["records.read"]);
      const asset = await records.call({
        item: { type: "fixed_asset", id: 1 },
      });
      expect(asset.body.error.code).toBe("FORBIDDEN");
      const both = await open(["records.read", "accounts.read"]);
      const allowed = await both.call({ item: { type: "fixed_asset", id: 1 } });
      expect(allowed.isError).toBe(false);
      expect(allowed.body.note).toBe("No changes are recorded for this item.");
    },
    SLOW,
  );

  it(
    "pages a trail with a cursor that only works with the same filters",
    async () => {
      const { book, call, locals } = await open();
      const { invoice } = plantRequest(book, locals);
      for (let i = 0; i < 2; i++) plantRequest(book, locals, `ref-${i}`);
      const first = await call({
        item: { type: "invoice", id: invoice },
        limit: 1,
      });
      expect(first.body.entries).toHaveLength(1);
      expect(first.body.total).toBeGreaterThan(1);
      expect(first.body.next_cursor).toBeTypeOf("string");
      expect(first.body.note).toMatch(/^Showing 1–1 of /);
      const second = await call({
        item: { type: "invoice", id: invoice },
        limit: 1,
        cursor: first.body.next_cursor,
      });
      expect(second.body.entries).toHaveLength(1);
      expect(second.body.entries[0]).not.toEqual(first.body.entries[0]);
      const wrong = await call({
        item: { type: "invoice", id: invoice },
        limit: 1,
        detail: "full",
        cursor: first.body.next_cursor,
      });
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "answers INVALID_INPUT and NOT_FOUND with a fix",
    async () => {
      const { call } = await open();
      for (const args of [
        {},
        { item: { type: "record", id: 1 }, request: "abc" },
      ]) {
        const bad = await call(args);
        expect(bad.body.error.code).toBe("INVALID_INPUT");
        expect(bad.body.error.fix).toBeTypeOf("string");
      }
      const admin = await call({ item: { type: "user", id: 1 } });
      expect(admin.body.error.code).toBe("INVALID_INPUT");
      expect(admin.body.error.issues[0].path).toBe("item.type");

      const unknownNumber = await call({
        item: { type: "record", id: "EXP-1999-0001" },
      });
      expect(unknownNumber.body.error.code).toBe("NOT_FOUND");
      const unknownId = await call({ item: { type: "record", id: 987654 } });
      expect(unknownId.body.error.code).toBe("NOT_FOUND");
      const unknownRequest = await call({ request: "no-such-request" });
      expect(unknownRequest.body.error.code).toBe("NOT_FOUND");
      expect(unknownRequest.body.error.fix).toContain("request_id");
      const noInvoice = await call({
        item: { type: "invoice", id: "INV-NOPE" },
      });
      expect(noInvoice.body.error.code).toBe("NOT_FOUND");
    },
    SLOW,
  );
});
