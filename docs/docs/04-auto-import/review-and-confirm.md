---
sidebar_position: 3
---

# Review and confirm

Akaun shows each record that it read as a card under **Ready to review**. Check the card, correct
it, and then confirm it. Akaun saves no record until you confirm.

:::info

To confirm or skip a card, you need the **Confirm** permission on **Auto Import**. You do not need
a permission on **Records**. Without **Confirm**, the buttons still show, but Akaun refuses the
action. To correct the fields of a card, you need the **Change** permission on **Auto Import**.

:::

## What a card shows

The title of the card is the name of the file. Click the title to open the original document in a
new tab. Below the title, a line tells if the AI read the document as an expense, an income or a
transfer.

| Field | What it holds |
|---|---|
| **Description** | A short text that tells what the record is for. |
| **Contact** | The supplier or the customer, as printed on the document. |
| **Amount** | The amount in the main currency. |
| **Currency** | The currency of the document. |
| **Source account** | Where the money came from. See the next section. |
| **Target account** | Where the money went. See the next section. |
| **Date** | The date of the document. |
| **Reference** | The number of the receipt or the bill. |
| **Remark** | Your own note. Akaun never completes it. |

When you change a field, the word **edited** shows beside its name. The bottom of the card can
show how many fields you changed. If you change nothing, it can show **Importing AI values as-is**.
A note about the accounts shows there in place of these texts.

## Source account and target account

The **Source account** decides if the record is an expense or an income.

| Record | **Source account** | **Target account** |
|---|---|---|
| Expense | A cash or bank account, a credit card, or **Accounts Payable**. The list shows them under **Payment**. | An expense category, or a thing that you buy and keep. |
| Income | An income category. The list shows them under **Income**. | A cash or bank account, or **Accounts Receivable**. |

If you choose an income category as the **Source account**, the card becomes an income. The
**Target account** list then shows only the accounts that fit.

### The record is outstanding at first

A document proves that an amount is owed. It does not prove that the money moved. So Akaun starts
each card as a record that is not paid yet:

- An expense starts with **Accounts Payable** as the **Source account**.
- An income starts with **Accounts Receivable** as the **Target account**.

An expense on **Accounts Payable** shows a note at the bottom of the card: "Recorded in accounts
payable to the contact above until it is paid." Akaun records a bill from the contact that is not
paid yet. It is a payable.

If you confirm without a change, the record is **Outstanding**. It is a payable to the contact on
the card, or a receivable from that contact. To pay a bill later, see
[Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md).

If the money already moved, choose the cash or bank account. For example, choose **Bank** as the
**Source account** of an expense. The record is then **Paid** when you confirm it.

An import profile can name the account of a document, for example a marketplace wallet. A card
from that profile starts on that account. See [Import profiles](./import-profiles.md).

### No category on the document

If the AI finds no category that fits, the **Target account** of an expense is the default for an
uncategorised expense. In a new book, this is **Other Expenses**. An income uses the default for
uncategorised income, which is **Other Revenue** in a new book. You can choose a better category
before you confirm.

## A transfer

A card that an import profile read as a transfer has **Transfer from** and **Transfer to** in
place of the two account fields. Both accounts hold money, for example a wallet and a bank account.
A transfer has no contact and no category.

A transfer must be in the main currency. If it is in a different currency, you cannot confirm it.
Record it by hand, or skip it.

## The contact

Akaun compares the name on the document with your contacts. A tag beside **Contact** shows the
result:

- **existing**: Akaun uses this contact.
- **new**: no contact has this name. Akaun adds the contact when you confirm. A new contact gets the
  role **Supplier** for an expense, or **Customer** for an income.

To use a different contact, choose it in the list. To use a new name, type the name.

## A foreign currency

If the document is in a foreign currency, the card shows two more fields. One is the amount in
that currency. The other is the rate, for example **Rate (1 USD = ? MYR)**. Akaun tries to find the rate for
the date of the document. **Amount** then shows the amount in the main currency.

If Akaun finds no rate, the card shows "Enter the rate manually to convert to MYR." Type the rate.
You cannot confirm the card until it has a rate. See [Foreign currency](../02-concepts/foreign-currency.md).

## A possible duplicate

Akaun compares each card with the records that are already in the book. If they look the same, the
card shows a **Duplicate** tag. The tag shows a score and the reasons, for example
"Duplicate · 85% · reference · amount".

Akaun looks at these signs:

- The file is the same file as one that Akaun imported before.
- The reference is the same.
- The amount is the same, or almost the same.
- The date is the same, or near.
- The contact has the same name, or a similar name.
- The file name is similar.
- The text of the document is similar.

For a transfer, Akaun looks for a record with the same amount, between the same two accounts, in
the same direction, within seven days.

The confirm button of a possible duplicate is **Import anyway**. The card does not link to the
existing record. Find the record on the **Records** screen and compare it first. If the card is a
second copy, click **Skip**.

## Confirm one card

1. Check each field on the card.
2. Make sure that the **Source account** and the **Target account** are correct.
3. If the document is in a foreign currency, make sure that the rate has a value.
4. Click **Confirm & import**.

If a rule stops the record, the bottom of the card shows the reason. Akaun saves nothing.

To make no record from the card, click **Skip**. The card moves to **This session** as skipped.

## Confirm many cards

1. Check each card on the list.
2. Click **Confirm all (3)** at the top of **Ready to review**.

The button confirms each card that is not a possible duplicate and has both accounts. It leaves a
card in a foreign currency that has no rate. Confirm those cards one at a time.

## Result

The card moves to **This session**. It shows **Importing…**, and then a check mark. Click the row
to open the new record.

The record shows on the **Records** screen. Its kind is **Expense**, **Income** or **Transfer**.
The original document is attached to the record. See [Records](../02-concepts/records.md).

## Notes and limits

- Your changes on a card stay in this browser tab only. If you reload the page before you confirm,
  the changes are lost.
- If a different user reads the document again while you review it, Akaun refuses your confirm.
  Check the new card and confirm again.
- A document with many records opens on its own page. See
  [Documents with many records](./documents-with-many-records.md).

## Related

- [Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md)
- [Contacts](../06-contacts.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)

## Importing revenue into contra revenue

For an income card, select an ordinary Revenue source and a target under **Contra revenue**.
The target must have the **Contra operating revenue** or **Contra other revenue** sub-type.
You can also apply a contra target to income items with the group's bulk account action.

For example, importing RM100 from Sales to Sales discounts credits Sales RM100 and debits Sales
discounts RM100. This increases gross revenue and its deduction equally, leaving total net
revenue unchanged. A cash refund requires a different entry involving cash or receivables.

Contra accounts are review targets; they are excluded from ordinary income sources and AI
income-category suggestions. Saved profiles continue to select money accounts.
