---
sidebar_position: 7
---

# Change, delete or undo a record

Use this page to correct a record, to delete it, or to remove a payment from it. You change a
record on its own page.

## Change a record

1. On the **Records** screen, click the record.
2. Change the fields that are wrong.

   A save bar shows at the bottom of the page. It shows **Unsaved changes**, **Discard** and
   **Save changes**.

3. Click **Save changes**.

To remove your changes, click **Discard**. The fields then show the saved values again.

If the save bar shows a message in place of **Unsaved changes**, the record cannot be saved yet.
Read the message and correct the form.

## Result

Akaun saves the changes. The **History** section in the rail shows a new line. It tells who made
the change, when, and which fields changed.

Akaun finds the kind again from the accounts. For example, if you change the **Debit** line of an
expense from a category to **Cash**, the record becomes a **Transfer**.

## If you leave the page before you save

If you click a link or **Records** before you save, Akaun shows **Leave without saving?**.

- Click **Discard and leave** to leave the page. Akaun does not save your changes.
- Click **Cancel** to stay on the page.

:::caution

If you reload the page or close the browser tab, Akaun does not warn you. Your changes are lost.
Save first.

:::

## What you cannot change

Some fields are read only in these cases:

- If the record is locked, the amount, the date, the currency and the cash or bank account are read
  only.
  A payment settles the record, or a bank statement line matches it. A note above the form gives
  the reason. See [Locked records](../02-concepts/locked-records.md).
- If the record is a payment, ordinary edits change only the description, the reference and the remark.
  Use **Correct payee** for an incorrect outgoing-payment recipient, **Reverse allocation**
  to reopen an expense, or **Correct reimbursement amount** for an eligible incorrectly
  recorded reimbursement payment amount. These corrections retain their history;
  reversing an allocation does not make its parent payment deletable.
- If the record came from an invoice, change the invoice, not the record. The note above the form
  says "This record was created by issuing an invoice. Change it on the invoice instead." See
  [Invoices](../05-sales/invoices.md).
- If you do not have the **Change** permission on **Records**, all fields are read only.

On a locked expense or income, you can still change the description, the contact, the reference,
the remark, the attachments and the categories.

## Delete one record

You can delete a record only when it is not locked. If **Delete** is not available, put the
pointer on it to see the reason.

:::caution

You cannot undo a delete. Akaun removes the record and all of its lines. Each balance that the
record touched changes.

:::

1. Open the record.
2. At the top right of the page, click **Delete**.
3. In **Delete this record?**, click **Delete**.

Akaun deletes the record and shows the **Records** screen.

## Delete many records

:::caution

You cannot undo a delete. Check the selected records before you confirm.

:::

1. On the **Records** screen, select the check box of each record.

   A bar at the bottom shows the number of records and their total.

2. On the bar, click **Delete**.
3. In **Delete these records?**, click **Delete**. For one record, the dialog is
   **Delete this record?**.

Akaun does not delete a locked record. If the selection has locked records, the dialog tells you
how many. Akaun deletes the other records.

Akaun also does not delete an **Invoice** record. Akaun deletes the other records and shows the
reason. To remove an **Invoice** record, cancel its invoice. See
[Cancel an invoice](../05-sales/invoices.md#cancel-an-invoice).

To select all records in the list, click the check box at the top of the list.

## Remove a payment from a record

Use this when a payment is on the wrong bill. **Reverse allocation** removes the allocation only.
The payment record stays, and its money still moved out of the cash or bank account.

:::caution

Akaun removes the allocation when you click the button. It does not ask you to confirm.

:::

1. Open the bill or the payment.
2. In the rail, find **Payments applied** (on a bill) or **Allocated to** (on a payment).
3. On the row of the allocation, click the undo arrow. Its tooltip is **Reverse allocation**.

The bill is **Outstanding** or **Partially paid** again. If nothing else locks the bill, you can change
it again.

A payment with no contact, which pays several people at once, must always be spent in full. When
you reverse one of its allocations, Akaun reverses all of them, and all of its bills are
outstanding again.

To use the money of the payment for a different bill, record a new payment. See
[Bills you pay later](./bills-you-pay-later.md).

## See the history of a record

1. Open the record.
2. In the rail, find **History**.

Each line shows the user, the change and the time. The list shows changes to the fields and to
the attachments.

## Notes and limits

- To change a record, you need the **Change** permission on **Records**.
- To delete a record or to click **Reverse allocation**, you need the **Delete** permission on
  **Records**. Without it, **Delete** and **Reverse allocation** do not show.
- To delete a payment that pays a bill, first click **Reverse allocation** on each allocation.
- If a bank statement line matches the record, remove the match first. See
  [Bank reconciliation](../07-bank-reconciliation.md).

## Related

- [Locked records](../02-concepts/locked-records.md)
- [Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md)
- [Find records](./find-records.md)
- [Attach receipts and documents](./attach-receipts.md)
