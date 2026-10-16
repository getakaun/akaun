---
sidebar_position: 6
---

# Find records

The **Records** screen shows the records of all kinds in one list. See
[Records](../02-concepts/records.md) for the kinds. This page tells how to find one record, or a
group of records, in the list.

## What the Records screen shows

Under the title, the screen shows the number of records. Below it, four cards show totals:

| Card | What it shows |
|---|---|
| **Income** | The total and the number of records with an income category. |
| **Expenses** | The total and the number of records with an expense category or equipment. |
| **Outstanding** | The amount that is still outstanding, and the number of records that are not fully settled. |
| **All records** | The number of records. When a tab, a filter or a search is active, the card shows **Records shown**. |

The cards always count the records that the list shows. When you use a filter, the cards change.

The list has these columns: **Item**, **Kind**, **Accounts**, **Status**, **Date** and **Amount**.

- **Item** shows the description and the record number. A lock icon shows beside a locked record.
  Put the pointer on the icon to see the reason. See [Locked records](../02-concepts/locked-records.md).
- **Kind** shows the kind and the contact.
- **Accounts** shows the credit account (the money came out of it) and the debit account (the
  money went into it). A record with more than two lines shows the number of lines, for example
  **3 lines**.
- **Status** shows **Outstanding**, **Partially paid** or **Paid**. **Unreconciled** shows when bank
  statement lines do not yet match the full amount of the record.
- **Amount** shows an income with a plus sign (+). A foreign amount also shows in its own currency.

## Use the status tabs

Above the list, click a tab to show the records with one status:

- **All**
- **Outstanding**
- **Partially paid**
- **Paid**

Each tab shows the number of records that it contains. See
[Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md).

## Search

1. Click the search box. It shows **Search description, contact, ref…**.
2. Type a word or a number.

The search finds text in the description, the contact, the reference, the remark, the record
number and the account names. It also finds text in attached files when Akaun can read them.

On a phone, click the search icon first.

## Filter the list

The filters are above the list. You can use more than one filter at the same time.

| Filter | What it does |
|---|---|
| **Unreconciled** | Shows only the records that show **Unreconciled**. Click it again to remove the filter. |
| **Kind** | Shows one or more kinds, for example **Expense** and **Transfer**. |
| **Contact** | Shows the records of one contact. |
| **Account** | Shows the records that use one account. See [See the statement of one account](#see-the-statement-of-one-account). |
| **Category** | Shows the records that use one or more categories. A split record shows under each of its categories. |
| **Date** | Shows the records from one date (**From**) to a different date (**To**). |
| **Amount** | Shows the records between a smallest amount (**Min**) and a largest amount (**Max**). |

To remove one filter, open it and click **Clear**. To remove all filters, the search and the tab,
click **Clear** beside the filters. This button shows only when a filter or a search is active.

Below the filters, the screen shows **Showing** with the number of records, and the
**Filtered total**.

On a phone, click **Filters**, choose the filters, and then click **Show results**. The phone
panel has the **Category**, **Date range** and **Amount range** filters only.

## Sort the list

Click a column title to sort the list by that column: **Item**, **Kind**, **Status**, **Date** or
**Amount**. Click the title again to change the order.

By default, the list shows the newest records first.

## See the statement of one account

When you filter by one account, the screen shows the statement of that account. The statement
shows each transaction in date order, with a running balance.

1. On the **Records** screen, click **Account**.
2. Choose the account, for example **Bank**.
3. Optional: click **Date** and choose a date range.

The statement shows:

- **Opening balance**: the balance before the first row.
- A table with **Date**, **Description**, **Amount** and **Balance**. **Balance** is the running
  balance after each row.
- **Closing balance**: the balance after the last row.

You can also open the statement from the page of an account. In the **Account ledger** card, click
**View account ledger**.

The statement shows only with the **Account** filter and an optional date range. If you add a
different filter, a search or a tab, the screen shows the normal list. If you sort by a column
that is not **Date**, the running balance does not show. The screen then tells you to sort by date
and clear the other filters.

The running balance disappears for a reason. A balance of only some records looks like the real
balance of the account, but it is not.

## Export a statement to CSV

1. Show the statement of one account. See [See the statement of one account](#see-the-statement-of-one-account).
2. Optional: choose a date range with **Date**.
3. Click **Export CSV**.

Your browser downloads a CSV file of the statement.

:::info

**Export CSV** is available only on the statement of one account. You cannot export the full list
of records.

:::

## Share a record or a list

Each record has its own address. To share a record, open it and copy the address from your
browser. A different user can open the address if they have the **View** permission on
**Records**.

The address of the **Records** screen also keeps the filters, the search and the tab. Copy it to
share a filtered list.

:::tip

To open a record in a new browser tab, hold Ctrl (Cmd on a Mac) and click its description.

:::

## Notes and limits

- The screen loads the newest 1,000 records. If there are more, the bottom of the list says so,
  for example "Showing the 1000 most recent of 1250". Use the search to find an older record.
- Paid and reconciled are different. A record can show **Paid** and **Unreconciled** at the same
  time.
  See [Bank reconciliation](../07-bank-reconciliation.md).

## Related

- [Records](../02-concepts/records.md)
- [Outstanding, partially paid and paid](../02-concepts/owed-and-paid.md)
- [Change, delete or undo a record](./edit-delete-undo.md)
