---
sidebar_position: 3
---

# Glossary

This page gives the meaning of each term in Akaun and in this guide. It is also the approved
term list: the guide uses each word here with one meaning only.

Terms in **bold** are labels that you see on the screen.

## A

### Account

An account is a place where money is kept, owed or counted. Each record moves money out of one
account and into a different account. You find all accounts on the **Accounts** screen.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Account code

The account code is the number of an account, for example 1000 for **Cash**. The field is
**Code**. Each type has its own range, for example 1000–1999 for an asset. If you leave the
field empty when you add an account, Akaun gives the lowest free number in the range.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Account statement

The account statement is the **Records** list filtered to one account. It shows the balance
before the first record, a running balance on each row and the balance after the last row. It
shows the running balance only when the list is in date order. A date range is permitted, but
no other filter.

See [Find records](../03-everyday-tasks/find-records.md).

### Account type

Each account has one of five types: **Asset**, **Liability**, **Equity**, **Revenue** or
**Expense**. The type tells the reports where the account goes. The **Accounts** screen has an
**All** tab and one tab for each type.

- **Asset**: a thing the business has, for example cash, a bank balance or money that a customer
  owes.
- **Liability**: money that the business owes to a different person or business.
- **Equity**: the value that the owners or partners have in the business.
- **Revenue**: money that the business earns. A Revenue account is an income category.
- **Expense**: money that the business spends. An Expense account is an expense category.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Accounts payable

**Accounts Payable** is the account for money that the business owes. Akaun uses it for a bill
that is not paid yet, or for an expense that a different person paid for the business. Each amount
on it belongs to one contact.

See [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md).

### Accounts receivable

**Accounts Receivable** is the account for money that customers owe to the business. Akaun uses
it when you send an invoice. Each amount on it belongs to one contact. This account is an
**Asset**.

See [Getting paid](../05-sales/getting-paid.md).

### Adjustments

**Adjustments** is an ability in the **Records** permission area. It lets a user save a record
between any two accounts. It also lets a user add more than two lines to a record that is not an
everyday split. Of the groups that Akaun creates, only **Administrators** has it, because that
group is a superuser group. When you select the whole **Records** area, Akaun does not select
**Adjustments**. Give it only to a person that you trust with the books.

See [Permissions explained](../09-administration/permissions-explained.md).

### AI assistant

An AI assistant is a chat program, for example Claude or ChatGPT, that can connect to Akaun. It
can read your books. If you give it the access, it can also change them.

See [Connect AI assistants](../09-administration/connect-ai-assistants.md).

### AI provider

An AI provider is a service that reads your documents for **Auto Import**. You add a provider in
**Settings**, on the **Intelligence** tab, under **Providers**. Auto Import cannot read a receipt
or a PDF until you add one provider.

See [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md).

### Allocated to

**Allocated to** is a section on the page of a payment. It shows each record that the payment
pays, and the amount for each record.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Allocation

An allocation is the part of a payment that goes against one record. On the payment form, the
**Allocation** section shows each outstanding record and the amount that the payment puts
against it.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### API token

An API token was the secret key of older versions of Akaun. The upgrade revoked all API tokens,
and they do not work any more. Use a [personal access token](#personal-access-token).

See [Troubleshooting](./troubleshooting.md#api-tokens-were-replaced-by-personal-access-tokens).

### Attachment

An attachment is a file that you add to a record, for example a receipt or a bill. The
**Attachments** section is on the record page.

See [Attach receipts](../03-everyday-tasks/attach-receipts.md).

### Auto Import

**Auto Import** is the screen where Akaun reads receipts, invoices, statements and spreadsheets.
Akaun reads each file, usually with AI, and prepares one or more records. You check each record
before Akaun saves it.

See [Import receipts](../04-auto-import/import-receipts.md).

### Auto-detect

**Auto-detect** is the default choice under **Read as**. Akaun uses an enabled import profile that
fits the document. If no profile fits, Akaun reads the document as one record.

See [Import profiles](../04-auto-import/import-profiles.md).


## B

### Balance

The balance of an account is the total of all money into it and out of it. The balance of a
contact is the amount that they owe you, or that you owe them. Akaun calculates each balance
from the records. You cannot type a balance.

See [Contacts and their balances](../02-concepts/contacts-and-balances.md).

### Balance Sheet

**Balance Sheet** is a report. It shows the assets, liabilities and equity of the business on one
date.

See [Balance Sheet](../08-reports/balance-sheet.md).

### Bank reconciliation

Bank reconciliation is a check of an account against the statement from the bank. You match
each statement line to a record in Akaun. Open an account, then click **Reconcile**.

See [Bank reconciliation](../07-bank-reconciliation.md).

### Book

The book is the full set of accounts, records and contacts for one business. One Akaun
installation keeps one book. The **Books** tab in **Settings** has the **Ledger integrity check**,
which makes sure that each record balances.

See [Prepare your book](../01-getting-started/set-up-your-book.md).


## C

### Cash Flow Statement

**Cash Flow Statement** is a report. It shows where cash came from and what it went on, for a
period.

See [Cash Flow Statement](../08-reports/cash-flow.md).

### Category

A category tells what the money was for or where it came from. In Akaun, a category is an
account of the type **Expense** or **Revenue**. The **Records** screen has a **Category** filter.
There is no separate screen for categories.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Cleared

A record is cleared when bank statement lines match its full amount. The **Records** list shows
**Not cleared** beside each record that is not cleared yet. It shows no label for a cleared record.
Click **Not yet cleared** to list only the records that are not cleared. Cleared and paid are two
different things. A record can be paid and not cleared.

See [Bank reconciliation](../07-bank-reconciliation.md).

### Connected app

A connected app is a program, for example an AI assistant, that you let read or change your Akaun
data.
You find the list on your profile, on the **Connected apps** tab. Click **Revoke access** to
disconnect an app immediately.

See [Connect AI assistants](../09-administration/connect-ai-assistants.md).

### Contact

A contact is a person or a business that you work with. A record can name one contact. Akaun
uses the contact to show who owes money and to whom.

See [Contacts](../06-contacts.md).

### Contact role

A role tells how you work with a contact. The roles are **Customer**, **Supplier**, **Employee**
and **Partner**. A contact can have more than one role, or no role.

See [Contacts](../06-contacts.md).

### Control total

The control total is the total that a document gives, for example the total on a statement.
Akaun compares it with the total of the items that it read. If the two totals are different,
you can still confirm the items.

See [Documents with many records](../04-auto-import/documents-with-many-records.md).


## D

### Dashboard

The **Dashboard** is a summary screen. It shows the net profit, the financial position, the cash
flow and the recent activity.

See [Dashboard](../08-reports/dashboard.md).

### Default transaction account

The **Default transaction account** is the account that new income and expenses use first. You
choose it in **Settings**, on the **Books** tab, under **Default accounts**. On the **Accounts**
screen, this account shows **Used by default**. The **General** tab also has a **Money usually
comes from** row, but at this time a change there is not kept.

See [Settings reference](../09-administration/settings-reference.md).


## E

### Entity type

The entity type tells if a contact is an **Individual** or a **Business**.

See [Contacts](../06-contacts.md).

### Exchange rate

The exchange rate changes an amount in a foreign currency into the main currency. The field
shows the two currencies, for example **Rate (1 USD = ? MYR)**. Akaun tries to find the rate for the date of the record. If it finds no rate, you type
the rate.

See [Foreign currency](../02-concepts/foreign-currency.md).

### Expense

**Expense** is a record of money that the business spends. **Expense** is also an account type.
An Expense account is an expense category.

See [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md).


## F

### Filtered total

**Filtered total** is the sum of the amounts on the list after your filters. It shows above the
table on the **Records**, **Quotations** and **Invoices** lists.

See [Find records](../03-everyday-tasks/find-records.md).

### Foreign currency

A foreign currency is any currency that is not the main currency. Click **+ Foreign currency** on
the record form to record an amount in a different currency. Invoices and quotations can also
use a foreign currency.

See [Foreign currency](../02-concepts/foreign-currency.md).


## G

### Group

A group is a set of users with the same permissions. Akaun creates four groups:
**Administrators**, **Bookkeeper**, **Data Entry** and **Reviewer**. A user gets all the
permissions of all their groups. At each start of the server, Akaun puts a user with no group into
**Administrators**.

See [Users and groups](../09-administration/users-and-groups.md).


## H

### History

**History** is the section on a record, account or contact page that shows the audit trail. The
audit trail is a list of each change: who made it and when.

See [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md).


## I

### Import profile

An import profile is a saved way to read one kind of document, for example a marketplace
statement. You make profiles in **Settings**, on the **Intelligence** tab. An enabled profile
shows under **Read as**.

See [Import profiles](../04-auto-import/import-profiles.md).

### Inactive account

An inactive account is an account that you do not use now. Click **Deactivate** on the account
page to make it inactive, and **Reactivate** to use it again. Akaun keeps its history. You cannot
deactivate an account that **Settings** names as a default account. The **Accounts** screen hides
inactive accounts. To see them, click **Show inactive (2)**. This button shows only when an
inactive account exists.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Income

**Income** is a record of money that the business earns. The account for the income is a
**Revenue** account.

See [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md).

### Invoice

An invoice is a document that asks a customer to pay. When you click **Mark as sent**, the
customer owes the amount and Akaun adds an **Invoice** record to the books. A sent invoice cannot
be deleted, but you can cancel it.

See [Invoices](../05-sales/invoices.md).

### Invoice status

An invoice shows one of these statuses:

- **Draft**: you can change or delete the invoice. The customer owes nothing yet.
- **Sent**: the customer owes the amount.
- **Part paid**: payments cover some of the amount, but not all of it.
- **Paid**: payments cover the full amount. Akaun calculates this from the payments.
- **Cancelled**: the invoice does not count. It keeps its number, and its amount is not in the
  books.
- **Overdue**: the invoice is sent, the due date is in the past, and the invoice is not fully
  paid.

See [Invoices](../05-sales/invoices.md).

### Item

An item is one record that Auto Import read from a document. A receipt gives one item. A
statement or a spreadsheet can give many items. You confirm or skip each item.

See [Review and confirm](../04-auto-import/review-and-confirm.md).


## J

### Journal entry

**Journal entry** is a record that is not an expense, income, transfer, payment, opening balance
or invoice. Usually it is a correction. To save a journal entry, you need the **Adjustments** permission.

See [How a record moves money](../02-concepts/how-an-entry-works.md).


## L

### Line

A line is one side of a record. Each record has two lines: the **out of** line and the **into**
line. On an expense or an income, click **+ Add a line** to add more lines, for example to split
a bill across categories. A user with **Adjustments** can add lines to any record. The lines of a
record always add up to zero.

See [Split across categories](../03-everyday-tasks/split-across-categories.md).

### Locked

A record is locked when a payment settles part or all of it, or a bank line matches it. The
payment that settles it is locked too. Its amount, date, currency and money accounts cannot
change, and you cannot delete it. The **Records** list shows a lock icon beside it. You can still
change the description, contact, reference, remark and attachments. On an expense or an income,
you can also change the category lines.

See [Locked records](../02-concepts/locked-records.md).


## M

### Main currency

The main currency is the currency of your book. All amounts show in it. You choose it in
**Settings**, on the **General** tab, in the **Currency** field. After the book has a record, an
invoice or a quotation, you cannot change it.

See [Foreign currency](../02-concepts/foreign-currency.md).

### Match

A match connects a bank statement line to a record in Akaun. One line can match more than one
record. **Use Suggested Match** accepts the match that Akaun found. Click **Save** or
**Save & Next** to keep it. **Save 3 exact matches** saves many matches at one time.

See [Bank reconciliation](../07-bank-reconciliation.md).

### Money account

A money account is an **Asset** account that holds money, for example **Cash**, a bank account or
an e-wallet. Equipment, inventory and prepayments are assets, but they are not money accounts. On a record, the money account
is the side that money came out of or went into.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).


## N

### Not cleared

See [Cleared](#cleared).


## O

### Opening balance

**Opening balance** is a record of the money in an account on the day that you start to use
Akaun. On the account page, the label is **Starting balance**. The other side of the record goes
to the account that **Settings** › **Books** names for **Opening balances**. By default, this is
**Owner's Equity**.

See [Prepare your book](../01-getting-started/set-up-your-book.md).

### Outstanding

**Outstanding** shows that nobody paid any of the amount of a record yet. One line of the record
is on **Accounts Payable** or **Accounts Receivable**. The record names the contact who owes the
money, or who is owed it.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Outstanding payables

**Outstanding payables** is a panel on the **Records** screen. It shows each contact that the
business owes money to, and the amount. From it, you can pay one contact or all of them.

See [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md).


## P

### Paid

**Paid** shows that the full amount of a record is paid. A record that moves money directly from
an account is paid when you save it. An outstanding record becomes paid when payments cover it.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Part paid

**Part paid** shows that payments cover some of the amount of a record, but not all of it.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Partners' Equity

**Partners' Equity** is a report. It shows the contributions, share of profit and drawings of each
partner. At this time, no control links a partner to an **Equity** account. So in a new book,
contributions and drawings show 0.00.

See [Partners' Equity](../08-reports/partners-equity.md).

### Payment

**Payment** is a record that pays an amount that the business owes. One payment can pay one
record or many records. On the **Records** screen, open the **Outstanding payables** panel. Click
**Record a payment** to pay one contact, or **Pay all outstanding** to pay all of them.

See [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md).

### Payments applied

**Payments applied** is a section on the page of an expense or an income. It shows each
payment that paid part or all of the record. **Take this back** removes one payment from it.

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Permission

A permission lets a user do one thing in one area of Akaun. Each area, for example **Records**,
**Contacts** or **Invoices**, has a list of abilities. Most areas have **View**, **Add**, **Change**
and **Delete**. Some areas have more, for example **Send** and **Void** on **Invoices**. Reports are
view only. On the screens, you choose a level for each area: **None**, **View**, **Edit**, **Full**
or **Custom**.

See [Permissions explained](../09-administration/permissions-explained.md).

### Personal access token

A personal access token is a secret key that lets a program, for example an AI assistant, use
Akaun as you. You make it on your profile, on the **Access tokens** tab. Only you can make a token
for yourself. Each token has a name, an expiry date or no expiry, and its own permissions. A token never does more than what you may hand on to tokens
and apps. Akaun shows the full token one time only. It starts with `akp_`. Keep the token secret.

See [Your profile](../09-administration/your-profile.md#access-tokens) and
[Connect AI assistants](../09-administration/connect-ai-assistants.md).

### Possible duplicate

**Possible duplicate** shows that an imported item looks like a record that is already in Akaun.
On a receipt card, the tag shows **Duplicate** with a percentage and the reasons. Check the item
before you click **Import anyway**.

See [Review and confirm](../04-auto-import/review-and-confirm.md).

### Profit & Loss

**Profit & Loss** is a report. It shows the revenue and the expenses for a period, and the
difference between them.

See [Profit & Loss](../08-reports/profit-and-loss.md).


## Q

### Quotation

A quotation is a document that offers a price to a customer before the work. A quotation does not
change the books. Click **Convert** on a sent or accepted quotation to make a draft invoice from it.

See [Quotations](../05-sales/quotations.md).

### Quotation status

A quotation shows one of these statuses: **Draft**, **Sent**, **Accepted**, **Declined**,
**Converted** or **Expired**. You change the status with the buttons on the quotation page.
**Converted** shows that you made an invoice from the quotation. **Expired** shows that the expiry
date of a draft or sent quotation is in the past.

See [Quotations](../05-sales/quotations.md).


## R

### Read as

**Read as** is the choice on **Auto Import** that tells Akaun how to read the next file. The
choices are **Auto-detect**, **Single record**, **Multiple records** and each enabled import
profile.

See [Import receipts](../04-auto-import/import-receipts.md).

### Record

A record is one event with money, for example an expense, an income or a transfer. It tells where
the money came from and where it went. All records show on the one **Records** screen.

See [Records](../02-concepts/records.md).

### Record kind

The kind tells what a record is. The kinds are **Expense**, **Income**, **Transfer**,
**Payment**, **Opening balance**, **Invoice** and **Journal entry**. You do not choose the kind.
Akaun finds it from the accounts on the record.

See [Records](../02-concepts/records.md).

### Running balance

A running balance is the balance after each line of a statement. The account statement on the
**Records** screen shows one on each row. Some spreadsheets also have a balance column. Akaun then
checks that each row's balance follows from the row before it. A break shows that a row is missing
or changed.

See [Find records](../03-everyday-tasks/find-records.md) and
[Documents with many records](../04-auto-import/documents-with-many-records.md).


## S

### Section

A section is one part of an import profile, for example the money in and the money out of a
wallet report. Each section tells Akaun what kind of record its lines become.

See [Import profiles](../04-auto-import/import-profiles.md).

### Settle

To settle a record is to pay what is owed on it. A payment settles one or more records. To
remove a settlement, click its undo icon (**Take this back**).

See [Owed, part paid and paid](../02-concepts/owed-and-paid.md).

### Source account

**Source account** is a field on an imported item. On an expense, it is the account that the money
came out of. On an income, it is the income category. The other field is **Target account**.
For a single receipt, the **Source account** of an expense is **Accounts Payable** by default. The
**Target account** of an income is **Accounts Receivable** by default. The record is then
**Outstanding** until a payment settles it.

See [Review and confirm](../04-auto-import/review-and-confirm.md).

### Starting balance

See [Opening balance](#opening-balance).

### Statement

A statement is the list of lines that your bank sends for one account. You upload it with
**Upload Statement** on the reconciliation screen of the account.

See [Bank reconciliation](../07-bank-reconciliation.md).

### Sub-type

The sub-type puts an account into a line of a report, for example **Bank**, **Credit card** or
**Operating expense**. Each account type except **Equity** has sub-types. An **Asset** or
**Liability** account with no sub-type shows **Needs review** on its page. A **Revenue** or
**Expense** account with no sub-type shows **Not yet classified** in its **Sub-type** field. The
reports count it as operating.

See [Accounts and categories](../02-concepts/accounts-and-categories.md).

### Superuser

A superuser can do all actions in all areas. The permissions of the groups do not limit a superuser.
Only a superuser can open **Users & Groups**.
The **Administrators** group is a superuser group.

See [Users and groups](../09-administration/users-and-groups.md).


## T

### Take this back

**Take this back** is the tooltip of the undo icon that removes a settlement. The record is then outstanding or
part paid again. If the record is locked only because of this settlement, it becomes unlocked.

See [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md).

### Transfer

**Transfer** is a record that moves money between two of your own accounts, for example from the
bank to cash. A transfer is not an expense or an income.

See [Move money between accounts](../03-everyday-tasks/move-money-between-accounts.md).

## Words we do not use

Use the word in the right column. The left column shows words that other software uses, and
words that do not match a feature of Akaun.

| Do not write | Write |
|---|---|
| transaction, entry | record |
| journal (for a normal record) | record |
| vendor, party, payee, client | contact (or the role: customer, supplier) |
| ledger account, GL account | account |
| chart of accounts screen | **Accounts** screen |
| categories screen, Categories tab | (no such screen; see [Category](#category)) |
| debit, credit | (see [How a record moves money](../02-concepts/how-an-entry-works.md)) |
| post, posting | save a record |
| leg, split line | line |
| unpaid, owed (as a status) | **Outstanding** |
| partially paid, partly paid | **Part paid** |
| reconciled (for one record) | **Cleared** |
| base currency, home currency | main currency |
| claim, reimbursement claim | (not a feature) |
| set up | prepare, configure |
| fill in, fill out | complete |
| look up | find |
| log in, log on | sign in |
| role (for a group of users) | group |
| admin rights | superuser |
| key (for API access), API token | personal access token |
| void | cancel |
