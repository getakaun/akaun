import { z } from "zod";
import {
  DefaultAccountPurpose,
  ImportState,
  LedgerRecordKind,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import { closedThrough } from "../../../closing/policy.js";
import { can } from "../../../permissions.js";
import { listAccounts } from "../../../queries/accounts.js";
import { listImportJobs } from "../../../queries/import.js";
import { invoiceSummary } from "../../../queries/invoices.js";
import { listRecords } from "../../../queries/ledger.js";
import { unresolvedTaxLines } from "../../../queries/tax-review.js";
import { getAccountDefaults } from "../../../services/account-defaults.js";
import { unmatchedLinesByAccount } from "../../../services/reconciliation.js";
import { getSetting, SETTING_KEYS } from "../../../settings.js";
import { mainCurrency, money } from "../../format.js";
import {
  defineReadTool,
  requirementsMet,
  type ToolDefinition,
} from "../../registry.js";
import {
  ACTION_REQUIREMENTS,
  GET_BOOKS_OVERVIEW,
  TOOL_REQUIREMENTS_V2,
} from "../../requirements/index.js";
import { accountKindOf, accountLabels } from "./accounts.js";

/**
 * `get_books_overview`: the first call. One screen: who the books are for,
 * what the date is, what is closed, where money sits, what needs work, and
 * what this connection may do. Each part is left out when the caller may not
 * read its area, so a narrow token gets a short answer rather than a refusal.
 */

/** "In the last two months" for the missing-receipt queue. */
function monthsBefore(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const total = year * 12 + (month - 1) - months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

const getBooksOverview = defineReadTool({
  base: "get_books_overview",
  title: "Books overview (start here)",
  description:
    "Start here. Akaun is double-entry bookkeeping for a small business: records (expenses, income, transfers, payments) are posted between accounts, and a category is an account that says what money was for. This one call tells you the state of the books and what you may do, in one screen. " +
    "It returns the business name; main_currency, which every amount in every tool uses unless a row names another; today; closed_through (the books are closed up to and including that date, and a person must reopen a month in Akaun before anything dated in it can change); and uncategorised_accounts, the two default accounts that hold records not yet categorised. " +
    "money_accounts lists where money sits with each balance (positive is money held). " +
    "queues counts the work waiting, each with a drill to list it: records on the uncategorised account, expenses from the last two months with no file attached, bank statement lines not yet matched (by account), expense lines whose tax treatment is unresolved, overdue invoices and imports waiting for review. A queue that is missing is one this connection may not read. " +
    "can names, for each write tool, the actions this connection may use; a tool or action that is missing is not allowed, so do not try it. " +
    "Take it once at the start, then use the search, record, account, report and review tools. Counts are live, so call it again to see progress.",
  input: z.object({}),
  requirements: GET_BOOKS_OVERVIEW.requirements,
  handler: (ctx, _args, meta) => {
    const { db, locals } = ctx;
    const today = localToday();
    const boundary = closedThrough(db);
    const labels = accountLabels(db);
    const readsRecords = can(locals, "records.read");
    const readsAccounts = can(locals, "accounts.read");

    // The two accounts a record sits on until someone categorises it.
    let uncategorisedAccounts: Record<string, string | undefined> | undefined;
    if (readsRecords || readsAccounts) {
      const defaults = getAccountDefaults(db);
      const named = (purpose: DefaultAccountPurposeCode) => {
        const account = defaults.find((d) => d.purpose === purpose)?.account;
        return account ? `${account.code} ${account.name}` : undefined;
      };
      uncategorisedAccounts = {
        expense: named(DefaultAccountPurpose.UncategorisedExpense),
        income: named(DefaultAccountPurpose.UncategorisedIncome),
      };
    }

    const moneyAccounts = readsAccounts
      ? listAccounts(db)
          .filter((account) => accountKindOf(account) === "money")
          .map((account) => ({
            id: account.id,
            account: labels.get(account.id)?.label,
            balance: money(account.balanceMinor),
          }))
      : undefined;

    // --- work queues, each only for a caller who may read its area ---
    const search = meta.nameOf("search_records");
    const queues: Record<string, unknown> = {};
    if (readsRecords) {
      queues.uncategorised = {
        count: listRecords(db, { uncategorised: true, limit: 1 }).total,
        drill: { tool: search, args: { category: "uncategorised" } },
      };
      const since = monthsBefore(today, 2);
      queues.expenses_without_file = {
        count: listRecords(db, {
          kind: LedgerRecordKind.Expense,
          hasAttachment: false,
          dateFrom: since,
          dateTo: today,
          limit: 1,
        }).total,
        drill: {
          tool: search,
          args: {
            kinds: ["expense"],
            has_attachment: false,
            period: `${since}..${today}`,
          },
        },
      };
      const from = boundary ? addDaysISO(boundary, 1) : null;
      queues.unresolved_tax_lines = {
        count: unresolvedTaxLines(db, boundary, today).length,
        drill: {
          tool: search,
          args: {
            tax: ["unclassified", "requires_review"],
            ...(from && from <= today ? { period: `${from}..${today}` } : {}),
          },
        },
      };
    }
    if (can(locals, "reconciliation.read")) {
      const byAccount = unmatchedLinesByAccount(db).sort(
        (a, b) => b.count - a.count || a.accountId - b.accountId,
      );
      queues.unmatched_bank_lines = {
        count: byAccount.reduce((sum, row) => sum + row.count, 0),
        by_account: byAccount.map((row) => ({
          id: row.accountId,
          account: labels.get(row.accountId)?.label,
          lines: row.count,
        })),
        drill: { tool: meta.nameOf("get_bank_reconciliation") },
      };
    }
    if (can(locals, "invoices.read")) {
      queues.overdue_invoices = {
        count: invoiceSummary(db, { from: today, to: today }, today)
          .overdueCount,
        drill: { tool: meta.nameOf("get_sales_documents") },
      };
    }
    if (can(locals, "import.read")) {
      queues.imports_to_review = {
        count: listImportJobs(db, {
          states: [ImportState.PendingReview],
          limit: 1,
          offset: 0,
        }).total,
        drill: { tool: meta.nameOf("get_import_queue") },
      };
    }

    // --- what this connection may do: the actions of each write tool ---
    const allowed: Record<string, string[] | true> = {};
    for (const [base, entry] of Object.entries(TOOL_REQUIREMENTS_V2)) {
      if (entry.kind !== "write") continue;
      const actions = ACTION_REQUIREMENTS[base];
      if (actions) {
        const names = Object.entries(actions)
          .filter(([, needs]) => requirementsMet(locals, needs))
          .map(([name]) => name);
        if (names.length) allowed[meta.nameOf(base)] = names;
      } else if (requirementsMet(locals, entry.requirements))
        allowed[meta.nameOf(base)] = true;
    }

    return {
      business: getSetting(db, SETTING_KEYS.companyName),
      main_currency: mainCurrency(db),
      today,
      closed_through: boundary,
      uncategorised_accounts: uncategorisedAccounts,
      money_accounts: moneyAccounts,
      queues,
      can: Object.keys(allowed).length
        ? allowed
        : "nothing: this connection can read but not change the books",
    };
  },
});

/** The overview read tools, in listing order. */
export const overviewReadTools: readonly ToolDefinition[] = [getBooksOverview];
