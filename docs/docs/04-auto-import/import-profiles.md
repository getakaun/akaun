---
sidebar_position: 7
---

# Import profiles

An import profile is a saved way to read one kind of document, for example the monthly statement
of a marketplace. You make it one time. Then Akaun reads each new statement of that kind the same
way.

:::info

To see the profiles, you need the **View** permission on **Auto Import**. To add, change, enable,
disable or delete a profile, you need **Profiles**. To enable or disable a profile, or to import
one from a file, you also need the **Manage** permission on **Settings**. Without it, the
**Intelligence** tab is read only.

:::

## When you need a profile

You do not need a profile for a receipt or a bill. **Single record** reads those well. Make a
profile when:

- you import the same report each week or each month,
- each row or line of the report must become one record,
- each type of line must go to its own category, for example commission or shipping fees,
- the report has withdrawals to your bank, which are transfers,
- you want Akaun to read a spreadsheet table without AI.

See also [Import spreadsheets](./spreadsheets.md).

## The four types of profile

Choose the type in **What to import**. The type decides what Akaun reads and who reads it.

| Type | What it imports | Who reads it |
|---|---|---|
| **Table rows** | Each row of a spreadsheet table becomes a record. | Akaun reads the cells. No AI. Spreadsheets only. |
| **Summary lines** | The totals and fees in the summary of a statement. | The AI. |
| **Transaction lines** | Each line of a document. | The AI. |
| **Table rows and summary lines** | The rows of a table, and lines outside the table, for example a fee. | Akaun reads the table. The AI reads the other lines. Spreadsheets only. |

## Make a profile

1. Click **Settings**.
2. Click the **Intelligence** tab.
3. Under **Import profiles**, click **New profile**.
4. In **What to import**, choose the type.
5. In **Reads**, select **PDF files and photos**, **Spreadsheets**, or both. A type that reads a
   table always reads **Spreadsheets** only.
6. Type a **Name**, for example "Marketplace monthly statement".
7. In **Account**, choose the account of the document, for example the wallet of the marketplace.
8. Complete the cards below. See the sections that follow.
9. Check the **Before you save** card on the right.
10. Click **Add profile**.

**Account** is optional. If you choose one, the items use it in place of **Accounts Payable** or
**Accounts Receivable**. A profile with a transfer section must have an account.

**Sheet** shows when the profile reads spreadsheets. Type the name of the sheet to read in a
workbook with many sheets. If you leave it empty, Akaun finds the sheet with the table headings.
For an AI profile, Akaun uses the first sheet.

## Show Akaun the table

A profile that reads a table needs a sample. The sample is a real report of the same kind.

1. In the **Table** card, drag a sample .xlsx or .csv file onto the drop area.
2. Make sure that Akaun found the correct heading row.
3. If the heading row is wrong, click **Select a different table**.
4. Check the role of each column: **Date**, **Description**, **Amount**, **Reference**,
   **Direction (inflow or outflow)**, **Running balance** or **Not used**.

Akaun gives a role to some columns from the sample. **Date**, **Description** and **Amount** are
necessary. If one column tells the direction of the
money, give it **Direction (inflow or outflow)**. Then set each of its values to **Inflow** or
**Outflow**. An inflow is money into the account. An outflow is money out of the account.

Akaun does not keep the sample. **More options** has the less common settings, for example
**Date format**, **Decimal separator**, **CSV separator** and **Labels of the stated totals**.

## Tell Akaun where each row goes

The **Rows become** cards tell Akaun which rows become which records.

Each table section, including **Every row**, has **Import rows only when**. Add conditions
such as **Status is Completed** to keep only matching rows. Every condition must match;
with no conditions, all rows assigned to the section are kept. Comparisons ignore case
and extra spacing. Filters remain in place when you change the column used to split rows.

Use **Test sample** to check the resulting section counts and ignored rows. Assignment
counts are shown before filtering. Filtered rows count as ignored and are not read by AI
in a mixed profile. A stated total still compares against the imported items, so filtering
can cause a difference from a whole-document total. Running-balance checks still inspect
the source table.


- If all rows are of one kind, use one section. Give it a kind and a category.
- If the rows are of different kinds, click **Split rows by a column**. Choose the **Column** that
  tells the type of each row. Then choose a section for each value, or **Ignore**.

Each section has these fields:

| Field | What it does |
|---|---|
| **Name** | The name of the section, for example "Fees". A profile with one section for all rows shows **Every row** in place of a name. |
| **Kind** | **Income**, **Expense**, **By sign** or **Transfer**. With **By sign**, a positive amount is income and a negative amount is an expense. With **Income** or **Expense**, Akaun ignores a row with the opposite sign. |
| **Category** | The category for each record of the section. If you choose none (**Reviewer selects**), the reviewer chooses it. |
| **Other account** | For a **Transfer** only. The account that the money goes to or comes from, for example your bank. |
| **Line types** | Optional. Divides the section into types, for example commission and shipping. Each type can have its own category. |

**More** in each section has additional row-selection and overlap rules.

## Sections that the AI reads

For **Summary lines** and **Transaction lines**, the cards are under **Lines to import**. For
**Table rows and summary lines**, the AI part is under **Lines outside the table**.

1. Click **Add section**.
2. Type a **Name**.
3. Choose a **Kind** and, if you know it, a **Category**.
4. In **Description**, tell the AI what the lines are and where they are on the document.

If you choose no category (**AI suggests**), the AI suggests one. A profile can have 20 sections
or fewer.

## Auto-detect

The **Auto-detect** card helps Akaun find this profile when you upload with **Auto-detect**.

- **Document description**: tell who sends the document and what it shows. A profile that the AI
  reads must have a description.
- **Fixed phrases**: text that is always on the document, for example its title. Type a phrase and
  click **Add**. You can add 10 phrases.

Auto-detect checks fixed phrases across all enabled profiles that can read the file first.
If exactly one profile has all its phrases in the document, Akaun selects it without AI.
For a spreadsheet with no phrase matches, a unique table-heading match is used next.
If the choice is still unclear, AI chooses among the matching profiles, or reports that none fits.
A table profile whose required headings are absent cannot read the file and is excluded.

The upload page remembers your last **Read as** selection on this device. Choosing a
specific profile uses that profile directly for every upload; choose **Auto-detect** to
match each document automatically.

## AI instructions

This card shows for a profile that the AI reads.

- **Instructions**: guidance for the AI for this profile only. They replace the
  **Custom instructions** in **Settings** › **Intelligence**.
- **Stated total**: the label of the printed total, for example "Total payout released". Akaun then
  shows if the items agree with the total. See
  [Documents with many records](./documents-with-many-records.md#control-total).

## Test the profile

A profile that reads a table has the **Test on the sample** card. You can test before you save.

1. Load a sample in the **Table** card.
2. In **Test on the sample**, click **Test**.
3. Read the result: the number of rows in each section, the ignored rows and the first items.
4. If the profile has stated totals, compare **Items** with **Stated total**.
5. Correct the profile, and then click **Test again**.

The test keeps no data and makes no records.

## Before you save

The **Before you save** card lists each problem that stops the save. Click a problem to go to its
field. When the list is empty, the card shows **Ready to save**.

To save a new profile, click **Add profile**. To save changes to a saved profile, click
**Save profile**.

## Enable or disable a profile

Only an enabled profile shows under **Read as** and in **Auto-detect**.

1. Click **Settings**.
2. Click the **Intelligence** tab.
3. Under **Saved profiles**, click the switch of the profile.
4. Click **Save** at the bottom of the tab.

If you disable a profile, a document in the queue that waits for it fails.

## Move a profile to a different installation

You can export a profile to a JSON file, and import it into a different Akaun installation.

To export a profile:

1. Open the profile from **Settings** › **Intelligence**.
2. If you changed the profile, save it first.
3. Click **Export**.

If **Settings** has unsaved changes, save or discard them before you import a profile.

To import a profile:

1. Click **Settings**.
2. Click the **Intelligence** tab.
3. Under **Saved profiles**, click **Import**.
4. Choose the JSON file.
5. Check the profile in the editor.
6. Choose each account or category that the editor shows as empty.
7. Click **Add profile** or **Save profile**.

The file names each account by its code and name. Akaun finds the account with the same code
first, and then with the same name. If it finds neither, the field stays empty. The
**Imported from** card lists these fields.

If a saved profile has the same name as the profile in the file, the editor opens that profile. Your save then
replaces it. The **History** of the profile keeps the changes. Nothing is saved until you click
the save button.

## Delete a profile

:::caution

You cannot undo this. The profile no longer shows under **Read as**. The records that you
imported with it do not change.

:::

1. Open the profile.
2. Click **Delete**.
3. In the dialog, click **Delete**.

## Related

- [Import spreadsheets](./spreadsheets.md)
- [Documents with many records](./documents-with-many-records.md)
- [Connect an AI provider](./connect-an-ai-provider.md)
