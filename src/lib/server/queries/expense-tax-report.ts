import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import {
  deductionMinor,
  TaxTreatmentLabels,
  needsTaxReview,
} from "$lib/expense-tax.js";
import { accounts, ledgerMovements, ledgerRecords } from "../db/schema.js";
import type { CsvTable, LedgerDb } from "../ledger/types.js";
import { isValidDate } from "../date.js";

import { inVoidPair } from "./void-state.js";

export function expenseTaxReport(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
  reviewOnly = false,
  accountId: number | null = null,
) {
  if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo)
    throw new Error("Choose a valid inclusive date range.");
  const rows = db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      label: ledgerMovements.label,
      accountId: accounts.id,
      accountName: accounts.name,
      expenseMinor: ledgerMovements.amountMinor,
      classification: ledgerMovements.taxClassification,
      voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(
      and(
        eq(accounts.type, AccountType.Expense),
        gte(ledgerRecords.date, dateFrom),
        lte(ledgerRecords.date, dateTo),
        accountId === null
          ? undefined
          : eq(ledgerMovements.accountId, accountId),
      ),
    )
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerRecords.id),
      asc(ledgerMovements.sortOrder),
      asc(ledgerMovements.id),
    )
    .all()
    .map((row) => {
      const tax = row.classification;
      const unresolved = needsTaxReview(tax);
      const percentageBps = tax?.percentageBps;
      const deductibleMinor =
        unresolved || percentageBps == null
          ? null
          : deductionMinor(row.expenseMinor, percentageBps);
      return {
        ...row,
        voided: Boolean(row.voided),
        reviewRequired: unresolved && !row.voided,
        reviewStatus: unresolved
          ? tax?.treatment === "requires_review"
            ? ("requires_review" as const)
            : ("unclassified" as const)
          : ("estimate" as const),
        deductibleMinor,
        addBackMinor:
          deductibleMinor === null ? null : row.expenseMinor - deductibleMinor,
      };
    })
    .filter((row) => !reviewOnly || row.reviewRequired);
  const sum = (values: number[]) => {
    const total = Number(values.reduce((s, n) => s + BigInt(n), 0n));
    if (!Number.isSafeInteger(total))
      throw new Error("The report total exceeds safe integer cents.");
    return total;
  };
  return {
    dateFrom,
    dateTo,
    accountId,
    reviewOnly,
    rows,
    expenseMinor: sum(rows.map((r) => r.expenseMinor)),
    deductibleMinor: sum(rows.map((r) => r.deductibleMinor ?? 0)),
    addBackMinor: sum(rows.map((r) => r.addBackMinor ?? 0)),
    unresolvedMinor: sum(
      rows
        .filter((r) => r.reviewStatus !== "estimate")
        .map((r) => r.expenseMinor),
    ),
    unresolvedLineCount: rows.filter((r) => r.reviewRequired).length,
    note: "Potential deductions and add-backs are estimates, not accountant-approved tax amounts. Unclassified and Requires review lines are excluded from both estimates. Amounts use saved line classifications in the main currency; void pairs cancel.",
  };
}
export type ExpenseTaxReport = ReturnType<typeof expenseTaxReport>;

export function expenseTaxCsv(report: ExpenseTaxReport): CsvTable {
  const money = (minor: number | null) =>
    minor === null ? null : (minor / 100).toFixed(2);
  return {
    columns: [
      "Date",
      "Record",
      "Record ID",
      "Movement ID",
      "Account",
      "Description",
      "Expense",
      "Potential deduction",
      "Potential add-back",
      "Percentage",
      "Treatment",
      "Review status",
      "Source",
      "Reason",
      "Classified by",
      "Classified at",
      "Provenance",
      "Needs tax review",
    ],
    rows: report.rows.map((r) => [
      r.date,
      r.recordNumber,
      r.recordId,
      r.movementId,
      r.accountName,
      r.label ?? r.description,
      money(r.expenseMinor),
      money(r.deductibleMinor),
      money(r.addBackMinor),
      r.classification?.percentageBps == null
        ? null
        : (r.classification.percentageBps / 100).toFixed(2),
      TaxTreatmentLabels[r.classification?.treatment ?? "unclassified"],
      r.reviewStatus,
      r.classification?.source ?? "historical_unreviewed",
      r.classification?.reason ?? null,
      r.classification?.classifiedBy ?? null,
      r.classification?.classifiedAt ?? null,
      r.classification?.provenance ?? "historical",
      r.reviewRequired ? "Yes" : "No",
    ]),
    notes: [
      report.note,
      `Total expense: ${money(report.expenseMinor)}; potential deduction: ${money(report.deductibleMinor)}; potential add-back: ${money(report.addBackMinor)}; unresolved: ${money(report.unresolvedMinor)} (${report.unresolvedLineCount} lines).`,
    ],
  };
}
