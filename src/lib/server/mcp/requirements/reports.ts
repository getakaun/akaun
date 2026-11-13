import { read, readToolBy } from "./define.js";

/**
 * Reports: `get_report`. v1 `get_financial_report` needed reports:read; the
 * reports it did not have need what their REST endpoints ask for as well.
 */

const REPORTS = read(["reports:read"]);

export const GET_REPORT = readToolBy("report", {
  profit_loss: REPORTS,
  balance_sheet: REPORTS,
  cash_flow: REPORTS,
  trial_balance: REPORTS,
  partner_statement: REPORTS,
  // `/api/reports/expense-tax` asks for reports.read.
  expense_tax: REPORTS,
  // `outstandingAgeing` reads open items: `/api/settlements` asks for
  // records.read (v1 `list_outstanding`).
  aged_receivables: read(["reports:read", "records:read"]),
  aged_payables: read(["reports:read", "records:read"]),
  // `readFixedAssets` asks for accounts.read and records.read.
  fixed_assets: read(["reports:read", "accounts:read", "records:read"]),
});
