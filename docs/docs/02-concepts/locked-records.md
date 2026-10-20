---
sidebar_position: 5
---

# Locked records

Some changes to a record can make a different record wrong. Akaun locks a record to prevent this.
This page tells when a record is locked, what you can still change, and how to unlock it.

## When a record is locked

A record is locked in these two cases:

- A payment settles some or all of the record. The payment record is also locked.
- A bank statement line matches the record.

For example, a supplier bill is 300.00 and a payment of 300.00 settles it. If you change the bill
to 250.00, the payment is then wrong. Thus Akaun locks the amount of the bill.

## What you cannot change

On a locked record, you cannot change these fields:

- The amount.
- The date.
- The currency and the exchange rate.
- The accounts. On an expense or an income, only the cash or bank account is locked. The category is
  not locked.

You also cannot delete a locked record.

## What you can still change

On a locked record, you can still change these fields:

- The description.
- The contact.
- The reference.
- The remark.
- The attachments.
- On an expense or an income, the category, and the extra lines of a split.

A change to these fields cannot make a payment or a bank match wrong.

## How Akaun shows a locked record

- On the **Records** screen, a lock icon shows beside the description. Put the pointer on the icon
  to see the reason.
- On the record page, a note above the form gives the reason. The locked fields are read only.
- On the record page, **Delete** is not available. Put the pointer on it to see the reason.

The reason tells you what to undo. For example: "A payment has settled this record. Undo the
settlement before changing its amount, date or the account it moved through."

## How to unlock a record

### Correct only a settled date

Trusted users with both **Edit records** and the separately granted **Correct settled dates**
permission can use **Correct date** on a settled expense or income record. This action is
available only in the browser, and only when the record has no bank statement matches.
Payment records and records created by issuing an invoice cannot use it.

Save or discard other edits first. Enter the corrected date and a reason of 10–500 characters,
then review and confirm. Moving between calendar months or years requires an extra
acknowledgement. Both dates, your reason, and who made the correction are saved in History.

The correction preserves payment allocations and payment dates. It changes the accounting
date, so reports and historical balances can change. **Do not use it for a finalized period
without consulting the person responsible for your accounts.** Akaun does not enforce a
closed-books cutoff for this action. Ordinary date editing remains locked.

### Unlock other changes

Remove each thing that locks the record:

- If a payment settles the record, click the undo icon (**Reverse allocation**) beside the payment. See
  [Outstanding, partially paid and paid](./owed-and-paid.md).
- If a bank statement line matches the record, remove the match on the reconciliation screen of
  the account. See [Bank reconciliation](../07-bank-reconciliation.md).

When nothing settles or matches the record, it is unlocked. You can then change all of its fields.

## Records made by an invoice

When you mark an invoice as sent, Akaun makes an **Invoice** record. This record belongs to the
invoice:

- All fields on its record page are read only. A note above the form says "This record was created
  by issuing an invoice. Change it on the invoice instead."
- **Delete** on its record page is disabled. Put the pointer on it to see the reason: "Cancel the
  invoice instead".
- A delete of many records on the **Records** list does not delete it. Akaun deletes the other
  selected records and shows the reason.
- The **Invoice** card in the rail opens the invoice.

On the invoice page, you can still change the due date, the reference, the notes and the terms.
You cannot change the customer, the issue date, the currency or the lines. To remove the
**Invoice** record from the books, cancel the invoice. See
[Cancel an invoice](../05-sales/invoices.md#cancel-an-invoice).

## Related

- [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md)
- [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md)
- [Attach receipts](../03-everyday-tasks/attach-receipts.md)
- [Bank reconciliation](../07-bank-reconciliation.md)
- [Invoices](../05-sales/invoices.md)
