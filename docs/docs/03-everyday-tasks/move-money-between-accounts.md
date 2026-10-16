---
sidebar_position: 4
---

# Move money between your accounts

Use a transfer when money moves between two of your own cash or bank accounts. For example, you take
100.00 out of the bank as cash. A transfer is not an expense or an income. It does not change the
profit of the business.

You use the same **New record** form as for an expense. Akaun saves the record as a **Transfer**
when both lines are cash or bank accounts. You do not need the **Adjustments** permission.

## Record a transfer

This example moves 100.00 from **Bank** to **Cash**.

1. On the **Records** screen, click **New record**.
2. In **Description**, type a description, for example "Cash withdrawal".
3. In **Amount**, type `100.00`.
4. In **Date**, choose the date of the transfer.
5. On the **Credit** line, choose **Bank**.
6. On the **Debit** line, choose **Cash**.
7. Click **Save record**.

## Result

Akaun saves the record and opens its page. The top of the page shows **Transfer**. The balance of
**Bank** goes down by 100.00. The balance of **Cash** goes up by 100.00.

A transfer has no status on its page. Nobody owes money for a transfer.

On the **Records** screen, the **Kind** column shows **Transfer**. The **Accounts** column shows
**Bank**, an arrow, and **Cash**. A transfer does not count in the **Income** card or the
**Expenses** card.

## Other examples

- You move money from a marketplace account into the bank: credit **Marketplace Clearing**, debit
  **Bank**.
- You put cash into the bank: credit **Cash**, debit **Bank**.

## Notes and limits

- The two lines must use two different accounts.
- A transfer is always in the main currency. The **+ Foreign currency** button does not show on a
  transfer.
- A transfer has two lines only. Without the **Adjustments** permission, **+ Add a line** does not
  show. With it, a record with a third line saves as a **Journal entry**, not a transfer.
- **Accounts Payable**, **Loans** and an account with the sub-type **Credit card** are not
  cash or bank accounts. Without the **Adjustments** permission, the form does not offer these accounts.
- Equipment is an asset, but it is not a cash or bank account. Money out of **Bank** into equipment
  is an **Expense**, not a transfer. See
  [Accounts and categories](../02-concepts/accounts-and-categories.md).
- To match a transfer to a bank statement, see [Bank reconciliation](../07-bank-reconciliation.md).

## Related

- [Record an expense or income](./record-expense-or-income.md)
- [How a record moves money](../02-concepts/how-an-entry-works.md)
- [Records](../02-concepts/records.md)
