---
sidebar_position: 5
---

# Connect AI assistants

Akaun can give data to an AI assistant that supports MCP (Model Context Protocol). Then you can ask
the assistant questions about your books, for example "What did we spend on shipping in
September?". If you allow it, the assistant can also do work in your books, for example "Record
this receipt as a software expense paid from the bank account".

By default the assistant can only read. It can change data only when you give it change access.

## What the assistant can read

The assistant can read these items. It reads only the areas where the user has the **View**
permission, and where the token or the connection gives read access.

| What the assistant can read | Permission that the user needs |
|---|---|
| The list of records, with filters for dates, kinds, accounts, categories, contacts, text, amounts, paid and cleared | **View** on **Records** |
| One record, with its lines. It can also read the settlements and the stored text of the documents. | **View** on **Records** |
| A file attached to a record: a receipt or bill as an image or a PDF, or a spreadsheet as text | **View** on **Records** |
| The statement of one account | **View** on **Records** |
| The outstanding amounts: what customers owe you, and what you owe | **View** on **Records** |
| The list of accounts, with their balances | **View** on **Accounts** |
| The list of contacts | **View** on **Contacts** |
| The balance of one contact | **View** on **Contacts** and **Records** |
| A report: **Profit & Loss**, **Balance Sheet**, **Cash Flow Statement** or **Partners' Equity** | **View** on **Reports** |
| The list of files on **Auto Import**, and the items of one file | **View** on **Auto Import** |
| Invoices and quotations, with their lines | **View** on **Invoices** or **Quotations** |
| Bank statements, their lines, and the records that can match them | **View** on **Reconciliation** and **Records** |
| The history of changes to one item | **View** on the area of the item |

Akaun also gives the assistant guidance for record descriptions. The assistant can use it to
suggest better descriptions in a table. It changes a description only after you approve it.

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
| Add or change a contact | **Add** or **Change** on **Contacts** |
| Make and change an invoice | **Add** or **Change** on **Invoices** |
| Send an invoice | **Send** on **Invoices** and **Add** on **Records** |
| Void an invoice | **Void** on **Invoices** and **Change** on **Records**. To make a new invoice in its place, also **Add** on **Invoices**. |
| Make and change a quotation, and change its status | **Add** or **Change** on **Quotations** |
| Revise a quotation | **Revise** and **Add** on **Quotations** |
| Convert a quotation into an invoice | **Convert** on **Quotations** and **Add** on **Invoices** |
| Match bank lines to records | **Match** on **Reconciliation** |
| Record a bank line as a transfer between two of your bank or cash accounts | **Add** on **Reconciliation** and **Add** on **Records** |
| Correct a file on **Auto Import** | **Change** on **Auto Import** |
| Confirm or skip a file on **Auto Import** | **Confirm** on **Auto Import** |

To delete something, the assistant needs delete access as well. With the sign-in, this is a
separate choice when you connect. With a token, select **Full** for the area, or select **Custom**
and switch on **Delete**. Then the assistant can delete records, settlements, accounts, contacts,
draft invoices, quotations and import files, where the user has **Delete**. Setting an opening
balance to zero deletes it, so that also needs **Delete** on **Records**.

Skipping a file on **Auto Import** deletes the uploaded file, so the assistant asks you first.

Some changes are only for you to make in Akaun, never for an assistant:

- Merge two contacts.
- Remove an attachment from a record.
- Correct or delete a line of a bank statement.

These cannot be undone, or they change the evidence that the books are checked against.

### Adjustments

A journal entry, or a record between any two accounts, needs **Adjustments** on **Records**. With
the sign-in, the assistant also needs the separate **Adjust** choice when you connect. Change
access to records does not include it. Give it only to an assistant that you trust with your
books: an adjustment can change any balance and still add up. A bank line recorded as a transfer
to anything other than a bank or cash account is an adjustment too.

Akaun applies all its normal rules to the assistant. For example:

- A record that is paid or matched to a bank line keeps its amount and date. Its description can
  still change.
- A sent invoice keeps its amounts. The assistant must void it and make a new one.
- An account with records cannot be deleted. The assistant can archive it.
- If someone else changed an item after the assistant read it, Akaun refuses the change. The
  assistant must read the item again.

Each change is saved at once. It shows in the history of the item under the name of the user, and
on other open screens at once. The assistant asks you before it deletes or voids something.

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

The page shows the access that the app asks for, in up to three groups:

- **Read** — Akaun selects each read permission that you can give.
- **Change** — Akaun never selects these for you. Select each area that the assistant may add to
  and change, for example **Record and change records, payments and settlements, and attach
  files**.
- **Delete** — Akaun never selects these for you. Select them only if the assistant must delete
  things.

Under each choice, **Includes** lists the abilities that the choice gives, for example
**Invoices: Add, Invoices: Change, Invoices: Send, Invoices: Void**.

The page offers only what you may hand on to tokens and apps. You cannot select the other choices:

- If you do not have a permission, the page shows **Your account does not have this permission.**
- If you have a permission, but your administrator does not let you hand it on, the page shows
  **Your administrator does not allow apps to do this.** See
  [What members may hand on](./users-and-groups.md#what-members-may-hand-on).

If you clear all the permissions, Akaun shows **Select at least one available permission.**
Click **Cancel** to refuse the connection.

Usually an app asks for read access first. When the assistant needs a tool that changes data, the
app asks again, and the **Connect** page opens again with the new access. You can also connect the
app again to give it more access.

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
with only the **View** level gives the assistant no tools that change data.

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
- A list gives 50 rows at a time by default, and 200 rows at the most. A statement gives 500 lines or
  fewer. For a long period, ask about a shorter period.
- The assistant can read an attached file of 5 MB or less. One user can read 60 files in 10
  minutes. After that, the assistant must wait.
- The assistant can attach a file of 15 MB or less. One user can attach 30 files in 10 minutes.
- The assistant cannot upload a new file to **Auto Import** or a new bank statement. Upload these in
  Akaun.
- Use HTTPS for a connection over the internet. A token sent over plain HTTP is not safe.
