---
sidebar_position: 3
---

# Bills you pay later

A bill that you pay later is a payable: an expense that the business owes. Akaun keeps it on
**Accounts Payable** until a payment settles it. This page tells how such a bill gets into Akaun
and how you pay it.

Read [Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md) first. It tells what
**Outstanding**, **Partially paid** and **Paid** mean.

## How a bill to pay later gets into Akaun

At this time, **Auto Import** is the way to record a bill that you pay later.

When Auto Import reads a receipt or a bill, it prepares an expense. The **Source account** of the
expense is **Accounts Payable** by default. The item also names the supplier as its contact. When
you confirm the item, Akaun saves an expense that is **Outstanding**.

1. Import the bill. See [Import receipts](../04-auto-import/import-receipts.md).
2. On the review card, make sure that **Source account** shows **Accounts Payable**.
3. Make sure that the contact is the supplier that you owe.
4. Confirm the item. See [Review and confirm](../04-auto-import/review-and-confirm.md).

If you change **Source account** to a cash or bank account, for example **Bank**, the expense is
**Paid** when you save it.

:::info

The **New record** form does not offer **Accounts Payable** to a user without the
**Adjustments** permission. Thus you cannot record a bill to pay later by hand. Use Auto Import.

:::

## See the payables

When the business has payables, the **Records** screen shows the
**Outstanding payables** panel above the list. It shows the number of contacts and the total.

1. On the **Records** screen, find the **Outstanding payables** panel.
2. Click **View details**.

A panel opens with one group for each contact. Each group shows the total and each bill that is
outstanding. Click a bill to open its page.

You can also click the **Outstanding** tab or the **Partially paid** tab on the **Records** screen.

## Pay the bills of one contact

1. On the **Records** screen, in the **Outstanding payables** panel, click **View details**.
2. Find the group of the contact.
3. Click **Record a payment**.

   The **Record a payment** page opens. **Who** shows **One contact**, and
   **Payee** shows the contact.

4. In **Description**, type a description, for example "Payment to supplier, March".
5. In **Date**, choose the date of the payment.
6. In **Payment account**, choose the account that the money came out of.
7. In **Allocation**, select the check box of each bill that this payment pays.

   Akaun puts the full outstanding amount of each bill in its amount box.

8. If the payment pays only part of a bill, change the amount in its box.
9. Check **Amount**. Akaun adds the ticked amounts for you.
10. Optional: in **Details**, type a **Reference** and a **Remark**.
11. Click **Save**.

If **Amount** is more than the ticked amounts, the **Allocation** section shows the part that is
not put against a bill.

## Pay the bills of many contacts at once

Use this when one bank transfer pays bills of more than one contact.

1. On the **Records** screen, in the **Outstanding payables** panel, click **Pay all payables**.

   **Who** shows **Batch (several contacts)**. **Allocation** shows each outstanding bill of each
   contact, and all of them are selected.

2. In **Allocation**, clear the check box of each bill that you do not pay now.
3. If you pay only part of a bill, change the amount in its box.
4. In **Description**, type a description.
5. In **Date**, choose the date of the payment.
6. In **Payment account**, choose the account that the money came out of.
7. Click **Save**.

:::tip

**Select all** and **Select none** at the top of **Allocation** select or clear all bills at once.

:::

With **Batch (several contacts)**, you cannot type **Amount**. It is always the total of the selected
bills.

## Result

Akaun saves a **Payment** record and opens its page. The rail of the payment shows
**Allocated to**: each bill that the payment pays, and the amount for each bill.

Each bill changes its status:

- **Paid** if the payment covers the full amount.
- **Partially paid** if the payment covers only part of it. The bill page shows the amount that is
  still outstanding.

The page of each bill shows **Payments applied** in its rail. The bill is now locked. See
[Locked records](../02-concepts/locked-records.md).

## Notes and limits

- **Pay all payables** shows only when the business owes money to more than one contact.
- The **Outstanding payables** panel shows only the payables. It does not show the receivables
  (the money that customers owe to the business).
- To pay a bill, you need the **Add** permission on **Records**.
- If you have only one cash or bank account, **Payment account** does not show. Akaun uses that account.
- To remove a payment from a bill, see [Change, delete or undo a record](./edit-delete-undo.md).
- To record money that a customer pays you, see [Getting paid](../05-sales/getting-paid.md).

## Related

- [Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md)
- [Contacts and their balances](../02-concepts/contacts-and-balances.md)
- [Review and confirm](../04-auto-import/review-and-confirm.md)
- [Locked records](../02-concepts/locked-records.md)
