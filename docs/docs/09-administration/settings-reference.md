---
sidebar_position: 3
---

# Settings reference

This page tells what each setting in **Settings** does, tab by tab. To prepare a new book in the
correct order, use [Prepare your book](../01-getting-started/set-up-your-book.md).

To open the settings, click **Settings** in the sidebar. The tabs are **General**, **Company**,
**Books**, **Intelligence**, **Templates** and **Advanced**.

:::info

To open **Settings**, you need the **View** permission on **Settings**. To change a setting, you
need the **Manage** permission on **Settings**. Without **Manage**, Akaun shows all the tabs as read
only, with a note at the top. The groups that Akaun makes give **View** only. Thus at the start,
only a superuser can change the settings. Akaun never shows the key of an AI provider. See
[Permissions explained](./permissions-explained.md#settings).

:::

## Save your changes

Each part of a tab has its own **Save** button. On the **Books** tab, the button is
**Save defaults**. Click the button of the part that you changed before you go to a different
part. After a save, Akaun shows **Settings saved**.

If you have unsaved changes and you click a different tab or a different screen, Akaun shows
**Unsaved changes**:

- Click **Keep editing** to stay and save your changes.
- Click **Discard changes** to remove your changes and continue.

A reload of the page, or a closed browser tab, removes unsaved changes without a message. The
**Unsaved changes** message also does not cover the **Default accounts** lists on the **Books** tab.

## General

The **General** tab has two parts: **Display** and **Numbering**.

### Display

- **Currency**: the main currency of the book. All amounts show in this currency. Akaun changes
  the amounts of foreign records into it.
- **Money usually comes from**: the account that new expenses and income use first. You can still
  change the account on each record. This row shows only when the book has two or more money
  accounts. At this time, a change in this row is not kept. To change this account, use
  **Default transaction account** on the **Books** tab.
- **Chart of Accounts**: click **Open accounts →** to open the **Accounts** screen.

Click **Save** under these rows to save **Currency**.

:::caution

**Currency** locks when the first record, quotation or invoice exists. A starting balance is also
a record. After the lock, **Currency** shows a lock icon and you cannot change it.

:::

See [Foreign currency](../02-concepts/foreign-currency.md).

### Numbering

**Numbering** sets one number format for expenses, income, payments, quotations and invoices.
Click a token, or drag it, to add it to the format: **PREFIX**, **YYYY**, **YY**, **MM**, **DD**
and **SEQ**. Type other characters, for example a dash, directly in the format. The **Preview**
line shows an example number. Click **Save** under **Numbering**.

[Prepare your book](../01-getting-started/set-up-your-book.md#3-choose-the-document-numbers) tells
what each token means.

The help text lists the codes EX, IN, CL, QT and IV, but it does not tell what CL is. CL is the
code for a payment.

:::caution

The number format locks when the first record, quotation or invoice exists. After the lock, the
tokens and the **Save** button do not show, and you cannot change the format.

:::

## Company

Akaun shows these details on printed quotations and invoices.

- **Logo**: click **Upload** to add a JPEG or PNG image of 5 MB or smaller. Click **Replace** to
  use a different image, or **Remove** to remove it. At this time, the logo does not print on
  quotations or invoices.
- **Letterhead**: a JPEG or PNG image of 5 MB or smaller, usually a wide banner with your logo,
  name and address. It prints at the top of quotations and invoices, in place of the company name,
  when **Header** on the **Templates** tab is **Letterhead**. **Upload**, **Replace** and **Remove**
  work as for the logo.
- **Company Name**: the name of the business.
- **Address**: the address of the business.
- **Registration No.**: the registration number of the business.

Click **Save** to save the fields.

## Books

:::info

The **Books** tab shows only for a user with the **View** permission on **Reports**.

:::

### Default accounts

Akaun uses these accounts for the automatic side of some records. Each list shows only the
accounts that fit the default.

| Default | What Akaun uses it for |
|---|---|
| **Accounts receivable** | An invoice that you send, and a payment from a customer. |
| **Accounts payable** | An expense that a different person pays for the business. |
| **Opening balances** | The other side of each starting balance. |
| **Sales revenue** | An invoice that does not choose a different revenue account. |
| **Uncategorised expense** | An imported expense with no matching expense account. |
| **Default transaction account** | The account that new expenses and income use first. **Money usually comes from** on the **General** tab shows this account. |
| **Uncategorised income** | An imported income with no matching revenue account. |

Click **Save defaults** to save. Akaun shows **Default accounts updated**. To change a default,
you need the **Change** permission on **Accounts** and the **Manage** permission on **Settings**.
Without them, the lists and the button are not available.

:::caution

Do not change **Accounts receivable** after you send invoices. A payment from a customer then
cannot settle an invoice that you sent before the change.

:::

See [Prepare your book](../01-getting-started/set-up-your-book.md#6-check-the-default-accounts).

### Ledger integrity check

The check adds the lines of each record and makes sure that each record balances. It only reads
the book. It changes nothing.

1. On the **Books** tab, find **Ledger integrity check**.
2. Click **Check now**.

If all records balance, Akaun shows **All good. Every record balances, and so does everything
added up together.** If a record does not balance, Akaun shows the record number and the
difference. Report this problem. See [Troubleshooting](../10-help/troubleshooting.md).

### Migration results

**Migration results** shows only after Akaun converted a book from an older version. It shows only
when the conversion had to make decisions without you. Each part lists the records that the
conversion changed, for example **Uncategorised records** or **Files that could not be found**.
Check each record in the list.

Akaun keeps the previous files in a `pre-chart-` folder next to the database. See
[Backups and upgrades](./backups-and-upgrades.md#what-happens-at-the-first-start).

## Intelligence

The **Intelligence** tab controls **Auto Import**. It has three parts. **Providers** holds the AI
providers that read your documents. **Import profiles** holds the saved ways to read one kind of
document. **Processing** controls how Akaun processes the files. Click **Save** at the bottom of
the tab to save the changes on this tab. **Import profiles** shows only for a user with the
**View** permission on **Auto Import**.

See [Connect an AI provider](../04-auto-import/connect-an-ai-provider.md) and
[Import profiles](../04-auto-import/import-profiles.md).

## Templates

The **Templates** tab controls printed quotations and invoices, and the terms that new ones start
with.

Under **Printed documents**:

- **Layout**: shows **Standard**. At this time, Akaun has one layout only, and you cannot change
  it.
- **Accent color**: the color of the printed documents. Choose a preset color, or choose a
  different color.
- **Header**: what prints at the top of the page. **Company name** prints the name as text.
  **Letterhead** prints the letterhead image from the **Company** tab in its place. The layout
  decides where the header goes. You can choose **Letterhead** only after you upload a letterhead.
  If you later remove the letterhead, the documents print the company name again.

Under **Default terms**:

- **Invoice due in (days)**: a new invoice is due this number of days after its issue date. Type
  0 for due on receipt. Leave it empty for no due date.
- **Quotation valid for (days)**: a new quotation expires this number of days after its issue
  date. Leave it empty for no expiry date.

Type a whole number from 0 to 365. The default for each setting is 30. A change applies only to new
invoices and quotations. The due date of an invoice that you make from a quotation also comes from
**Invoice due in (days)**.

Click **Save** to save the color and the terms.

## Advanced

The **Advanced** tab has **Search index**. The search index is the text that the search box on
each list uses.

1. On the **Advanced** tab, find **Rebuild search index**.
2. Click **Rebuild**.

Akaun reads the stored files again. Then it makes the search text again for all records,
quotations, invoices and contacts. The row shows the progress. At the end, it shows the number of
records. Use this when the search does not find a record that it must find.

## Notes and limits

- Each setting applies to the full book and to all users.
- Your name, your password and the order of your screens are on your profile, not in
  **Settings**. See [Your profile](./your-profile.md).
