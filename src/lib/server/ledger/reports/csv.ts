import { fromMinor } from "../money.js";
import { AccountType } from "$lib/enums.js";
import type {
  AccountHistoryReport,
  BalanceSheetReport,
  CashFlowReport,
  CsvTable,
  PartnerStatementReport,
  ProfitLossReport,
  ReportLine,
} from "../types.js";

/**
 * Turning a report into something an accountant's software will open (FR-029).
 *
 * String building, no dependency: CSV is a handful of rules and a package for
 * it would weigh more than the rules do (D-18, Principle II).
 *
 * Two of those rules are worth stating because getting either wrong is silent.
 * First, a field is quoted when it contains a separator, a quote, a line break,
 * a tab, or padding spaces — anything that would otherwise move the boundary
 * between one field and the next. Second, a *text* field beginning with `=`,
 * `+`, `-`, `@` or a tab is a formula to a spreadsheet, so it is prefixed with
 * an apostrophe and opens as the text it was. Numbers are never prefixed: a
 * number cannot carry a formula, and defusing -30.00 would turn every amount
 * the business is out of pocket into a word the spreadsheet refuses to add up.
 */

/** Anything that would otherwise move the boundary between one field and the next. */
const NEEDS_QUOTING = /["\r\n\t,]|^\s|\s$/;

/** What a spreadsheet reads as the start of a formula rather than as text. */
const READS_AS_A_FORMULA = /^[=+\-@\t\r]/;

const ROW_SEPARATOR = "\r\n";

function quoteIfNeeded(text: string): string {
  if (!NEEDS_QUOTING.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function field(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return quoteIfNeeded(String(value));
  const safe = READS_AS_A_FORMULA.test(value) ? `'${value}` : value;
  return quoteIfNeeded(safe);
}

/** A note is a sentence, not data, so it is always one quoted cell of its own. */
function noteRow(note: string): string {
  return `"${note.replace(/"/g, '""')}"`;
}

export function toCsv(table: CsvTable): string {
  const lines = [
    table.columns.map(field).join(","),
    ...table.rows.map((row) => row.map(field).join(",")),
  ];

  // A blank line, so the notes underneath read as a footer rather than as two
  // more rows of the table.
  if (table.notes && table.notes.length > 0) {
    lines.push("", ...table.notes.map(noteRow));
  }

  return lines.join(ROW_SEPARATOR);
}

// ---------------------------------------------------------------------------
// One table per report. The column order is fixed here rather than at each
// endpoint, so the file a user exported last month has the same shape as the
// one they export today.
// ---------------------------------------------------------------------------

const SECTION_COLUMNS = ["Section", "Account", "Amount"];

const REVENUE = "Revenue";
const EXPENSES = "Expenses";

function coveredPeriod(dateFrom: string, dateTo: string): string {
  return `Covers ${dateFrom} to ${dateTo}.`;
}

export function profitLossCsv(report: ProfitLossReport): CsvTable {
  const rows: (string | number | null)[][] = [];

  for (const line of report.income) {
    rows.push([REVENUE, line.accountName, fromMinor(line.amountMinor)]);
  }
  rows.push([REVENUE, "Total revenue", fromMinor(report.totalIncomeMinor)]);

  for (const line of report.expenses) {
    rows.push([EXPENSES, line.accountName, fromMinor(line.amountMinor)]);
  }
  rows.push([EXPENSES, "Total expenses", fromMinor(report.totalExpensesMinor)]);

  rows.push([
    "Net profit (loss)",
    report.resultMinor < 0 ? "Net loss" : "Net profit",
    fromMinor(report.resultMinor),
  ]);

  return {
    columns: SECTION_COLUMNS,
    rows,
    notes: [coveredPeriod(report.dateFrom, report.dateTo), ...report.notes],
  };
}

function sectionRows(
  section: string,
  lines: ReportLine[],
  totalMinor: number,
): (string | number | null)[][] {
  const rows = lines.map((line) => [
    section,
    line.accountName,
    fromMinor(line.amountMinor),
  ]);
  rows.push([section, "Total", fromMinor(totalMinor)]);
  return rows;
}

export function balanceSheetCsv(report: BalanceSheetReport): CsvTable {
  return {
    columns: SECTION_COLUMNS,
    rows: [
      ...sectionRows("Assets", report.owned.lines, report.owned.totalMinor),
      ...sectionRows("Liabilities", report.owed.lines, report.owed.totalMinor),
      ...sectionRows(
        "Equity",
        report.ownersStake.lines,
        report.ownersStake.totalMinor,
      ),
    ],
    notes: [`As at ${report.asAt}.`, ...report.notes],
  };
}

function cashFlowSectionRows(
  section: CashFlowReport["operating"],
): (string | number | null)[][] {
  const rows = section.lines.map((line) => [
    section.label,
    line.label,
    fromMinor(line.amountMinor),
  ]);
  rows.push([section.label, "Total", fromMinor(section.totalMinor)]);
  return rows;
}

export function cashFlowCsv(report: CashFlowReport): CsvTable {
  const rows: (string | number | null)[][] = [
    ...cashFlowSectionRows(report.operating),
    ...cashFlowSectionRows(report.investing),
    ...cashFlowSectionRows(report.financing),
  ];
  if (report.needsReviewMinor !== 0) {
    rows.push([
      "Unclassified",
      "Unclassified accounts",
      fromMinor(report.needsReviewMinor),
    ]);
  }
  rows.push(["Cash", "Opening cash and cash equivalents", fromMinor(report.openingCashMinor)]);
  rows.push(["Cash", "Net change in cash", fromMinor(report.netChangeMinor)]);
  rows.push(["Cash", "Closing cash and cash equivalents", fromMinor(report.closingCashMinor)]);

  return {
    columns: SECTION_COLUMNS,
    rows,
    notes: [coveredPeriod(report.dateFrom, report.dateTo), ...report.notes],
  };
}

export function partnerStatementCsv(report: PartnerStatementReport): CsvTable {
  return {
    columns: [
      "Partner",
      "Contributions",
      "Share of profit",
      "Drawings",
      "Closing balance",
    ],
    rows: report.partners.map((partner) => [
      partner.contactName,
      fromMinor(partner.contributionsMinor),
      fromMinor(partner.shareOfResultMinor),
      fromMinor(partner.drawingsMinor),
      fromMinor(partner.netMinor),
    ]),
    notes: [coveredPeriod(report.dateFrom, report.dateTo), ...report.notes],
  };
}

export function accountHistoryCsv(report: AccountHistoryReport): CsvTable {
  // The same flip the screen applies, for the same reason: under the one sign
  // convention money we owe accumulates negative, and a reader expects to see
  // "we owe 1,200" rather than "-1,200" (D-03).
  //
  // The other three reports are already oriented by the time they reach here,
  // because their report modules flipped them. Account history is the one that
  // arrives raw — `accountHistory` returns the stored amounts and the component
  // flips them at render — so without this line the exported file disagreed
  // with the screen it was exported from, which is the one thing an export
  // must never do.
  const sign =
    report.account.type === AccountType.Asset ||
    report.account.type === AccountType.Expense
      ? 1
      : -1;

  const rows: (string | number | null)[][] = [
    // What the account already held before the first line shown, so the running
    // balance down the right-hand side starts from somewhere.
    [
      "",
      "",
      "Balance brought forward",
      "",
      null,
      fromMinor(report.openingBalanceMinor * sign),
    ],
    ...report.entries.map((entry) => [
      entry.date,
      entry.recordNumber ?? "",
      entry.description,
      entry.contactName ?? "",
      fromMinor(entry.amountMinor * sign),
      fromMinor(entry.runningBalanceMinor * sign),
    ]),
  ];

  return {
    columns: [
      "Date",
      "Reference",
      "Description",
      "Contact",
      "Amount",
      "Running balance",
    ],
    rows,
    notes: [`Account: ${report.account.name}.`, ...report.notes],
  };
}
