---
sidebar_position: 1
toc_max_heading_level: 2
---

# Troubleshooting

Use this page when Akaun does not do what you expect. Each heading is a message or a problem that
you see. Below each heading, the page tells you the cause and what to do. The links go to the
full procedures.

## Invalid username or password

### Cause

The username or the password is wrong. The username is case-sensitive. For example,
`Admin` is not the same as `admin`.

### What to do

1. Type the username again. Check the capital letters.
2. Type the password again.
3. If you forgot the password, see [You forgot your password](#you-forgot-your-password).

See [Sign in for the first time](../01-getting-started/first-sign-in.md#if-you-cannot-sign-in).

## Too many attempts. Try again in 15 minute(s).

### Cause

Akaun allows 5 attempts for one username from one computer in 15 minutes. The
15 minutes start at the first attempt. While this message shows, Akaun refuses the correct
password too.

### What to do

1. Wait for the number of minutes in the message.
2. Sign in again with the correct password.

A correct sign-in sets the count to zero. A restart of the server also sets it to zero.

## You forgot your password

### Cause

The **Forgot?** button on the sign-in page does not work at this time. Akaun cannot
send a password by email.

### What to do

Ask a superuser to give you a new password.

1. The superuser opens **Users & Groups**.
2. On the **Users** tab, the superuser clicks your row.
3. The superuser types a new password in **Reset password**.
4. The superuser clicks **Save changes**.
5. Sign in with the new password.
6. Change the password on the **Security** tab of your profile.

See [Users and groups](../09-administration/users-and-groups.md#change-a-user) and
[Your profile](../09-administration/your-profile.md#security).

## The only superuser forgot the password

### Cause

No screen in Akaun can give a new password to the last superuser. Only a superuser
can open **Users & Groups**.

### What to do

- If a different user is in **Administrators**, that user can reset the password. See
  [You forgot your password](#you-forgot-your-password).
- If no other superuser exists, Akaun has no tested way to recover access at this time.

The source code has a script, `scripts/create-admin.ts`, that adds a new user. Nobody has tested
it outside the application, and it may not run. If you try it, make a backup first. See
[Backups and upgrades](../09-administration/backups-and-upgrades.md).

:::caution

Keep two or more trusted users in **Administrators**. Then one superuser can always reset the
password of the other.

:::

## Forbidden (CSRF origin check failed)

### Cause

The address in the browser is not the same as the `ORIGIN` setting of the server.
Akaun refuses a sign-in or a save from a different address. The scheme (`http` or `https`), the
name and the port must all agree.

### What to do

The administrator of the server does these steps.

1. Find the exact address that the users type, for example `https://books.example.com`.
2. Set `ORIGIN` to this address.
3. Start Akaun again.

If users open Akaun with two different addresses, only the address in `ORIGIN` works. See
[Install Akaun](../01-getting-started/install.md#environment-variables).

## The sign-in page opens again after you click Sign in

You type the correct username and password, but the sign-in page shows again. No message shows.

### Cause

The server runs with `NODE_ENV=production`, and the Docker image sets this value. Then
the browser keeps the sign-in only on an HTTPS address or on `localhost`. Over plain HTTP to a
different address, the browser does not keep the sign-in.

### What to do

1. Serve Akaun over HTTPS. Use a reverse proxy, or set `SSL_ENABLED`, `SSL_KEY_PATH` and `SSL_CERT_PATH`.
2. Set `ORIGIN` to the HTTPS address.
3. Start Akaun again.

See [Install Akaun](../01-getting-started/install.md#environment-variables).

## Akaun opens Settings after you sign in

### Cause

The user has no **View** permission on **Records**. After the sign-in, Akaun tries **Records**,
then the **Dashboard**, and then opens **Settings**. For example, a user in the **Data Entry** group
only sees this. This group can add records, but it has no **View** permission on **Records**.

If the user also has no **View** permission on **Settings**, Akaun opens their **Profile**
instead. These users see this:

- A user in no group, and with no extra permissions.
- A user in a group with no permissions, for example a group that stops access.

A user who opens Akaun from the home screen of a phone can also see **Settings**. The home-screen
icon opens the **Dashboard**, and only **Administrators** have **View** on **Dashboard**. Click
**Records** in the menu to continue.

### What to do

A superuser puts the user in a group with the correct permissions. See
[Users and groups](../09-administration/users-and-groups.md).

:::caution

Do not leave a user in no group. At the next start of the server, Akaun puts each user with no
group into **Administrators**. That user then becomes a superuser. To stop the access of a user,
see [Stop the access of a user](../09-administration/users-and-groups.md#stop-the-access-of-a-user).

:::

## A screen, a tab or a button is missing

### Cause

Usually the user does not have a permission. Some items also show only in some
conditions.

| What is missing | Why |
|---|---|
| A screen in the sidebar | You have no **View** permission on that area. |
| **New record** | You have no **Add** permission on **Records**. |
| **Delete** or **Reverse allocation** | You have no **Delete** permission on **Records**. No group except **Administrators** gives it. |
| **Users & Groups** | Only a superuser sees it. |
| **Settings** in the sidebar | You have no **View** permission on **Settings**. |
| The fields and the **Save** buttons in **Settings** | You have no **Manage** permission on **Settings**. A note at the top of the page tells this. The groups that Akaun makes do not give it. |
| **Reconcile** on an account page | You have no **View** permission on **Reconciliation**, or the account is inactive. |
| The **Ledger** tab in **Settings** | You have no **View** permission on **Reports**. |
| **Quotations** and **Invoices** | You have no **View** permission on these areas. A group that you make has none until you choose a level for them in the group. |
| **Convert** on a quotation | The status is not **Sent** or **Accepted**. Or you do not have **Convert** on **Quotations** and **Add** on **Invoices**. |
| **Cancel invoice** | The invoice is a draft, or a payment is recorded against it. Or you do not have **Void** on **Invoices** and **Change** on **Records**. |
| **Record payment** on an invoice | The invoice is a draft, is cancelled or is fully paid. Or you have no **Add** permission on **Records**. |
| The **Partners' Equity** tab | No contact has the **Partner** role. |
| **Pay all payables** | The business owes money to one contact only, or to none. Or you have no **Add** permission on **Records**. |
| **Payment account** on a payment | The book has only one cash or bank account. Akaun uses that account. |
| **Contact** on a new record | You have no contacts yet. |
| **Scan** on **Auto Import** | The screen is wide. **Scan** shows only on a narrow screen, such as a phone. |

### What to do

Ask a superuser for the permission. See
[Permissions explained](../09-administration/permissions-explained.md).

**Confirm & import** and **Skip** show for all users, but Akaun refuses them without the
**Confirm** permission on **Auto Import**. **Read again** shows only with the **Upload** and
**Change** permissions on **Auto Import**. The **Bookkeeper** group does not give **Change** or
**Confirm** on **Auto Import**. See
[Users and groups](../09-administration/users-and-groups.md#the-groups-that-akaun-makes).

## API tokens were replaced by personal access tokens

The full message is "API tokens were replaced by personal access tokens. Create one under Profile →
Access tokens." A program or an AI assistant gets this message, and it cannot connect.

### Cause

The program uses an API token of an older version of Akaun. The upgrade revoked all these tokens.
They do not work any more.

### What to do

1. Open your profile, and click the **Access tokens** tab.
2. Make a new token with only the permissions that the program needs. See
   [Make a token](../09-administration/your-profile.md#make-a-token).
3. In the program, replace the old token with the new token. The new token starts with `akp_`.

If **Permissions** offers nothing, ask your administrator to let your group hand on permissions to
tokens and apps. See
[What members may hand on](../09-administration/users-and-groups.md#what-members-may-hand-on).

## The amount, the date or the account of a record is read only

A note above the form gives the reason. For example: "This record is settled by a payment.
Reverse the settlement before you change its amount, date or account."

### Cause

The record is locked. A payment settles it, a bank statement line matches it, or both.
A locked record keeps its amount, date, currency and cash or bank account. You also cannot delete it.

### What to do

Remove each thing that locks the record.

1. If a payment settles the record, open the record.
2. In **Payments applied**, click the undo arrow on the payment. Its tooltip is **Reverse allocation**.
3. If a bank statement line matches the record, open the account page and click **Reconcile**.
4. Click the row of the statement.
5. Click the record in the list.
6. Remove the tick from each statement line.
7. Click **Save & Next** or **Save**.
8. Change the record.

**Reverse allocation** needs the **Delete** permission on **Records**. **Save & Next** and **Save**
need the **Match** permission on **Reconciliation**. You can still change the
description, contact, reference, remark and attachments of a locked record. On a locked expense or
income, you can also change the categories.

On a payment record, Akaun saves only the description, the reference and the remark. The other
fields can look editable, but Akaun does not save them.

See [Locked records](../02-concepts/locked-records.md) and
[Change, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md).

## This record was created by issuing an invoice. Change it on the invoice instead.

### Cause

The record is an **Invoice** record. Akaun made it when you clicked **Mark as sent** on an
invoice. The record belongs to the invoice, so its record page is read only. If you try to delete
it, Akaun shows "This record was created by issuing an invoice. Cancel the invoice instead."

### What to do

1. In the rail of the record page, click the **Invoice** card.

   The invoice opens.

2. To change the due date, the reference, the notes or the terms, click **Edit**.
3. If the customer, the date, the currency or a line is wrong, click **Cancel invoice**. Then make
   a new invoice.

See [Change a sent invoice](../05-sales/invoices.md#change-a-sent-invoice) and
[Cancel an invoice](../05-sales/invoices.md#cancel-an-invoice).

## A payment has been recorded against this invoice

The full message is "A payment has been recorded against this invoice. Remove that payment first,
then cancel the invoice."

### Cause

A payment settles the invoice, in full or in part. While a payment settles an invoice,
**Cancel invoice** does not show. The message shows when someone recorded the payment after you
opened the invoice page.

### What to do

1. On the invoice page, in the **Payments** card, click the payment.
2. Beside the allocation to the invoice, click **Reverse allocation**.
3. Open the invoice again, and click **Cancel invoice**.

**Reverse allocation** needs the **Delete** permission on **Records**.

See [Cancel an invoice](../05-sales/invoices.md#cancel-an-invoice).

## You cannot choose Accounts Payable on a new record

### Cause

Without the **Adjustments** permission, each line of the record form offers cash or
bank accounts and categories only. **Accounts Payable**, a loan account and a **Credit card** account
are not in the list. The same cause can make a line of an imported bill show **Select account**.

### What to do

- To record a bill that you pay later, import it with **Auto Import**. See
  [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md).
- For a different record on these accounts, ask a user with the **Adjustments** permission.

No group that Akaun makes gives **Adjustments**. See
[Permissions explained](../09-administration/permissions-explained.md#adjustments).

## These two accounts need the Adjustments ability

The full message is: "These two accounts need the Adjustments ability. Ask an administrator for
it, or choose an everyday account on each line."

### Cause

The accounts on the record do not make an everyday record, such as an expense, an
income or a transfer. Akaun saves such a record as a **Journal entry**, and a journal entry needs
**Adjustments**.

### What to do

1. Check the account on the **Debit** line and on the **Credit** line.
2. Choose a cash or bank account on one line and a category on the other line.
3. If the record must use these accounts, ask a user with **Adjustments** to save it.

See [How a record moves money](../02-concepts/how-an-entry-works.md).

## Debits and credits do not balance

The full message is, for example: "Debits and credits do not balance. Difference: 5.00." This
message shows on the save bar. The top of **Journal entry** shows a figure with **apart**.

### Cause

The record has more than two lines. The total of the category lines is not the same as the
amount of the record.

### What to do

1. Find the difference at the top of **Journal entry**.
2. Correct the amount on one category line.
3. Make sure that the top of **Journal entry** shows **Balanced**.
4. Click **Save record** on a new record, or **Save changes** on a saved record.

:::tip

On the last line, click the arrow button in the amount box. Its tooltip shows the difference, for
example **Use the remaining 5.00**. The button puts the difference on that line.

:::

See [Split a record across categories](../03-everyday-tasks/split-across-categories.md).

## The record does not save, and a message shows

Akaun does not save the record until you correct each problem. When the record has more than two
lines, these messages show on the save bar:

| Message | What to do |
|---|---|
| "Select an account for each line." | Choose an account on each line. |
| "A line amount cannot be zero." | Type an amount that is not zero on each line, or remove the line. |
| "Select the contact for this receivable or payable." | Choose a **Contact**. A record on **Accounts Payable** or **Accounts Receivable** must name a contact. |

After you click save, these messages can show above the form:

| Message | What to do |
|---|---|
| "Select the contact for this receivable or payable." | Choose a **Contact**. |
| "Money cannot move from an account to itself. Choose two different accounts." | Choose a different account on one line. |

See [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md).

## No LLM providers configured. Go to Settings → Intelligence to add one.

### Cause

**Auto Import** has no enabled AI provider. Each file that needs AI then fails with
this message.

### What to do

1. Add a provider, or enable a provider. See
   [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md).
2. On **Auto Import**, click **Read again** on each failed row.
3. In the dialog, click **Read again**.

**Read again** needs the **Upload** and **Change** permissions on **Auto Import**.

A spreadsheet that a **Table rows** import profile reads does not need a provider. See
[Import profiles](../04-auto-import/import-profiles.md).

## A file stays in the Processing queue

### Cause

Akaun reads a limited number of files at the same time. Other files wait as
**Queued**. A long document takes more time, because Akaun reads it in parts. **Rate limit** in
**Settings** also makes Akaun wait between two calls to the provider.

### What to do

- Wait. The row shows the progress, for example **Reading part 3 of 25…**.
- To read more files at the same time, increase **Parallel tasks**. See
  [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md#processing-options).
- If the server stops during a reading, the reading starts again from the start at the next
  start of the server.

## A file shows under Failed

### Cause

Akaun or the AI provider could not read the file. The row shows the reason. Usually
the photo is not clear, the provider is not available, or no provider is enabled.

### What to do

1. Read the reason on the row.
2. Correct the cause. For example, enable a provider, or choose a different model.
3. Click **Read again**.
4. In the dialog, choose how Akaun reads the file.
5. Click **Read again**.

If the photo is not clear, upload a clearer photo. Then click **Discard** on the failed row.

**Retry** uploads the same file again. It shows only in the browser tab where you uploaded the
file, before a reload. **Read again** needs the **Add** and **Change** permissions on
**Auto Import**. See
[Import receipts and documents](../04-auto-import/import-receipts.md#if-a-file-fails).

## Akaun refuses a file when you upload it

A message shows below the drop area on **Auto Import**. It starts with the name of the file.

| Message | What to do |
|---|---|
| "This is an old Excel file (.xls), which cannot be read." | Open the file in Excel. Save it as .xlsx or .csv. Upload it again. |
| "This workbook is protected with a password, so it cannot be read." | Remove the password in Excel. Save the file. Upload it again. |
| "File too large. Maximum size is 15 MB." | Make the file smaller, or divide it into two files. |
| "Upload failed" | The server refused the file before Akaun could read it. See the next paragraph. |

If a file of less than 15 MB shows "Upload failed", the server can have a lower upload limit. The
`BODY_SIZE_LIMIT` setting controls this limit. The Docker image sets it to `21M`. Without it, the
server refuses files larger than about 0.5 MB. The administrator sets `BODY_SIZE_LIMIT=21M` and
starts Akaun again. See
[Install Akaun](../01-getting-started/install.md#environment-variables).

For more messages about spreadsheets, see
[Import spreadsheets](../04-auto-import/spreadsheets.md#files-that-akaun-refuses).

## A new item shows a Duplicate tag

### Cause

Akaun compares each item with the records in the book. It looks for the same file, the
same reference, a similar amount, a near date, a similar contact, a similar file name and similar
text. A new bill can
look like an old bill. For example, a monthly bill from one supplier often has the same amount
and the same layout.

### What to do

1. Read the reasons on the tag, for example "Duplicate · 85% · reference · amount".
2. Find the existing record on the **Records** screen, and compare it with the item.
3. If the item is new, click **Import anyway**.
4. If the item is a second copy, click **Skip**.

See [Review and confirm](../04-auto-import/review-and-confirm.md#a-possible-duplicate).

## No rate found for that date — enter it yourself.

On **Auto Import**, the message is "Enter the rate manually to convert to MYR." The last word is
your main currency.

### Cause

Akaun gets exchange rates from a free public rate service on the internet. It finds no
rate in these cases:

- The server cannot connect to the internet.
- The rate service does not have the currency. It has about 30 main currencies only.
- The rate service is not available at this time.

### What to do

1. Find the rate on your bank statement or on the bill.
2. Type the rate in the **Rate (1 USD = ? MYR)** field. The field shows your currencies.
3. Save the record, or confirm the item.

See [Foreign currency](../02-concepts/foreign-currency.md#the-exchange-rate).

## Statement extraction failed

The statement shows the status **Failed**. The statement drawer shows the reason after
"Statement extraction failed:".

### Cause

Akaun could not read the lines of the statement. The usual reasons are these:

- The file has too little text that Akaun can read.
- No AI provider is enabled.
- The AI provider found no lines in the text.

### What to do

1. Correct the cause. For example, enable an AI provider.
2. Open the [statement drawer](../07-bank-reconciliation.md#open-the-statement-drawer).
3. Click **Retry Extraction**.
4. If the retry fails again, click **Delete** in the drawer to delete the statement.
5. Upload a clearer file, for example the PDF from the website of the bank.

**Retry Extraction** needs the **Add** permission on **Reconciliation**. **Delete** needs the
**Delete** permission on **Reconciliation**.

One message tells you to add the lines by hand. At this time, no screen can add a statement line.
See [Bank reconciliation](../07-bank-reconciliation.md#if-the-upload-fails).

## A record does not show on the match screen

### Cause

The match screen lists the records that have a line on an account with a statement.
These are the usual reasons that a record does not show:

- The record uses a different account. For example, you recorded the expense on **Cash** and not
  on **Bank**.
- The record does not exist yet in Akaun.
- The search box or the date filter on the match screen hides it.

### What to do

1. Clear the search box and the date filter.
2. Open the record.
3. Check the cash or bank account of the record.
4. If the account is wrong, change it to the account of the statement.
5. If the record does not exist, add it on the **Records** screen.

If you cannot change the account, the record is locked. See
[The amount, the date or the account of a record is read only](#the-amount-the-date-or-the-account-of-a-record-is-read-only).

The list can also show records from other accounts that have a statement. These records can never
match this statement. If a statement line does not show under **Compatible Statement Lines**,
check its **Direction**. See [Bank reconciliation](../07-bank-reconciliation.md#match-the-lines).

## The balance sheet does not balance

This message shows on the **Balance sheet** card of the **Dashboard**, with the difference. The
**Action items** list also shows **Balance sheet does not balance**.

### Cause

The data of one or more records is damaged. The total of the lines of each record must
be zero. The screens do not normally cause this.

### What to do

1. Click **Settings**.
2. Click the **Ledger** tab.
3. Under **Ledger integrity check**, click **Check now**.
4. Make a note of each record number and difference in the result.
5. Report the problem. See [Report a problem](#report-a-problem).

The **Ledger** tab shows only with the **View** permission on **Reports**. The check only reads the
book. It changes nothing. Do not send reports to anybody until the check
shows **The ledger is in balance. All records and the trial balance agree.** See
[Dashboard](../08-reports/dashboard.md#if-the-balance-sheet-does-not-balance).

## Partners' Equity shows 0.00 for Contributions and Drawings

### Cause

No control in Akaun connects an Equity account to a partner. The **Partner** role does
not make these accounts. Thus **Contributions** and **Drawings** are 0.00 in a new book. Only
**Share of profit** has a value.

### What to do

At this time, the report cannot show contributions and drawings for a new book.
Use the **Records** screen, filtered by the Equity account, to see this money. See
[Find records](../03-everyday-tasks/find-records.md#see-the-statement-of-one-account) and
[Partners' Equity](../08-reports/partners-equity.md#contributions-and-drawings).

## A file does not show in Attachments after you add it

### Cause

On the page of a saved record, Akaun does not show a message when an upload fails. These
are the usual causes:

- The file is not a PDF, JPEG or PNG file.
- The file is larger than 15 MB.
- The server has a lower upload limit, because `BODY_SIZE_LIMIT` is not set.
- You have no **Change** permission on **Records**. **Add** shows, but the upload fails.

### What to do

1. Check the type and the size of the file.
2. Check that you have the **Change** permission on **Records**.
3. If a small PDF also fails, ask the administrator to set `BODY_SIZE_LIMIT=21M`.
4. Add the file again.

See [Attach receipts and documents](../03-everyday-tasks/attach-receipts.md) and
[Install Akaun](../01-getting-started/install.md#environment-variables).

## Report a problem

If this page does not solve the problem, report it to the people who make Akaun. Open an issue on
the [Akaun project on GitHub](https://github.com/getakaun/akaun).

Give this information:

- The version of Akaun. It shows under your name at the bottom of the sidebar, for example
  `v0.1.7`.
- The steps that you did, and the message that you saw. Copy the message exactly.
- The lines of the server log at the time of the problem. With Docker, type
  `docker compose logs akaun`.

:::caution

The server log can contain names, amounts and other data from your books. Remove this data before
you send the log.

:::

## Related

- [Glossary](./glossary.md)
- [Frequently asked questions](./faq.md)
- [Permissions explained](../09-administration/permissions-explained.md)
- [Backups and upgrades](../09-administration/backups-and-upgrades.md)
