---
sidebar_position: 3
---

# How a record moves money

Each record moves an amount out of one account and into a different account. This page tells how
the record form shows this, and why it keeps each balance correct.

## Two lines: a debit and a credit

Each record has two lines. On the record form, the **Journal entry** section shows a **Debit**
line and a **Credit** line. You choose one account for each line. The amount of the record goes
out of the credit account and into the debit account.

- **Debit**: value goes into this account.
- **Credit**: value goes out of this account.

For example, you buy printer paper for 50.00 with cash:

| Line | Account | Amount |
|---|---|---|
| **Debit** | An expense category, for example Office supplies | 50.00 |
| **Credit** | **Cash** | 50.00 |

The balance of **Cash** goes down by 50.00. The total of the expense category goes up by 50.00.

Income works in the same way, but in the other direction. A customer pays you 200.00 into the
bank. The debit is **Bank**. The credit is **Product Sales**. The income category is the place
that the money came from.

A transfer also has two lines. You move 100.00 from **Bank** to **Cash**. The debit is **Cash**.
The credit is **Bank**.

## More than two lines

Sometimes one amount goes to more than one place. For example, one supplier bill of 80.00 is for
fuel and for paper. Click **+ Add a line** to add a line for each category. The form shows
**+ Add a line** only on an expense or an income, unless you have the **Adjustments** permission.

On an expense or an income, each extra line is a category of the same kind. You type the amount
of each category. Without the **Adjustments** permission, you can add only this type of line.
Akaun keeps one record with all the lines. It is still an **Expense** or an **Income**. See
[Split across categories](../03-everyday-tasks/split-across-categories.md).

## Debits must equal credits

The total of the debits must be equal to the total of the credits. With two lines, this is always
true, because both lines use the amount of the record.

With more lines, the form shows the difference while you type. At the top of the **Journal entry**
section, a label shows **Balanced** when the debits and the credits are equal. If they are not equal, it shows the
difference, for example **5.00 apart**. Then the save bar shows the reason, and Akaun does not
save the record.

## Why this keeps each balance correct

Each record adds the same amount to the debit side as it takes from the credit side. Thus the money in
the book is always complete. Money cannot appear from nowhere, and it cannot disappear.

Akaun calculates the balance of each account from its records. You cannot type a balance. If you
change or delete a record, each balance that the record touches changes with it. Thus two screens
cannot show two different balances for one account.

## Records that need the Adjustments permission

Most records match an everyday kind: an expense, an income, a transfer, a payment or an opening
balance. Some records do not match one of these kinds. Examples:

- A record between two accounts that do not fit together as an everyday kind. For example, you
  receive a loan of 1,000.00 into the bank. The debit is **Bank**. The credit is **Loans**.
- A record with extra lines that are not an everyday split. For example, the lines include two
  cash or bank accounts, or an expense category and an income category.

Akaun saves such a record as a **Journal entry**. To save a journal entry, you must have the
**Adjustments** permission.

:::info

A journal entry needs the **Adjustments** permission. No group that Akaun creates gives this
permission. A user with it can save a record between any two accounts. The record form then shows
all accounts on each line. See [Permissions explained](../09-administration/permissions-explained.md).

:::

:::info For accountants

Akaun is a double-entry system. The record form labels each line **Debit** or **Credit**.

The lines of each record add up to zero. Akaun keeps each amount as a signed number: a debit is
positive and a credit is negative.

In the reports, Akaun shows each balance with its natural sign. Thus Liability, Equity and
Revenue balances show as positive numbers. On the **Accounts** screen and on each account page,
Akaun shows the stored sign. There, a credit balance shows with a minus sign.

:::

## Related

- [Record an expense or income](../03-everyday-tasks/record-expense-or-income.md)
- [Split across categories](../03-everyday-tasks/split-across-categories.md)
- [Move money between accounts](../03-everyday-tasks/move-money-between-accounts.md)
- [Edit, delete or undo a record](../03-everyday-tasks/edit-delete-undo.md)
- [Permissions explained](../09-administration/permissions-explained.md)
