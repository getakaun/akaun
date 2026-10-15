---
sidebar_position: 3
---

# Prepare your book

Use this checklist after the first sign-in, before anybody records money. Do the steps in this
order. Two settings lock when the first record exists, so do them first.

:::info

Sign in as a superuser, for example `admin`, to do all the steps on this page.

:::

## Checklist

- [ ] 1. [Choose the main currency](#1-choose-the-main-currency)
- [ ] 2. [Add the company details](#2-add-the-company-details)
- [ ] 3. [Choose the document numbers](#3-choose-the-document-numbers)
- [ ] 4. [Check the accounts](#4-check-the-accounts)
- [ ] 5. [Enter the starting balances](#5-enter-the-starting-balances)
- [ ] 6. [Check the default accounts](#6-check-the-default-accounts)
- [ ] 7. [Add the users](#7-add-the-users)
- [ ] 8. [Connect an AI provider](#8-connect-an-ai-provider)

## 1. Choose the main currency

The main currency is the currency of your book. All amounts show in it. The default is USD.

:::caution

The **Currency** field locks when the first record, quotation or invoice exists. A starting
balance is also a record. After the lock, you cannot change the main currency.

:::

1. In the sidebar, click **Settings**.
2. Click the **General** tab.
3. In **Currency**, choose the currency of your business.
4. Click **Save**.

If the field shows a lock icon, the currency is already locked.

See [Foreign currency](../02-concepts/foreign-currency.md).

## 2. Add the company details

Akaun shows these details on printed quotations and invoices.

1. In **Settings**, click the **Company** tab.
2. Under **Logo**, click **Upload** and choose a JPEG or PNG image of 5 MB or smaller.
3. Optional: under **Letterhead**, click **Upload** and choose a JPEG or PNG image of your
   letterhead.
4. In **Company Name**, type the name of the business.
5. In **Address**, type the address.
6. In **Registration No.**, type the registration number of the business.
7. Click **Save**.

The **Templates** tab controls printed documents. To print the letterhead in place of the company
name, set **Header** to **Letterhead** there. See
[Settings reference](../09-administration/settings-reference.md).

## 3. Choose the document numbers

Akaun gives a number to each expense, income, payment, quotation and invoice. One format
applies to all of them. The default format is `{PREFIX}{YYYY}{MM}{DD}-{SEQ:3}`, for example
`EX20261009-001`.

The format uses these tokens:

| Token | Meaning |
|---|---|
| `{PREFIX}` | A fixed code for each type: `EX` for an expense, `IN` for an income, `CL` for a payment, `QT` for a quotation, `IV` for an invoice. You cannot change these codes. |
| `{YYYY}` | The year with four digits. |
| `{YY}` | The year with two digits. |
| `{MM}` | The month. |
| `{DD}` | The day. |
| `{SEQ}` | The sequence number. `{SEQ:3}` gives three digits, for example `001`. |

The format must have one `{SEQ}` token. The sequence starts again at 1 when the date part of the
number changes. With `{DD}`, it starts again each day. With only `{YYYY}`, it starts again each
year. Without a date token, it never starts again.

:::caution

The format locks when the first record, quotation or invoice exists. After the lock, you cannot
change it.

:::

1. In **Settings**, click the **General** tab.
2. Under **Numbering**, click a token to add it to the format. You can also drag a token.
3. Type other characters, for example a dash, directly in the format.
4. Look at the **Preview** line under the format.
5. Click **Save** under **Numbering**.

## 4. Check the accounts

Akaun starts with these accounts:

| Type | Accounts |
|---|---|
| **Asset** | 1000 **Cash**, 1100 **Bank**, 1200 **Accounts Receivable**, 1300 **Inventory**, 1400 **Marketplace Clearing** |
| **Liability** | 2000 **Accounts Payable**, 2100 **Loans** |
| **Equity** | 3000 **Owner's Equity**, 3100 **Retained Earnings** |
| **Revenue** | 4000 **Product Sales**, 4100 **Other Revenue** |
| **Expense** | 5000 **Cost of Goods Sold**, 5100 **Advertising**, 5200 **Packaging**, 5300 **Shipping**, 5400 **Software**, 5500 **Utilities**, 5900 **Other Expenses** |

An **Expense** or **Revenue** account is a category. Add the categories that your business
needs. Add one account for each bank account, card and cash box of the business.

1. In the sidebar, click **Accounts**.
2. Click a tab to see one type, or click **All**.
3. Click **Add account**.
4. In **Name**, type the name, for example the name of your bank.
5. In **Account type**, choose the type. You cannot change the type after the account has records.
6. Leave **Code** empty. Akaun gives the lowest free number for the type.
7. If **Sub-type** shows, choose the line of the report, for example **Bank**.
8. Click **Create account**.

The new account shows in the list.

To change the name of a starter account, click the account, change **Name**, and click
**Save changes**. On their account pages, **Marketplace Clearing** and **Loans** show
**Needs review** until you choose a sub-type.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

## 5. Enter the starting balances

The starting balance is the money in an account on the day that you start to use Akaun. Enter it
for each account that holds money, for example **Cash** and each bank account.

1. In the sidebar, click **Accounts**.
2. Click the account.
3. On the right side of the account page, under **Starting balance**, click the card.
4. In **On this date**, choose the first day of your books in Akaun.
5. In **Amount**, type the balance on that day, in the main currency. If the account was overdrawn, type a negative
   amount.
6. Click **Save starting balance**.

The card shows the amount and the date. Akaun saves an **Opening balance** record. The other
side of the record goes to the **Opening balances** default account, which is **Owner's Equity**
at the start.

Each account has one starting balance only. If you save a new one, it replaces the old one. If
you save zero, Akaun removes the starting balance.

You cannot change a starting balance after a payment settles it or a bank line matches it.

## 6. Check the default accounts

Akaun uses default accounts for the automatic side of some records. The starter values work for
most businesses.

| Default | What Akaun uses it for | Starter account |
|---|---|---|
| **Accounts receivable** | An invoice that you send, and a payment from a customer. | **Accounts Receivable** |
| **Accounts payable** | An expense that a different person pays for the business. | **Accounts Payable** |
| **Opening balances** | The other side of each starting balance. | **Owner's Equity** |
| **Sales revenue** | An invoice that does not choose a different revenue account. | **Product Sales** |
| **Uncategorised expense** | An imported expense with no matching expense account. | **Other Expenses** |
| **Default transaction account** | The account that new expenses and income use first. | **Bank** |
| **Uncategorised income** | An imported income with no matching revenue account. | **Other Revenue** |

1. In **Settings**, click the **Books** tab.
2. Under **Default accounts**, choose an account for each default.
3. Click **Save defaults**.

:::info

The **Books** tab shows only for a user with the **View** permission on **Reports**. To change a
default account, the user needs the **Change** permission on **Accounts** and the **Manage**
permission on **Settings**.

:::

## 7. Add the users

Add a user for each person who works in the book. Put each user in a group. Do not use the
`admin` user for everyday work.

See [Users and groups](../09-administration/users-and-groups.md) and
[Permissions explained](../09-administration/permissions-explained.md).

## 8. Connect an AI provider

**Auto Import** uses AI to read receipts, bills and statements. It does not work until you add
an AI provider. You can skip this step if you enter all records by hand.

See [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md).

## Result

Your book has the correct currency, company details, accounts and starting balances. You can
start to record money. See [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md).
