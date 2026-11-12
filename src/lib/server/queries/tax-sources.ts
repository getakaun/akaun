import { taxEvidenceRead } from "../tax-evidence.js";
import { safeTaxSum, type TaxSourceSnapshot } from "$lib/tax-worksheet.js";
import type { LedgerDb } from "../ledger/types.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import { expenseTaxReport } from "./expense-tax-report.js";
import { profitLossReport } from "./reports.js";
/** No current defaults, dates of capture or live-source FKs in retained evidence. */
export function captureTaxSources(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
): TaxSourceSnapshot {
  return taxEvidenceRead(db, `sources:${dateFrom}:${dateTo}`, () => {
    const pl = profitLossReport(db, dateFrom, dateTo);
    const report = expenseTaxReport(db, dateFrom, dateTo);
    const expenses = report.rows.map((r) => ({
      movementId: r.movementId,
      recordId: r.recordId,
      recordNumber: r.recordNumber,
      date: r.date,
      description: r.description,
      label: r.label,
      accountId: r.accountId,
      accountName: r.accountName,
      expenseMinor: r.expenseMinor,
      classification: r.classification,
      voided: r.voided,
    }));
    const incomeMinor = safeTaxSum(pl.income.map((l) => l.amountMinor));
    const expenseMinor = safeTaxSum(pl.expenses.map((l) => l.amountMinor));
    if (safeTaxSum(expenses.map((l) => l.expenseMinor)) !== expenseMinor)
      throw new Error("Expense tax sources do not reconcile to Profit & Loss.");
    return {
      calculationVersion: 1,
      currency: getSetting(db, SETTING_KEYS.currencyCode) || "MYR",
      companyName: getSetting(db, SETTING_KEYS.companyName) || "Akaun",
      incomeMinor,
      expenseMinor,
      profitMinor: safeTaxSum([incomeMinor, -expenseMinor]),
      notes: pl.notes,
      profitLines: [
        ...pl.income.map((l) => ({ ...l, type: "income" as const })),
        ...pl.expenses.map((l) => ({ ...l, type: "expense" as const })),
      ],
      expenses,
    };
  });
}
