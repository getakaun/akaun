---
sidebar_position: 5
---

# Partners' Equity

**Partners' Equity** tells you what each partner has in the business for a period. It shows what
each partner contributed, their share of the profit and what they withdrew.

:::info

You need the **View** permission on **Reports**. Reports are view only. See
[Permissions explained](../09-administration/permissions-explained.md).

:::

## Before you start

The **Partners' Equity** tab shows only when at least one contact has the **Partner** role. To give
a contact this role, open the contact, select **Partner** under **Roles** and save the contact. See
[Contacts](../06-contacts.md).

## Open the report

1. Click **Reports**.
2. Click the **Partners' Equity** tab.
3. In **From**, choose the first day of the period.
4. In **To**, choose the last day of the period.

At the start, the period is from 1 January of this year to today. If **From** is after **To**,
Akaun uses the **To** date for both.

## What the report shows

The report has one row for each partner, in the order of their names. It has these columns:

- **Partner**: the name of the contact.
- **Contributions**: the money that the partner put into the business in the period.
- **Share of profit**: the part of the **Net profit** of the period for this partner.
- **Drawings**: the money that the partner withdrew from the business in the period.
- **Closing balance**: **Contributions** plus **Share of profit** minus **Drawings**.

If there are two or more partners, the last row is **All partners**. It gives the total of each
column. A partner with no records in the period still has a row.

On a phone, each partner shows as a small block with the same figures.

## How Akaun calculates the share of profit

Akaun takes the **Net profit** of the same period from [Profit & Loss](./profit-and-loss.md). It
divides it equally between all partners. Akaun cannot record a different share for each partner.
A note below the report tells you this.

If the business made a loss, each partner gets an equal part of the loss. The **Share of profit**
is then a negative number.

## Contributions and drawings

**Contributions** and **Drawings** come from Equity accounts that belong to one partner. Money that a
partner gives to the business is a contribution. Money that a partner takes from it is a drawing.

At this time, Akaun has no control that connects an Equity account to a partner. The **Partner**
role does not make these accounts. Thus, in a new book, **Contributions** and **Drawings** show 0.00.
A book from an earlier version of Akaun can still have such accounts.

## Signs

Contributions and a profit show as positive numbers. **Drawings** is also
a positive number, and Akaun subtracts it.

## Example

Two partners, Aina and Ben, share a business. In the year, the business made a net profit of
10,000.00.

| Partner | Contributions | Share of profit | Drawings | Closing balance |
|---|---|---|---|---|
| Aina | 0.00 | 5,000.00 | 0.00 | 5,000.00 |
| Ben | 0.00 | 5,000.00 | 0.00 | 5,000.00 |
| **All partners** | 0.00 | 10,000.00 | 0.00 | 10,000.00 |

Each partner gets half of the profit, because Akaun divides it equally.

## Export the report

1. Click **Export**.

Akaun downloads a CSV file, for example `partners-equity-2026-01-01-to-2026-12-31.csv`. The file has the columns "Partner", "Contributions", "Share of profit",
"Drawings" and "Closing balance". It has one row for each partner. It has no "All partners" row.
Below the table, the file gives the period and the notes of the report.

## Notes

- You cannot print a report at this time. Use **Export** and print the CSV file.
- **Closing balance** covers only the period of the report. It does not include earlier periods.
- You cannot click a row on this report.
- If you remove the **Partner** role from all contacts, the tab does not show.

## Related

- [Profit & Loss](./profit-and-loss.md)
- [Balance Sheet](./balance-sheet.md)
- [Contacts](../06-contacts.md)
- [Accounts and categories](../02-concepts/accounts-and-categories.md)
