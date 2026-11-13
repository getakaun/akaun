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
import {
  balanceSheetReport,
  cashFlowReport,
  profitLossReport,
} from "../../../queries/reports.js";
import { expenseTaxReport } from "../../../queries/expense-tax-report.js";
import { outstandingAgeing } from "../../../queries/settlements.js";
import { trialBalance } from "../../../queries/trial-balance.js";
import { localToday } from "$lib/local-date.js";
import { money } from "../../format.js";
import { reportsReadTools } from "./reports.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tool in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/reports.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-reports-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: reportsReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-reports-spec", version: "1" });
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
      name: "akaun_get_report",
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

const month = (book: EvalBook) => book.manifest.statementMonth; // "2026-09"
const range = (book: EvalBook) => ({
  from: `${month(book)}-01`,
  to: `${month(book)}-30`,
});

describe("get_report", () => {
  it(
    "is one read-only tool whose report is required, with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["akaun_get_report"]);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[0].inputSchema.required).toContain("report");
      expect(tools[0].description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tools[0].description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
    },
    SLOW,
  );

  it(
    "reads the profit and loss with the query's totals and a drill on every account",
    async () => {
      const { book, call, replies } = await open();
      const { from, to } = range(book);
      const { isError, body } = await call({
        report: "profit_loss",
        period: month(book),
      });
      expect(isError).toBe(false);
      const direct = profitLossReport(book.db, from, to);
      expect(body).toMatchObject({
        report: "profit_loss",
        currency: "MYR",
        period: { from, to },
      });
      expect(body.total_income.amount).toBe(money(direct.totalIncomeMinor));
      expect(body.total_expenses.amount).toBe(money(direct.totalExpensesMinor));
      expect(body.result.amount).toBe(money(direct.resultMinor));
      expect(body.subtotals.map((s: Loose) => s.label)).toEqual(
        direct.subtotals.map((s) => s.label),
      );
      expect(body.expenses).toHaveLength(direct.expenses.length);
      for (const [i, line] of direct.expenses.entries()) {
        expect(body.expenses[i].amount).toBe(money(line.amountMinor));
        expect(body.expenses[i].id).toBe(line.accountId);
        expect(body.expenses[i].drill).toEqual({
          tool: "akaun_search_records",
          args: { account: line.accountId, period: `${from}..${to}` },
        });
      }
      // The default is this year to today, and it says so.
      const year = await call({ report: "profit_loss" });
      expect(year.body.period).toEqual({
        from: `${localToday().slice(0, 4)}-01-01`,
        to: expect.any(String),
      });
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "compares with the earlier month, quarter or year, and refuses it where it does not apply",
    async () => {
      const { book, call } = await open();
      const aug = profitLossReport(book.db, "2026-08-01", "2026-08-31");
      const prior = await call({
        report: "profit_loss",
        period: "2026-09",
        compare: "previous_period",
      });
      expect(prior.body.compared_with).toEqual({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      expect(prior.body.total_expenses.prior).toBe(
        money(aug.totalExpensesMinor),
      );
      const line = prior.body.expenses[0];
      expect(line.change).toBe(
        money(
          Math.round(Number(line.amount) * 100) -
            Math.round(Number(line.prior) * 100),
        ),
      );
      const quarter = await call({
        report: "profit_loss",
        period: "2026-Q3",
        compare: "previous_period",
      });
      expect(quarter.body.compared_with).toEqual({
        from: "2026-04-01",
        to: "2026-06-30",
      });
      const year = await call({
        report: "profit_loss",
        period: "2026-03",
        compare: "previous_year",
      });
      expect(year.body.compared_with).toEqual({
        from: "2025-03-01",
        to: "2025-03-31",
      });
      const days = await call({
        report: "profit_loss",
        period: "2026-09-10..2026-09-19",
        compare: "previous_period",
      });
      expect(days.body.compared_with).toEqual({
        from: "2026-08-31",
        to: "2026-09-09",
      });

      const refused = await call({
        report: "trial_balance",
        compare: "previous_year",
      });
      expect(refused.body.error.code).toBe("INVALID_INPUT");
      expect(refused.body.error.fix).toContain("profit_loss");
    },
    SLOW,
  );

  it(
    "reads the balance sheet and cash flow, with prior figures on request",
    async () => {
      const { book, call } = await open();
      const asAt = "2026-09-30";
      const sheet = await call({ report: "balance_sheet", as_at: asAt });
      const direct = balanceSheetReport(book.db, asAt);
      expect(sheet.body.owned.total).toBe(money(direct.owned.totalMinor));
      expect(sheet.body.owed.total).toBe(money(direct.owed.totalMinor));
      expect(sheet.body.owners_stake.total).toBe(
        money(direct.ownersStake.totalMinor),
      );
      expect(sheet.body.accumulated_result).toBe(
        money(direct.accumulatedResultMinor),
      );
      expect(sheet.body.balances).toBeUndefined();
      const bank = sheet.body.owned.lines.find(
        (l: Loose) => l.id === book.manifest.accounts.bank,
      );
      expect(bank.drill).toEqual({
        tool: "akaun_search_records",
        args: { account: book.manifest.accounts.bank, as_at: asAt },
      });
      // The current-earnings line is not an account: nothing to drill into.
      const earnings = sheet.body.owners_stake.lines.find(
        (l: Loose) => l.id === undefined,
      );
      expect(earnings.drill).toBeUndefined();

      const compared = await call({
        report: "balance_sheet",
        as_at: asAt,
        compare: "previous_period",
      });
      expect(compared.body.compared_with).toEqual({ as_at: "2026-08-31" });
      expect(compared.body.owned.prior_total).toBe(
        money(balanceSheetReport(book.db, "2026-08-31").owned.totalMinor),
      );

      const { from, to } = range(book);
      const flow = await call({ report: "cash_flow", period: month(book) });
      const cash = cashFlowReport(book.db, from, to);
      expect(flow.body.operating.total).toBe(money(cash.operating.totalMinor));
      expect(flow.body.opening_cash.amount).toBe(money(cash.openingCashMinor));
      expect(flow.body.closing_cash.amount).toBe(money(cash.closingCashMinor));
      expect(flow.body.net_change.amount).toBe(money(cash.netChangeMinor));
    },
    SLOW,
  );

  it(
    "reads the trial balance in debit and credit columns that agree",
    async () => {
      const { book, call, replies } = await open();
      const asAt = "2026-09-30";
      const { isError, body } = await call({
        report: "trial_balance",
        as_at: asAt,
      });
      expect(isError).toBe(false);
      const direct = trialBalance(book.db, { asAt });
      expect(body.as_at).toBe(asAt);
      expect(body.accounts).toHaveLength(direct.rows.length);
      expect(body.totals).toEqual({
        debit: money(direct.totals.debitMinor),
        credit: money(direct.totals.creditMinor),
      });
      expect(body.balanced).toBe(true);
      const bank = body.accounts.find(
        (a: Loose) => a.id === book.manifest.accounts.bank,
      );
      expect(bank.type).toBe("asset");
      expect(bank.debit).toMatch(/^\d+\.\d{2}$/);
      expect(bank.credit).toBeUndefined();
      expect(bank.drill.args).toEqual({
        account: book.manifest.accounts.bank,
        as_at: asAt,
      });
      // A bad date is INVALID_INPUT, not a thrown RangeError.
      const bad = await call({ report: "trial_balance", as_at: "2026-02-30" });
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "reads the partner statement",
    async () => {
      const { book, call } = await open();
      const { body } = await call({
        report: "partner_statement",
        period: "2026",
      });
      expect(body.partners.map((p: Loose) => p.id)).toEqual([
        book.manifest.contacts.partner,
      ]);
      expect(body.partners[0]).toMatchObject({
        contact: expect.any(String),
        net: expect.stringMatching(/^-?\d+\.\d{2}$/),
      });
      expect(body.notes.join(" ")).toContain("allocated equally");
    },
    SLOW,
  );

  it(
    "reads the expense tax report with the query's totals, pages its rows and hides line ids",
    async () => {
      const { book, call, replies } = await open();
      const { from, to } = { from: "2026-01-01", to: "2026-12-31" };
      const direct = expenseTaxReport(book.db, from, to);
      const { isError, body } = await call({
        report: "expense_tax",
        period: "2026",
        limit: 5,
      });
      expect(isError).toBe(false);
      expect(body.totals).toEqual({
        expense: money(direct.expenseMinor),
        deductible: money(direct.deductibleMinor),
        add_back: money(direct.addBackMinor),
        unresolved: money(direct.unresolvedMinor),
        unresolved_lines: direct.unresolvedLineCount,
      });
      expect(body.total).toBe(direct.rows.length);
      expect(body.rows).toHaveLength(5);
      expect(body.next_cursor).toBeTypeOf("string");
      expect(body.drill.args).toEqual({ period: "2026-01-01..2026-12-31" });
      const next = await call({
        report: "expense_tax",
        period: "2026",
        limit: 5,
        cursor: body.next_cursor,
      });
      expect(next.body.rows[0].id).not.toBe(body.rows[0].id);

      const review = await call({
        report: "expense_tax",
        period: "2026",
        review_only: true,
      });
      expect(review.body.rows.length).toBe(direct.unresolvedLineCount);
      for (const row of review.body.rows)
        expect(row.review).toBeTypeOf("string");

      const account = book.manifest.accounts.meals;
      const one = await call({
        report: "expense_tax",
        period: "2026",
        account,
      });
      for (const row of one.body.rows) expect(row.account).toContain("Meals");
      expect(one.body.drill.args.account).toBe(account);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "reads the aged reports from the open items, with bands and the contacts owed most",
    async () => {
      const { book, call, replies } = await open();
      const receivables = await call({ report: "aged_receivables" });
      const direct = outstandingAgeing(book.db, {
        direction: "owed-to-us",
        openOnly: true,
        asOf: localToday(),
      });
      expect(receivables.isError).toBe(false);
      expect(receivables.body.total_outstanding).toBe(
        money(direct.totalOutstandingMinor),
      );
      expect(receivables.body.bands.length).toBeGreaterThan(0);
      const overdue = receivables.body.items.find(
        (i: Loose) => i.id === book.manifest.invoices.overdue.recordId,
      );
      expect(overdue.days_overdue).toBeGreaterThan(0);
      expect(overdue.outstanding).toBe(
        money(book.manifest.invoices.overdue.totalMinor),
      );
      // Most overdue first.
      const age = receivables.body.items.map((i: Loose) => i.days_overdue);
      expect([...age].sort((a, b) => b - a)).toEqual(age);
      expect(receivables.body.largest_contacts[0].drill.tool).toBe(
        "akaun_get_contact",
      );

      const payables = await call({ report: "aged_payables" });
      expect(payables.body.items.length).toBeGreaterThan(0);
      expect(payables.body.report).toBe("aged_payables");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "reads the asset register with its totals and reconciliation",
    async () => {
      const { call, replies } = await open();
      const { isError, body } = await call({ report: "fixed_assets" });
      expect(isError).toBe(false);
      // The tool reads the real clock, whatever day the fixture was built for.
      expect(body.as_at).toBe(localToday());
      expect(body.totals).toEqual({
        cost: expect.stringMatching(/^\d+\.\d{2}$/),
        depreciation: expect.stringMatching(/^-?\d+\.\d{2}$/),
        net_book_value: expect.stringMatching(/^-?\d+\.\d{2}$/),
      });
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "checks the report asked for: reports read alone cannot read the aged reports",
    async () => {
      const reportsOnly = await open(["reports.read"]);
      const fine = await reportsOnly.call({
        report: "profit_loss",
        period: "2026-09",
      });
      expect(fine.isError).toBe(false);
      const refused = await reportsOnly.call({ report: "aged_receivables" });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("FORBIDDEN");
      expect(refused.body.error.message).toContain("records.read");
      const assets = await reportsOnly.call({ report: "fixed_assets" });
      expect(assets.body.error.code).toBe("FORBIDDEN");
    },
    SLOW,
  );

  it(
    "answers INVALID_INPUT and NOT_FOUND with a fix",
    async () => {
      const { call } = await open();
      const noReport = await call({});
      expect(noReport.body.error.issues[0].path).toBe("report");
      const typo = await call({ report: "profit_and_loss" });
      expect(typo.body.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(typo.body.error.issues)).toContain("profit_loss");
      const asAt = await call({ report: "profit_loss", as_at: "2026-09-30" });
      expect(asAt.body.error.code).toBe("INVALID_INPUT");
      expect(asAt.body.error.fix).toContain("period");
      const both = await call({
        report: "balance_sheet",
        period: "2026-09",
        as_at: "2026-09-30",
      });
      expect(both.body.error.code).toBe("INVALID_INPUT");
      const badPeriod = await call({ report: "profit_loss", period: "Q3" });
      expect(badPeriod.body.error.code).toBe("INVALID_INPUT");
      const account = await call({ report: "profit_loss", account: 1 });
      expect(account.body.error.code).toBe("INVALID_INPUT");
      const missing = await call({
        report: "expense_tax",
        period: "2026",
        account: "No Such Account",
      });
      expect(missing.body.error.code).toBe("NOT_FOUND");
    },
    SLOW,
  );
});
