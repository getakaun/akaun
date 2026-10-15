import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  balanceSheetReport,
  cashFlowReport,
  partnerStatementReport,
  profitLossReport,
} from "../../queries/reports.js";
import {
  registerRead,
  date,
  checkDateRange,
  McpToolError,
  type McpContext,
} from "../common.js";

export function registerReports(server: McpServer, context: McpContext) {
  registerRead(
    server,
    context,
    "get_financial_report",
    "Read the app's canonical financial report in main-currency minor units. balance-sheet requires asAt only; other types require inclusive dateFrom/dateTo only. Preserve report notes about incomplete history or accounts needing classification. Totals come from ledger movements, never a sum of record display amounts. Account lines have list_records drill-down filters; cash-flow lines represent activities rather than individual accounts.",
    {
      type: z.enum([
        "profit-loss",
        "balance-sheet",
        "cash-flow",
        "partner-statement",
      ]),
      dateFrom: date.optional(),
      dateTo: date.optional(),
      asAt: date.optional(),
    },
    (input) => {
      if (input.type === "balance-sheet") {
        if (!input.asAt || input.dateFrom || input.dateTo)
          throw new McpToolError(
            "INVALID_INPUT",
            "balance-sheet requires asAt and does not accept dateFrom/dateTo.",
          );
        const report = balanceSheetReport(context.db, input.asAt);
        return {
          type: input.type,
          report,
          drillDown: [
            ...report.owned.lines,
            ...report.owed.lines,
            ...report.ownersStake.lines,
          ]
            .filter((line) => line.accountId > 0)
            .map((line) => ({
              accountId: line.accountId,
              dateTo: input.asAt,
              path: `/records?account=${line.accountId}&dateTo=${input.asAt}`,
            })),
          reportPath: `/reports/balance-sheet?asAt=${input.asAt}`,
        };
      }
      if (!input.dateFrom || !input.dateTo || input.asAt)
        throw new McpToolError(
          "INVALID_INPUT",
          "This report requires dateFrom and dateTo and does not accept asAt.",
        );
      checkDateRange(input);
      const { dateFrom, dateTo } = input;
      switch (input.type) {
        case "profit-loss": {
          const report = profitLossReport(context.db, dateFrom, dateTo);
          return {
            type: input.type,
            report,
            drillDown: [...report.income, ...report.expenses].map((line) => ({
              accountId: line.accountId,
              dateFrom,
              dateTo,
              path: `/records?account=${line.accountId}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
            })),
            reportPath: `/reports/profit-loss?from=${dateFrom}&to=${dateTo}`,
          };
        }
        case "cash-flow":
          return {
            type: input.type,
            report: cashFlowReport(context.db, dateFrom, dateTo),
            reportPath: `/reports/cash-flow?from=${dateFrom}&to=${dateTo}`,
          };
        case "partner-statement":
          return {
            type: input.type,
            report: partnerStatementReport(context.db, dateFrom, dateTo),
            reportPath: `/reports/partners?from=${dateFrom}&to=${dateTo}`,
          };
      }
    },
  );
}
