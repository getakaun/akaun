import { z } from "zod";
import { AccountType, AccountTypeLabels } from "$lib/enums.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import { assetNumber } from "$lib/fixed-assets.js";
import { readFixedAssets } from "../../../application/fixed-assets.js";
import { accounts } from "../../../db/schema.js";
import { isValidDate } from "../../../date.js";
import type {
  BalanceSheetReport,
  CashFlowReport,
  LedgerDb,
  Minor,
  ProfitLossReport,
  ReportLine,
} from "../../../ledger/types.js";
import {
  balanceSheetReport,
  cashFlowReport,
  partnerStatementReport,
  profitLossReport,
} from "../../../queries/reports.js";
import { expenseTaxReport } from "../../../queries/expense-tax-report.js";
import {
  balancesByContact,
  outstandingAgeing,
} from "../../../queries/settlements.js";
import { trialBalance } from "../../../queries/trial-balance.js";
import { LedgerRecordKindLabels } from "$lib/enums.js";
import { fromAppFailure, toolError } from "../../envelope.js";
import {
  enumLabel,
  mainCurrency,
  money,
  parsePeriod,
  periodShape,
} from "../../format.js";
import { pageResult, pagingShape, startPage } from "../../paging.js";
import { defineReadTool, type ToolDefinition } from "../../registry.js";
import {
  actionRefusal,
  GET_REPORT,
  missingForActions,
} from "../../requirements/index.js";
import { Refs, refInput } from "../writes/payments.js";

/**
 * `get_report`: the reports the screens show, as figures an agent can read
 * and drill into.
 *
 * Nothing is totalled or signed here. Each report's lines, subtotals and
 * totals come from its query (`queries/reports.ts`, `trial-balance.ts`,
 * `expense-tax-report.ts`, `outstandingAgeing`, `readFixedAssets`), which
 * apply `displaySign` once, in `ledger/reports/*`; a figure is only turned
 * into a decimal string. `report` is the argument the OAuth step-up reads.
 * Rows that name an account carry `drill`, a `search_records` call that lists
 * the records behind the figure.
 */

const REPORTS = [
  "profit_loss",
  "balance_sheet",
  "cash_flow",
  "trial_balance",
  "partner_statement",
  "expense_tax",
  "aged_receivables",
  "aged_payables",
  "fixed_assets",
] as const;
type Report = (typeof REPORTS)[number];

const RANGE_REPORTS: readonly Report[] = [
  "profit_loss",
  "cash_flow",
  "partner_statement",
  "expense_tax",
];
const COMPARABLE: readonly Report[] = [
  "profit_loss",
  "balance_sheet",
  "cash_flow",
];

const input = z.object({
  report: z.enum(REPORTS).describe("Which report."),
  ...periodShape,
  compare: z
    .enum(["previous_period", "previous_year"])
    .optional()
    .describe(
      "profit_loss, balance_sheet and cash_flow: add the earlier figures.",
    ),
  account: refInput
    .optional()
    .describe("expense_tax: only this expense account (id, code or name)."),
  review_only: z
    .boolean()
    .optional()
    .describe(
      "expense_tax: only lines whose tax treatment still needs review.",
    ),
  ...pagingShape,
});

const DESCRIPTION = `Read a financial report. report is one of:
- profit_loss: income, expenses, gross profit and the result over a period.
- balance_sheet: what is owned, owed and held by the owners, as at a date.
- cash_flow: where the period's cash came from and went, with opening and closing cash.
- trial_balance: every account's balance as at a date, in debit and credit columns.
- partner_statement: each partner's contributions, share of the result and drawings.
- expense_tax: expense lines with tax treatment, potential deduction, add-back and what needs review (account, review_only).
- aged_receivables, aged_payables: open items by how overdue, and the contacts owed most.
- fixed_assets: the asset register: cost, depreciation, net book value, unregistered purchases, differences.

Send period ("2026-03", "2026-Q1", "2026" or a range) for profit_loss, cash_flow, partner_statement, expense_tax; as_at for balance_sheet, trial_balance, fixed_assets (aged reports use it only to count age). Defaults: this year to today; today; the response states the dates used. compare (previous_period or previous_year) adds prior and change to profit_loss, balance_sheet and cash_flow.

Amounts are decimal strings in the main currency, signed as the report screens show them. Take totals from the report, never by adding rows. Account rows carry drill: a search_records call for the records behind them. expense_tax, aged and fixed_assets page rows with limit and cursor. Pass on the notes.`;

// --- dates -------------------------------------------------------------------

const isMonthEnd = (date: string) => addDaysISO(date, 1).endsWith("-01");

/** `date` moved by whole months, a month-end staying a month-end and a 31st clamped. */
function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const day = isMonthEnd(date) ? last : Math.min(d, last);
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Range = { from: string; to: string };

/** The earlier range: the same months before a whole-month range, else the same days. */
function earlierRange(
  range: Range,
  how: "previous_period" | "previous_year",
): Range {
  if (how === "previous_year")
    return {
      from: shiftMonths(range.from, -12),
      to: shiftMonths(range.to, -12),
    };
  const to = addDaysISO(range.from, -1);
  if (range.from.endsWith("-01") && isMonthEnd(range.to)) {
    const [fy, fm] = range.from.split("-").map(Number);
    const [ty, tm] = range.to.split("-").map(Number);
    return {
      from: shiftMonths(range.from, -(ty * 12 + tm - (fy * 12 + fm) + 1)),
      to,
    };
  }
  const days =
    Math.round(
      (Date.parse(`${range.to}T00:00:00Z`) -
        Date.parse(`${range.from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return { from: addDaysISO(range.from, -days), to };
}

const earlierAsAt = (asAt: string, how: "previous_period" | "previous_year") =>
  shiftMonths(asAt, how === "previous_year" ? -12 : -1);

// --- rows --------------------------------------------------------------------

function accountLabels(db: LedgerDb): Map<number, string> {
  return new Map(
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .all()
      .map((a) => [a.id, a.code ? `${a.code} ${a.name}` : a.name]),
  );
}

const byId = (lines: readonly ReportLine[]) =>
  new Map(lines.map((l) => [l.accountId, l.amountMinor]));

/** Current lines, then lines only the earlier figures have, so the two columns add up alike. */
function merged(lines: readonly ReportLine[], prior?: readonly ReportLine[]) {
  if (!prior)
    return lines.map((l) => ({
      ...l,
      priorMinor: undefined as Minor | undefined,
    }));
  const before = byId(prior);
  const seen = new Set(lines.map((l) => l.accountId));
  return [
    ...lines.map((l) => ({ ...l, priorMinor: before.get(l.accountId) ?? 0 })),
    ...prior
      .filter((l) => !seen.has(l.accountId))
      .map((l) => ({ ...l, amountMinor: 0, priorMinor: l.amountMinor })),
  ];
}

const change = (now: Minor, before: Minor | undefined) =>
  before === undefined ? undefined : money(now - before);

const getReport = defineReadTool({
  base: "get_report",
  title: "Get a report",
  description: DESCRIPTION,
  input,
  requirements: GET_REPORT.requirements,
  handler: (ctx, args, meta) => {
    const { db } = ctx;
    const report: Report = args.report;
    const shortfalls = missingForActions(ctx.locals, "get_report", [report]);
    if (shortfalls.length)
      return toolError(actionRefusal(meta.name, shortfalls));
    const main = mainCurrency(db);
    const today = localToday();
    const search = meta.nameOf("search_records");

    // --- the dates --------------------------------------------------------------
    const parsed = parsePeriod({ period: args.period, as_at: args.as_at });
    if (!parsed.ok) return toolError(parsed.error);
    const ranged = RANGE_REPORTS.includes(report);
    let range: Range | undefined;
    let asAt: string | undefined;
    if (ranged) {
      if (parsed.value && parsed.value.from === null)
        return toolError({
          code: "INVALID_INPUT",
          path: "as_at",
          message: `${report} covers a period, not a single date.`,
          fix: 'Send period, e.g. "2026-03" or "2026-01-01..2026-03-31".',
        });
      range = parsed.value
        ? { from: parsed.value.from!, to: parsed.value.to }
        : { from: `${today.slice(0, 4)}-01-01`, to: today };
    } else asAt = parsed.value?.to ?? today;
    if (args.compare && !COMPARABLE.includes(report))
      return toolError({
        code: "INVALID_INPUT",
        path: "compare",
        message: `compare is not available for ${report}.`,
        fix: `Drop compare, or use it with ${COMPARABLE.join(", ")}.`,
      });
    if (args.account !== undefined && report !== "expense_tax")
      return toolError({
        code: "INVALID_INPUT",
        path: "account",
        message: "account applies to expense_tax only.",
        fix: "Drop account, or use report expense_tax.",
      });

    const periodText = range ? `${range.from}..${range.to}` : undefined;
    const head = {
      report,
      currency: main,
      period: range,
      as_at: asAt,
    };
    const labels = accountLabels(db);
    const label = (id: number, name: string) => labels.get(id) ?? name;
    const drill = (id: number) =>
      id > 0
        ? {
            tool: search,
            args: periodText
              ? { account: id, period: periodText }
              : { account: id, as_at: asAt },
          }
        : undefined;
    const accountRows = (
      lines: readonly ReportLine[],
      prior?: readonly ReportLine[],
    ) =>
      merged(lines, prior).map((l) => ({
        account: label(l.accountId, l.accountName),
        id: l.accountId > 0 ? l.accountId : undefined,
        amount: money(l.amountMinor),
        prior: l.priorMinor === undefined ? undefined : money(l.priorMinor),
        change: change(l.amountMinor, l.priorMinor),
        drill: drill(l.accountId),
      }));

    // --- the reports --------------------------------------------------------------
    switch (report) {
      case "profit_loss": {
        const now: ProfitLossReport = profitLossReport(
          db,
          range!.from,
          range!.to,
        );
        const before = args.compare
          ? earlierRange(range!, args.compare)
          : undefined;
        const prev = before
          ? profitLossReport(db, before.from, before.to)
          : undefined;
        const pair = (a: Minor, b: Minor | undefined) => ({
          amount: money(a),
          prior: b === undefined ? undefined : money(b),
          change: change(a, b),
        });
        return {
          ...head,
          compared_with: before,
          income: accountRows(now.income, prev?.income),
          total_income: pair(now.totalIncomeMinor, prev?.totalIncomeMinor),
          expenses: accountRows(now.expenses, prev?.expenses),
          total_expenses: pair(
            now.totalExpensesMinor,
            prev?.totalExpensesMinor,
          ),
          subtotals: now.subtotals.map((s, i) => ({
            label: s.label,
            ...pair(s.amountMinor, prev?.subtotals[i]?.amountMinor),
          })),
          result: pair(now.resultMinor, prev?.resultMinor),
          notes: now.notes,
        };
      }
      case "balance_sheet": {
        const now: BalanceSheetReport = balanceSheetReport(db, asAt!);
        const beforeAt = args.compare
          ? earlierAsAt(asAt!, args.compare)
          : undefined;
        const prev = beforeAt ? balanceSheetReport(db, beforeAt) : undefined;
        const section = (
          key: "owned" | "owed" | "ownersStake",
        ): Record<string, unknown> => {
          const s = now[key];
          const p = prev?.[key];
          return {
            total: money(s.totalMinor),
            prior_total: p ? money(p.totalMinor) : undefined,
            change: change(s.totalMinor, p?.totalMinor),
            subtotals: s.subsections?.map((sub) => ({
              label: sub.label,
              total: money(sub.totalMinor),
            })),
            lines: accountRows(s.lines, p?.lines),
          };
        };
        return {
          ...head,
          compared_with: beforeAt ? { as_at: beforeAt } : undefined,
          owned: section("owned"),
          owed: section("owed"),
          owners_stake: section("ownersStake"),
          accumulated_result: money(now.accumulatedResultMinor),
          balances: now.balances ? undefined : false,
          difference: now.balances ? undefined : money(now.differenceMinor),
          notes: now.notes,
        };
      }
      case "cash_flow": {
        const now: CashFlowReport = cashFlowReport(db, range!.from, range!.to);
        const before = args.compare
          ? earlierRange(range!, args.compare)
          : undefined;
        const prev = before
          ? cashFlowReport(db, before.from, before.to)
          : undefined;
        const section = (key: "operating" | "investing" | "financing") => {
          const s = now[key];
          const p = prev?.[key];
          const priorByLabel = new Map(
            p?.lines.map((l) => [l.label, l.amountMinor]),
          );
          return {
            total: money(s.totalMinor),
            prior_total: p ? money(p.totalMinor) : undefined,
            lines: s.lines.map((l) => ({
              label: l.label,
              amount: money(l.amountMinor),
              prior: p ? money(priorByLabel.get(l.label) ?? 0) : undefined,
            })),
          };
        };
        const pair = (a: Minor, b: Minor | undefined) => ({
          amount: money(a),
          prior: b === undefined ? undefined : money(b),
        });
        return {
          ...head,
          compared_with: before,
          operating: section("operating"),
          investing: section("investing"),
          financing: section("financing"),
          net_change: pair(now.netChangeMinor, prev?.netChangeMinor),
          opening_cash: pair(now.openingCashMinor, prev?.openingCashMinor),
          closing_cash: pair(now.closingCashMinor, prev?.closingCashMinor),
          needs_review: now.needsReviewMinor
            ? money(now.needsReviewMinor)
            : undefined,
          ties: now.ties ? undefined : false,
          difference: now.ties ? undefined : money(now.differenceMinor),
          notes: now.notes,
        };
      }
      case "trial_balance": {
        // `trialBalance` throws a RangeError on a bad date, so check it first.
        if (!isValidDate(asAt))
          return toolError({
            code: "INVALID_INPUT",
            path: "as_at",
            message: `"${asAt}" is not a real date.`,
            fix: 'Send as_at as YYYY-MM-DD, e.g. "2026-03-31".',
          });
        const tb = trialBalance(db, { asAt });
        return {
          ...head,
          accounts: tb.rows.map((r) => ({
            account: label(r.accountId, r.name),
            id: r.accountId,
            type: enumLabel(AccountTypeLabels, r.type),
            debit: r.debitMinor ? money(r.debitMinor) : undefined,
            credit: r.creditMinor ? money(r.creditMinor) : undefined,
            drill: drill(r.accountId),
          })),
          totals: {
            debit: money(tb.totals.debitMinor),
            credit: money(tb.totals.creditMinor),
          },
          balanced: tb.totals.debitMinor === tb.totals.creditMinor,
        };
      }
      case "partner_statement": {
        const statement = partnerStatementReport(db, range!.from, range!.to);
        return {
          ...head,
          partners: statement.partners.map((p) => ({
            contact: p.contactName,
            id: p.contactId,
            contributions: money(p.contributionsMinor),
            share_of_result: money(p.shareOfResultMinor),
            drawings: money(p.drawingsMinor),
            net: money(p.netMinor),
          })),
          notes: statement.notes,
        };
      }
      case "expense_tax": {
        const refs = new Refs(ctx, meta);
        const account =
          args.account !== undefined
            ? refs.account(args.account, "account", {
                types: [AccountType.Expense],
              })
            : undefined;
        const missed = refs.failure();
        if (missed) return missed;
        const page = startPage(args, args);
        if (!page.ok) return toolError(page.error);
        let tax: ReturnType<typeof expenseTaxReport>;
        try {
          tax = expenseTaxReport(
            db,
            range!.from,
            range!.to,
            args.review_only ?? false,
            account?.id ?? null,
          );
        } catch {
          return toolError({
            code: "INVALID_INPUT",
            path: "period",
            message: "That is not a valid inclusive date range.",
            fix: 'Send period, e.g. "2026-03" or "2026-01-01..2026-03-31".',
          });
        }
        const rows = tax.rows
          .slice(page.value.offset, page.value.offset + page.value.limit + 1)
          .map((r) => ({
            id: r.recordId,
            no: r.recordNumber ?? `#${r.recordId}`,
            date: r.date,
            description: r.label ?? r.description,
            account: label(r.accountId, r.accountName),
            amount: money(r.expenseMinor),
            deductible:
              r.deductibleMinor === null ? undefined : money(r.deductibleMinor),
            add_back:
              r.addBackMinor === null ? undefined : money(r.addBackMinor),
            treatment: r.classification?.treatment ?? "unclassified",
            percent:
              r.classification?.percentageBps == null
                ? undefined
                : String(r.classification.percentageBps / 100),
            review: r.reviewRequired ? r.reviewStatus : undefined,
            voided: r.voided || undefined,
          }));
        return pageResult({
          rows,
          page: page.value,
          total: tax.rows.length,
          narrow: "period, account or review_only",
          key: "rows",
          head: {
            ...head,
            account: account ? label(account.id, account.name) : undefined,
            totals: {
              expense: money(tax.expenseMinor),
              deductible: money(tax.deductibleMinor),
              add_back: money(tax.addBackMinor),
              unresolved: money(tax.unresolvedMinor),
              unresolved_lines: tax.unresolvedLineCount,
            },
            drill: account
              ? {
                  tool: search,
                  args: { account: account.id, period: periodText },
                }
              : { tool: search, args: { period: periodText } },
            notes: [tax.note],
          },
        });
      }
      case "aged_receivables":
      case "aged_payables": {
        const page = startPage(args, args);
        if (!page.ok) return toolError(page.error);
        const direction =
          report === "aged_receivables" ? "owed-to-us" : "we-owe";
        const ageing = outstandingAgeing(db, {
          direction,
          openOnly: true,
          asOf: asAt,
        });
        const open = ageing.items
          .filter((i) => i.position !== "credit")
          .sort(
            (a, b) =>
              b.daysOverdue - a.daysOverdue || a.date.localeCompare(b.date),
          );
        const contacts = balancesByContact(ageing.items)
          .filter((c) => c.outstandingMinor !== 0)
          .slice(0, 10);
        return pageResult({
          rows: open
            .slice(page.value.offset, page.value.offset + page.value.limit + 1)
            .map((i) => ({
              id: i.recordId,
              no: i.recordNumber ?? `#${i.recordId}`,
              kind: enumLabel(LedgerRecordKindLabels, i.kind),
              date: i.date,
              due: i.dueDate ?? i.date,
              contact: i.contactName ?? i.supplierContactName ?? undefined,
              description: i.description,
              outstanding: money(i.outstandingMinor),
              days_overdue: i.daysOverdue,
              band: i.band,
            })),
          page: page.value,
          total: open.length,
          narrow: "as_at",
          key: "items",
          head: {
            ...head,
            as_at: ageing.asOf,
            total_outstanding: money(ageing.totalOutstandingMinor),
            owed: money(ageing.totalObligationsMinor),
            unapplied_credit: money(ageing.totalCreditsMinor),
            bands: ageing.bands.map((b) => ({
              band: b.label,
              count: b.count,
              total: money(b.totalMinor),
            })),
            largest_contacts: contacts.map((c) => ({
              contact: c.contactName,
              id: c.contactId,
              outstanding: money(c.outstandingMinor),
              drill: {
                tool: meta.nameOf("get_contact"),
                args: { contact: c.contactId },
              },
            })),
            notes: [
              "Open items are as they stand now; as_at only sets the day age is counted to. Unapplied credits reduce the total and are not listed here: see get_contact.",
            ],
          },
        });
      }
      case "fixed_assets": {
        const page = startPage(args, args);
        if (!page.ok) return toolError(page.error);
        const register = readFixedAssets(ctx, asAt!);
        if (!register.ok) return toolError(fromAppFailure(register));
        const r = register.value;
        const sum = (pick: (a: (typeof r.assets)[number]) => number) =>
          r.assets.reduce((total, a) => total + pick(a), 0);
        const differing = (
          rows: {
            accountId: number;
            accountName: string;
            registerMinor: number;
            ledgerMinor: number;
            differenceMinor: number;
          }[],
        ) =>
          rows
            .filter((x) => x.differenceMinor !== 0)
            .map((x) => ({
              account: label(x.accountId, x.accountName),
              register: money(x.registerMinor),
              ledger: money(x.ledgerMinor),
              difference: money(x.differenceMinor),
            }));
        return pageResult({
          rows: r.assets
            .slice(page.value.offset, page.value.offset + page.value.limit + 1)
            .map((a) => ({
              id: a.id,
              no: assetNumber(a.id),
              name: a.name,
              type: a.assetType,
              serial: a.serialNumber || undefined,
              account: label(a.assetAccountId, a.accountName),
              acquired: a.acquisitionDate,
              cost: money(a.costMinor),
              depreciation: money(a.accumulatedDepreciationMinor),
              net_book_value: money(a.netBookValueMinor),
              status: a.depreciation.status,
              months_due: a.depreciation.dueCount || undefined,
              next_month: a.depreciation.nextMonth ?? undefined,
              review:
                a.depreciation.reviewReason ?? a.reviewReason ?? undefined,
              source_record: a.sourceRecordId ?? undefined,
              // The version manage_fixed_assets needs as expected_version.
              v: a.version,
              drill: drill(a.assetAccountId),
            })),
          page: page.value,
          total: r.assets.length,
          narrow: "as_at",
          key: "assets",
          head: {
            ...head,
            totals: {
              cost: money(r.totalCostMinor),
              depreciation: money(sum((a) => a.accumulatedDepreciationMinor)),
              net_book_value: money(sum((a) => a.netBookValueMinor)),
            },
            unregistered_purchases: r.unregistered.slice(0, 20).map((l) => ({
              id: l.recordId,
              no: l.recordNumber ?? `#${l.recordId}`,
              date: l.recordDate,
              account: label(l.accountId, l.accountName),
              amount: money(Math.abs(l.amountMinor)),
              description: l.label ?? l.description,
            })),
            unregistered_total:
              r.unregistered.length > 20 ? r.unregistered.length : undefined,
            cost_differences: differing(r.costReconciliation),
            depreciation_differences: differing(r.depreciationReconciliation),
          },
        });
      }
    }
  },
});

/** The report read tools, in listing order. */
export const reportsReadTools: readonly ToolDefinition[] = [getReport];
