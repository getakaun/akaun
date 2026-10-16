---
sidebar_position: 2
---

# Permissions explained

A permission lets a user do one thing in one area of Akaun. Read this page before you make a
group, give a user extra permissions or make a token. To change the permissions, see
[Users and groups](./users-and-groups.md).

## Areas and abilities

Each area of Akaun has a list of abilities. In **Users & Groups** and on the **New access token**
page, each area shows as a row. You choose a level of access for the row, or you switch on single
abilities. See [Levels of access](#levels-of-access).

- **View** opens the screen of the area and shows its items. Without **View**, the screen does not
  open, and its item does not show in the sidebar.
- **Add**, **Change** and **Delete** make, change and remove the items of the area.
- Some areas have more abilities, for example **Send** and **Void** on **Invoices**. Each one
  lets a user do one special task.

A superuser has all the abilities in all the areas. The levels and the abilities do not apply to a
superuser.

## The areas

The table tells what each ability lets a user do.

| Area | Ability | What the ability lets a user do |
|---|---|---|
| **Records** | **View** | Open the **Records** list, the record pages and the account statements. |
| | **Add** | Make a new record. Record a payment. |
| | **Change** | Change a record. Attach a file to a record. |
| | **Delete** | Delete a record or an attachment. Click **Reverse allocation** on a settlement. |
| | **Adjustments** | Save a record that is not an everyday record. See [Adjustments](#adjustments). |
| **Auto Import** | **View** | Open **Auto Import** and see the import profiles. |
| | **Upload** | Upload files. |
| | **Change** | Correct what Akaun read from a file. |
| | **Confirm** | Confirm or skip the items of a file. |
| | **Profiles** | Add, change, enable, disable or delete an import profile. |
| | **Delete** | Click **Discard** on a file. Click **Clear history**. |
| **Contacts** | **View** | Open **Contacts** and the contact pages. |
| | **Add** | Add a contact. |
| | **Change** | Change a contact and its roles. |
| | **Delete** | Delete a contact. |
| | **Merge** | Merge two contacts into one. |
| **Quotations** | **View** | Open **Quotations** and the quotation pages. Print a quotation. |
| | **Add** | Make a quotation. |
| | **Change** | Change a quotation and its status. |
| | **Delete** | Delete a quotation. |
| | **Revise** | Replace a sent quotation with a new revision. |
| | **Convert** | Make an invoice from an accepted quotation. |
| **Invoices** | **View** | Open **Invoices** and the invoice pages. Invoices are sales invoices issued to customers. Print an invoice. |
| | **Add** | Make a draft invoice. |
| | **Change** | Change an invoice. |
| | **Delete** | Delete a draft invoice. |
| | **Send** | Mark an invoice as sent. This posts the invoice to the ledger. |
| | **Void** | Cancel a sent invoice. This reverses the posting of the invoice. |
| **Reconciliation** | **View** | Open the reconciliation screen of an account. |
| | **Add** | Upload a statement. Make a transfer from a statement line. |
| | **Change** | Edit a statement line. |
| | **Match** | Match statement lines to records, and remove a match. |
| | **Delete** | Remove a statement or a statement line. |
| **Accounts** | **View** | Open **Accounts** and the account pages. |
| | **Add** | Add an account or a category. |
| | **Change** | Change an account, deactivate it, or enter its opening balance. Choose the default accounts. |
| | **Delete** | Delete an account that has no records. |
| **Reports** | **View** | Open **Reports**. See the **Ledger** tab in **Settings**. |
| **Dashboard** | **View** | Open the **Dashboard**. |
| **Settings** | **View** | Open **Settings** and see the settings. |
| | **Manage** | Change the settings. See [Settings](#settings). |
| **Users & Groups** | **Manage** | Open **Users & Groups**. See [Users & Groups](#users--groups). |

## Levels of access

For each area, you select one level: **None**, **View**, **Edit**, **Full** or **Custom**. A level
is a quick way to choose a set of abilities. Akaun keeps each ability on its own. A sentence under
the name of the area tells what the choice allows, for example "Can see, add, change and send
invoices. Cannot delete or void."

- **None** gives no ability in the area.
- **View** gives the **View** ability only.
- **Edit** gives **View** and each ability that adds or changes items.
- **Full** gives all the abilities of the area, except **Adjustments**.
- **Custom** shows a switch for each ability of the area, with its description. Switch on the
  abilities that you need.

| Area | **Edit** gives | **Full** also gives |
|---|---|---|
| **Records** | **View**, **Add**, **Change** | **Delete** |
| **Auto Import** | **View**, **Upload**, **Change**, **Confirm**, **Profiles** | **Delete** |
| **Contacts** | **View**, **Add**, **Change** | **Delete**, **Merge** |
| **Quotations** | **View**, **Add**, **Change**, **Revise**, **Convert** | **Delete** |
| **Invoices** | **View**, **Add**, **Change**, **Send** | **Delete**, **Void** |
| **Reconciliation** | **View**, **Add**, **Change**, **Match** | **Delete** |
| **Accounts** | **View**, **Add**, **Change** | **Delete** |
| **Settings** | **View**, **Manage** | no **Full** level |

**Reports** and **Dashboard** have one ability. They offer only **None** and **View**.

Read these notes:

- A set of abilities that is not the same as a level shows as **Custom**. For example, the
  **Data Entry** group has **Add** on **Records** but no **View**. One ability never gives a
  different ability.
- **Adjustments** on **Records** is never part of a level. It always has its own switch under
  **Records**. Thus you give it only on purpose.
- An ability with a warning sign gives a lot of power. Examples are **Adjustments** on **Records**
  and **Manage** on **Settings**. Give them only on purpose.
- A level that includes an ability that you cannot choose is not available. Hold the pointer on
  it to see why.

## Tasks that need more than one ability

- To mark an invoice as sent, a user needs **Send** on **Invoices** and **Add** on **Records**.
- To cancel a sent invoice, a user needs **Void** on **Invoices** and **Change** on **Records**. To
  make a new invoice in its place, the user also needs **Add** on **Invoices**.
- To make an invoice from a quotation, a user needs **Convert** on **Quotations** and **Add** on
  **Invoices**.
- To revise a quotation, a user needs **Revise** and **Add** on **Quotations**.
- To merge two contacts, a user needs **Merge**, **Change** and **Delete** on **Contacts**.
- To record a statement line as a transfer, a user needs **Add** on **Reconciliation** and **Add**
  on **Records**.
- To read a file again on **Auto Import**, a user needs **Upload** and **Change** on
  **Auto Import**.
- To record a payment from an invoice page, a user needs **View** on **Invoices** and **Add** on
  **Records**.

To confirm the items of a file on **Auto Import**, a user needs only **Confirm** on
**Auto Import**. The user does not need a permission on **Records**.

## Records

**Records** is one permission area for all kinds of record. It covers expenses, income, transfers,
payments, opening balances and journal entries. A user cannot have permission for expenses only.

## Reports

**Reports** is view only. A report shows figures and never changes them. Thus **Reports** has only
the **View** ability.

## Adjustments

**Adjustments** is an ability in the **Records** area. It lets a user save a record between any
two accounts. Akaun decides from the accounts if a record needs this ability. These records are
everyday records, and they do not need **Adjustments**:

- An expense: debit an expense category, credit a cash or bank account.
- A bill to pay later: debit an expense category, credit **Accounts Payable**.
- An income: debit a cash or bank account, credit an income category.
- A transfer: debit one cash or bank account, credit a different cash or bank account.
- A payment: debit **Accounts Payable** and credit a cash or bank account. Or debit a cash or bank
  account and credit **Accounts Receivable**.
- An opening balance.
- A split: one cash, bank, receivable or payable account, and two or more categories of the same
  kind.

All other records need **Adjustments**. Examples are a correction between two categories, a record
with two cash or bank accounts and a category, and a record with partner capital. On the record form,
**Adjustments** also gives the user a choice of all accounts.

:::caution

No group that Akaun makes gives **Adjustments**. No level includes **Adjustments**, also not
**Full** on **Records**. A user with this ability can make the ledger show any
figures, and the ledger is still in balance. Give it only to a person that you trust with the books. Give
it on purpose, to one user, as an extra permission.

:::

See [How a record moves money](../02-concepts/how-an-entry-works.md).

## Quotations and invoices

**Send** and **Void** on **Invoices** change the ledger: they add or remove an **Invoice** record.
Thus each one also needs a permission on **Records**. See
[Tasks that need more than one ability](#tasks-that-need-more-than-one-ability).

The groups that Akaun makes have permissions on Quotations and Invoices, as the table in
[Users and groups](./users-and-groups.md#the-groups-that-akaun-makes) shows. A new group that you
make has none. Choose a level for them in the group.

## Settings

**Settings** has two abilities:

- **View** lets a user open **Settings** and see all the tabs. Akaun never shows the key of an AI
  provider.
- **Manage** lets a user change the settings. Examples are the company details, the templates of
  printed documents, the number format, the AI providers and **Rebuild search index**.

A user with **View** and no **Manage** sees the settings as read only. A note at the top of the
page tells the user to ask an administrator for **Settings › Manage**.

Two parts also have a check of a different area:

- The **Ledger** tab shows only for a user with **View** on **Reports**.
- To choose a default account, a user needs **Change** on **Accounts**.

The groups that Akaun makes have **View** on **Settings** only. Thus at the start, only a superuser
can change the settings. To let a different user change them, give **Manage** on **Settings**.

See [Settings reference](./settings-reference.md).

## Users & Groups

**Users & Groups** has one ability, **Manage**. Only a superuser group has it. You cannot give it to
a different group, to one user, to a token or to an app. Thus only a superuser can open
**Users & Groups**.

## What tokens and apps can do

A user can let a program act for them, with a personal access token or with a connected app. See
[Your profile](./your-profile.md#access-tokens) and
[Connect AI assistants](./connect-ai-assistants.md).

Each group has a second list of areas: **Members may hand on to tokens & apps**. It is the most that the
tokens and the apps of a member can do. A token or an app can do an action only when all of these
are true:

- The token or the app has the permission.
- One of the groups of the user lets the user hand it on.
- The user can do the action at that time.

A permission that a user has as an extra permission is never handed on. See
[What members may hand on](./users-and-groups.md#what-members-may-hand-on).

## How the old permissions changed

Before this version, each area had the same four actions. Akaun changed the permissions of each
group at the upgrade. In the areas of the book, no user can do more or less than before.

| Old permission | New abilities |
|---|---|
| **Change** on **Auto Import** | **Change**, **Confirm** and **Profiles** |
| **Delete** on **Contacts** | **Delete** and **Merge** |
| **Change** on **Quotations** | **Change**, **Revise** and **Convert** |
| **Change** on **Invoices** | **Change**, **Send** and **Void** |
| **Change** on **Reconciliation** | **Change** and **Match** |
| The **Adjustments** area | **Adjustments** on **Records** |

**Settings** is different. Before, all users could change the settings. Now each group got **View**
on **Settings**, and no **Manage**. Thus only a superuser can change the settings until you give
**Manage** to a group or a user.

Each group can hand on to tokens and apps all the permissions that it gives, except
**Adjustments** and the **Settings** abilities. All the old API tokens stopped working. See
[Your profile](./your-profile.md#access-tokens).

## Notes and limits

- A change to the permissions applies on the next action of the user, and of each token and app of
  the user.
- A user who is in no group has no permissions, and extra permissions have no effect. At the next
  start of the server, Akaun puts that user into **Administrators**. See
  [Stop the access of a user](./users-and-groups.md#stop-the-access-of-a-user).
- An AI assistant that connects as a user can read only the areas that the user can view. See
  [Connect AI assistants](./connect-ai-assistants.md).
