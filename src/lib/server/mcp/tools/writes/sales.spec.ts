import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { contacts } from "../../../db/schema.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { salesWriteTools } from "./sales.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tools in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/sales.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// Replies are JSON read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Reply = { isError: boolean; body: Loose; text: string };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-e4-sales-"));
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
    tools: { reads: [], writes: [...salesWriteTools] },
  });
  const client = new Client({ name: "e4-sales-spec", version: "1" });
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
  const call = async (
    name: "akaun_create_sales_documents" | "akaun_change_sales_documents",
    args: Record<string, unknown>,
  ): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  const create = (args: Record<string, unknown>) =>
    call("akaun_create_sales_documents", args);
  const change = (args: Record<string, unknown>) =>
    call("akaun_change_sales_documents", args);
  return { book, client, create, change, replies };
}

const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

function noInternalIds(replies: string[]) {
  for (const text of replies)
    expect(text).not.toMatch(
      /"[a-zA-Z_]*(movement|settlement)[a-zA-Z_]*"\s*:/i,
    );
}

const lines = [
  { description: "Consulting day", quantity: 2, unit_price: "450.00" },
  { description: "Travel", quantity: 1, unit_price: "20.50" },
];

function draftInvoice(book: EvalBook, extra: Record<string, unknown> = {}) {
  return {
    contact: book.manifest.contacts.acme,
    issue_date: "2026-11-10",
    due_date: "2026-12-10",
    reference: "PO-7781",
    lines,
    ...extra,
  };
}

describe("create_sales_documents", () => {
  it(
    "is listed, additive, with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const create = tools.find(
        (t) => t.name === "akaun_create_sales_documents",
      );
      const change = tools.find(
        (t) => t.name === "akaun_change_sales_documents",
      );
      expect(create && change).toBeTruthy();
      for (const tool of [create!, change!]) {
        expect(tool.description!.length).toBeLessThanOrEqual(1500);
        for (const noun of book.manifest.nouns)
          expect(tool.description!.toLowerCase()).not.toContain(
            noun.toLowerCase(),
          );
      }
      expect(create!.annotations?.destructiveHint).toBe(false);
      expect(change!.annotations?.destructiveHint).toBe(true);
    },
    SLOW,
  );

  it(
    "creates a draft invoice and a draft quotation; a dry run saves nothing",
    async () => {
      const { book, create, replies } = await open();
      const before = {
        invoices: count(book, "invoices"),
        quotations: count(book, "quotations"),
        records: count(book, "ledger_records"),
      };
      const input = {
        invoices: [draftInvoice(book)],
        quotations: [
          {
            contact: book.manifest.contacts.acme,
            issue_date: "2026-11-10",
            expiry_date: "2026-12-10",
            lines: [
              { description: "Fit-out", quantity: 1, unit_price: "3000" },
            ],
          },
        ],
      };

      const dry = await create({ ...input, dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      expect(dry.body.items[0].invoice.total).toBe("920.50");
      expect(count(book, "invoices")).toBe(before.invoices);
      expect(count(book, "quotations")).toBe(before.quotations);

      const saved = await create(input);
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.request_id).toBeTruthy();
      const [invoice, quotation] = saved.body.items;
      expect(invoice).toMatchObject({ n: 1, action: "invoices" });
      expect(invoice.invoice).toMatchObject({
        status: "draft",
        issue_date: "2026-11-10",
        due_date: "2026-12-10",
        reference: "PO-7781",
        currency: "MYR",
        total: "920.50",
        lines: [
          {
            description: "Consulting day",
            quantity: 2,
            unit_price: "450.00",
            amount: "900.00",
          },
          {
            description: "Travel",
            quantity: 1,
            unit_price: "20.50",
            amount: "20.50",
          },
        ],
      });
      expect(invoice.invoice.no).toMatch(/\S/);
      expect(typeof invoice.invoice.v).toBe("string");
      expect(quotation).toMatchObject({ n: 2, action: "quotations" });
      expect(quotation.quotation).toMatchObject({
        status: "draft",
        expiry_date: "2026-12-10",
        total: "3000.00",
      });
      expect(count(book, "invoices")).toBe(before.invoices + 1);
      expect(count(book, "quotations")).toBe(before.quotations + 1);
      // A draft is not in the books.
      expect(count(book, "ledger_records")).toBe(before.records);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "refuses bad input, an unknown customer and a close name, all at once",
    async () => {
      const { book, create } = await open();

      const bad = await create({
        invoices: [
          draftInvoice(book, {
            lines: [{ description: "x", quantity: 1, unit_price: "twelve" }],
          }),
        ],
      });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(bad.body.error.issues[0].path).toBe(
        "invoices[0].lines[0].unit_price",
      );

      const nothing = await create({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");

      const acme = book.db
        .select({ name: contacts.legalName })
        .from(contacts)
        .where(eq(contacts.id, book.manifest.contacts.acme))
        .get()!.name;
      const close = acme.split(/\s+/)[0];
      const before = count(book, "contacts");

      const missing = await create({
        invoices: [
          draftInvoice(book, { contact: "No Such Customer Ltd" }),
          draftInvoice(book, { contact: undefined, new_contact: close }),
        ],
      });
      expect(missing.isError).toBe(true);
      expect(
        missing.body.error.errors.map((e: Loose) => [e.code, e.path]),
      ).toEqual([
        ["NOT_FOUND", "invoices[0].contact"],
        ["AMBIGUOUS", "invoices[1].new_contact"],
      ]);
      expect(missing.body.error.errors[1].candidates[0].name).toBe(acme);
      expect(count(book, "contacts")).toBe(before);
      expect(count(book, "invoices")).toBe(
        (
          book.raw.query("SELECT COUNT(*) AS n FROM invoices").get() as {
            n: number;
          }
        ).n,
      );

      // A foreign currency needs its rate, and a bare draft is in the main currency.
      const noRate = await create({
        invoices: [draftInvoice(book, { currency: "usd" })],
      });
      expect(noRate.isError).toBe(true);
      expect(noRate.body.error.path).toBe("invoices[0].exchange_rate");
      const foreign = await create({
        invoices: [draftInvoice(book, { currency: "USD", exchange_rate: 4.5 })],
        dry_run: true,
      });
      expect(foreign.body.items[0].invoice).toMatchObject({
        currency: "USD",
        exchange_rate: 4.5,
        total: "920.50",
      });

      const forced = await create({
        invoices: [
          draftInvoice(book, {
            contact: undefined,
            new_contact: close,
            force_new_contact: true,
          }),
        ],
      });
      expect(forced.isError).toBe(false);
      expect(forced.body.items[0].invoice.contact).toBe(close);
      expect(count(book, "contacts")).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "returns the first result for a retried call with the same idempotency key",
    async () => {
      const { book, create } = await open();
      const before = count(book, "invoices");
      const input = {
        invoices: [draftInvoice(book)],
        idempotency_key: "draft-invoice-1",
      };
      const first = await create(input);
      const again = await create(input);
      expect(first.body.saved).toBe(true);
      expect(again.body).toMatchObject({
        saved: true,
        replayed: true,
        request_id: first.body.request_id,
      });
      expect(again.body.items).toEqual(first.body.items);
      expect(count(book, "invoices")).toBe(before + 1);

      const other = await create({
        invoices: [draftInvoice(book, { reference: "PO-9999" })],
        idempotency_key: "draft-invoice-1",
      });
      expect(other.isError).toBe(true);
      expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
      expect(count(book, "invoices")).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "refuses a token without invoices.create for an invoice",
    async () => {
      const { book, create } = await open([
        "quotations.create",
        "invoices.read",
      ]);
      const denied = await create({ invoices: [draftInvoice(book)] });
      expect(denied.isError).toBe(true);
      expect(denied.body.error.code).toBe("FORBIDDEN");
      expect(denied.body.error.message).toContain("invoices.create");
      expect(count(book, "invoices")).toBe(3);
    },
    SLOW,
  );
});

describe("change_sales_documents", () => {
  it(
    "issues a draft invoice, keeps it sealed, then voids it with a reissue",
    async () => {
      const { book, create, change, replies } = await open();
      const made = await create({ invoices: [draftInvoice(book)] });
      const draft = made.body.items[0].invoice;
      const records = count(book, "ledger_records");

      // issue: a dry run posts nothing; a stale version is a CONFLICT.
      const dry = await change({
        invoice_issue: [{ invoice: draft.no, expected_version: draft.v }],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.items[0].invoice).toMatchObject({
        status: "sent",
        outstanding: "920.50",
      });
      expect(dry.body.items[0].invoice.posted_as).toBeTruthy();
      expect(count(book, "ledger_records")).toBe(records);
      const stale = await change({
        invoice_issue: [{ invoice: draft.id, expected_version: "stale" }],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(draft.v);

      const issued = await change({
        invoice_issue: [{ invoice: draft.no, expected_version: draft.v }],
      });
      expect(issued.isError).toBe(false);
      expect(issued.body.saved).toBe(true);
      const sent = issued.body.items[0].invoice;
      expect(sent).toMatchObject({
        id: draft.id,
        status: "sent",
        total: "920.50",
        outstanding: "920.50",
      });
      expect(sent.posted_as).toBeTruthy();
      expect(count(book, "ledger_records")).toBe(records + 1);

      // A sent invoice is sealed: its date cannot change, its wording can.
      const sealed = await change({
        invoice_update: [
          {
            invoice: draft.no,
            expected_version: sent.v,
            set: { issue_date: "2026-11-11" },
          },
        ],
      });
      expect(sealed.isError).toBe(true);
      expect(sealed.body.error.items[0].error.code).toBe("REFUSED");
      expect(sealed.body.error.items[0].error.message).toContain("sent");
      const reworded = await change({
        invoice_update: [
          {
            invoice: draft.no,
            expected_version: sent.v,
            set: { notes: "Payable by bank transfer." },
          },
        ],
      });
      expect(reworded.isError).toBe(false);
      expect(reworded.body.items[0].invoice.notes).toBe(
        "Payable by bank transfer.",
      );

      // void with reissue: the posting leaves the books and a corrected draft appears.
      const v = reworded.body.items[0].invoice.v;
      const invoices = count(book, "invoices");
      const voidDry = await change({
        invoice_void: [
          { invoice: draft.no, expected_version: v, reissue: true },
        ],
        dry_run: true,
      });
      expect(voidDry.isError).toBe(false);
      expect(count(book, "invoices")).toBe(invoices);
      const voided = await change({
        invoice_void: [
          { invoice: draft.no, expected_version: v, reissue: true },
        ],
      });
      expect(voided.isError).toBe(false);
      const item = voided.body.items[0];
      expect(item.voided).toMatchObject({ id: draft.id, status: "cancelled" });
      expect(item.reissued).toMatchObject({
        status: "draft",
        total: "920.50",
        replaces: draft.no,
      });
      expect(count(book, "invoices")).toBe(invoices + 1);

      // The reissued draft can be deleted; the cancelled one cannot.
      const gone = await change({
        invoice_delete: [
          { invoice: item.reissued.no, expected_version: item.reissued.v },
        ],
      });
      expect(gone.isError).toBe(false);
      expect(gone.body.items[0].deleted).toMatchObject({
        no: item.reissued.no,
      });
      expect(count(book, "invoices")).toBe(invoices);
      const kept = await change({
        invoice_delete: [
          { invoice: draft.no, expected_version: item.voided.v },
        ],
      });
      expect(kept.isError).toBe(true);
      expect(kept.body.error.items[0].error.message).toContain("cancelled");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "sends, accepts and converts a quotation; a sent quotation is sealed",
    async () => {
      const { book, create, change } = await open();
      const made = await create({
        quotations: [
          {
            contact: book.manifest.contacts.acme,
            issue_date: "2026-11-10",
            lines: [
              { description: "Fit-out", quantity: 1, unit_price: "3000" },
            ],
          },
        ],
      });
      const quotation = made.body.items[0].quotation;

      // A draft cannot be converted yet.
      const early = await change({
        quotation_convert: [
          { quotation: quotation.no, expected_version: quotation.v },
        ],
      });
      expect(early.isError).toBe(true);
      expect(early.body.error.items[0].error.code).toBe("REFUSED");

      const sent = await change({
        quotation_status: [
          {
            quotation: quotation.no,
            expected_version: quotation.v,
            status: "sent",
          },
        ],
      });
      expect(sent.isError).toBe(false);
      expect(sent.body.items[0].quotation.status).toBe("sent");
      const sealed = await change({
        quotation_update: [
          {
            quotation: quotation.no,
            expected_version: sent.body.items[0].quotation.v,
            set: { issue_date: "2026-11-11" },
          },
        ],
      });
      expect(sealed.isError).toBe(true);
      expect(sealed.body.error.items[0].error.message).toContain("sent");

      const accepted = await change({
        quotation_status: [
          {
            quotation: quotation.no,
            expected_version: sent.body.items[0].quotation.v,
            status: "accepted",
          },
        ],
      });
      expect(accepted.body.items[0].quotation.status).toBe("accepted");

      const invoices = count(book, "invoices");
      const dry = await change({
        quotation_convert: [
          {
            quotation: quotation.no,
            expected_version: accepted.body.items[0].quotation.v,
          },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(count(book, "invoices")).toBe(invoices);
      const converted = await change({
        quotation_convert: [
          {
            quotation: quotation.no,
            expected_version: accepted.body.items[0].quotation.v,
          },
        ],
      });
      expect(converted.isError).toBe(false);
      const item = converted.body.items[0];
      expect(item.quotation.status).toBe("converted");
      expect(item.quotation.converted_to).toBe(item.invoice.no);
      expect(item.invoice).toMatchObject({
        status: "draft",
        total: "3000.00",
        from_quotation: quotation.no,
      });
      expect(count(book, "invoices")).toBe(invoices + 1);

      // A converted quotation is kept.
      const kept = await change({
        quotation_delete: [
          { quotation: quotation.no, expected_version: item.quotation.v },
        ],
      });
      expect(kept.isError).toBe(true);
      expect(kept.body.error.items[0].error.message).toContain("Converted");
    },
    SLOW,
  );

  it(
    "revises a sent quotation and deletes a draft one",
    async () => {
      const { book, create, change } = await open();
      const made = await create({
        quotations: [
          {
            contact: book.manifest.contacts.acme,
            issue_date: "2026-11-10",
            lines: [
              { description: "Fit-out", quantity: 1, unit_price: "3000" },
            ],
          },
        ],
      });
      const quotation = made.body.items[0].quotation;
      const sent = await change({
        quotation_status: [
          {
            quotation: quotation.id,
            expected_version: quotation.v,
            status: "sent",
          },
        ],
      });
      const revised = await change({
        quotation_revise: [
          {
            quotation: quotation.no,
            expected_version: sent.body.items[0].quotation.v,
          },
        ],
      });
      expect(revised.isError).toBe(false);
      const item = revised.body.items[0];
      expect(item.quotation).toMatchObject({
        status: "draft",
        revised_from: quotation.no,
      });
      expect(item.previous).toMatchObject({
        id: quotation.id,
        status: "superseded",
      });
      const before = count(book, "quotations");
      const deleted = await change({
        quotation_delete: [
          { quotation: item.quotation.no, expected_version: item.quotation.v },
        ],
      });
      expect(deleted.isError).toBe(false);
      expect(count(book, "quotations")).toBe(before - 1);
    },
    SLOW,
  );

  it(
    "refuses unknown documents with candidates, and actions the token lacks",
    async () => {
      const { book, change } = await open();
      const missing = await change({
        invoice_issue: [{ invoice: "INV-9999", expected_version: "x" }],
        quotation_delete: [{ quotation: 99999, expected_version: "x" }],
      });
      expect(missing.isError).toBe(true);
      expect(
        missing.body.error.errors.map((e: Loose) => [e.code, e.path]),
      ).toEqual([
        ["NOT_FOUND", "invoice_issue[0].invoice"],
        ["NOT_FOUND", "quotation_delete[0].quotation"],
      ]);
      // Nothing is alike, so the newest numbers show what one looks like.
      expect(missing.body.error.errors[0].candidates.length).toBeGreaterThan(0);
      expect(missing.body.error.errors[0].candidates[0].detail).toBe(
        "most recent",
      );

      const bad = await change({
        invoice_update: [{ invoice: 1, expected_version: "x", set: {} }],
      });
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(bad.body.error.path).toBe("invoice_update[0].set");

      const nothing = await change({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");
      expect(count(book, "invoices")).toBe(3);
    },
    SLOW,
  );

  it(
    "refuses a delete without invoices.delete and a reissue without invoices.create",
    async () => {
      const { book, change } = await open([
        "invoices.update",
        "invoices.void",
        "records.update",
        "invoices.read",
      ]);
      const upcoming = book.manifest.invoices.upcoming;
      const deleted = await change({
        invoice_delete: [{ invoice: upcoming.id, expected_version: "x" }],
      });
      expect(deleted.isError).toBe(true);
      expect(deleted.body.error.code).toBe("FORBIDDEN");
      expect(deleted.body.error.message).toContain("invoices.delete");

      const reissue = await change({
        invoice_void: [
          { invoice: upcoming.id, expected_version: "x", reissue: true },
        ],
      });
      expect(reissue.isError).toBe(true);
      expect(reissue.body.error.code).toBe("FORBIDDEN");
      expect(reissue.body.error.message).toContain("invoice_void_reissue");
      expect(reissue.body.error.message).toContain("invoices.create");
      expect(count(book, "invoices")).toBe(3);
    },
    SLOW,
  );
});
