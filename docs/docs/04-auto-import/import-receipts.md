---
sidebar_position: 2
---

# Import receipts and documents

Use **Auto Import** to let AI read receipts, bills, invoices, statements and spreadsheets. Akaun
reads each file and prepares a record. You check each record before Akaun saves it.

:::info

To upload files, you need the **Upload** permission on **Auto Import**. To confirm or skip a record,
you need **Confirm**. To correct a record before you confirm it, you need **Change**. To read a
file again, you need both **Upload** and **Change**. See [Permissions explained](../09-administration/permissions-explained.md).

:::

Before you start, add an AI provider. See [Connect an AI provider](./connect-an-ai-provider.md).

## The files that Akaun reads

| File | Notes |
|---|---|
| PDF | A PDF with text, or a scanned PDF. Akaun reads a scanned PDF with text recognition (OCR). |
| JPG or PNG | A photo of a receipt or a bill. Akaun reads it with OCR. |
| Excel workbook (.xlsx) | See [Import spreadsheets](./spreadsheets.md). |
| CSV | See [Import spreadsheets](./spreadsheets.md). |

Each file can be 15 MB or smaller. OCR reads English and Simplified Chinese.

## Choose how Akaun reads the file

**Read as** is below the drop area. Choose it before you add the file.

| Choice | What Akaun does |
|---|---|
| **Auto-detect** | Akaun uses an enabled import profile that fits the document. If no profile fits, Akaun reads the document as one record. |
| **Single record** | Akaun reads the document as one receipt or one bill. It makes one record. |
| **Multiple records** | Akaun reads each item on the document as a separate record, for example each line of a statement. |
| The name of a profile | Akaun reads the document with this import profile. |

A profile that reads one type of file only shows it after its name, for example
"(spreadsheets only)". Akaun remembers your last choice on this computer or phone.

## Upload files

1. Click **Auto Import**.
2. In **Read as**, choose how Akaun reads the files.
3. Drag the files onto the area with the text **Drop files here, or browse**.

To choose the files from a folder, click the area, and then choose the files. You can add many
files at the same time. If Akaun refuses a file, the reason shows below the area. On a phone, you can also scan a page with the camera. See
[Scan with your phone](./scan-with-your-phone.md).

## Follow the queue

Each file goes into the **Processing queue**. The row of each file shows its type and its state:

| State | Meaning |
|---|---|
| **Queued** | The file waits for a free place. |
| **Extracting text…** | Akaun reads the text from the file. |
| **Reading with AI…** | The AI provider reads the text. |
| **Reading part 3 of 25…** | Akaun reads a long document in parts. The numbers show the progress. |

The heading of the queue shows the number of files that Akaun reads at this moment, for example
"2/3 workers active". The number after the slash is always 3. It does not show the
**Parallel tasks** setting.

## Result

When Akaun finishes a file, the file moves to one of these sections:

- **Ready to review**: Akaun made one record, or a document with many records. See
  [Review and confirm](./review-and-confirm.md) and
  [Documents with many records](./documents-with-many-records.md).
- **Failed**: Akaun could not read the file. The row shows the reason.

## If a file fails

A failed row has these buttons:

- **Retry**: uploads the same file again, with the same **Read as** choice. This button shows only
  in the browser tab where you uploaded the file, before a reload.
- **Read again**: reads the file again from the copy on the server. You can choose a different
  **Read as** choice. Then click **Read again** in the dialog. This button shows only when you
  have the **Upload** and **Change** permissions.
- **Discard**: removes the row from the list. You need the **Delete** permission on **Auto Import**.

A review card also has **Read again**. The new reading replaces the card and all your changes on
it. If Akaun cannot read the document again, the button is not available. Point to the button to
see the reason.

## This session

**This session** lists the documents that are confirmed, imported or skipped. Click the row of an
imported record to open the record. Click the row of a document with many records to open its
page. A skipped row does not open.

A row with "filed as Uncategorised" went to the default category for uncategorised items. Give it
a better category on its record page.

:::caution

**Clear history** removes the list for all users. You cannot undo it. The records that Akaun made
do not change.

:::

To clear the list:

1. Click **Clear history**.
2. In the dialog, click **Clear history**.

To clear the history, you need the **Delete** permission on **Auto Import**.

## Notes and limits

- All users see the same queue. Any user with the **Confirm** permission can confirm a document
  that a different user uploaded.
- If Akaun reads too little text, the file fails. Use a clearer photo, or a PDF with text.
- If you upload a file that Akaun already imported as one record, the card shows a possible
  duplicate. See [Review and confirm](./review-and-confirm.md).
- If Akaun reads a file as many records and that file already made records, the file fails. The row
  tells you how the file was imported before.
- If no AI provider is enabled, a file that needs AI fails. The row tells you to add a provider.
  See [Connect an AI provider](./connect-an-ai-provider.md).
- If an import profile reads all of a spreadsheet from its columns, Akaun does not use AI for it.
  See [Import spreadsheets](./spreadsheets.md).

## Related

- [Review and confirm](./review-and-confirm.md)
- [Import profiles](./import-profiles.md)
- [Attach receipts](../03-everyday-tasks/attach-receipts.md)
