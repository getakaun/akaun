---
sidebar_position: 5
---

# Connect AI assistants

Akaun can give read-only data to an AI assistant that supports MCP (Model Context Protocol). Then
you can ask the assistant questions about your books, for example "What did we spend on shipping
in September?". The assistant reads the data. It cannot change the data.

## What the assistant can read

The assistant can read these items. It reads only the areas where the user has the **View**
permission.

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

Akaun also gives the assistant guidance for record descriptions. The assistant can use it to
suggest better descriptions. You make each change by hand in Akaun.

The assistant cannot add, change or delete anything. It cannot upload files, confirm imports,
match bank lines or record payments.

:::caution

The assistant sends the data that it reads to the AI service of the assistant. This can include
amounts, contact names, descriptions, the text of your receipts and bills, and the receipt and
bill files themselves. Connect an assistant
only if you agree that this service can read this data. Give the assistant only the permissions
that it needs.

:::

## Two ways to connect

- With the sign-in (OAuth), the assistant opens Akaun in a browser. You sign in and choose what
  the assistant can read. Use this way when the assistant supports it. The administrator must
  enable it first.
- With an API token, you put an API token in the settings of the assistant. Use this way when the
  assistant cannot use the sign-in.

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

The API token way needs no change on the server.

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
6. Clear each permission that you do not want to give.
7. Click **Allow selected access**.

The assistant can now read your data. The app shows on your profile, on the **Connected apps**
tab.

The page shows each permission that the app asks for, from this list:

- **Read records, their attached files, statements and outstanding amounts**
- **Read accounts and balances**
- **Read contacts**
- **Read financial reports**
- **Read import jobs and extracted documents**

Akaun selects each permission that you have. If you do not have a permission, the page shows
**Your account does not have this permission.** and you cannot select it. If you clear all the
permissions, Akaun shows **Select at least one available permission.** Click **Cancel** to refuse
the connection.

A connection stays valid for 30 days or less. Then connect the assistant again.

## Connect with an API token

:::caution

An API token can do more than read. Through the API of Akaun, a program with the token can do all
the actions that the user can do, also changes and deletes. Do not use the token of a superuser.
Make a separate user that can only view.

:::

1. As a superuser, make a group that has only **View** on the areas that the assistant needs. See
   [Make a group](./users-and-groups.md#make-a-group).
2. Add a user for the assistant, in this group only. See
   [Add a user](./users-and-groups.md#add-a-user).
3. Issue an API token for this user. See
   [Issue an API token for a user](./users-and-groups.md#issue-an-api-token-for-a-user).
4. In the assistant, add a new MCP server of the type "Streamable HTTP".
5. Type the server address, for example `https://books.example.com/mcp`.
6. Add the header `Authorization` with the value `Bearer` and the token, for example
   `Bearer akn_1234…`.

The assistant can now read the data that the user can view.

## Disconnect an assistant

- If you connected with the sign-in, open your profile, click **Connected apps**, and click
  **Revoke access** for the app. See [Your profile](./your-profile.md#connected-apps).
- If you connected with an API token, revoke the token. See
  [Replace or remove a token](./users-and-groups.md#replace-or-remove-a-token).

The assistant stops immediately. A new password also disconnects all the apps of the user that
connected with the sign-in. **Sign out** does not disconnect them.

## Notes and limits

- Akaun checks the permissions of the user on each request. If you remove a permission from the
  group, the assistant loses that data on its next request.
- With the sign-in, a superuser is also limited to the permissions that the superuser selected.
- The assistant reads the data at the time of its question. It does not get live updates.
- A list gives 50 rows at a time by default, and 200 rows at the most. A statement gives 500 lines or
  fewer. For a long period, ask about a shorter period.
- The assistant can read an attached file of 5 MB or less. One user can read 60 files in 10
  minutes. After that, the assistant must wait.
- Use HTTPS for a connection over the internet. An API token sent over plain HTTP is not safe.
