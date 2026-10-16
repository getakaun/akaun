---
sidebar_position: 2
---

# Accounts and categories

An account is a place where money is kept, owed or counted. Some accounts tell where money is.
Other accounts tell what the money was for. This page tells how Akaun keeps the two apart.

## Where money is, and what it was for

Each record moves money from one account into a different account. Usually one side is a place
where money is, for example **Bank**. The other side tells what the money was for, for example
**Software**.

- A **cash or bank account** is an Asset account that holds money, for example **Cash** or
  **Bank**. **Accounts Receivable** is in this group too. It holds the receivables: the money that
  customers owe.
- A **category** tells what the business spent money on, or how it earned money. Examples are
  **Advertising**, **Shipping** and **Product Sales**.

In Akaun, a category is an account of the type **Expense** or **Revenue**. There is no separate
screen for categories. You find all accounts and all categories on the **Accounts** screen. On
the **Records** screen, the **Category** filter shows only the records of the categories that you
choose.

## The five account types

Each account has one of five types. The **Accounts** screen has an **All** tab and one tab for
each type.

| Type | What it is | Examples |
|---|---|---|
| **Asset** | A thing that the business owns. | Cash, a bank balance, receivables, stock, equipment. |
| **Liability** | Money that the business owes to a different person or business. | Payables (a supplier bill that is not paid yet), a loan. |
| **Equity** | The value that the owners or partners have in the business. | Owner's Equity, Retained Earnings. |
| **Revenue** | Money that the business earns. A Revenue account is an income category. | Product Sales, Other Revenue. |
| **Expense** | Money that the business spends. An Expense account is an expense category. | Advertising, Software, Utilities. |

The type tells the reports where the account goes. Asset, Liability and Equity accounts go on the
**Balance Sheet**. Revenue and Expense accounts go on **Profit & Loss**. You cannot change the type
of an account after a record or a bank statement uses it.

## Things that you buy and keep

Equipment is an asset that you buy and keep, for example a laptop. It stays on the
**Balance Sheet** and does not go into the expenses on **Profit & Loss**. But you record its
purchase in the same way as an expense.

The record form shows these asset accounts together with the categories. These are the Asset
accounts with these sub-types: **Fixed asset**, **Intangible asset**, **Inventory**,
**Prepayments and deposits**, **Tax receivable**, **Other current asset** and
**Other non-current asset**. All other Asset accounts are cash or bank accounts.

## Sub-types

The sub-type puts an account into a line of a report. Each type except **Equity** has sub-types.

| Type | Sub-types |
|---|---|
| **Asset** | **Cash**, **Bank**, **Wallet**, **Prepaid/debit card**, **Accounts receivable**, **Inventory**, **Prepayments and deposits**, **Clearing**, **Tax receivable**, **Other current asset**, **Fixed asset**, **Intangible asset**, **Other non-current asset** |
| **Liability** | **Accounts payable**, **Credit card**, **Accrued liabilities**, **Short-term loan**, **Tax payable**, **Other current liability**, **Long-term loan**, **Other non-current liability** |
| **Revenue** | **Operating revenue**, **Other revenue**, **Contra operating revenue**, **Contra other revenue** |
| **Expense** | **Cost of goods sold**, **Operating expense**, **Other expense** |

The sub-type is important for the reports:

- **Balance Sheet**: the sub-type puts each asset and liability into current or non-current. For
  example, **Fixed asset** is non-current and **Short-term loan** is current.
- **Profit & Loss**: the sub-type puts each expense into cost of goods sold, operating expenses or
  other expenses. It puts each income into operating revenue or other revenue.
- **Cash Flow Statement**: Asset accounts with the sub-type **Cash**, **Bank**, **Wallet** or
  **Prepaid/debit card** count as cash.

An Asset or Liability account must have a sub-type. If an account has no sub-type, it shows
**Unclassified**. Give it a sub-type on its account page. A Revenue or Expense account can have no
sub-type. The reports then count it as operating.

## Contra revenue

Sales discounts, returns and allowances can use a **Revenue** account with the sub-type
**Contra operating revenue** or **Contra other revenue**. These accounts normally have a debit
balance. Profit & Loss shows their debit balances as deductions from revenue. Contra operating
revenue reduces operating revenue; Contra other revenue reduces other revenue.

Existing accounts keep their sub-types. To identify an existing contra account, edit its sub-type
on the account page. Contra accounts cannot be the default Sales revenue or Uncategorised income.

## Account code

Each account has a number, the account code. The field is **Code**. Each type has its own range
of numbers:

| Type | Codes |
|---|---|
| **Asset** | 1000–1999 |
| **Liability** | 2000–2999 |
| **Equity** | 3000–3999 |
| **Revenue** | 4000–4999 |
| **Expense** | 5000–5999 |

If you leave **Code** empty when you add an account, Akaun gives the lowest free number in the
range.

## The starter accounts

A new book starts with these accounts. You can rename them, and you can add more.

| Code | Name | Type | Sub-type |
|---|---|---|---|
| 1000 | Cash | Asset | Cash |
| 1100 | Bank | Asset | Bank |
| 1200 | Accounts Receivable | Asset | Accounts receivable |
| 1300 | Inventory | Asset | Inventory |
| 1400 | Marketplace Clearing | Asset | (none: **Unclassified**) |
| 2000 | Accounts Payable | Liability | Accounts payable |
| 2100 | Loans | Liability | (none: **Unclassified**) |
| 3000 | Owner's Equity | Equity | — |
| 3100 | Retained Earnings | Equity | — |
| 4000 | Product Sales | Revenue | Operating revenue |
| 4100 | Other Revenue | Revenue | Other revenue |
| 5000 | Cost of Goods Sold | Expense | Cost of goods sold |
| 5100 | Advertising | Expense | Operating expense |
| 5200 | Packaging | Expense | Operating expense |
| 5300 | Shipping | Expense | Operating expense |
| 5400 | Software | Expense | Operating expense |
| 5500 | Utilities | Expense | Operating expense |
| 5900 | Other Expenses | Expense | Other expense |

Akaun uses some of these accounts for special jobs:

- **Bank** is the account that new expenses and income use first. To change it, use
  **Default transaction account** in **Settings**, on the **Ledger** tab. On the **Accounts**
  screen, this account shows **Default account**. The **General** tab also has a **Default
  payment account** row, but at this time a change there is not kept.
- **Accounts Receivable** holds the receivables: the money that customers owe to the business.
- **Accounts Payable** holds the payables: the money that the business owes.
- By default, **Owner's Equity** is the other side of each opening balance.

**Marketplace Clearing** and **Loans** show **Unclassified**. A loan can be short-term or
long-term, so give **Loans** the correct sub-type.

## Inactive accounts

If you do not use an account now, click **Deactivate** on its account page. Akaun keeps the
account and all its records, but the record form does not show it. Click **Reactivate** to use it
again.

You cannot deactivate an account that **Settings** names as a default account. First choose a
different default account.

The **Accounts** screen hides inactive accounts. If there is an inactive account, the screen shows
a button with the number of inactive accounts, for example **Show inactive (2)**. Click it to see
them. Click **Hide inactive (2)** to hide them again.

## Related

- [Prepare your book](../01-getting-started/set-up-your-book.md)
- [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md)
- [Split across categories](../03-everyday-tasks/split-across-categories.md)
- [Balance Sheet](../08-reports/balance-sheet.md)
- [Profit & Loss](../08-reports/profit-and-loss.md)
- [Cash Flow Statement](../08-reports/cash-flow.md)
- [Settings reference](../09-administration/settings-reference.md)
