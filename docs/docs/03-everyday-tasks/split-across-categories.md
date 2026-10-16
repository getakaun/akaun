---
sidebar_position: 2
---

# Split a record across categories

Use a split when one amount is for more than one category. For example, one supplier bill of
80.00 is for packaging and for shipping. You make one record with one line for each category.

Read [How a record moves money](../02-concepts/how-an-entry-works.md) first if lines are new to
you.

## Which splits you can save

Without the **Adjustments** permission, you can save these splits:

- An expense: one cash or bank account, and two or more expense categories.
- An income: one income category or more, and one cash or bank account.

Akaun keeps such a record as an **Expense** or an **Income**.

You need the **Adjustments** permission for all other splits. Examples:

- The lines include two cash or bank accounts.
- The lines include an expense category and an income category.

Akaun saves such a record as a **Journal entry**. See
[Permissions explained](../09-administration/permissions-explained.md).

:::info

Without the **Adjustments** permission, the form offers only the lines that you can save. A new
line on an expense offers expense categories. A new line on an income offers income categories.
The list does not show a category that the record already uses.

:::

## Split an expense

This example records a bill of 80.00 from **Bank**: 50.00 for **Packaging** and 30.00 for
**Shipping**.

1. On the **Records** screen, click **New record**.
2. In **Description**, type a description of the bill.
3. In **Amount**, type the full amount, `80.00`.
4. In **Date**, choose the date of the bill.
5. On the **Credit** line, choose **Bank**.
6. On the **Debit** line, choose **Packaging**.
7. In **Journal entry**, click **+ Add a line**.
8. On the **Debit** line for **Packaging**, change the amount from `80.00` to `50.00`.
9. On the new line, click **Choose an account**.
10. Choose **Shipping**.
11. In the amount box of the new line, type `30.00`.
12. Make sure that the top of **Journal entry** shows **Balanced**.
13. Click **Save record**.

:::tip

If part of the amount is not on a line yet, a small arrow button shows in the amount box of the
last line. Its tooltip gives the amount, for example **Use the remaining 30.00**. Click it to put
that amount on the line.

:::

## How the form shows the difference

The top of **Journal entry** shows the state of the lines:

- **Balanced** shows that the debits are equal to the credits.
- A figure with **apart**, for example **5.00 apart**, shows the difference.

The bottom of **Journal entry** also shows the difference as a number. While the debits and the
credits are not equal, the save bar tells you why the record cannot be saved. For example:
"Debits and credits do not balance. Difference: 5.00."

## Give a line its own label

When a record has more than two lines, each category line has a box below it:
**Label (optional) — defaults to the description**. Type a label to describe that part of the
bill, for example "Boxes". If you leave it empty, the line uses the description of the record.

## Remove a line

1. Click the **X** at the end of the line.

When you remove the last extra line, the record has two lines again. The category line then
gets the full amount of the record again.

## Result

Akaun saves one record. The **Kind** column on the **Records** screen shows **Expense** or
**Income**. The **Accounts** column shows the number of lines, for example **3 sides**. The
**Category** filter finds the record under each of its categories.

## Notes and limits

- Without the **Adjustments** permission, **+ Add a line** shows only when one line is an expense
  category or an income category. With the **Adjustments** permission, it shows on all records.
- Each line must have an account and an amount that is not zero. If not, the save bar shows
  "Pick an account for every side." or "A side of a record cannot be worth nothing."
- The money line always has the full amount of the record. You do not type its amount.
- On a locked expense or income, you can still change the categories and the split. See
  [Locked records](../02-concepts/locked-records.md).

## Related

- [Record an expense or income](./record-expense-or-income.md)
- [How a record moves money](../02-concepts/how-an-entry-works.md)
- [Change, delete or undo a record](./edit-delete-undo.md)
