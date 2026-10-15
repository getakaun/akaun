---
sidebar_position: 5
---

# Attach receipts and documents

Attach a receipt, a bill or a statement to a record as proof. You can attach files when you make
the record, or later on the page of the record. A record can have many attachments.

## Files that you can attach

- PDF, JPEG and PNG files only. Akaun checks the content of the file, not only its name.
- Each file can be 15 MB or smaller.

The server also has an upload limit. If that limit is lower than 15 MB, a large file does not
upload. Ask your administrator to check it. See
[Environment variables](../01-getting-started/install.md#environment-variables).

## Attach files to a new record

1. On the **New record** page, find the **Attachments** section on the right.
2. Click **Add**, or click **Drop files here or click to add**.
3. Choose one or more files.

   You can also drag the files from your computer into the **Attachments** section.

4. Complete the record.
5. Click **Save record**.

Akaun keeps the files in a list until you save. It uploads them only after it saves the record.
The list shows the name and the size of each file.

To remove a file before you save, click the **X** beside it.

If you click **Discard** on the save bar, Akaun also removes the files from the list.

## Attach files to a record that you saved

1. Open the record.
2. In the rail on the right, find the **Attachments** section.
3. Click **Add**.
4. Choose one or more files.

Akaun uploads each file immediately. You do not click a save button. You can also drag files into
the **Attachments** section.

## Open an attachment

1. Open the record.
2. In **Attachments**, click the name of the file.

The file opens in a new tab.

## Delete an attachment

:::caution

Akaun deletes the attachment when you click **X**. It does not ask you to confirm. To get the
file back, you must attach it again.

:::

1. Open the record.
2. In **Attachments**, click the **X** beside the file.

## Result

The **Attachments** section shows each file with its date. The **History** section of the record
shows each file that was added or deleted, and who did it. A new change shows there after you
reload the page.

## Notes and limits

- You can attach and delete files on a locked record. A receipt does not change the amounts. See
  [Locked records](../02-concepts/locked-records.md).
- To attach a file to a saved record, you need the **Change** permission on **Records**. The **Add**
  button shows also without this permission, but the upload fails with no message.
- To delete a file, you need the **Delete** permission on **Records**. Without it, the **X** is
  greyed out.
- If a file does not upload after you save a new record, Akaun saves the record without it. A
  message tells you how many files did not upload. Open the record and attach them again.
- On the page of a saved record, Akaun does not show a message when an upload fails. If the file
  is not in the list after the upload, check its type and its size.
- Akaun can read the text of some attached files. The search box on the **Records** screen then
  finds the record by that text. See [Find records](./find-records.md).
- To make a record from a receipt automatically, use **Auto Import**. See
  [Import receipts](../04-auto-import/import-receipts.md).

## Related

- [Record an expense or income](./record-expense-or-income.md)
- [Change, delete or undo a record](./edit-delete-undo.md)
