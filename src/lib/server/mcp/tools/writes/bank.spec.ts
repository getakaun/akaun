import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
} from "$lib/enums.js";
import * as schema from "../../../db/schema.js";
import { createRecord } from "../../../application/records.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { accountDefaultId } from "../../../services/account-defaults.js";
import { contactBalances } from "../../../queries/settlements.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { getRecord } from "../../../queries/ledger.js";
import { statementLineVersion } from "../../../application/version.js";
import { paymentsWriteTools } from "./payments.js";
import { bankWriteTools } from "./bank.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tools in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/bank.spec.ts

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
  const dir = mkdtempSync(join(tmpdir(), "akaun-e2-bank-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: [], writes: [...paymentsWriteTools, ...bankWriteTools] },
  });
  const client = new Client({ name: "e2-bank-spec", version: "1" });
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
    name: string,
    args: Record<string, unknown>,
  ): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  return { book, client, call, replies };
}

const no = (book: EvalBook, id: number) =>
  getRecord(book.db, id)!.recordNumber!;
const allocations = (book: EvalBook) =>
  (
    book.raw
      .query("SELECT COUNT(*) AS n FROM reconciliation_allocations")
      .get() as { n: number }
  ).n;
const records = (book: EvalBook) =>
  (
    book.raw.query("SELECT COUNT(*) AS n FROM ledger_records").get() as {
      n: number;
    }
  ).n;

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

function noInternalIds(replies: string[]) {
  for (const text of replies) {
    const keys = [...keysOf(JSON.parse(text))];
    expect(keys.filter((k) => /movement|settlement/i.test(k))).toEqual([]);
  }
}

describe("match_bank_lines and unmatch_bank_lines", () => {
  it(
    "lists both tools with short descriptions free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const mine = tools.filter((t) =>
        ["akaun_match_bank_lines", "akaun_unmatch_bank_lines"].includes(t.name),
      );
      expect(mine.map((t) => t.name)).toEqual([
        "akaun_match_bank_lines",
        "akaun_unmatch_bank_lines",
      ]);
      for (const tool of mine) {
        expect(tool.description!.length).toBeLessThanOrEqual(1500);
        for (const noun of book.manifest.nouns)
          expect(tool.description!.toLowerCase()).not.toContain(
            noun.toLowerCase(),
          );
      }
      expect(mine[0].annotations?.destructiveHint).toBe(false);
      expect(mine[1].annotations?.destructiveHint).toBe(true);
    },
    SLOW,
  );

  it(
    "matches a line to its record dated two days apart, then unmatches it",
    async () => {
      const { book, call, replies } = await open();
      const gap = book.manifest.plants.bankStatement.dateGap;
      const line = `L${gap.line}`;
      const record = no(book, gap.record);
      const before = allocations(book);

      const dry = await call("akaun_match_bank_lines", {
        match: [{ line, records: [{ record }] }],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      expect(allocations(book)).toBe(before);

      const saved = await call("akaun_match_bank_lines", {
        match: [{ line, records: [{ record }] }],
      });
      expect(saved.isError).toBe(false);
      const item = saved.body.items[0];
      expect(item).toMatchObject({
        action: "match",
        line,
        amount: "312.75",
        matched: [{ id: gap.record, no: record, amount: "312.75" }],
        line_unmatched: "0.00",
      });
      expect(item.v).toBe(statementLineVersion(book.db, gap.line));
      expect(getRecord(book.db, gap.record)!.cleared).toBe(true);

      // Matched in full: a second match finds nothing left to cover.
      const again = await call("akaun_match_bank_lines", {
        match: [{ line, records: [{ record }] }],
      });
      expect(again.body.error.code).toBe("REFUSED");

      const stale = await call("akaun_unmatch_bank_lines", {
        unmatch: [{ line, expected_version: "stale" }],
      });
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(item.v);

      const dryUndo = await call("akaun_unmatch_bank_lines", {
        unmatch: [{ line, record, expected_version: item.v }],
        dry_run: true,
      });
      expect(dryUndo.body.dry_run).toBe(true);
      expect(getRecord(book.db, gap.record)!.cleared).toBe(true);

      const undone = await call("akaun_unmatch_bank_lines", {
        unmatch: [{ line, record, expected_version: item.v }],
      });
      expect(undone.isError).toBe(false);
      expect(undone.body.items[0]).toMatchObject({
        line,
        unmatched: [{ id: gap.record, no: record, amount: "312.75" }],
        line_unmatched: "312.75",
      });
      expect(getRecord(book.db, gap.record)!.cleared).toBe(false);
      expect(allocations(book)).toBe(before);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "refuses bad input and unknown lines or records",
    async () => {
      const { book, call } = await open();
      const gap = book.manifest.plants.bankStatement.dateGap;
      const bad = await call("akaun_match_bank_lines", {
        match: [{ line: `L${gap.line}`, records: [] }],
      });
      expect(bad.body.error.code).toBe("INVALID_INPUT");

      const unknownLine = await call("akaun_match_bank_lines", {
        match: [{ line: "L9999", records: [{ record: gap.record }] }],
      });
      expect(unknownLine.body.error.code).toBe("NOT_FOUND");
      expect(unknownLine.body.error.path).toBe("match[0].line");

      // A record that moved no money through the bank account.
      const elsewhere = await call("akaun_match_bank_lines", {
        match: [
          {
            line: `L${gap.line}`,
            records: [{ record: no(book, book.manifest.records.spotify) }],
          },
        ],
      });
      expect(elsewhere.body.error.code).toBe("NOT_FOUND");
      expect(elsewhere.body.error.path).toBe("match[0].records[0].record");

      const unmatch = await call("akaun_unmatch_bank_lines", {
        unmatch: [{ line: "S1", expected_version: "x" }],
      });
      expect(unmatch.body.error.code).toBe("NOT_FOUND");
    },
    SLOW,
  );

  it(
    "books the interest as income and the service charge as an expense",
    async () => {
      const { book, call, replies } = await open();
      const m = book.manifest;
      const noRecord = m.plants.bankStatement.noRecord;
      const interest = noRecord.find(
        (r) => r.account === m.accounts.interestIncome,
      )!;
      const charge = noRecord.find(
        (r) => r.account === m.accounts.bankCharges,
      )!;
      const before = records(book);

      const args = {
        create_from_lines: [
          {
            lines: [`L${interest.line}`],
            kind: "income",
            category: interest.account,
            description: "Bank interest",
          },
          {
            lines: [`L${charge.line}`],
            kind: "expense",
            category: charge.account,
            tax: { treatment: "non_deductible", reason: "Bank fee policy" },
          },
        ],
      };
      const dry = await call("akaun_match_bank_lines", {
        ...args,
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(records(book)).toBe(before);

      const saved = await call("akaun_match_bank_lines", args);
      expect(saved.isError).toBe(false);
      const [income, expense] = saved.body.items;
      expect(income).toMatchObject({
        action: "create_from_lines",
        record: {
          kind: "income",
          amount: "12.47",
          description: "Bank interest",
        },
        lines: [{ line: `L${interest.line}` }],
      });
      expect(expense.record.kind).toBe("expense");
      expect(records(book)).toBe(before + 2);
      const incomeRecord = getRecord(book.db, income.record.id)!;
      expect(incomeRecord.kind).toBe(LedgerRecordKind.Income);
      expect(incomeRecord.cleared).toBe(true);
      const expenseRecord = getRecord(book.db, expense.record.id)!;
      expect(expenseRecord.kind).toBe(LedgerRecordKind.Expense);
      expect(
        expenseRecord.movements.some((mv) => mv.accountId === charge.account),
      ).toBe(true);
      expect(expenseRecord.cleared).toBe(true);

      const wrongKind = await call("akaun_match_bank_lines", {
        create_from_lines: [
          {
            lines: [`L${noRecord.find((r) => r.kind === "income")!.line}`],
            kind: "income",
            category: m.accounts.dividendIncome,
            tax: { treatment: "non_deductible", reason: "x" },
          },
        ],
      });
      expect(wrongKind.body.error.code).toBe("INVALID_INPUT");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "auto-matches the same-day pairs with max_days 0 and refuses a wide window",
    async () => {
      const { book, call, replies } = await open();
      const m = book.manifest.plants.bankStatement;
      const before = allocations(book);
      const pairs = (body: Loose) =>
        body.items[0].matched.map(
          (p: { line: string; record: { id: number } }) =>
            `${p.line}->${p.record.id}`,
        );
      const expected = m.decoyPair.map((p) => `L${p.line}->${p.record}`);

      const dry = await call("akaun_match_bank_lines", {
        auto_match: { account: m.account, max_days: 0 },
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(pairs(dry.body)).toEqual(expect.arrayContaining(expected));
      // The line two days off its record stays for a person, or a wider window.
      expect(dry.body.items[0].skipped).toContainEqual({
        line: `L${m.dateGap.line}`,
        reason: "no_candidate",
      });
      expect(allocations(book)).toBe(before);

      const wide = await call("akaun_match_bank_lines", {
        auto_match: { account: m.account, max_days: 30 },
      });
      expect(wide.body.error.code).toBe("INVALID_INPUT");
      expect(wide.body.error.issues[0].path).toBe("auto_match.max_days");
      expect(allocations(book)).toBe(before);

      const saved = await call("akaun_match_bank_lines", {
        auto_match: { account: m.account, period: "2026-09", max_days: 2 },
      });
      expect(saved.isError).toBe(false);
      const matched = pairs(saved.body);
      expect(matched).toEqual(expect.arrayContaining(expected));
      expect(matched).toContain(`L${m.dateGap.line}->${m.dateGap.record}`);
      for (const pair of saved.body.items[0].matched)
        expect(m.matches).toContainEqual({
          line: Number(pair.line.slice(1)),
          record: pair.record.id,
        });
      expect(allocations(book)).toBe(before + matched.length);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "refuses a token without reconciliation:write",
    async () => {
      const { client, call } = await open([
        "records.read",
        "records.create",
        "reconciliation.read",
      ]);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("akaun_match_bank_lines");
      expect(names).not.toContain("akaun_unmatch_bank_lines");
      await expect(
        call("akaun_unmatch_bank_lines", {
          unmatch: [{ line: "L1", expected_version: "x" }],
        }),
      ).rejects.toThrow(/not found/);

      // Matching without the ability to create: create_from_lines is refused.
      const { book, call: matchOnly } = await open([
        "records.read",
        "reconciliation.read",
        "reconciliation.match",
      ]);
      const line = book.manifest.plants.bankStatement.noRecord[0];
      const refused = await matchOnly("akaun_match_bank_lines", {
        create_from_lines: [
          { lines: [`L${line.line}`], kind: "expense", category: line.account },
        ],
      });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("FORBIDDEN");
      expect(refused.body.error.message).toContain("create_from_lines");
    },
    SLOW,
  );
});

describe("create_from_lines payments (review finding 2)", () => {
  /** A new supplier we paid 200.00 nothing was owed for, and their 200.00 refund on the bank statement. */
  function overpaidSupplier(book: EvalBook) {
    const m = book.manifest;
    const owner = {
      db: book.db,
      locals: localsFor([], { superuser: true, userId: m.users.owner }),
    };
    const supplier = book.db
      .insert(schema.contacts)
      .values({ legalName: "Refunding Supplier Sdn Bhd", entityType: 2 })
      .returning()
      .get()!.id;
    const date = `${m.statementMonth}-10`;
    const overpayment = createRecord(owner, {
      kind: "payment",
      date,
      amount: 200,
      currency: "MYR",
      exchangeRate: 1,
      description: "Paid twice by mistake",
      paidFromAccountId: m.accounts.bank,
      contactId: supplier,
      direction: "we-pay",
      settlements: [],
    });
    if (!overpayment.ok) throw new Error(overpayment.reason);
    const line = book.db
      .insert(schema.bankStatementLines)
      .values({
        statementId: m.statements.bank,
        date: `${m.statementMonth}-24`,
        amount: 200,
        direction: StatementDirection.In,
        description: "REFUND REFUNDING SUPPLIER",
      })
      .returning()
      .get()!.id;
    return { supplier, line };
  }

  it(
    "records a supplier's refund against Payable, and asks for direction when one runs the wrong way",
    async () => {
      const { book, call, replies } = await open();
      const { supplier, line } = overpaidSupplier(book);
      const payable = accountDefaultId(book.db, DefaultAccountPurpose.Payable)!;
      const receivable = accountDefaultId(
        book.db,
        DefaultAccountPurpose.Receivable,
      )!;

      const wrongWay = await call("akaun_match_bank_lines", {
        create_from_lines: [
          {
            lines: [`L${line}`],
            kind: "payment",
            contact: supplier,
            direction: "we_pay",
          },
        ],
      });
      expect(wrongWay.isError).toBe(true);
      const item = wrongWay.body.error.items?.[0]?.error ?? wrongWay.body.error;
      expect(item.code).toBe("REFUSED");
      expect(item.path).toBe("create_from_lines[0].direction");
      expect(item.fix).toMatch(/we_receive or refund_received/);

      const saved = await call("akaun_match_bank_lines", {
        create_from_lines: [
          { lines: [`L${line}`], kind: "payment", contact: supplier },
        ],
      });
      expect(saved.isError).toBe(false);
      const record = getRecord(book.db, saved.body.items[0].record.id)!;
      const byAccount = Object.fromEntries(
        record.movements.map((mv) => [mv.accountId, mv.amountMinor]),
      );
      expect(byAccount[payable]).toBe(-20000);
      expect(byAccount[receivable]).toBeUndefined();
      expect(contactBalances(book.db, "we-owe", supplier)).toEqual([]);
      noInternalIds(replies);
    },
    SLOW,
  );
});
