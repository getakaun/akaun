import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  AccountTypeLabels,
  AccountSubTypeLabels,
  LedgerRecordKindLabels,
  accountTypeEnum,
  type AccountTypeCode,
} from "$lib/enums.js";
import {
  listAccounts,
  accountHistory,
  canonicalAccountId,
} from "../../queries/accounts.js";
import { ledgerTrackingStartDate } from "../../queries/reports.js";
import {
  displaySignForAccountType,
  isCategoryAccount,
} from "../../ledger/account-type.js";
import { historyGapNotes } from "../../ledger/reports/notes.js";
import type { AccountView } from "../../ledger/types.js";
import { accountVersion } from "../../application/version.js";
import { openingBalanceVersion } from "../../application/accounts.js";
import {
  registerRead,
  id,
  dateRangeShape,
  pageShape,
  checkDateRange,
  pagination,
  McpToolError,
  type McpContext,
} from "../common.js";

function accountSummary(context: McpContext, account: AccountView) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: AccountTypeLabels[account.type],
    subType:
      account.subType === null ? null : AccountSubTypeLabels[account.subType],
    category: isCategoryAccount(account),
    archived: account.archivedAt !== null,
    mergedIntoAccountId: account.mergedIntoAccountId ?? null,
    postingEligible: account.postingEligible,
    balanceMinor: account.balanceMinor,
    displayBalanceMinor:
      account.balanceMinor * displaySignForAccountType(account.type),
    path: `/accounts/${account.id}`,
    version: accountVersion(context.db, account.id),
    /** For set_opening_balance: its record's version, or "absent". */
    openingBalanceVersion: openingBalanceVersion(context.db, account.id),
  };
}

export function registerAccounts(server: McpServer, context: McpContext) {
  registerRead(
    server,
    context,
    "list_accounts",
    "Discover accounts and categories (categories are accounts). Balances are current signed ledger amounts; displayBalanceMinor applies the account type's reporting sign, so contra revenue debit balances display as deductions. Archived accounts are optionally included. The chart is small and is read as one set before output paging.",
    {
      ...pageShape,
      type: z
        .enum(["asset", "liability", "equity", "revenue", "expense"])
        .optional(),
      category: z.boolean().optional(),
      includeArchived: z.boolean().default(false),
      search: z.string().trim().max(200).optional(),
    },
    (input) => {
      const rows = listAccounts(context.db, {
        ...input,
        type: input.type
          ? (accountTypeEnum.fromLabel(input.type) as AccountTypeCode)
          : undefined,
      }).filter(
        (account) =>
          input.category === undefined ||
          isCategoryAccount(account) === input.category,
      );
      const accounts = rows
        .slice(input.offset, input.offset + input.limit)
        .map((account) => accountSummary(context, account));
      return {
        accounts,
        pagination: pagination(rows.length, input, accounts.length),
        filters: input,
        balanceBasis:
          "Current all-time ledger balances in main-currency minor units. Positive ledger value enters the account; liabilities/equity/revenue use the opposite display sign.",
      };
    },
  );

  registerRead(
    server,
    context,
    "get_account_statement",
    "Read an account's chronological movements and signed running balances. Dates are inclusive. No offset or additional filters: skipping movements would corrupt running balances. When truncated, returnedClosingBalanceMinor is only through returned rows; periodClosingBalanceMinor is null. Narrow dates to obtain a complete statement.",
    {
      accountId: id,
      ...dateRangeShape,
      limit: z.number().int().min(1).max(500).default(100),
    },
    (input) => {
      checkDateRange(input);
      const accountId = canonicalAccountId(context.db, input.accountId);
      if (accountId === null)
        throw new McpToolError("NOT_FOUND", "That account does not exist.");
      const history = accountHistory(context.db, accountId, input);
      if (!history)
        throw new McpToolError("NOT_FOUND", "That account does not exist.");
      const truncated = history.total > history.entries.length;
      return {
        account: accountSummary(context, history.account),
        requestedAccountId: input.accountId,
        openingBalanceMinor: history.openingBalanceMinor,
        returnedClosingBalanceMinor: history.closingBalanceMinor,
        periodClosingBalanceMinor: truncated
          ? null
          : history.closingBalanceMinor,
        entries: history.entries.map((entry) => ({
          ...entry,
          kind: LedgerRecordKindLabels[entry.kind],
          path: `/records/${entry.recordId}`,
        })),
        total: history.total,
        returned: history.entries.length,
        truncated,
        filters: input,
        notes: [
          ...history.notes,
          ...historyGapNotes(
            input.dateFrom ?? null,
            ledgerTrackingStartDate(context.db),
          ),
          ...(truncated
            ? [
                "This is a partial statement. The returned closing balance is not the full period closing balance; narrow the date range.",
              ]
            : []),
        ],
      };
    },
  );
}
