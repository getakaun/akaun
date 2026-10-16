---
sidebar_position: 3
---

# Balance Sheet

The **Balance Sheet** shows the assets, the liabilities and the equity of the business on one date.

- **Assets**: what the business owns.
- **Liabilities**: what the business owes.
- **Equity**: what the owners have in the business.

:::info

You need the **View** permission on **Reports**. Reports are view only. See
[Permissions explained](../09-administration/permissions-explained.md).

:::

## Open the report

1. Click **Reports**.
2. Click the **Balance Sheet** tab.
3. In **As at**, choose the date.

At the start, **As at** is today. The report includes all records up to and including this date.

## What the report shows

The top of the report shows **Total assets, as at** the date. Below it, Akaun compares this figure
with the liabilities plus the equity. If the two are equal, Akaun tells you that the balance sheet is in balance.

The report has three sections:

- **Assets**: the Asset accounts.
- **Liabilities**: the Liability accounts.
- **Equity**: the Equity accounts and **Current earnings**.

Each section ends with **Total**. The report shows only the accounts with a balance on the date.
If a section has no accounts, it shows "Nothing at this date."

**Current earnings** is the revenue minus the expenses, from the first record up to the date. It is
not an account. You cannot click it.

## How the sub-type groups the lines

**Assets** and **Liabilities** each have up to three groups. Each group ends with **Subtotal**.

- **Current**: money and things that the business uses or pays within about one year.
- **Non-current**: things that the business keeps for longer, and loans for longer.
- **Unclassified**: accounts without a sub-type.

The sub-type of the account selects the group. For example, **Fixed asset** goes into
**Non-current**, and **Credit card** goes into **Current**. Give each account in **Unclassified** a
sub-type. See [Accounts and categories](../02-concepts/accounts-and-categories.md).

## Signs

Assets, liabilities and equity all show as positive numbers. A negative number shows an unusual
balance. For example, a bank account with an overdraft shows a negative asset.

## Example

On 31 March, the business has 8,000.00 in **Bank** and 2,000.00 in **Accounts Receivable**. It owes
3,000.00 on **Accounts Payable**. The owner gave 5,000.00 to the business at the start. Since then, the business
made a profit of 2,000.00.

| Section | Group | Line | Amount |
|---|---|---|---|
| **Assets** | **Current** | **Bank** | 8,000.00 |
| **Assets** | **Current** | **Accounts Receivable** | 2,000.00 |
| **Assets** | **Current** | **Subtotal** | 10,000.00 |
| **Assets** | | **Total** | 10,000.00 |
| **Liabilities** | **Current** | **Accounts Payable** | 3,000.00 |
| **Liabilities** | **Current** | **Subtotal** | 3,000.00 |
| **Liabilities** | | **Total** | 3,000.00 |
| **Equity** | | **Owner's Equity** | 5,000.00 |
| **Equity** | | **Current earnings** | 2,000.00 |
| **Equity** | | **Total** | 7,000.00 |

The assets are 10,000.00. The liabilities plus the equity are 3,000.00 + 7,000.00 = 10,000.00.

## If the balance sheet is out of balance

The assets must always be equal to the liabilities plus the equity. If they are not equal, the
balance sheet is out of balance. The **Total assets** figure shows in red. The text below it gives
the difference. A warning also shows
below the report. This tells you that the data of a record is damaged.

1. Click **Settings**.
2. Click the **Ledger** tab.
3. In **Ledger integrity check**, click **Check now**.
4. Give the result to your administrator.

Do not send this report to anybody until the check is good.

## See the records behind a line

To open a line, you also need the **View** permission on **Accounts** and on **Records**.

1. Click the name of a line, for example **Bank**.
2. On the account page, click **View account ledger**.

The **Records** screen shows all records of the account, with a running balance. It shows all
dates, not only the dates up to **As at**. See
[Find records](../03-everyday-tasks/find-records.md).

## Export the report

1. Click **Export**.

Akaun downloads a CSV file, for example `balance-sheet-2026-03-31.csv`. The file has the columns "Section", "Account" and "Amount". The
sections are "Assets", "Liabilities" and "Equity", each with a "Total" row. Below the table, the
file gives the date and the notes of the report. The **Current**, **Non-current** and
**Unclassified** groups are not in the file.

## Notes

- You cannot print a report at this time. Use **Export** and print the CSV file.
- The address of the report includes the date. Copy the address to send the same report to a
  different user.
- On the **Accounts** screen and the account page, Liability and Equity balances show with a minus
  sign. The report shows them as positive numbers.
- If Akaun converted your book from an earlier version, a note shows below the report. Invoices
  from before the conversion are not in the figures.

## Related

- [Dashboard](./dashboard.md)
- [Profit & Loss](./profit-and-loss.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)
- [How a record moves money](../02-concepts/how-an-entry-works.md)
