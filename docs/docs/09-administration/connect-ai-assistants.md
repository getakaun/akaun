---
sidebar_position: 5
---

# Connect AI assistants

Akaun can give data to an AI assistant that supports MCP (Model Context Protocol). Then you can ask
the assistant questions about your books, for example "What did we spend on shipping in
September?". If you allow it, the assistant can also do work in your books, for example "Categorise
the expenses that have no category, with my rules".

By default the assistant can only read. It can change data only when you give it change access.

## What an assistant can do

Akaun gives the assistant 28 tools. The name of each tool starts with `akaun_`, for example
`akaun_search_records`. You see these names when the assistant asks for your approval. If you
write a permission rule for one tool in Claude Code, use the new name, for example
`mcp__akaun__akaun_search_records`. A rule for the whole server, `mcp__akaun`, still works.

The first thing that an assistant does is read a short summary of your books: the main currency,
today's date, the date through which the books are closed, the work that waits, and what the
assistant may do. Then it uses the other tools for your request.

| What you ask for | What the assistant does | Access that it needs |
|---|---|---|
| Answer a question, or total something | Finds records, or totals them by category, account, contact or month. It reads a report: **Profit & Loss**, **Balance Sheet**, **Cash Flow Statement**, **Partners' Equity**, a trial balance, an expense tax report, receivables, payables or the asset register. | **View** |
| Find what needs attention | Lists records with no category, expenses with no receipt, records that look entered twice, contacts that look the same, unmatched bank lines, bills that are not paid, overdue invoices and expense lines with no tax treatment. | **View** |
| Categorise records with your rules | Reads which categories the contact or the description used before, applies your rules, and changes the category. Akaun stores no rules. The rules stay with you and the assistant. | **Change** on **Records** |
| Match bank lines to records | Shows each unmatched bank line with the records that it could be, matches the clear ones and leaves the others to you. | **Match** on **Reconciliation** |
| Record a bank line that has no record yet, for example interest or a bank charge | Makes the record from the bank line and matches it. | **Add** on **Reconciliation** and **Add** on **Records** |
| Check the receipts of a month | Finds records with no file, and records that have the same file or the same amount, date and contact. It reads the receipt and tells you what it finds. | **View**. To attach a file, **Change** on **Records**. |
| Clean up your contacts | Finds contacts that look the same, renames them, and merges them. | **Change** on **Contacts**. To merge, see [Merge contacts](#merge-contacts). |
| Correct the date or the amount of a record that is paid or matched | Chooses the correction that fits, tells you what it would reverse and apply again, and then does it. | **Change** on **Records** and a correction choice. See [Corrections](#corrections). |
| Move a payment to the right bill | Reverses the wrong allocation and applies the payment to the right bills, in one step. | **Correct allocations** |
| Cancel a record that is not valid | Voids the record. The books read as if it never happened. | **Void records** |
| Record a payment, or repay a person | Records the payment and applies it to the bills or the invoices. | **Add** on **Records** |
| Keep equipment as an asset | Moves an expense to an asset account and registers the asset. It posts depreciation when you ask. | **Change** on **Accounts** and on **Records**. Depreciation needs **Adjustments**. |
| Prepare an invoice or a quotation | Makes a draft. It does not send it. | **Add** on **Invoices** or **Quotations** |
| Prepare a month-end review | Lists what blocks the next close and what to check, and goes through it with you. | **View** |
| Add a receipt that came by email | The assistant gets the file with its own email tools. Then it attaches the file to the record. | **Change** on **Records** |

Some assistants show three ready-made requests. In Claude Code they are the commands
`/mcp__akaun__month-end-review`, `/mcp__akaun__categorise-expenses` and
`/mcp__akaun__reconcile-account`. Other assistants, for example ChatGPT, do not use them. They are
only a faster way to ask. Akaun applies the same rules to a request that you type yourself.

## What the assistant can read

The assistant reads only the areas where the user has the **View** permission, and where the token
or the connection gives read access.

| What the assistant can read | Permission that the user needs |
|---|---|
| Records, with filters, totals and an account statement. One record, with its lines, files, settlements, bank matches and the stored text of its documents. | **View** on **Records** |
| A file attached to a record: a receipt or bill as an image or a PDF | **View** on **Records** |
| Accounts, with their balances and tax defaults | **View** on **Accounts** |
| Contacts | **View** on **Contacts** |
| The balance and the open items of one contact | **View** on **Contacts** and **Records** |
| A report: **Profit & Loss**, **Balance Sheet**, **Cash Flow Statement**, **Partners' Equity**, a trial balance and the expense tax report | **View** on **Reports** |
| Receivables and payables by age, and the asset register | **View** on **Reports** and **Records**. For the asset register also **View** on **Accounts**. |
| The list of files on **Auto Import**, and the items of one file | **View** on **Auto Import** |
| Invoices and quotations, with their lines | **View** on **Invoices** or **Quotations** |
| Bank statements, their lines, and the records that can match them | **View** on **Reconciliation** and **Records** |
| The history of changes to one item, and everything that one request changed | **View** on the area of the item |

The list of what needs attention shows only the parts that the user may read. A part that the
user may not read shows as skipped. It never shows as "no problems". The history of users, groups,
tokens, apps and settings is never shown to an assistant.

## What the assistant can change

The assistant can change data only if all of these are true:

- You gave the assistant the access. With the sign-in, you select change access when you connect.
  With a token, you choose the level or the ability when you make the token. See
  [Connect with the sign-in](#connect-with-the-sign-in) and
  [Connect with a personal access token](#connect-with-a-personal-access-token).
- The user may hand on the permission to tokens and apps. The administrator sets this on each
  group, in **Members may hand on to tokens & apps**. See
  [What members may hand on](./users-and-groups.md#what-members-may-hand-on).
- The user has the permission in Akaun. The assistant can never do more than the user.

Akaun checks these on each request. If the administrator removes a permission from the group, or
from what the group may hand on, the assistant loses it immediately. A permission that the user has
as an extra permission is never handed on to an assistant.

| What the assistant can do | Permission that the user needs |
|---|---|
| Record an expense, income or transfer. Change a record. | **Add** or **Change** on **Records** |
| Record a payment, and apply it to bills or invoices | **Add** on **Records** |
| Attach a receipt to a record (PDF, JPEG or PNG, 15 MB or smaller) | **Change** on **Records** |
| Add, rename or archive an account or a category. Set an opening balance. | **Add** or **Change** on **Accounts** |
| Set the tax default of an account | **Change** on **Accounts** |
| Apply the tax default to the entries that have no tax treatment | **Change** on **Accounts** and **Change** on **Records** |
| Add or change a contact | **Add** or **Change** on **Contacts** |
| Make and change an invoice | **Add** or **Change** on **Invoices** |
| Send an invoice | **Send** on **Invoices** and **Add** on **Records** |
| Void an invoice | **Void** on **Invoices** and **Change** on **Records**. To make a new invoice in its place, also **Add** on **Invoices**. |
| Make and change a quotation, and change its status | **Add** or **Change** on **Quotations** |
| Revise a quotation | **Revise** and **Add** on **Quotations** |
| Convert a quotation into an invoice | **Convert** on **Quotations** and **Add** on **Invoices** |
| Match bank lines to records | **Match** on **Reconciliation** |
| Record a bank line as a record of any kind | **Add** on **Reconciliation** and **Add** on **Records** |
| Correct a file on **Auto Import** | **Change** on **Auto Import** |
| Confirm or skip a file on **Auto Import** | **Confirm** on **Auto Import** |

To delete something, the assistant needs delete access as well. With the sign-in, this is a
separate choice when you connect. With a token, select **Full** for the area, or select **Custom**
and switch on **Delete**. Then the assistant can delete records, accounts, contacts, draft
invoices, quotations and import files, where the user has **Delete**. Setting an opening balance
to zero deletes it, so that also needs **Delete** on **Records**.

Skipping a file on **Auto Import** deletes the uploaded file, so the assistant asks you first.

Akaun applies all its normal rules to the assistant. For example:

- An ordinary edit keeps the amount and the date of a paid or matched record. The assistant must
  use a correction, which needs a reason and its own access.
- A sent invoice keeps its amounts. The assistant must void it and make a new one.
- An account with records cannot be deleted. The assistant can archive it.
- If someone else changed an item after the assistant read it, Akaun refuses the change. The
  assistant must read the item again.

### Access that you must choose by name

These choices are never part of ordinary change access. With the sign-in, they start unchecked.
With a token, you switch them on by name.

#### Adjustments

A journal entry, or a record between any two accounts, needs **Adjustments** on **Records**. With
the sign-in, the assistant also needs the separate **Adjust** choice when you connect. Give it only
to an assistant that you trust with your books. An adjustment can change any balance and keep the
ledger in balance. Posting depreciation is an adjustment too.

#### Merge contacts

:::caution

A merge cannot be undone. Akaun moves the records, quotations and invoices of the merged contacts
to the contact that you keep, and then deletes the merged contacts.

:::

Merging needs the choice that starts with **Merge duplicate contacts**. With the sign-in, it
shows in the **Delete** group. It is not part of change access or of delete access, so an
assistant that you connected before this choice existed does not get it. The user also needs
**Merge**, **Change** and **Delete** on **Contacts**. With a token, select **Full** on
**Contacts**, or select **Custom** and switch on these three abilities.

The assistant is told to show you the records that would move before it merges. Check this list,
and tell the assistant to continue only if it is correct.

#### Corrections

A correction changes a record that other records depend on: a paid expense, a matched record, a
payment that you applied to a bill. You do not ask the assistant to choose a method. You tell it
what the record must say. Akaun chooses the steps, and it needs a reason.

- **Correct settled dates**: change the date of a paid expense or income. A change to another
  month needs your agreement. It also needs **View** and **Change** on **Records**.
- **Correct expense contacts**: change the supplier of an expense, or the person who paid it. This
  can move amounts that you owe between contacts. It also needs **View** and **Change** on
  **Records**.
- **Correct allocations**: reverse a payment allocation and apply the payment again. Akaun keeps
  the old allocation in the history. It also needs **Add** on **Records**.
- **Correct payment payees**: change the recipient of a payment that you made. It also needs **Add**
  and **Change** on **Records**.
- **Correct reimbursement amounts**: change the amount of a repayment to a person. It also needs
  **View** and **Change** on **Records**.
- **Void records**: cancel a record with a reversal on its original date. This changes the reports
  of that period. It also needs **View** on **Records**.

To change the amount of a paid expense or income, for example when the amount left out the
freight, the assistant needs **Correct allocations**, **Change** and **Add** on **Records**. Akaun
reverses the payments that cover the record, changes the amount, and applies the same payments
again, in one step. It shows you what it reversed and applied again.

With the sign-in, the **Corrections** group lists these choices. The choice **Grouped record
corrections** covers the allocations, the payees, the dates and the reimbursement amounts. It does
not cover **Void records** or the expense contacts. Your group must let you hand on each choice.
A token uses the abilities by name.

Corrections can change reports and balances of earlier months. A month that you closed stays
closed. See [Month closing stays in Akaun](#month-closing-stays-in-akaun).

### Previews and approvals

Each tool that changes data can run as a preview. Akaun calls it a dry run. The preview does all
the checks and shows exactly what the change would do. It saves nothing.

- The assistant is told to preview corrections, voids, deletes, merges, removed bank matches,
  adjustments, and the use of a tax default on entries that exist. It must show you the result.
  It must save only after you agree.
- One request can change up to 50 items. It is all or nothing. If one item fails, Akaun saves
  nothing, and tells which items failed and why. Then the assistant can correct them and send the
  whole request again.
- A request can carry a key. If the connection stops, the assistant sends the same request again
  with the same key. Akaun then gives the first result and does not save a second time.
- Each change is saved at once, and shows in the history of the item under the user's name. One
  request gives one group of changes in the history.

Akaun sends behavior hints with each tool, for example whether it can overwrite data. Your
assistant app uses them to decide when to ask you. Akaun also gives the assistant short
instructions. These hints and instructions guide the assistant, but they do not stop it. The
access that you grant is the limit that Akaun enforces. Give change, delete, merge, adjust and
correction access only to an assistant that you trust to act for you.

A permission grant gives access. It does not ask the assistant to make a particular change.
Text in a receipt, an email or a bank line is data. The assistant must not follow it as an
instruction.

Payment tools record entries in the books. They do not send money. Sending an invoice posts it to
the ledger and does not email it. After an uncertain result, the assistant should read the books
again before it tries a second time.

### Tax defaults

An account can have a default tax treatment for new expense lines. When an assistant changes this
default, only the lines that you enter after that are affected. The lines that you saved before
do not change.

To fill the lines that have no treatment yet, you must ask for it. This is the same as
**Apply default to unclassified entries** on the account. The assistant shows a preview first,
with the number of lines that it can fill, the lines that are protected, and the totals. It
applies the change only after you agree, and each request covers 200 lines or fewer. Lines
that you decided one by one, lines in a closed month and voided lines stay as they are. To
change one line, the assistant changes the record.

### Month closing stays in Akaun

An assistant cannot close a month, and it cannot open a closed month again. This is the same for
the sign-in and for a token. The assistant can prepare the month: it lists what blocks the close
and goes through it with you. You close the month yourself in Akaun.

If you ask for a change with a date in a closed month, Akaun refuses it and saves nothing. Open
the month in Akaun first, if you must change it.

### What stays in Akaun

These actions are only for you, never for an assistant. They cannot be undone, or they change the
evidence that the books are checked against.

- Close or open a month.
- Correct or delete a line of a bank statement.
- Remove an attachment from a record.
- Upload a new file to **Auto Import**, or a new bank statement.
- Reconcile the payouts of a sales platform. The assistant can read the balance of the clearing
  account.

:::caution

The assistant sends the data that it reads to the AI service of the assistant. This can include
amounts, contact names, descriptions, the text of your receipts and bills, and the receipt and
bill files themselves. Connect an assistant only if you agree that this service can read this
data. Give the assistant only the permissions that it needs. Give change or delete access only to
an assistant that you trust to act for you.

:::

## Two ways to connect

- With the sign-in (OAuth), the assistant opens Akaun in a browser. You sign in and choose what
  the assistant can read, change and delete. Use this way when the assistant supports it. The
  administrator must enable it first.
- With a personal access token, you put a token in the settings of the assistant. Use this way when
  the assistant cannot use the sign-in. The token can do only what you select when you make it.
  See [Connect with a personal access token](#connect-with-a-personal-access-token).

In both ways, the server address is the address of Akaun with `/mcp` at the end, for example
`https://books.example.com/mcp`.

## Prepare the server (administrator)

For the sign-in way, the administrator must change two settings on the server:

1. Set `ORIGIN` to the public HTTPS address of Akaun, for example `https://books.example.com`.
2. Add the setting `OAUTH_ENABLED=true`.
3. Start Akaun again.

See [Install Akaun](../01-getting-started/install.md#environment-variables).

`ORIGIN` must start with `https://`. Only a `localhost` or `127.0.0.1` address can use `http://`.
Do not put a path after the address. If the address is not correct, Akaun does not start, and the
server log tells why.

An assistant that runs in the cloud must reach your server from the internet. If you use a
reverse proxy, it must send the paths `/mcp`, `/oauth/` and `/.well-known/` to Akaun.

For the assistant to attach the largest files, `BODY_SIZE_LIMIT` must be `21M` or more. The Docker
image already sets it.

## Connect Claude Code, Cowork, ChatGPT and other assistants

The menus of each assistant are different, and they change. Use the function of the assistant that
adds an MCP server. Its name can be "connector", "integration" or "custom connector". Akaun needs
three things from you:

| Assistant | What to do |
|---|---|
| Claude Code | Run `claude mcp add --transport http akaun https://books.example.com/mcp`. For the sign-in, start `/mcp` in Claude Code and select the server. For a token, add `--header "Authorization: Bearer akp_…"` to the command. |
| Cowork | Add the server address as a custom connector in the settings, and choose the sign-in or a token as the type of authentication. |
| ChatGPT | Add the server address as a custom connector, and choose the sign-in. ChatGPT connects from the internet, so the address must be a public HTTPS address. It does not use the ready-made requests. |
| Other assistants | Add a server of the type "Streamable HTTP" with the server address. Use the sign-in if the assistant supports it. If not, add the header `Authorization` with the value `Bearer` and the token. |

In all of them, the server address is the address of Akaun with `/mcp` at the end. After you
update Akaun, connect the assistant again. The assistant keeps the list of tools that it read
last, and the names of the tools changed.

## Connect with the sign-in

:::caution

The app sends its own name. Akaun does not check it. Connect only from an assistant that you
started yourself. If you did not start the connection, click **Cancel**.

:::

1. In the assistant, add a new MCP server. The name of this function is different in each
   assistant, for example "connector" or "integration".
2. Type the server address, for example `https://books.example.com/mcp`.
3. Choose OAuth as the type of authentication.
4. If Akaun asks you to sign in, sign in.
5. On the **Connect** page, read the app name and the Client ID.
6. Select the access that you want to give, and clear the rest.
7. Click **Allow selected access**.

The app shows on your profile, on the **Connected apps** tab.

The page shows all supported permissions. Select the ones you want to allow;
permissions blocked by your account or administrator are disabled. The groups include:

- **Read**: Akaun selects each read permission that you can give.
- **Change**: Akaun never selects these for you. Select each area that the assistant may add to
  and change, for example **Record and change records, payments and settlements, and attach
  files**.
- **Delete**: Akaun never selects these for you. Select them only if the assistant must delete
  things. This group also has **Merge duplicate contacts**.
- **Adjust**: Allow journal and adjustment postings only if needed. These start unchecked.
- **Corrections**: Choose the corrections the assistant may make, and **Void records**. These
  start unchecked.

Under each choice, **Includes** lists the abilities that the choice gives, for example
**Invoices: Add, Invoices: Change, Invoices: Send, Invoices: Void**.

You can select only what you may hand on to tokens and apps. Other choices are disabled:

- If you do not have a permission, the page shows **Your account does not have this permission.**
- If you have a permission, but your administrator does not let you hand it on, the page shows
  **Your administrator does not allow apps to do this.** See
  [What members may hand on](./users-and-groups.md#what-members-may-hand-on).

If you clear all the permissions, Akaun shows **Select at least one available permission.**
Click **Cancel** to refuse the connection.

You can choose read and change access during the first connection, even if the app initially
asks only for read access. Only the permissions you select are granted. Connect the app again
to change the permissions you give it. If you connect again, select the choices that you want to
keep as well. A new choice, for example **Merge duplicate contacts**, is not added to a
connection that exists.

A connection stays valid for 30 days or less. Then connect the assistant again.

## Connect with a personal access token

:::caution

A token can do more than read. A program with the token can do all the actions that you select for
the token, also changes and deletes. Select only the permissions that the assistant needs. For a
read-only assistant, select **View** for each area that it must read, and **None** for the other
areas. If you are a superuser, do not give the token more than the assistant needs.

:::

1. Open your profile, and click the **Access tokens** tab.
2. Click **New token**, and make a token with only the permissions that the assistant needs. See
   [Make a token](./your-profile.md#make-a-token).
3. Click **Copy** to copy the token. It starts with `akp_`.
4. In the assistant, add a new MCP server of the type "Streamable HTTP".
5. Type the server address, for example `https://books.example.com/mcp`.
6. Add the header `Authorization` with the value `Bearer` and the token, for example
   `Bearer akp_1234…`.

The assistant sees only the tools that the permissions of the token allow. For example, a token
with only the **View** level gives the assistant no tools that change data. A tool that has
several actions shows when the token allows one of them. If the assistant uses an action that
the token does not allow, Akaun refuses the whole request and names the action.

A token stops working at the end of the day in **Expires** (UTC). Then the assistant cannot connect. Make a new
token, and put it in the settings of the assistant.

For an assistant that does not act for one person, a superuser can add a separate user with only
the permissions that the assistant needs. Then the superuser signs in as that user, and makes the
token on the profile of that user. A superuser cannot make a token for a different user. See
[Add a user](./users-and-groups.md#add-a-user) and
[The tokens of a user](./users-and-groups.md#the-tokens-of-a-user).

## Disconnect an assistant

- If you connected with the sign-in, open your profile, click **Connected apps**, and click
  **Revoke access** for the app. See [Your profile](./your-profile.md#connected-apps).
- If you connected with a token, open your profile, click **Access tokens**, and click **Revoke**
  for the token. See [Replace or remove a token](./your-profile.md#replace-or-remove-a-token).
- A superuser can also revoke the tokens of each user on **Users & Groups**. See
  [Revoke the tokens of a user](./users-and-groups.md#revoke-the-tokens-of-a-user).

The assistant stops immediately. A new password also disconnects all the apps and revokes all the
tokens of the user. **Sign out** does not disconnect them.

## Notes and limits

- Akaun checks the permissions of the user on each request. If you remove a permission from the
  group, or from what the group may hand on, the assistant loses that ability on its next request.
- A superuser is also limited to the access that the superuser selected for the connection or the
  token. No token and no app can manage users and groups.
- The API tokens of older versions do not work any more. See
  [API tokens were replaced by personal access tokens](../10-help/troubleshooting.md#api-tokens-were-replaced-by-personal-access-tokens).
- The assistant reads the data at the time of its question. It does not get live updates.
- A list gives 50 rows at a time by default, and 200 rows at the most. A statement of one account
  has no closing balance when it has more than 5,000 lines. For a long period, ask about a
  shorter period.
- The assistant can read an attached file of 5 MB or less. One user can read 60 files in 10
  minutes. After that, the assistant must wait.
- The assistant can attach a file of 15 MB or less. One user can attach 30 files in 10 minutes.
  The assistant attaches one file in each request.
- Akaun does not read your email and does not fetch receipts. If the assistant can read your
  email, it gets the file itself and attaches it to the record.
- The assistant cannot upload a new file to **Auto Import** or a new bank statement. Upload these in
  Akaun.
- Use HTTPS for a connection over the internet. A token sent over plain HTTP is not safe.
