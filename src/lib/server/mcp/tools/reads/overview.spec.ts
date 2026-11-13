import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { localToday } from "$lib/local-date.js";
import { closedThrough } from "../../../closing/policy.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { unmatchedLinesByAccount } from "../../../services/reconciliation.js";
import { patLocals } from "../../../tokens/pat.js";
import { unresolvedTaxLines } from "../../../queries/tax-review.js";
import {
  buildEvalBook,
  type EvalBook,
  type EvalVariant,
} from "../../__fixtures__/eval-book.js";
import { createServerV2, MAX_DESCRIPTION_CHARS } from "../../registry.js";
import { accountsReadTools } from "./accounts.js";
import { overviewReadTools } from "./overview.js";
import { recordsReadTools } from "./records.js";

/**
 * `akaun_get_books_overview`, driven through a real MCP client over
 * `InMemoryTransport` against the evaluation book (a file database under
 * `os.tmpdir()`; nothing here imports `db/client.ts`).
 */

const TOOLS = [...overviewReadTools, ...recordsReadTools, ...accountsReadTools];
const TODAY = localToday();

const folders: string[] = [];
const books: EvalBook[] = [];
afterAll(() => {
  for (const book of books) book.raw.close();
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

async function build(variant: EvalVariant = "A"): Promise<EvalBook> {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d1-overview-"));
  folders.push(dir);
  const book = await buildEvalBook({ dir, variant, today: TODAY });
  books.push(book);
  return book;
}

async function connect(book: EvalBook, locals: App.Locals) {
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: TOOLS, writes: [] },
  });
  const client = new Client({ name: "d1-overview-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: `akaun_${name}`,
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, text, body: JSON.parse(text) };
  };
  return { client, server, call };
}

const agentLocals = (book: EvalBook) =>
  patLocals(book.db, `Bearer ${book.agentToken}`)!;

const SLOW = 60_000;

describe("get_books_overview", () => {
  const shared = build();

  it(
    "gives the business, currency, date, close date and uncategorised accounts on one screen",
    async () => {
      const book = await shared;
      const { call } = await connect(book, agentLocals(book));
      const { isError, text, body } = await call("get_books_overview");
      expect(isError).toBe(false);
      expect(body.business).toBe(book.manifest.business);
      expect(body.main_currency).toBe("MYR");
      expect(body.today).toBe(TODAY);
      expect(body.closed_through).toBe(book.manifest.closedThrough);
      expect(body.closed_through).toBe(closedThrough(book.db));
      // "code name", the way an account is sent back.
      expect(body.uncategorised_accounts.expense).toBe("5900 Other Expenses");
      expect(body.uncategorised_accounts.income).toBe("4100 Other Revenue");
      // Compact: it is the first call every agent makes.
      expect(text.length).toBeLessThan(4096);
    },
    SLOW,
  );

  it(
    "lists the money accounts with decimal-string balances",
    async () => {
      const book = await shared;
      const { call } = await connect(book, agentLocals(book));
      const { body } = await call("get_books_overview");
      const accounts = body.money_accounts as {
        id: number;
        account: string;
        balance: string;
      }[];
      const ids = accounts.map((a) => a.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          book.manifest.accounts.bank,
          book.manifest.accounts.cash,
          book.manifest.accounts.card,
        ]),
      );
      // Where money is owed, what it was for and equity are not money accounts.
      expect(ids).not.toContain(book.manifest.accounts.receivable);
      expect(ids).not.toContain(book.manifest.accounts.payable);
      expect(ids).not.toContain(book.manifest.accounts.advertising);
      const bank = accounts.find((a) => a.id === book.manifest.accounts.bank)!;
      expect(bank.account).toMatch(/^1\d{3} /);
      expect(bank.balance).toMatch(/^-?\d+\.\d{2}$/);
    },
    SLOW,
  );

  it(
    "counts each work queue from the same queries the screens use",
    async () => {
      const book = await shared;
      const { call } = await connect(book, agentLocals(book));
      const { body } = await call("get_books_overview");
      const queues = body.queues;

      expect(queues.uncategorised.count).toBe(
        book.manifest.plants.uncategorised.expected.length,
      );
      expect(queues.uncategorised.drill).toEqual({
        tool: "akaun_search_records",
        args: { category: "uncategorised" },
      });

      const unmatched = unmatchedLinesByAccount(book.db);
      expect(queues.unmatched_bank_lines.count).toBe(
        unmatched.reduce((sum, row) => sum + row.count, 0),
      );
      expect(
        queues.unmatched_bank_lines.by_account.map(
          (row: { id: number; lines: number }) => [row.id, row.lines],
        ),
      ).toEqual(unmatched.map((row) => [row.accountId, row.count]));
      expect(queues.unmatched_bank_lines.by_account[0].account).toMatch(
        /^1\d{3} /,
      );

      expect(queues.unresolved_tax_lines.count).toBe(
        unresolvedTaxLines(book.db, closedThrough(book.db), TODAY).length,
      );
      expect(queues.unresolved_tax_lines.count).toBeGreaterThan(0);

      // The one overdue invoice; the paid and the upcoming one are not.
      expect(queues.overdue_invoices.count).toBe(1);
      expect(queues.imports_to_review.count).toBe(0);

      // Expenses of the last two months with no file: the drill lists the same ones.
      const missing = queues.expenses_without_file;
      const listed = await call("search_records", {
        ...missing.drill.args,
        limit: 200,
      });
      expect(listed.body.total).toBe(missing.count);
      expect(
        listed.body.records.every(
          (r: { kind: string; files: number }) =>
            r.kind === "expense" && r.files === 0,
        ),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "says which actions of each write tool this connection may use",
    async () => {
      const book = await shared;
      const { call } = await connect(book, agentLocals(book));
      const { body } = await call("get_books_overview");
      expect(body.can.akaun_change_records).toEqual([
        "update",
        "void",
        "delete",
      ]);
      expect(body.can.akaun_create_records).toEqual(["records"]);
      expect(body.can.akaun_change_contacts).toContain("merge");
      expect(body.can.akaun_attach_file).toBe(true);
      expect(body.can.akaun_review_imports).toEqual(
        expect.arrayContaining(["confirm", "discard"]),
      );

      // A token that may read and add records is told so: no void, no merge.
      const writer = await connect(
        book,
        localsFor(["records.read", "records.create"]),
      );
      const narrow = (await writer.call("get_books_overview")).body;
      expect(narrow.can.akaun_create_records).toEqual(["records"]);
      expect(narrow.can.akaun_change_records).toBeUndefined();
      expect(narrow.can.akaun_change_contacts).toBeUndefined();
    },
    SLOW,
  );

  it(
    "shows a narrow connection only what it may read",
    async () => {
      const book = await shared;
      // Records only: no balances, no bank, invoice or import queues.
      const records = await connect(book, localsFor(["records.read"]));
      const body = (await records.call("get_books_overview")).body;
      expect(body.business).toBe(book.manifest.business);
      expect(body.money_accounts).toBeUndefined();
      expect(Object.keys(body.queues).sort()).toEqual([
        "expenses_without_file",
        "uncategorised",
        "unresolved_tax_lines",
      ]);
      expect(typeof body.can).toBe("string");

      // Accounts only: balances, no queues at all.
      const accounts = await connect(book, localsFor(["accounts.read"]));
      const second = (await accounts.call("get_books_overview")).body;
      expect(second.money_accounts.length).toBeGreaterThan(0);
      expect(second.queues).toBeUndefined();

      // The bank and the invoices on their own.
      const some = await connect(
        book,
        localsFor(["reconciliation.read", "invoices.read"]),
      );
      const third = (await some.call("get_books_overview")).body;
      expect(Object.keys(third.queues).sort()).toEqual([
        "overdue_invoices",
        "unmatched_bank_lines",
      ]);
      expect(third.money_accounts).toBeUndefined();
      expect(third.uncategorised_accounts).toBeUndefined();
    },
    SLOW,
  );

  it(
    "is not listed to a caller who can read nothing",
    async () => {
      const book = await shared;
      const { client } = await connect(book, localsFor([]));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain(
        "akaun_get_books_overview",
      );
    },
    SLOW,
  );

  it(
    "rejects an unknown input field with a hint and does nothing",
    async () => {
      const book = await shared;
      const { call } = await connect(book, agentLocals(book));
      const { isError, body } = await call("get_books_overview", {
        period: "2026-09",
      });
      expect(isError).toBe(true);
      expect(body.error.code).toBe("INVALID_INPUT");
      expect(body.error.issues[0].path).toBe("period");
    },
    SLOW,
  );

  it(
    "writes nothing: every D1 read leaves the books byte for byte as they were",
    async () => {
      const book = await shared;
      const locals = agentLocals(book);
      const { call } = await connect(book, locals);
      const m = book.manifest;
      const fingerprint = () =>
        createHash("sha256").update(book.raw.serialize()).digest("hex");
      const before = fingerprint();
      await call("get_books_overview");
      await call("list_accounts");
      await call("search_records", { account: m.accounts.bank });
      await call("search_records", { group_by: "category" });
      await call("get_record", {
        record: m.records.nandosClaimed,
        include: ["evidence_text", "history"],
      });
      await call("get_category_history", { records: [m.records.misc] });
      expect(fingerprint()).toBe(before);
    },
    SLOW,
  );
});

describe("the D1 tool descriptions", () => {
  it(
    "fit the limit, name no fixture noun and stay the same under both variants",
    async () => {
      const a = await build("A");
      const b = await build("B");
      const nouns = [...a.manifest.nouns, ...b.manifest.nouns];
      expect(nouns.length).toBeGreaterThan(40);
      const { client } = await connect(a, agentLocals(a));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "akaun_get_books_overview",
        "akaun_search_records",
        "akaun_get_record",
        "akaun_get_category_history",
        "akaun_list_accounts",
      ]);
      for (const tool of tools) {
        const text = tool.description ?? "";
        expect(text.length).toBeGreaterThan(300);
        expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
        for (const noun of nouns)
          expect(text.toLowerCase()).not.toContain(noun.toLowerCase());
        expect(tool.annotations?.readOnlyHint).toBe(true);
        // Money is always said to be a decimal string in a named currency.
        expect(JSON.stringify(tool.inputSchema)).not.toMatch(/Minor/);
      }
      const named = (name: string) =>
        tools.find((t) => t.name === name)?.description ?? "";
      // Written for an agent that has never seen Akaun.
      expect(named("akaun_get_books_overview")).toMatch(/Start here/);
      expect(named("akaun_get_category_history")).toMatch(/your own rules/);
      expect(named("akaun_get_category_history")).toMatch(/only reports/);
    },
    SLOW,
  );
});
