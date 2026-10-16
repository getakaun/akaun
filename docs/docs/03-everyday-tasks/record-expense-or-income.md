---
sidebar_position: 1
---

# Record an expense or income

Use this page to record money that the business spends or earns. You use the same form for both.
You do not choose the kind of record. Akaun finds the kind from the two accounts that you choose.

To learn how a record moves money, read [How a record moves money](../02-concepts/how-an-entry-works.md).

:::info

To make a record, you need the **Add** permission on **Records**. Without it, the **Records**
screen does not show **New record**. See
[Permissions explained](../09-administration/permissions-explained.md).

:::

## The record form

The **New record** page has three sections:

| Section | What you type in it |
|---|---|
| **Transaction details** | **Description**, **Amount** and **Date**. The **Amount** label also shows the symbol of your main currency. |
| **Journal entry** | Two lines. The **Credit** line is the account that the money came out of. The **Debit** line is the account that the money went into. |
| **Details** | **Contact**, **Reference** and **Remark**. These fields are optional. |

The **Attachments** section is on the right side of the page. On a narrow screen, it is below the form.

When the page opens, Akaun puts an account on each line. The **Credit** line gets your default
payment account. The **Debit** line gets the first different account in its list. This account is
often a cash or bank account, not a category. Always check both lines before you save.

## Record an expense

This example records 50.00 that you pay from **Bank** for software.

1. On the **Records** screen, click **New record**.
2. In **Description**, type what you bought, for example "Accounting software, March".
3. In **Amount**, type `50.00`.
4. In **Date**, choose the date of the payment.
5. On the **Credit** line, choose **Bank**.
6. On the **Debit** line, choose the expense category **Software**.
7. Optional: in **Contact**, choose the supplier.
8. Optional: in **Reference**, type the number of the receipt or the bill.
9. Optional: in **Remark**, type a note.
10. Optional: add the receipt. See [Attach receipts and documents](./attach-receipts.md).
11. Click **Save record**.

## Record an income

This example records 200.00 that a customer pays you in cash.

1. On the **Records** screen, click **New record**.
2. In **Description**, type what you sold, for example "Order 1042".
3. In **Amount**, type `200.00`.
4. In **Date**, choose the date when you got the money.
5. On the **Credit** line, choose the income category **Product Sales**.
6. On the **Debit** line, choose **Cash**.
7. Optional: in **Contact**, choose the customer.
8. Click **Save record**.

For an income, the income category is the credit. The income category is the place that
the money came from.

## Result

Akaun saves the record and opens its page. The top of the page shows the kind, the date, the
amount and the status. A record that moves money directly from a cash or bank account shows **Paid**.

The record is also on the **Records** screen. The **Kind** column shows **Expense** or
**Income**.

## Choose a contact

The **Contact** field searches your contacts while you type. It shows only contacts with the
role that fits the record:

- For an expense, it shows contacts with the role **Supplier**.
- For an income, it shows contacts with the role **Customer**.

If the contact is not in the list, click **Create "…"**. The button shows the name that you
typed, for example **Create "Kedai Ali"**. Akaun makes the new contact when you save the record.
The new contact gets the role that the list uses.

If a contact does not have that role, it is not in the list. Add the role on the contact page
first. If you click **Create "…"** for that name, Akaun makes a second contact.

To make a new contact here, you need the **Add** permission on **Contacts**.

If you have no contacts yet, the **Contact** field does not show. See [Contacts](../06-contacts.md).

## Use a foreign currency

The **+ Foreign currency** button shows on an expense or an income.

1. Click **+ Foreign currency**.
2. In **Currency**, choose the currency.
3. In the second **Amount** field, type the amount in that currency.
4. Check the **Rate** field. Akaun finds the rate for the date of the record.
5. If Akaun finds no rate, type the rate.

The first **Amount** field then shows the amount in your main currency. See
[Foreign currency](../02-concepts/foreign-currency.md).

## The default payment account

The default payment account is the account that the **Credit** line gets on a new record. You
choose it in **Settings**, on the **Ledger** tab, in **Default transaction account**. The
**General** tab also shows **Default payment account**, but at this time a change there is not kept. See [Settings reference](../09-administration/settings-reference.md).

## Notes and limits

- If the save bar shows a message in place of **Unsaved changes**, the record cannot be saved
  yet. Read the message and correct the form.
- If Akaun cannot save the record, a red message shows at the top of the page. It tells you what
  to change.
- The two lines must use two different accounts.
- Without the **Adjustments** permission, each line offers cash or bank accounts and categories only.
  You cannot choose **Accounts Payable**, a loan account or a **Credit card** account on a new record. To pay
  a bill later, see [Bills you pay later](./bills-you-pay-later.md).
- To put one amount on more than one category, see
  [Split a record across categories](./split-across-categories.md).
- To move money between two of your own accounts, see
  [Move money between your accounts](./move-money-between-accounts.md).

## Related

- [Records](../02-concepts/records.md)
- [How a record moves money](../02-concepts/how-an-entry-works.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)
- [Change, delete or undo a record](./edit-delete-undo.md)
