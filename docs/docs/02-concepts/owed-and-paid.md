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

For company-paid expenses, **Auto import** or **+ Add record** records the expense
and bank payment together, with the supplier as its contact. There is no additional payment step.

For expenses someone personally paid, select **Accounts payable** as the source account
when recording the expense or reviewing an import. Keep the supplier as the contact.
Accounts payable expenses are treated as personally paid; no additional payment-source field is needed.

Use **Reimburse expenses** on Records, select the person receiving the reimbursement,
and choose outstanding expenses across suppliers. **Default reimbursement payee** in Settings
prefills that recipient. Available credit belongs to the selected recipient.

The bank payment is allocated directly to the selected expenses. No summary, clearing or
supplier-transfer records are created. You can pay part now, apply selected available credit,
or settle using credit alone. Credit-only settlement creates no new bank payment.

The payment's original amount stays visible with the amount applied and current available credit.
On each expense, **Payments applied** links to its payments. On a payment, **Allocated to**
links to the covered expenses, including their suppliers.

Previously recorded reimbursements retain their original accounts and helper entries.
Those entries remain read-only under **Accounting details**, with their existing correction
and full-reversal safeguards. They are not converted automatically. Credits stay on their
original payable account; they are not silently transferred between supplier and reimbursement balances.

## Correct a reimbursement amount

If a reimbursement payment was entered with the wrong amount, open its payment record and
choose **Actions → Correct reimbursement amount…**. This controlled action requires a signed-in
browser session and both **Change records** and **Correct reimbursement amounts** permissions.
Save or discard other edits and remove any bank statement matches first.

Enter the amount actually paid and a reason of 10–2000 characters. For one covered expense,
Akaun calculates the reimbursement automatically. For several expenses, enter how much was
reimbursed against each one. Review the corrected payment, remaining expense balances and
available credit, then choose **Confirm correction**.

For example, an expense costs RM5.50 but only RM5.00 was reimbursed. Correcting its payment
from RM5.50 to RM5.00 makes the expense **Partially paid**, with RM0.50 outstanding. Use
**Reimburse expenses** when that RM0.50 is paid later; it creates a separate payment for the
new transfer. The expense cost stays RM5.50.

An increase beyond the covered expenses remains available credit for the same recipient.
Previous allocations and the correction reason stay in History. The correction changes
historical bank and payable balances; it does not move money at the bank.

This action supports direct reimbursements. Older reimbursements with generated payable or
clearing entries, refunds and payments with dependent refund/offset allocations use their
existing correction flows. If another change happens while reviewing, reload and review again.

## Reverse an allocation

If a payment is on the wrong record, reverse the allocation. On the record page or the payment
page, click **Correct allocation** beside the allocation. Review the selected
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

## Correcting a reimbursement allocation

Choose **Correct allocation** beside an expense on the payment. Review the affected amounts,
remove or replace only the mistaken allocations, enter a reason, and confirm. The real bank payment
and its bank matches stay recorded. Removed allocations become available credit for that person;
the expense stays recorded under its original supplier and becomes outstanding again.

If the original expense itself was entered incorrectly, correct that separately after removing
its allocations. A new reimbursement does not need a whole-group reversal or replacement
helper entries merely to correct payment coverage.

Older reimbursements that contain linked transfer entries still use **Reverse entire reimbursement…**.
The preview shows every affected expense and credit before and after; their reversal history
remains visible. No replacement reimbursement is created automatically.

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
