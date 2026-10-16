---
sidebar_position: 2
---

# Profit & Loss

**Profit & Loss** tells you if the business made a profit or a loss in a period. It shows the
revenue, the expenses and the difference between them.

:::info

You need the **View** permission on **Reports**. Reports are view only. See
[Permissions explained](../09-administration/permissions-explained.md).

:::

## Open the report

1. Click **Reports**.
2. Click the **Profit & Loss** tab.
3. In **From**, choose the first day of the period.
4. In **To**, choose the last day of the period.

**Profit & Loss** is the first tab. At the start, the period is from 1 January of this year to
today. If **From** is after **To**, Akaun uses the **To** date for both.

## What the report shows

The top of the report shows **Net profit** or **Net loss**. This is the total revenue minus the
total expenses for the period.

Below it, the report has these sections:

- **Revenue**: one line for each Revenue account, and **Total revenue**.
- **Expenses**: one line for each Expense account, and **Total expenses**.
- **Summary**: **Gross profit** and **Operating income**.

The report shows only the accounts with an amount in the period. If a section is empty, it shows
"Nothing in this period."

A transfer between two of your own accounts is not on this report. A purchase of equipment is also
not on this report, because equipment stays on the **Balance Sheet**. See
[Accounts and categories](../02-concepts/accounts-and-categories.md).

## How the summary uses the sub-type

The sub-type of each account puts its amount into the **Summary**:

- **Gross profit** is the **Operating revenue** minus the **Cost of goods sold**.
- **Operating income** is the **Gross profit** minus the **Operating expense** accounts.

**Other revenue** and **Other expense** accounts are not in these two subtotals. They are in the
**Net profit**. A Revenue or Expense account without a sub-type counts as operating. See
[Accounts and categories](../02-concepts/accounts-and-categories.md).

## Signs

Revenue and expenses both show as positive numbers. A negative number on a line is unusual. For
example, a refund that is more than the sales of the period gives a negative revenue line.

## Example

In March, the business sold goods for 10,000.00. The goods cost 4,000.00. Advertising cost
1,000.00. The bank paid interest of 100.00 into the **Other Revenue** account.

| Line | Amount |
|---|---|
| **Product Sales** | 10,000.00 |
| **Other Revenue** | 100.00 |
| **Total revenue** | 10,100.00 |
| **Cost of Goods Sold** | 4,000.00 |
| **Advertising** | 1,000.00 |
| **Total expenses** | 5,000.00 |
| **Gross profit** | 6,000.00 |
| **Operating income** | 5,000.00 |
| **Net profit** | 5,100.00 |

The interest is in **Net profit**, but not in **Operating income**.

## See the records behind a line

To open a line, you also need the **View** permission on **Accounts** and on **Records**.

1. Click the name of a line, for example **Advertising**.
2. On the account page, click **View account ledger**.

The **Records** screen shows all records of the account, with a running balance. It shows all
dates, not only the period of the report. Choose the dates again in the **Date** filter. See
[Find records](../03-everyday-tasks/find-records.md).

## Export the report

1. Click **Export**.

Akaun downloads a CSV file, for example `profit-and-loss-2026-01-01-to-2026-03-31.csv`. The file
has the columns "Section", "Account" and "Amount". It has the revenue lines, the expense lines, the
totals and the "Net profit (loss)" row. Below the table, the file gives the
period and the notes of the report. The **Summary** subtotals are not in the file.

## Notes

- You cannot print a report at this time. Use **Export** and print the CSV file.
- The address of the report includes the dates. Copy the address to send the same report to a
  different user.
- If Akaun converted your book from an earlier version, a note can show below the report. It
  shows when the period starts before the conversion. Invoices from before that day are not in
  the figures.
- On the account page, the balance of a Revenue account shows with a minus sign. The report shows
  it as a positive number.

## Related

- [Dashboard](./dashboard.md)
- [Balance Sheet](./balance-sheet.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)
- [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md)
