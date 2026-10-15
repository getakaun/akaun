---
sidebar_position: 3
---

# Getting paid

When you mark an invoice as sent, the customer owes the amount. This page tells how to record the
payment from the customer, what **Paid** means for an invoice, and where you see the amount that
customers still owe.

Read [Owed, part paid and paid](../02-concepts/owed-and-paid.md) first. It tells what
**Outstanding**, **Part paid** and **Paid** mean.

:::info

To record a payment, you need the **Add** permission on records and the **View** permission on
invoices.

:::

## Record a payment from an invoice

Record the payment from the invoice that it pays. **Record payment** shows on a sent invoice that
is not fully paid.

1. Open the invoice.
2. Click **Record payment**.

   The **Record a receipt** page opens. **Who paid you?** shows the customer of the invoice. In
   **Allocation**, the invoice is ticked, with its outstanding amount. **Amount** shows the same
   amount.

3. If the customer paid only part of the invoice, type the amount that they paid in the box beside
   the invoice.
4. In **Description**, type a description, for example "Payment for IV20261009-001".
5. In **Date**, choose the date of the payment.
6. In **Receipt account**, choose the account that got the money, for example the bank account.

   If you have only one money account, **Receipt account** does not show. Akaun uses that account.

7. Optional: in **Reference**, type a reference, for example the number of the bank transfer.
8. In the bar at the bottom of the page, click **Save**.

Akaun saves a **Payment** record and opens the invoice again. The **Payments** card shows the
payment. The **Settled** card shows the new **Paid so far** and **Outstanding** amounts. The
status of the invoice changes to **Part paid** or **Paid**.

The amount of a payment is always in the main currency. For an invoice in a foreign currency, see
[An invoice in a foreign currency](./invoices.md#an-invoice-in-a-foreign-currency).

If the customer paid more than the invoice, the extra amount stays on the payment. It is not put
against any record.

## What Paid means for an invoice

A sent invoice puts its amount on **Accounts Receivable**, with the customer as the contact. A
payment from the customer settles this amount, in full or in part.

Akaun calculates the status from the payments. You cannot mark an invoice as paid.

| Status on the Invoices list | What it shows |
|---|---|
| **Sent** | No payment covers the invoice yet. |
| **Part paid** | Payments cover some of the amount, but not all of it. |
| **Paid** | Payments cover the full amount. |
| **Overdue** | The due date is in the past and payments do not cover the full amount. |

## See what customers owe you

You can see the amount that is still owed in these places.

### The invoice page

After you mark the invoice as sent, the **Settled** card in the rail shows **Paid so far** and
**Outstanding**. If a payment settles part or all of the invoice, the **Payments** card shows it.

### The Invoices screen

The **Sent** tab shows the sent invoices that are not fully paid. The **Sent** card shows the
amount that is still owed on them. The **Overdue** card shows the amount that is overdue.

### The Contacts screen

The **Balance** column shows **owed to you** beside each contact that owes you money. Under the
title, **owed to you** shows the total. You see these amounts only if you have the **View**
permission on records.

### The contact page

The amount at the top shows **still owed to you**. This amount also needs the **View**
permission on records.

### The Records screen

The **Outstanding** tab and the **Part paid** tab show each **Invoice** record that is not fully
paid.

See [Contacts and their balances](../02-concepts/contacts-and-balances.md) and
[Find records](../03-everyday-tasks/find-records.md).

## Do not record the payment as an income

:::caution

Do not save a new income for money that pays an invoice. The invoice already counts the sale. A
second income counts the sale two times, and the invoice stays outstanding.

:::

## Notes and limits

- The **Records** screen has no link to record a payment from a customer. Start from the invoice.
- The **Outstanding payables** panel on the **Records** screen shows only what the business owes.
  It does not show what customers owe.
- To remove a payment from an invoice, open the payment from the **Payments** card. Then click
  **Take this back** beside the allocation. See
  [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md).
- A paid invoice prints with **Amount paid** and the date of the last payment. See
  [Invoices](./invoices.md#print-an-invoice).
- If you change the **Accounts receivable** default account in **Settings**, a payment cannot
  settle an invoice that you sent before the change.

## Related

- [Invoices](./invoices.md)
- [Owed, part paid and paid](../02-concepts/owed-and-paid.md)
- [Contacts and their balances](../02-concepts/contacts-and-balances.md)
- [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md)
