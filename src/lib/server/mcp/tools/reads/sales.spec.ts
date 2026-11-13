import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken, localsFor } from "../../../permissions/test-locals.js";
import { createQuotation } from "../../../application/sales.js";
import {
  invoiceVersion,
  quotationVersion,
} from "../../../application/version.js";
import { money } from "../../format.js";
import { salesReadTools } from "./sales.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tool in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/sales.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-sales-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: salesReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-sales-spec", version: "1" });
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
  const replies: string[] = [];
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "akaun_get_sales_documents",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Loose,
      text,
    };
  };
  return { book, client, call, replies };
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

const noInternalIds = (replies: string[]) => {
  for (const text of replies)
    expect(
      [...keysOf(JSON.parse(text))].filter((k) =>
        /movement|settlement/i.test(k),
      ),
    ).toEqual([]);
};

/** A draft quotation for the book's overdue-invoice customer. */
function addQuotation(book: EvalBook) {
  const made = createQuotation(
    {
      db: book.db,
      locals: localsFor([], { superuser: true, userId: book.ownerId }),
      store: book.store,
      storageRoot: book.storageRoot,
    },
    {
      contactId: book.manifest.contacts.majuJaya,
      issueDate: "2026-11-01",
      expiryDate: "2026-11-30",
      reference: "RFQ-7",
      lines: [
        { description: "Kraft mailer boxes", quantity: 10, unitPrice: 12.5 },
      ],
    },
  );
  if (!made.ok) throw new Error(made.reason);
  return made.value.quotation;
}

describe("get_sales_documents", () => {
  it(
    "is one read-only tool whose kind is required, with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["akaun_get_sales_documents"]);
      const [tool] = tools;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.required).toContain("kind");
      expect(tool.description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tool.description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
    },
    SLOW,
  );

  it(
    "lists invoices with their amounts, outstanding and version, and filters overdue ones",
    async () => {
      const { book, call, replies } = await open();
      const { isError, body } = await call({ kind: "invoice" });
      expect(isError).toBe(false);
      expect(body.currency).toBe("MYR");
      expect(body.invoices.map((i: Loose) => i.id).sort()).toEqual(
        Object.values(book.manifest.invoices)
          .map((i) => i.id)
          .sort(),
      );
      const overdue = book.manifest.invoices.overdue;
      const row = body.invoices.find((i: Loose) => i.id === overdue.id);
      expect(row).toMatchObject({
        no: overdue.number,
        status: "sent",
        overdue: true,
        amount: money(overdue.totalMinor),
        outstanding: money(overdue.totalMinor),
        v: invoiceVersion(book.db, overdue.id),
      });
      expect(row.contact).toBeTypeOf("string");
      // The book's invoices are in USD: the row names its own currency.
      expect(row.currency).toBe("USD");

      const late = await call({ kind: "invoice", overdue: true });
      expect(late.body.invoices.map((i: Loose) => i.id)).toEqual([overdue.id]);

      const paid = await call({ kind: "invoice", status: "paid" });
      expect(paid.body.invoices.map((i: Loose) => i.id)).toEqual([
        book.manifest.invoices.paid.id,
      ]);
      expect(paid.body.invoices[0].outstanding).toBe("0.00");

      const month = await call({
        kind: "invoice",
        period: book.manifest.invoices.paid.issueDate.slice(0, 7),
      });
      expect(
        month.body.invoices.some(
          (i: Loose) => i.id === book.manifest.invoices.paid.id,
        ),
      ).toBe(true);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "reads one invoice by id or number with its lines, record and the payments that settled it",
    async () => {
      const { book, call, replies } = await open();
      const paid = book.manifest.invoices.paid;
      const byId = await call({ kind: "invoice", id: paid.id });
      const byNumber = await call({ kind: "invoice", id: paid.number });
      expect(byNumber.body).toEqual(byId.body);
      const doc = byId.body;
      expect(doc).toMatchObject({
        kind: "invoice",
        id: paid.id,
        no: paid.number,
        status: "paid",
        currency: "MYR",
        amount: money(paid.totalMinor),
        paid: money(paid.totalMinor),
        outstanding: "0.00",
        v: invoiceVersion(book.db, paid.id),
      });
      expect(doc.lines).toHaveLength(1);
      expect(doc.lines[0]).toMatchObject({
        description: expect.any(String),
        quantity: expect.any(Number),
        unit_price: expect.stringMatching(/^\d+\.\d{2}$/),
        total: expect.stringMatching(/^\d+\.\d{2}$/),
      });
      expect(doc.record).toMatchObject({ id: paid.recordId });
      expect(doc.record.no).toBeTypeOf("string");
      expect(doc.payments.length).toBeGreaterThan(0);
      expect(doc.payments[0].no).toBeTypeOf("string");
      expect(doc.payments[0].amount).toMatch(/^\d+\.\d{2}$/);
      expect(
        doc.payments.reduce(
          (sum: number, p: Loose) => sum + Math.round(Number(p.amount) * 100),
          0,
        ),
      ).toBe(paid.totalMinor);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "reads quotations: a list, a document with lines, and the status filter",
    async () => {
      const { book, call } = await open();
      const quotation = addQuotation(book);
      const list = await call({ kind: "quotation" });
      expect(list.isError).toBe(false);
      expect(list.body.quotations).toHaveLength(1);
      expect(list.body.quotations[0]).toMatchObject({
        id: quotation.id,
        no: quotation.quotationNumber,
        status: "draft",
        expires: "2026-11-30",
        amount: "125.00",
        v: quotationVersion(book.db, quotation.id),
      });
      const one = await call({
        kind: "quotation",
        id: quotation.quotationNumber,
      });
      expect(one.body).toMatchObject({
        kind: "quotation",
        id: quotation.id,
        status: "draft",
        reference: "RFQ-7",
        amount: "125.00",
      });
      expect(one.body.lines).toEqual([
        {
          description: "Kraft mailer boxes",
          quantity: 10,
          unit_price: "12.50",
          total: "125.00",
        },
      ]);
      expect(
        (await call({ kind: "quotation", status: "sent" })).body.quotations,
      ).toBeUndefined();
      expect(
        (
          await call({
            kind: "quotation",
            contact: book.manifest.contacts.majuJaya,
          })
        ).body.quotations,
      ).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "pages with a cursor tied to the filters",
    async () => {
      const { call } = await open();
      const first = await call({ kind: "invoice", limit: 2 });
      expect(first.body.invoices).toHaveLength(2);
      expect(first.body.next_cursor).toBeTypeOf("string");
      expect(first.body.note).toMatch(/^Showing 1–2/);
      const second = await call({
        kind: "invoice",
        limit: 2,
        cursor: first.body.next_cursor,
      });
      expect(second.body.invoices).toHaveLength(1);
      expect(second.body.next_cursor).toBeUndefined();
      const wrong = await call({
        kind: "invoice",
        limit: 2,
        status: "sent",
        cursor: first.body.next_cursor,
      });
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "answers INVALID_INPUT, NOT_FOUND and FORBIDDEN with a fix",
    async () => {
      const { call } = await open();
      const noKind = await call({});
      expect(noKind.body.error.code).toBe("INVALID_INPUT");
      expect(noKind.body.error.issues[0].path).toBe("kind");
      const badStatus = await call({ kind: "invoice", status: "accepted" });
      expect(badStatus.body.error.code).toBe("INVALID_INPUT");
      expect(badStatus.body.error.fix).toContain(
        "draft, sent, paid, cancelled",
      );
      const quotationOverdue = await call({ kind: "quotation", overdue: true });
      expect(quotationOverdue.body.error.code).toBe("INVALID_INPUT");
      const badPeriod = await call({ kind: "invoice", period: "last week" });
      expect(badPeriod.body.error.code).toBe("INVALID_INPUT");

      const noId = await call({ kind: "invoice", id: 987654 });
      expect(noId.body.error.code).toBe("NOT_FOUND");
      const noNumber = await call({ kind: "quotation", id: "QUO-NOPE" });
      expect(noNumber.body.error.code).toBe("NOT_FOUND");
      const noContact = await call({ kind: "invoice", contact: "Nobody Ltd" });
      expect(noContact.body.error.code).toBe("NOT_FOUND");

      const invoicesOnly = await open(["invoices.read"]);
      const mine = await invoicesOnly.call({ kind: "invoice" });
      expect(mine.isError).toBe(false);
      const refused = await invoicesOnly.call({ kind: "quotation" });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("FORBIDDEN");
      expect(refused.body.error.message).toContain("quotations.read");
    },
    SLOW,
  );
});
