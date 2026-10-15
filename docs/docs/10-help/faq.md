---
sidebar_position: 2
---

# Frequently asked questions

This page gives short answers to questions that bookkeepers and administrators often ask. Each
answer has a link to the full page.

## Is my data sent anywhere?

Your books stay on your own server. Akaun sends the text of each document that you give to
**Auto Import** or to bank reconciliation to the AI provider that you choose. With the text, it
sends the names of your categories. Akaun also gets
exchange rates and text-recognition files from the internet, but these requests contain no data
from your books. If you connect an AI assistant, the assistant can read the areas that you allow.

See [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md#what-akaun-sends-to-the-provider)
and [Connect AI assistants](../09-administration/connect-ai-assistants.md).

## Can several people work in Akaun at the same time?

Yes. Each user signs in from a web browser, with their own username. Most screens show the changes
of other users immediately, without a reload. Each user sees and changes only what their groups
allow.

See [Find your way around](../01-getting-started/finding-your-way.md#live-updates) and
[Users and groups](../09-administration/users-and-groups.md).

## Can I keep the books of two businesses?

One Akaun installation keeps one book. For a second business, install a second copy of Akaun. Give
it its own `data` folder, its own port and its own `ORIGIN`.

See [Install Akaun](../01-getting-started/install.md).

## Can I use more than one currency?

Yes. Your book has one main currency, and all reports use it. You can record an expense, an income,
a quotation or an invoice in a foreign currency. Akaun changes the amount into the main currency
with the exchange rate of the date.

See [Foreign currency](../02-concepts/foreign-currency.md).

## Can I change the main currency later?

No. The **Currency** setting locks when the first record, quotation or invoice exists. A starting
balance is also a record. Choose the main currency before you add any data.

See [Prepare your book](../01-getting-started/set-up-your-book.md#1-choose-the-main-currency).

## How do I mark a bill as paid?

You do not mark a bill as paid. You record a payment, and Akaun calculates the status from the
payments. On the **Records** screen, find the **Outstanding payables** panel. Click
**Pay all outstanding**, or click **View details** and then **Record a payment** for one contact.

See [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md) and
[Owed, part paid and paid](../02-concepts/owed-and-paid.md).

## How do I record a payment from a customer?

Open the invoice and click **Record payment**. Akaun opens a receipt with the invoice already
ticked. Do not save a new income for this money, because the invoice already counts the sale.

See [Getting paid](../05-sales/getting-paid.md).

## Does Akaun send invoices by email?

No. **Mark as sent** on an invoice records that the customer owes the amount. It does not send
an email.
Click **Print** to get a PDF, and give the PDF to the customer yourself.

See [Invoices](../05-sales/invoices.md).

## Can I undo a delete?

No. Akaun removes a deleted record permanently, and no screen can restore it. The only way to
recover it is to restore a backup, and a restore also removes all later changes.

See [Change, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md) and
[Backups and upgrades](../09-administration/backups-and-upgrades.md#restore-a-backup).

## How do I make a backup of my books?

Akaun has no backup button. Stop Akaun, then copy the database files and the storage folder to a
different computer. With Docker, copy the full `data` folder.

See [Backups and upgrades](../09-administration/backups-and-upgrades.md).

## Does Akaun calculate tax, for example GST, SST or VAT?

No. Invoices and quotations have no tax field, and Akaun makes no tax report. The account
sub-types **Tax receivable** and **Tax payable** put tax balances on the correct lines of the
**Balance Sheet**.

See [Accounts and categories](../02-concepts/accounts-and-categories.md#sub-types).

## Can I print a report?

Not directly. Each report has **Export**, which downloads a CSV file. Open the file in a spreadsheet
program to print it. Quotations and invoices have **Print**, which makes a PDF.

See [Profit & Loss](../08-reports/profit-and-loss.md#export-the-report).

## Can I import my data from a different accounting program?

Not directly. Akaun cannot read a backup file or an export of the chart of accounts of a different
program. **Auto Import** can read records from an Excel workbook (.xlsx) or a CSV file. Add the
accounts and the starting balances by hand.

See [Import spreadsheets](../04-auto-import/spreadsheets.md) and
[Prepare your book](../01-getting-started/set-up-your-book.md).

## Is there a mobile app?

Akaun is a web application. It works in the browser of a phone, with a bottom bar in place of the
sidebar. You can add Akaun to the home screen of the phone, and it then opens in its own window.
Akaun does not work offline.

See [Find your way around](../01-getting-started/finding-your-way.md#on-a-phone) and
[Scan with your phone](../04-auto-import/scan-with-your-phone.md).

## Why is a category an account?

Each record moves money out of one account and into a different account. The category is the
account at one end of the record. For example, an expense moves money out of **Bank** and into
**Software**. Thus a category is an account of the type **Expense** or **Revenue**.

See [Accounts and categories](../02-concepts/accounts-and-categories.md) and
[How a record moves money](../02-concepts/how-an-entry-works.md).

## Related

- [Troubleshooting](./troubleshooting.md)
- [Glossary](./glossary.md)
