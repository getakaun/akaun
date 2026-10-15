---
sidebar_position: 4
---

# Documents with many records

Some documents hold many records, for example a statement from a marketplace or an e-wallet.
Akaun reads each line as an item. You review the items of one document on its own page.

Akaun reads a document this way when you choose **Multiple records** under **Read as**. It also
reads a document this way when an import profile reads it. If the reading finds only one item,
Akaun shows it as one card. See [Review and confirm](./review-and-confirm.md) and
[Import receipts and documents](./import-receipts.md).

## The card on Auto Import

A document with many records shows as one card under **Ready to review**. The card shows:

- how Akaun read the document, and the number of items,
- the number of items that are ready, need attention, are confirmed and are skipped,
- the control total, if the document has one. See [Control total](#control-total).

Click the card to open the page of the document. **Skip** on the card skips each item that still
waits. Akaun asks you first, and you click **Skip** in the dialog. Items that are already
confirmed keep their records. **Skip** shows only when you have the **Confirm** permission.

## Confirm the items

1. On **Auto Import**, click the card of the document.
2. Check the items in the list. Click an item to open its card.
3. In the account field, choose the account for all items, for example **Bank**.
4. Click **Confirm all (12)**.

The name of the account field tells what the account does:

| Field | When it shows |
|---|---|
| **Paid from** | All items are expenses. |
| **Received into** | All items are income. |
| **Paid from or received into** | The document has expenses and income. |
| **Statement account** | The document has transfers. |

The account field shows **Choose one for every item** until you choose an account. Akaun saves
your choice immediately. If an account does not fit an item, the item keeps its own account, and a
note tells you why.

If you choose no account, each item stays on its account from the reading. Usually this is
**Accounts Payable** or **Accounts Receivable**, so the records are **Outstanding**. See
[Review and confirm](./review-and-confirm.md).

The number in **Confirm all (12)** is the number of items that are ready. The button confirms only
these items. A bar shows the progress. If Akaun leaves an item, a report shows the item and the
reason.

## Result

Each confirmed item becomes one record on the **Records** screen. The document file is attached to
each record. A confirmed item in the list links to its record.

At the end, the page shows the note "Every item is confirmed or skipped." The document then moves
to **This session** on **Auto Import**.

## Items that need attention

An item needs attention when Akaun cannot confirm it without your check. For example:

- it is a possible duplicate,
- it has a foreign currency and no rate,
- it has no account,
- the import profile marked it for review, with a note.

**Confirm all (12)** leaves these items. Open each item, correct it, and click **Confirm & import**.
For a possible duplicate, the button is **Import anyway**.

## Find items

Use the tabs above the list: **All**, **Ready**, **Needs attention**, **Possible duplicates**,
**Confirmed** and **Skipped**.

Two more filters show when they are useful:

- **Kind** shows when the document has more than one kind of record. Choose **Expense**,
  **Income** or **Transfer**.
- **Section** shows when the import profile has more than one section. Choose one section.

The list shows 50 items on each page.

## Change one item

1. Click the item in the list.
2. Correct the fields on its card.
3. Click **Confirm & import**, or click **Skip**.

Akaun saves each change on an item immediately. You do not lose it when you leave the page.

## Change many items

1. Select the check box of each item. Only the items that wait have a check box.
2. In the bar at the bottom, choose an action.

| Action | What it does |
|---|---|
| **Confirm** | Confirms the selected items that are ready. |
| **Skip** | Skips the selected items, after you click **Skip** in the dialog. |
| **Category** | Gives the selected items one category. |
| **Account** | Gives the selected items one account. |

## The side panel

### Source document

Click the file name to open the original document in a new tab. Akaun attaches this one file to
each record that it makes from the document.

### Control total

The control total is the total that the document prints, for example "Total payout released".
Akaun compares it with the total of the items that it read.

- **On the document** is the printed total.
- **Items as read** is the total of the items.

If the two are different, a line shows the difference. You can still confirm the items. A
difference usually shows that the reading missed a line, or read one line twice. Compare the items
with the document before you confirm.

Akaun checks the items as it read them. Your later changes and skips do not change the result.

### Ignored lines

A line such as **Ignored 3 lines** shows the number of lines that the reading left out, for
example subtotals. Click it to see the lines. For a long list, Akaun shows only the first lines.

### Running balance

This shows for a spreadsheet that an import profile read from its columns, with a balance column.
Akaun checks that each row's balance is the previous balance plus the row's amount. If the balance
does not follow, the panel names the row. A row can be missing from the export, or changed.

### Read again

**Read again** reads the file again in a different way. The new reading replaces each item that
waits and each skipped item. When an item is confirmed, you cannot read the document again. You
need the **Upload** and **Change** permissions on **Auto Import**.

## Discard the document

:::caution

You cannot undo this. The items that wait are removed. The records that Akaun already made stay,
and so does the file while a record uses it.

:::

1. In the side panel, under **Discard**, click **Delete**.
2. In the dialog, click **Delete**.

To discard a document, you need the **Delete** permission on **Auto Import**. The **Discard**
section shows only while items wait.

## Notes and limits

- One file is imported one way only. If a file already made records, Akaun does not read a second
  copy of it as many records.
- A document can have 1,000 items or fewer.

## Related

- [Review and confirm](./review-and-confirm.md)
- [Import spreadsheets](./spreadsheets.md)
- [Import profiles](./import-profiles.md)
