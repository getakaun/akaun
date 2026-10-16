---
sidebar_position: 4
---

# Outstanding, partially paid and paid

Some records are paid when they happen. Other records stay outstanding until a payment comes
later. This page tells how Akaun knows which records are paid.

## Paid now, or outstanding until later

A record that moves money straight from a cash or bank account is paid when you save it. For example,
you pay 50.00 from **Bank** for software. The record shows **Paid** immediately.

A record that uses **Accounts Payable** or **Accounts Receivable** is outstanding. The money did
not move yet:

- **Accounts Payable** holds the payables. A payable is money that the business owes to a contact.
  For example, a supplier sends a bill of 300.00, and you pay it next month.
- **Accounts Receivable** holds the receivables. A receivable is money that a contact owes to the
  business. For example, you send an invoice of 500.00 to a customer.

Such a record must name a contact. Akaun then knows who owes the money, or to whom the business
owes it. See [Contacts and their balances](./contacts-and-balances.md).

## The statuses

Each record has one of these statuses. The page of a transfer shows no status.

| Status | What it shows |
|---|---|
| **Outstanding** | Nobody paid any of the amount yet. |
| **Partially paid** | Payments cover some of the amount, but not all of it. The record page shows the amount that is still outstanding. |
| **Paid** | Payments cover the full amount, or the record did not use Accounts Payable or Accounts Receivable. |

The **Records** screen has a tab for each status: **All**, **Outstanding**, **Partially paid** and
**Paid**.

## Akaun calculates the status

You cannot mark a record as paid. Akaun calculates the status from the payments against the
record. Thus the status on each screen is always the same.

A payment is a record of its own. It moves money out of a cash or bank account and puts it against one
or more outstanding records. The part of a payment that goes against one record is an allocation.
When you record a payment, the **Allocation** section shows each outstanding record and its
allocation.

For example, a supplier bill is 300.00. You pay 100.00. The bill shows **Partially paid**, with 200.00
outstanding. Later you pay 200.00. The bill then shows **Paid**.

A payment cannot put more against a record than the amount that is outstanding on it.

## One payment for many records

One payment can settle many records. For example, a supplier sends three bills in one month. You
pay all three with one bank transfer.

One payment can also settle records of many contacts. In the **Payee** field (or the **Payer**
field), choose **Batch (several contacts)**. On the **Records** screen, **Pay all payables** opens
a payment for all contacts that the business owes money to.

On the page of a record, the rail shows **Payments applied**: each payment that settles the
record. On the page of a payment, the rail shows **Allocated to**: each record that the payment
settles.

## Reverse an allocation

If a payment is on the wrong record, reverse the allocation. On the record page or the payment
page, click the undo icon (**Reverse allocation**) beside the allocation. The record is then
**Outstanding** or **Partially paid** again. To do this, you must have the permission to delete
records.

**Reverse allocation** removes the allocation only. The payment record stays. Its money still
moved out of the cash or bank account.

## Paid and reconciled are different

**Paid** tells that the money moved. **Reconciled** tells that a bank statement line matches the
record. A record can be paid and **Unreconciled**. See
[Bank reconciliation](../07-bank-reconciliation.md).

## Related

- [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md)
- [Getting paid](../05-sales/getting-paid.md)
- [Invoices](../05-sales/invoices.md)
- [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md)
- [Locked records](./locked-records.md)
- [Contacts and their balances](./contacts-and-balances.md)
