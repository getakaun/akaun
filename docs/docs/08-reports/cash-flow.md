---
sidebar_position: 4
---

# Cash Flow Statement

The **Cash Flow Statement** tells you where your cash came from and what the business spent it on in a period. A
business can make a profit and still have less cash. This report shows why.

:::info

You need the **View** permission on **Reports**. Reports are view only. See
[Permissions explained](../09-administration/permissions-explained.md).

:::

## Open the report

1. Click **Reports**.
2. Click the **Cash Flow Statement** tab.
3. In **From**, choose the first day of the period.
4. In **To**, choose the last day of the period.

At the start, the period is from 1 January of this year to today.

## What counts as cash

Cash means cash and cash equivalents: the money in Asset accounts with the sub-type **Cash**, **Bank**, **Wallet** or
**Prepaid/debit card**. A transfer between two of these accounts does not change the cash. Thus it
is not on this report. See [Accounts and categories](../02-concepts/accounts-and-categories.md).

## What the report shows

The top of the report shows **Net change in cash** for the period. Below it, Akaun shows the cash at
the start of the period plus the change. The result must be equal to the cash at the end.

If **From** is after **To**, Akaun uses the **To** date for both.

The report has three sections. Each section ends with **Total**.

- **Operating activities**: the cash from the daily work of the business.
- **Investing activities**: the cash for things that the business keeps.
- **Financing activities**: the cash from loans and from the owners.

## How the sub-type selects the line

Each line is the total of a group of accounts. The account type and the sub-type select the line:

| Section | Line | Accounts |
|---|---|---|
| **Operating activities** | **Revenue** | Revenue accounts |
| **Operating activities** | **Change in receivables** | **Accounts receivable** |
| **Operating activities** | **Change in inventory** | **Inventory** |
| **Operating activities** | **Change in other current assets** | Other current Asset sub-types, for example **Prepayments and deposits** |
| **Operating activities** | **Trade payables and other liabilities** | Current Liability sub-types, for example **Accounts payable** and **Credit card** |
| **Operating activities** | **Cost of goods sold** | **Cost of goods sold** |
| **Operating activities** | **Operating expenses** | **Operating expense**, or no sub-type |
| **Operating activities** | **Other operating expenses** | **Other expense** |
| **Investing activities** | **Capital expenditure** | **Fixed asset**, **Intangible asset**, **Other non-current asset** |
| **Financing activities** | **Long-term debt** | **Long-term loan**, **Other non-current liability** |
| **Financing activities** | **Owner's equity** | Equity accounts |

The report shows only the lines with an amount in the period. If a section is empty, it shows
"Nothing this period."

### Unclassified

An Asset or Liability account without a sub-type does not go into a section. Its amount shows in a
separate **Unclassified** box, on the line **Unclassified movements**. A note below the report also
tells you about it.

To give an account a sub-type, you need the **Change** permission on **Accounts**.

1. Click **Accounts**.
2. Click the account.
3. Make sure that the top of the account page shows **Unclassified**.
4. In **Sub-type**, choose the correct sub-type.
5. Click **Save changes**.

The report then puts the amount on the correct line. In a new book, **Marketplace Clearing** and
**Loans** have no sub-type.

## Signs

A positive number is cash that the business received. A negative number is cash that the business paid. For example, the
expenses that you paid show as a negative number.

## Example

In April, the business had 5,000.00 in **Bank** at the start. Customers paid 9,000.00 for sales.
The business paid 3,000.00 for expenses and 2,000.00 for a laptop. The owner gave 1,000.00 more to the business.

| Section | Line | Amount |
|---|---|---|
| **Operating activities** | **Revenue** | 9,000.00 |
| **Operating activities** | **Operating expenses** | -3,000.00 |
| **Operating activities** | **Total** | 6,000.00 |
| **Investing activities** | **Capital expenditure** | -2,000.00 |
| **Investing activities** | **Total** | -2,000.00 |
| **Financing activities** | **Owner's equity** | 1,000.00 |
| **Financing activities** | **Total** | 1,000.00 |

The **Net change in cash** is 6,000.00 - 2,000.00 + 1,000.00 = 5,000.00. The cash at the end is
5,000.00 + 5,000.00 = 10,000.00.

## If the figures do not agree

If the change does not explain the cash at the end, the **Net change in cash** figure shows in
red. The text below it gives the difference. A warning also shows below the report. This tells you
that the data of a record is damaged.

1. Click **Settings**.
2. Click the **Ledger** tab.
3. In **Ledger integrity check**, click **Check now**.
4. Give the result to your administrator.

## See the records behind a line

You cannot click a line on this report, because each line can include many accounts. To see the
records, use the **Records** screen. Filter it by one cash account and by the dates of the report.
See [Find records](../03-everyday-tasks/find-records.md).

## Export the report

1. Click **Export**.

Akaun downloads a CSV file, for example `cash-flow-2026-01-01-to-2026-03-31.csv`. The file has the
columns "Section", "Account" and "Amount". It has the lines and the "Total" of each section. If an
amount is unclassified, the file has an "Unclassified movements" row. At the end, it has three
"Cash" rows: "Opening cash and cash equivalents", "Net change in cash" and "Closing cash and cash
equivalents".
Below the table, the file gives the period and the notes of the report.

## Notes

- You cannot print a report at this time. Use **Export** and print the CSV file.
- The address of the report includes the dates. Copy the address to send the same report to a
  different user.
- If Akaun converted your book from an earlier version, a note can show below the report. It
  shows when the period starts before the conversion. Invoices from before that day are not in
  the figures.

## Related

- [Dashboard](./dashboard.md)
- [Profit & Loss](./profit-and-loss.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)
- [Move money between accounts](../03-everyday-tasks/move-money-between-accounts.md)
