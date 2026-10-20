---
sidebar_position: 8
---

# Bank reconciliation

Bank reconciliation is a check of one account against the statement from your bank. You match
each statement line to a record in Akaun. When each line has a match, Akaun and the bank agree.
Do this check each month, after the bank sends the statement.

## Before you start

You need these things:

- The **Reconciliation** permission. **View** lets you open the screens. **Add** lets you upload a
  statement, retry a failed statement and record a line as a transfer. **Match** lets you save and
  remove a match. **Change** lets you correct a line and move a statement to a different account.
  **Delete** lets you delete a statement or a statement line. To record a line as a transfer, you
  also need the **Add** permission on **Records**. See
  [Permissions explained](./09-administration/permissions-explained.md).
- An AI provider. Akaun uses the AI provider to read the lines of a statement. See
  [Connect an AI provider](./04-auto-import/connect-an-ai-provider.md).
- The statement as a PDF, JPEG or PNG file. The file can be 15 MB or smaller.
- The records for the period of the statement. Record each expense, income and transfer first.

:::info

You reconcile an account from its account page. **Reconcile** shows only on an active account,
and only if you have the **View** permission on **Reconciliation**.

:::

To open the reconciliation screen of an account:

1. Click **Accounts**.
2. Click the account, for example **Bank**.
3. Click **Reconcile**.

If the account has statements that are not complete, the button shows their number, for example
**Reconcile · 2 open**.

The **Bank reconciliation** screen shows the statements of this account. Below the title, Akaun
shows the unreconciled amount, for example **1,250.00 unreconciled**. When nothing is left, it
shows **Fully reconciled**.

## Upload a statement

1. On the **Bank reconciliation** screen, click **Upload Statement**.
2. Click **Choose file**.
3. Select the statement file.
4. Click **Upload**.

Akaun shows "Statement extraction started". The new statement shows in the list with the status
**Extracting**. When Akaun has read the lines, the status changes to **Active**.

### The list of statements

The list has these columns:

- **Statement**: the file name and the date of the upload.
- **Date Range**: the date of the first line and the last line.
- **Status**: **Extracting**, **Failed**, **Active** or **Matched**.
- **Matched**: the number of statement lines with a full match, out of all lines.
- **Remaining**: the amount of the statement lines that has no match yet.

The **Active**, **Completed** and **All** tabs show a count for each group. **Active** shows
statements that still need work. **Completed** shows statements with a full match on each line.
**All** shows both groups. The page opens on **Active** by default. Use **Search statements…**
to find a statement by its file name.

### Statement details

Click a statement in the list to open its matching page. The summary shows the account, statement
period, matched transactions and unallocated statement amount. Open **Statement details** to see
the full filename, upload date and **View source file** link, which opens the original in a new tab.

If you uploaded the statement to the wrong account, choose the correct account in **Account this
statement belongs to**, then click **Move statement**. You can move a statement only before it
has a match. This control shows only if you have the **Change** permission. After the move, the
matching page opens under the new account.

### If the upload fails

If Akaun cannot read the file, the status is **Failed**. The matching page shows the reason.

1. Open the statement from the list.
2. Read the reason shown below the summary.
3. Click **Retry extraction**.

If the retry fails again, delete the statement. Then upload a clearer file.

If no AI provider is enabled, the statement fails. Add a provider, and then retry.

The reason can tell you to add the transactions manually. Akaun has no control to add a statement
line. Upload a different file of the statement instead.

### Delete a statement

:::caution

You cannot undo this. Akaun deletes the statement, its lines and all their matches. Each record
that only this statement matched is then unreconciled.

:::

1. Open the statement from the list, then expand **Statement details**.
2. Click **Delete statement**.
3. Confirm **Delete statement**. Akaun returns to the statement list.

## Match the lines

1. In the list of statements, click the statement.
2. Click a record in the list on the left.
3. Make sure that the correct statement lines are ticked.
4. Click **Save & Next**.

Akaun saves the match and opens the next record. If no other record needs a match, the button is
**Save**. You need the **Match** permission to save.

The match screen has three parts:

- The list of records. Each row shows the record, the **Account**, the **Date**, the **Total**,
  the **Match** status and the amount that is **Remaining**.
- The match panel, beside the list. It shows the record that you clicked.
- **Extracted Transactions**, below the list. These are the lines that Akaun read from the
  statement.

The title of the screen shows the file name. Below it, Akaun shows the status of the statement,
the number of records to match and the amount of the statement lines without a match. Click
**Source file** to open the uploaded file in a new tab.

A statement line can match only a record that used the account of the statement. The list of
records can also show records from other accounts that have a statement. These records have no
lines to match. Look at the **Account** column, and do not choose them.

### Find a record

- Type in **Search records…** to filter the list. Akaun searches the description, the contact,
  the account and the kind of each record.
- Click **Date**, and then choose a **From** date, a **To** date or both. The list then shows only
  the records in that period. Click **Clear** to remove the dates.

On a narrow screen, the date filter is under **Filters**. The bottom of the list shows how many records
the filters show, for example "Showing 8 of 20".

### How Akaun suggests a match

Akaun looks for statement lines that have the same direction as the record: **Credit** (money into
the account) or **Debit** (money out of the account).
The lines must have the same date as the record, and their total must equal its amount.
If Akaun finds them, the record shows **Exact match**. If records compete for the same line,
they show **Needs manual choice** and automatic matching skips them. You can still select
lines manually when the bank and record dates differ.

The **Match** column shows one of these statuses:

- **Exact match**: Akaun found statement lines with exactly the amount of the record.
- **Needs manual choice**: records compete for the same statement line; choose the correct record manually.
- **Partial**: some of the amount has a match, but not all of it.
- **No match**: Akaun found no lines that fit.
- **Matched**: statement lines cover the full amount of the record.

The list shows **Exact match** records first, then **Partial**, then **No match**, then
**Matched**.

### The match panel

When you click a record, the panel shows three amounts:

- **Total**: the amount of the record.
- **Staged**: the total of the ticked statement lines.
- **Remaining**: the amount of the record that has no line yet.

If Akaun found an exact match, it ticks those lines for you. The panel then shows
**Suggested match**. If you change the ticks, the panel shows **Exact Match Found**. Click **Use
Suggested Match** to tick the suggested lines again.

**Compatible Statement Lines** lists the lines that can match this record. A record of money into
the account shows **Credit** lines. A record of money out of the account shows **Debit** lines. Each line shows
the amount that is still available.

### Match a part of a line

One record can use more than one statement line. One statement line can also go to more than one
record. For example, the bank shows one line of 500.00. In Akaun, you have two records: 300.00 and
200.00.

1. Click the record of 300.00.
2. Tick the line of 500.00.
3. Make sure that the amount beside the line is 300.00.
4. Click **Save & Next**.
5. Click the record of 200.00.
6. Tick the same line.
7. Click **Save & Next**.

The line now has 0.00 available, and both records show **Matched**.

The staged total cannot be more than the amount of the record. If it is more, the panel shows the
difference in red, for example "50.00 over record total". You cannot save until you correct it.

Click **Reset** to remove the changes that you did not save.

### Save all exact matches

:::caution

This saves many matches at one time. To remove a match later, you must remove it one record at a
time.

:::

1. Click **Save *n* exact matches**. For example, **Save 12 exact matches**.
2. Read the message.
3. Click **Save Matches**.

Akaun saves the suggested lines for each record that shows **Exact match**. It does not change a
record that already has a part of a match. Competing records are skipped until you choose a
match manually. A record is also skipped if its suggested lines are no longer available.
Akaun then shows the number of records that it matched and skipped.

The button counts only the records that the list shows. If you search or filter the list, the
button saves only the matches in the filtered list. You need the **Match** permission to see the
button.

### Correct a statement line

Sometimes Akaun reads a line incorrectly. You can correct the line.

1. In **Extracted Transactions**, click the line.
2. Change **Date**, **Description**, **Amount**, **Direction** or **Note**.

Akaun saves each change when you leave the field. You need the **Change** permission. In **Direction**, **Credit** is money into the account.
**Debit** is money out of the account. These are the terms of the bank statement.

### Record a line as a transfer

Some statement lines have no record, because the money moved between two of your own accounts. For
example, you moved money from **Bank** to **Cash**. Akaun can make the transfer record for you.

1. In **Extracted Transactions**, click the line.
2. Click **Record as a transfer from another account**.
3. Choose the other account.
4. Optional: change the **Description**.
5. Click **Save & Match**.

For money into the account, the field of the other account is **From account**. For money out of
the account, it is **To account**.

Akaun makes a **Transfer** record in the main currency, with the date and amount of the line. Then
it matches the line to the transfer. The button shows only on a line without a match. You need the
**Add** permission on **Reconciliation** and on **Records**.

The list of other accounts shows only cash and bank accounts. A category, an owner account, a
receivable or a payable is not a transfer: record the line as an expense or
income, or as a payment, and match it. A user with **Adjustments** on **Records** sees every
account.

### Delete a statement line

:::caution

You cannot undo this. Akaun deletes the line and all its matches.

:::

1. In **Extracted Transactions**, click the line.
2. Click **Delete Transaction**.
3. In the dialog, click **Delete Transaction**.

You need the **Delete** permission.

### Remove a match

1. Click the record that has the match.
2. Remove the tick from each statement line.
3. Click **Save & Next** or **Save**.

The record then has no match. If nothing else locks it, you can change its amount, date and payment
account again.

## Finish a statement

A statement is complete when each of its lines has a full match. Its status then changes to
**Matched**. It moves from **Active** to **Completed**. You do not click a button to complete a
statement.

If a statement line has no record, do one of these things:

- Add the missing record on the **Records** screen. Then match the line.
- If the money moved between two of your accounts, record the line as a transfer.
- If the line is wrong or appears two times, delete the line.

## What a match does to a record

- When statement lines cover the full amount of a record, the record is reconciled. On the
  **Records** screen, a record without a full match shows **Unreconciled**.
- When a record has a match, also a part match, the record page shows **Reconciled** in the
  **Bank** section.
- A record with a match, also a part match, is locked. You cannot change its amount, date or payment account, and you
  cannot delete it. See [Locked records](./02-concepts/locked-records.md).

Reconciled and paid are different. **Paid** tells that the money has moved. **Reconciled** tells
that the bank statement agrees.

## Notes

- To find the records of all accounts without a full match, use the **Unreconciled** filter on
  the **Records** screen. See [Find records](./03-everyday-tasks/find-records.md).
- On a narrow screen, the match panel opens as a drawer.
- If you open a different record or leave the match screen with changes that you did not save,
  Akaun asks you first. Click **Discard Changes** to continue without them.
- An AI provider can make mistakes. Compare the **Matched** count and the **Remaining** amount with
  the statement from the bank.

## Related

- [Locked records](./02-concepts/locked-records.md)
- [Move money between accounts](./03-everyday-tasks/move-money-between-accounts.md)
- [Find records](./03-everyday-tasks/find-records.md)
- [Connect an AI provider](./04-auto-import/connect-an-ai-provider.md)
