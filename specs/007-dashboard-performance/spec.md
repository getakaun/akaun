# Feature Specification: A Dashboard That Shows How the Business Is Doing

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description: "Previously we have a dashboard, and after we change the application to
double entry accounting, we've changed the dashboard and i feel it's incomplete now, i need you to
reanalyze the codebase and feature set, propose me a better dashboard, that can provide business
performance insight"

## Why this replaces part of 005

005 turned the dashboard's charts into three headline indicators because each chart did its own
arithmetic, and two screens disagreed. That fixed the disagreement and left the owner with three
numbers: no trend, no comparison, nothing about who owes what, the sales pipeline or what needs
doing. The problem 005 solved was never the chart, it was the second calculation. This spec keeps
005's rule (one calculation, the report's) and brings back the pictures that answer "how are we
doing" on top of it.

## Wording (whole application)

Labels use the standard accounting term (Receivables, Payables, Debit, Credit, Opening balance,
Reconciled, Unclassified, Capital expenditure, Working capital changes, Free cash flow). A short
line under a label explains it in ASD-STE100 simplified English where a hint helps. No screen uses
invented plain-language names for accounting ideas ("owed to us", "money in", "into / out of",
"starting balance", "needs review").

This rule started with the dashboard and was then applied to every screen, server message, report
note, CSV export, permission description, MCP tool description and the user guide. It reverses
the earlier choice, recorded in code comments on the record form, to keep accounting words off the
everyday screens. The journal entry block now says Debit and Credit. The balance-sheet subsection
"Needs review" is now "Unclassified" (a change to the `BalanceSheetSubsection` label type in
`ledger/types.ts`).

## Glossary

| Term | Plain meaning |
|---|---|
| Comparison period | The period each headline figure is measured against: the previous period of the same length, or the same period last year. |
| Operating cash flow | Cash from day-to-day trading. It differs from net profit by timing — customers not yet paid, bills not yet paid, stock. |
| Capital spending | Cash spent on things the business keeps (machinery, vehicles, software). It leaves the bank at once but is not an expense, so it never reduces profit in the period it is bought. |
| Free cash flow | Operating cash flow plus capital spending (which is negative): the cash the business actually generated after keeping itself equipped. |
| Runway | How many months the cash on hand would last if it kept falling at the recent rate. Only meaningful while cash is falling. |

## Requirements

**Calculation**

- **FR-001**: The dashboard MAY show charts. Every value a chart or a figure shows MUST come from the
  same calculation the matching Reports statement uses for that period or date (005 FR-014, carried
  forward). A monthly trend is the Profit & Loss run once per month; a cash trend is the Cash Flow
  Statement's closing cash at each month end.
- **FR-002**: Each headline figure, and each month of the monthly chart, MUST link to the matching
  Reports statement already set to the same period or date (005 FR-015, carried forward). When the
  books do not balance, the financial-position figures MUST show the Balance Sheet's warning
  (005 FR-016, carried forward).

**Periods**

- **FR-003**: The period selector MUST offer This month, This quarter, Year to date and Last 12
  months. Every period ends today; "today" is decided by the server and handed to the page, so the
  labels and the figures can never disagree.
- **FR-004**: Each headline figure that has a history MUST show its change against a comparison
  period: either the same number of days at the start of the previous period, or the same dates one
  year earlier. Year to date and Last 12 months offer only the one-year comparison, because for them
  the two are the same range.

**What the owner sees**

- **FR-005**: Headline figures: revenue, net profit with net margin, cash balance with runway, and
  receivables with the overdue part.
- **FR-006**: A 12-month chart of revenue and expenses with the net result, and a 12-month chart of
  month-end cash.
- **FR-007**: A profit-to-cash bridge for the period: net profit, operating cash flow, capital
  spending, free cash flow, financing, and the net change in cash, all read off the Cash Flow
  Statement. It MUST say that the app does not record depreciation, so equipment reaches profit
  only through a journal someone writes.
- **FR-008**: The largest expense and income lines for the period, with the rest folded into
  "Other" so the lines add up to the report's total, each with its change against the comparison
  period and a link to the records behind it.
- **FR-009**: Receivables and payables, grouped by how overdue they are, with the three largest
  contacts on each side.
- **FR-010**: The sales pipeline: open quotations and their value, quotations expiring within a
  week, invoices sent in the period, and unpaid and overdue invoices.
- **FR-011**: An "Action items" list: documents waiting for import review, unpaid bills, overdue
  invoices, bank statement lines not yet matched, accounts not yet classified, and books that do not
  balance. An item with nothing to report is left out.
- **FR-012**: Recent activity lists the newest records of every kind (not only expenses and
  income), and each row opens the record.

**Permissions and empty states**

- **FR-013**: `dashboard.read` opens the page. Each section additionally needs the permission of the
  screen its figures come from — statements need `reports.read`; amounts owed and recent activity
  need `records.read`; quotations need `quotations.read`; invoices need `invoices.read`; each
  attention item needs its own screen's read permission. A section the user may not read is left
  out entirely, not shown empty.
- **FR-014**: A book with no records shows one empty state that points at adding a record or
  importing a document, instead of a page of zeros.
- **FR-015**: The dashboard refreshes itself when records, settlements, accounts, sales documents or
  import jobs change, over the existing server-sent event stream.

## Out of scope

- Gross margin. The Profit & Loss does not say whether any cost-of-goods-sold lines exist, and
  `ledger/types.ts` is frozen.
- A trend for amounts owed. The ageing has no dated history.
- Depreciation, which 004 already places out of scope.
