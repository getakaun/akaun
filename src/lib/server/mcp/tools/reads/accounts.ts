import { z } from "zod";
import {
  AccountSubType,
  AccountSubTypeLabels,
  AccountType,
  AccountTypeLabels,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { accountTaxDefault } from "$lib/expense-tax.js";
import { accounts } from "../../../db/schema.js";
import { isCategoryAccount } from "../../../ledger/account-type.js";
import type { LedgerDb } from "../../../ledger/types.js";
import { listAccounts } from "../../../queries/accounts.js";
import { accountTaxOverview } from "../../../application/account-tax-classification.js";
import { accountVersion } from "../../../application/version.js";
import { formatMinor } from "../../../ledger/money.js";
import { fitRows } from "../../envelope.js";
import { enumLabel, money, mainCurrency } from "../../format.js";
import { defineReadTool, type ToolDefinition } from "../../registry.js";
import { LIST_ACCOUNTS, missingForActions } from "../../requirements/index.js";

/**
 * The accounts read tool, and the two small helpers the other D1 tools share
 * for naming an account the way an agent sends it back: `"5100 Advertising"`.
 */

// --- shared helpers ------------------------------------------------------------

/** One account as the agent reads it: its code and name, and what it is. */
export type AccountLabel = {
  id: number;
  code: number;
  name: string;
  /** `"5100 Advertising"`, which `resolveAccount` accepts back. */
  label: string;
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
};

/** Every account by id, archived ones too, so an old record still names its category. */
export function accountLabels(db: LedgerDb): Map<number, AccountLabel> {
  return new Map(
    db
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        subType: accounts.subType,
      })
      .from(accounts)
      .all()
      .map((row) => {
        // An account saved without a code shows its id, as the chart does.
        const code = row.code ?? row.id;
        return [
          row.id,
          {
            id: row.id,
            code,
            name: row.name,
            label: `${code} ${row.name}`,
            type: row.type as AccountTypeCode,
            subType: row.subType as AccountSubTypeCode | null,
          },
        ];
      }),
  );
}

/**
 * The four groups an agent asks for. Every account is in exactly one:
 * - `category`: what money was for (expense, income, equipment and other things bought and kept);
 * - `equity`: owner and partner capital, drawings, opening balances;
 * - `owed`: money owed either way (payables and other liabilities, receivables);
 * - `money`: where money sits (cash, bank, wallet, card, clearing).
 */
export type AccountKind = "money" | "category" | "owed" | "equity";
export const ACCOUNT_KINDS = ["money", "category", "owed", "equity"] as const;

export function accountKindOf(account: {
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
}): AccountKind {
  if (isCategoryAccount(account)) return "category";
  if (account.type === AccountType.Equity) return "equity";
  if (
    account.type === AccountType.Liability ||
    account.subType === AccountSubType.Receivable
  )
    return "owed";
  // What is left of the assets is where money sits (`isMoneyPotAccount`).
  return "money";
}

/** Basis points as the percent an agent reads and sends back: `5000` → `"50.00"`. */
export function percentText(bps: number): string {
  return formatMinor(bps, 2);
}

// --- list_accounts -------------------------------------------------------------

const ROW_STEERING = "Narrow with kind or query to see the rest.";

const listAccountsTool = defineReadTool({
  base: "list_accounts",
  title: "List accounts and categories",
  description:
    "List the chart of accounts with balances. Use it to find the account or category to name in another call, to see where money sits and what is owed, and to check tax defaults. " +
    "In Akaun a category is an account too: an expense or income category says what money was for, and the other accounts say where money sits or what is owed. " +
    "kind narrows the list: money (cash, bank, wallet, card), category (expense, income and equipment accounts), owed (payables and receivables) or equity. query matches a code or part of a name. Archived accounts are left out unless include_archived is true. " +
    "Each row has id, account (code and name, which can be sent back as a reference), type, sub_type, balance and v (the version, to pass as expected_version when changing the account). " +
    "balance is the ledger balance in the main currency (see currency): positive when value has gone into the account, so money held is positive and money owed, equity and income are negative; spending on a category is positive. For totals over a period use the report tool, not the sum of balances. " +
    "tax_default (expense accounts) is what new lines on the account capture; it does not change saved lines. unclassified_fillable counts open entries the default could fill; it shows only above zero and only to a caller allowed to apply tax defaults. " +
    "The list is not paged; if it is cut to fit, narrow with kind or query.",
  input: z.object({
    kind: z
      .enum(ACCOUNT_KINDS)
      .optional()
      .describe("money, category, owed or equity. Omit for every account."),
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("A code, or part of a name."),
    include_archived: z
      .boolean()
      .optional()
      .describe("Also list archived accounts. False by default."),
  }),
  requirements: LIST_ACCOUNTS.requirements,
  handler: (ctx, args) => {
    const views = listAccounts(ctx.db, {
      search: args.query,
      includeArchived: args.include_archived ?? false,
    }).filter((view) => !args.kind || accountKindOf(view) === args.kind);
    const labels = accountLabels(ctx.db);

    // Counting what a default could fill needs more than a read, so it is a
    // check: an account list shown to a reader-only token has none.
    const fillable =
      missingForActions(ctx.locals, "list_accounts", ["tax_overview"])
        .length === 0;

    const rows = views.map((view) => {
      const label = labels.get(view.id);
      const taxed = view.type === AccountType.Expense;
      const taxDefault = taxed ? accountTaxDefault(view) : null;
      const hasDefault =
        taxDefault !== null &&
        (taxDefault.percentageBps !== null ||
          taxDefault.treatment === "requires_review");
      let unclassified: number | undefined;
      if (fillable && taxed) {
        const overview = accountTaxOverview(ctx, view.id);
        if (overview.ok && overview.value.eligibleCount > 0)
          unclassified = overview.value.eligibleCount;
      }
      return {
        id: view.id,
        account: label?.label ?? `${view.code ?? view.id} ${view.name}`,
        type: enumLabel(AccountTypeLabels, view.type),
        sub_type: enumLabel(AccountSubTypeLabels, view.subType),
        balance: money(view.balanceMinor),
        archived: view.archivedAt !== null ? true : undefined,
        merged_into:
          view.mergedIntoAccountId != null
            ? labels.get(view.mergedIntoAccountId)?.label
            : undefined,
        tax_default: hasDefault
          ? {
              treatment: taxDefault.treatment,
              percent:
                taxDefault.percentageBps === null
                  ? undefined
                  : percentText(taxDefault.percentageBps),
            }
          : undefined,
        unclassified_fillable: unclassified,
        v: accountVersion(ctx.db, view.id),
      };
    });

    const head = { currency: mainCurrency(ctx.db) };
    const { payload } = fitRows(
      rows,
      (kept, trimmed) => ({
        ...head,
        count: trimmed ? rows.length : undefined,
        accounts: kept,
        note: rows.length === 0 ? "No account matches." : undefined,
      }),
      {
        steering: `Showing the first part of ${rows.length} accounts. ${ROW_STEERING}`,
      },
    );
    return payload;
  },
});

/** The accounts read tools, in listing order. */
export const accountsReadTools: readonly ToolDefinition[] = [listAccountsTool];
