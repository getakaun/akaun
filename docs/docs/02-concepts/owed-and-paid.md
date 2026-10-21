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

Every payment has one actual payee; every receipt has one actual payer. **Pay supplier**
lists that supplier's bills. Invoice **Record payment** opens a receipt for that customer.
The page follows the action you opened; there is no operation dropdown.

For expenses someone personally paid across suppliers, open **Record a payment** (or
**Reimburse expenses** on Records). The general page opens as a reimbursement. Select the recipient once, choose the expense amounts,
and confirm that this person paid them. The original suppliers stay on the expenses.
A linked reimbursement transfers what the business owes from those suppliers to the recipient
through balanced clearing entries. It records the expense only once.

Review the claim total, recipient credit, cash and remaining amount owed before saving.
You can reimburse part now, use only available credit, or leave part payable to the recipient.
Generated transfer entries are read-only and linked under the reimbursement.

Use **Correct recipient** on a completed payment if the person was selected incorrectly.
Enter a reason and review the change. Cash, bank matches and source suppliers stay recorded.
If its credit was later used or refunded, the preview identifies allocations to reverse first.

On the page of a record, the rail shows **Payments applied**: each payment that settles the
record. On the page of a payment, the rail shows **Allocated to**: each record that the payment
settles.

## Reverse an allocation

If a payment is on the wrong record, reverse the allocation. On the record page or the payment
page, click the undo icon (**Reverse allocation**) beside the allocation. Review the selected
allocations and the amount that will remain unallocated, enter a reason, and confirm. You can
also choose replacement allocations in the same correction. The record is then
**Outstanding** or **Partially paid** again. To do this, you must have the permission to delete
records.

**Reverse allocation** removes the allocation only. The payment record stays. Its money still
moved out of the cash or bank account.

## Carry an overpayment forward

An unallocated payment is credit on the contact's account. It does not increase the original
expense. Contacts show unpaid bills and invoices separately from unapplied credits, along with
the net balance. Payments show **Allocated** or **Unallocated credit**.

When you record the next payment for the same contact, choose the bills or claims being paid.
Under **Available credit**, select **Apply** beside the earlier payment and enter how much to use.
Akaun shows the claim total, credit applied and cash remaining. It never applies credit automatically.

For example, an employee received 28.00 too much. Their next valid claim is 100.00. Apply the
28.00 credit and record a bank payment of 72.00. The expense remains 100.00. If the next claim
is only 20.00, apply 20.00 credit with no cash payment; 8.00 remains for another claim.

Credits apply only to the same contact and the same payable or receivable account. Use the
single-contact payment flow to apply credit. Batch payments do not automatically deduct credits.

## Record an overpayment refund

If the contact returns an overpayment, open the original overpaid payment and use
**Record refund**. Select their credit, the amount returned, the receipt account and the actual
refund date. Match the receipt to the bank statement when available.

To return a customer's excess payment, use **Record refund** on the original customer receipt.
The form opens in the appropriate direction automatically.
Refunds reduce the original credit balance. They do not create income or reverse the expense.
Partial refunds leave the remaining credit available.

## A company-paid expense reimbursed by mistake

1. For a linked reimbursement, choose **Reverse reimbursement**, enter its reversal date and
   a reason, then review and confirm. This creates contra entries, reopens the supplier expenses
   and releases funding as recipient credit. The real payment and bank matches stay recorded.
   For an older direct allocation, reverse that allocation instead.
2. Record the company's original supplier payment against the mistaken bill and reconcile it.
3. Rebuild any remaining legitimate reimbursement using the released recipient credit.
4. Carry the excess credit forward to a later claim, or record its repayment as an overpayment refund.

Legacy contactless batches remain readable and reversible. New payments always name one person.

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
