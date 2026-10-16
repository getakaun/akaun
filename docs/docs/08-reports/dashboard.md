---
sidebar_position: 1
---

# Dashboard

The **Dashboard** shows how the business performs. It shows the headline figures, the trends of the
last 12 months, the receivables and payables, the sales pipeline and the tasks to do. Use it for a
fast check. For the full figures, open the reports.

Each figure comes from the same calculation as its report. When you open the report from a figure,
the report shows the same number.

:::info

You need the **View** permission on **Dashboard**. Without it, the **Dashboard** item does not show
in the sidebar, and Akaun opens **Settings** instead. Of the groups that Akaun creates, only
**Administrators** has this permission. See
[Permissions explained](../09-administration/permissions-explained.md).

Each section also needs the permission of its source screen. See
[Who sees which section](#who-sees-which-section).

:::

## Open the Dashboard

1. Click **Dashboard**.

The top of the screen shows **Welcome back** and your username.

If the book has no records, the **Dashboard** shows **No records yet** and no figures. Click
**Add a record** or **Import a document** to start.

## Choose the period

The period bar is at the top of the screen. It has four periods:

| Period | Dates |
|---|---|
| **This month** | From the first day of this month to today. |
| **This quarter** | From the first day of this quarter to today. |
| **Year to date** | From 1 January to today. |
| **Last 12 months** | From the first day of the month 11 months ago to today. |

Every period ends today. At the start, the **Dashboard** shows **This month**.

### Choose the comparison period

Each headline figure shows its change against a comparison period. Next to **compared with**,
choose one of these:

- **Previous period**: the same number of days at the start of the previous month or quarter. For
  example, 1–16 October compares with 1–16 September.
- **Same period last year**: the same dates one year earlier.

**Year to date** and **Last 12 months** always compare with the same period last year. For these
periods, the two choices give the same dates.

The dates of the comparison period show in brackets after the selector.

The period and the comparison are in the address of the page. If you send the link to a colleague,
the colleague sees the same period.

## The four headline figures

Each figure shows these items:

- A **change chip**: the change against the comparison period, as a percentage. Green shows good
  news. Red shows bad news. The chip shows **new** when the comparison period has no value.
- A small chart (a sparkline) of the last 12 months.

Click a figure to open its report with the same dates.

### Revenue

**Revenue** is the total income for the period. It opens [Profit & Loss](./profit-and-loss.md).

### Net profit

**Net profit** is the revenue minus the expenses for the period. If the expenses are more than the
revenue, the label changes to **Net loss** and the figure shows in red.

Below the figure, Akaun shows the **Net margin**: the net profit as a percentage of the revenue. The
margin of the comparison period shows after it, for example **(was 12%)**. If the period has no
revenue, the line shows **No revenue in this period**.

It opens [Profit & Loss](./profit-and-loss.md).

### Cash balance

**Cash balance** is the total of the cash and cash equivalents today. These are the accounts with
the sub-type **Cash**, **Bank**, **Wallet** or **Prepaid/debit card**. The change chip compares
the balance today with the balance at the end of the comparison period.

When the cash falls, the figure also shows the **Runway**. The runway is the number of months that
the cash lasts at the recent rate:

**Runway = cash balance today ÷ average fall in cash for each month**

Akaun calculates the average fall over the last three complete months. The runway shows only when
the cash balance is more than zero and the cash fell over these three months. If the runway is less
than six months, it shows in amber.

It opens [Cash Flow Statement](./cash-flow.md).

### Receivables

**Receivables** is the total that customers owe you today. Below the figure, Akaun shows the
overdue part in red. The bar shows the ageing of the total: **Not yet due**, **1–30 days**,
**31–60 days**, **61–90 days** and **Over 90 days** overdue.

This figure has no change chip and no sparkline. Akaun keeps no dated history of the ageing.

It opens the **Contacts** screen. If you do not have the **View** permission on **Contacts**, it
opens the **Records** screen with the unpaid records. See [Contacts](../06-contacts.md).

## Revenue and expenses

This chart shows the revenue and the expenses for each of the last 12 months, as bars. A line shows
the net profit of each month. The months before the selected period show lighter.

Click a month to open the [Profit & Loss](./profit-and-loss.md) for that month.

## Cash balance and Balance sheet

### Cash balance

This chart shows the cash and cash equivalents at the end of each of the last 12 months. The last
point is today. Click **Cash flow** to open the [Cash Flow Statement](./cash-flow.md) for the
period.

### Balance sheet

This card shows the **Assets**, the **Liabilities** and the **Equity** today. The assets are always
equal to the liabilities plus the equity. Click **Open report** to open the
[Balance Sheet](./balance-sheet.md) for today.

The **Balance sheet** card does not change with the period. It always shows today.

### If the balance sheet does not balance

Sometimes the card shows **The balance sheet does not balance** and the difference. This tells you
that a record in the book is not correct. The lines of each record must add to zero. This message
shows only when the data is damaged. Do not use the figures until you correct the problem.

1. Click **Settings**.
2. Click the **Ledger** tab.
3. In **Ledger integrity check**, click **Check now**.
4. Read the result.

The **Ledger** tab shows only if you have the **View** permission on **Reports**. The check only
reads the book. It changes nothing. If a record is wrong, the result gives its record number and
the difference. Give this result to your administrator.

## Net profit to cash flow

Profit and cash are not the same. This panel shows, step by step, how the net profit of the period
becomes the change in cash. Each figure comes from the [Cash Flow Statement](./cash-flow.md) and
[Profit & Loss](./profit-and-loss.md) of the period.

| Step | What it shows |
|---|---|
| **Net profit** | Revenue minus expenses. |
| **Working capital changes** | Changes in receivables, payables and inventory. For example, a sale that the customer has not paid increases the profit, but not the cash. |
| **Operating cash flow** | Cash from operating activities. This is the net profit plus the working capital changes. |
| **Capital expenditure** | Purchases of equipment and other fixed assets. |
| **Free cash flow** | Operating cash flow minus capital expenditure. |
| **Financing activities** | Loans, owner contributions and drawings. |
| **Unclassified accounts** | Cash movements on accounts that have no sub-type. This step shows only when there are such movements. |
| **Net change in cash** | Closing cash minus opening cash. |

### Example: you buy a machine

You buy a machine for 10,000.00 and pay from the bank:

- The bank balance falls by 10,000.00. **Capital expenditure** shows −10,000.00, and the **Net
  change in cash** falls by the same amount.
- The machine is an asset, not an expense. The **Net profit** does not change.

Akaun does not calculate depreciation. To put the cost of the machine into the profit over its
life, record the depreciation with a journal entry. A journal entry needs the **Adjustments**
permission. See [How a record moves money](../02-concepts/how-an-entry-works.md).

If the panel shows **The cash flow statement does not reconcile**, open the
[Cash Flow Statement](./cash-flow.md) to find the cause.

## Top expenses and Top revenue

These two lists show the largest expense accounts and revenue accounts for the period. Each list
shows the six largest accounts. The other accounts are added together in one **Other** line. Thus
the list adds up to the total of the [Profit & Loss](./profit-and-loss.md).

Each line shows these items:

- The amount.
- The percentage of the total.
- A change chip against the comparison period. For an expense, a fall shows green.

Click a line to open the **Records** screen. It shows the records of that account for the same
dates. The **Other** line does not open. Click **Open report** to open the Profit & Loss.

## Receivables and Payables

These two panels show the amounts that are outstanding today:

- **Receivables**: the amounts that customers owe you.
- **Payables**: the amounts that you owe to suppliers.

Each panel shows these items:

- The **outstanding balance**.
- The **overdue** amount and the number of overdue items.
- The ageing bar: **Not yet due**, **1–30 days**, **31–60 days**, **61–90 days** and
  **Over 90 days**.
- The three contacts with the largest balances.

Click a contact to open its page. Click **Contacts** to open the **Contacts** screen. These links
show only if you have the **View** permission on **Contacts**. The figures are the same as on the
**Contacts** screen. See [Contacts and balances](../02-concepts/contacts-and-balances.md).

## Sales pipeline

This panel shows the sales that are not complete:

| Figure | What it shows |
|---|---|
| **Open quotations** | The value and number of open quotations. The note shows how many expire this week. |
| **Accepted quotations** | Accepted quotations that you did not convert to an invoice yet. |
| **Invoiced sales** | The value and number of invoices sent in the period. |
| **Outstanding invoices** | Invoices that customers did not pay completely. The note shows how many are overdue, and their value. |

Click a figure to open the **Quotations** or **Invoices** screen. See
[Quotations](../05-sales/quotations.md) and [Invoices](../05-sales/invoices.md).

## Action items

This list shows the tasks that keep the books correct. Click an item to open the screen where you
do the task.

| Item | Opens |
|---|---|
| **Balance sheet does not balance** | The [Balance Sheet](./balance-sheet.md) for today. |
| **Imported documents to review** | **Auto Import**. See [Review and confirm](../04-auto-import/review-and-confirm.md). |
| **Overdue invoices** | **Invoices**. |
| **Unpaid bills** | **Records**, with the unpaid expenses. See [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md). |
| **Unreconciled bank lines** | The reconciliation screen of the account. If more than one account has such lines, it opens **Accounts**. See [Bank reconciliation](../07-bank-reconciliation.md). |
| **Accounts without a sub-type** | **Accounts**. Give each account a sub-type, so that the reports classify it. See [Accounts and categories](../02-concepts/accounts-and-categories.md). |

An item shows only when it has something to do. If no item shows, the list shows **No open items.
The books are up to date.**

## Recent transactions

This list shows the eight newest records of all types: expenses, income, payments, transfers,
opening balances, invoices and journal entries. Each row shows the description, the record type,
the contact and the date.

- A plus sign shows that cash came in.
- A minus sign shows that cash went out.
- No sign shows that the cash did not change, for example a transfer between two of your own
  accounts.

Click a row to open the record. Click **View all** to open the **Records** screen.

## Who sees which section

You need the **View** permission on **Dashboard** to open the page. Each section also needs the
**View** permission of the screen that its figures come from:

| Section | Permission |
|---|---|
| **Revenue**, **Net profit** and **Cash balance** figures, **Revenue and expenses**, **Cash balance** chart, **Balance sheet**, **Net profit to cash flow**, **Top expenses**, **Top revenue** | **View** on **Reports** |
| **Receivables** figure, **Receivables** and **Payables** panels, **Recent transactions** | **View** on **Records** |
| **Open quotations** and **Accepted quotations** | **View** on **Quotations** |
| **Invoiced sales** and **Outstanding invoices** | **View** on **Invoices** |
| Each action item | **View** on the screen that the item opens |

If you do not have a permission, Akaun does not show the section. It does not show the section
empty.

## Notes

- The **Dashboard** updates by itself when somebody changes a record, a payment, an account, an
  invoice, a quotation or an import.
- "Today" is the date on the server.
- The **Dashboard** has no export. Use the reports to export the figures.

## Related

- [Profit & Loss](./profit-and-loss.md)
- [Balance Sheet](./balance-sheet.md)
- [Cash Flow Statement](./cash-flow.md)
- [Contacts](../06-contacts.md)
- [Settings reference](../09-administration/settings-reference.md)
