---
sidebar_position: 4
---

# Your profile

Your profile holds the settings that apply only to you. Examples are your name, your password and
the order of your screens. All users can open their own profile. No
permission is necessary.

## Open your profile

1. At the bottom of the sidebar, click the user menu button (three dots) next to your name.
2. Click **Profile**.

The **My Profile** screen opens. It has five tabs: **Profile**, **Security**, **Access tokens**,
**Connected apps** and **Navigation**.

## Profile

:::caution

If you are the `admin` user, do not change the username. At each start, Akaun adds a new superuser
with the username `admin` and the password `akaun-admin` when no user has the username `admin`.
See [Users and groups](./users-and-groups.md#change-a-user).

:::

1. Click the **Profile** tab.
2. Change **Display name**, **Email** or **Username**.
3. Click **Save changes**.

Akaun shows **Profile updated**.

**Email** and **Username** are necessary. Each user must have a different email and a different
username. If the step fails, Akaun shows one of these messages:

- **Email or username is already taken.**
- **Enter a valid email address.**

## Security

Use this tab to change your password.

1. Click the **Security** tab.
2. In **Current password**, type your password.
3. In **New password**, type a new password. Use 8 characters or more.
4. In **Confirm new password**, type the new password again.
5. Click **Change password**.

Akaun shows **Password changed**. Akaun also disconnects all your connected apps and revokes all
your access tokens. The other browsers where you are signed in stay signed in.

If the step fails, Akaun shows one of these messages:

- **Current password is incorrect.**
- **New password must be at least 8 characters.**
- **Passwords do not match.**

## Access tokens

A personal access token lets a program, for example a script or an AI assistant, connect to Akaun
as you. Each token has its own name, expiry date and permissions. Only you can make a token for
yourself. The program sends the token in the header `Authorization: Bearer akp_…`. A token works
on the API of Akaun and on MCP. See
[Connect AI assistants](./connect-ai-assistants.md).

:::caution

A program with your token can do all the actions that the token permits, also changes and deletes
if you select them. Give each token only the permissions that the program needs. Give the token
only to a program that you trust.

:::

### See your tokens

Click the **Access tokens** tab. The tab shows one row for each token. You can also open the tab
with the address `/profile?tab=token`.

Each row shows:

- the name of the token,
- `akp_…` and the last four characters of the token,
- what the token can do in each area, for example **Invoices Edit** or
  **Records View + Adjustments**. Hold the pointer on an area to see a sentence that tells what the
  token can do there,
- **Expires**: the date when the token stops working, **Never**, or an **Expired** badge,
- **Last used**: the date of the last use, or **Never**,
- the **Regenerate** and **Revoke** buttons.

If you have no tokens, the tab shows **No access tokens yet**.

### Make a token

1. Click the **Access tokens** tab.
2. Click **New token**. The **New access token** page opens.
3. Under **Token**, in **Name**, type a name that tells what the token is for, for example
   `Claude — bookkeeping`. Each token must have a different name.
4. In **Expires**, select the last day when the token works. See
   [Choose the expiry date](#choose-the-expiry-date).
5. Under **Permissions**, select a level for each area that the program needs. See
   [Choose the permissions of a token](#choose-the-permissions-of-a-token).
6. Read the **This token can** panel at the side. It tells, for each area, what the token can do.
7. At the bottom of the page, click **Create token**.
8. Akaun shows the token one time, with the warning **Copy the token now. It won't be shown
   again.** Click **Copy**.
9. Keep the token in a safe place, for example a password manager.
10. Click **Done**. Akaun shows the list of your tokens again.

The token starts with `akp_`. After you click **Done**, Akaun shows only the last four characters
of the token.

The bar at the bottom of the page shows after your first change. To remove your changes, click
**Discard**.

#### Choose the expiry date

**Expires** shows a date 6 months from today. Click the field to select a different date. You can
select only a date after today. The token works until the end of that day (UTC).

To make a token that never expires, click **×** in the field. The field then shows
**Never expires**, and a warning says "Anyone who gets this token can use it until you revoke it."
To set a date again, click the field and select a date.

:::caution

A token that never expires works until you revoke it. Use an expiry date when you can.

:::

#### Choose the permissions of a token

**Permissions** shows one row for each area, for example **Records** or **Invoices**. For each
area, select **None**, **View**, **Edit**, **Full** or **Custom**. A sentence under the name of the
area tells what your choice lets the token do. See
[Levels of access](./permissions-explained.md#levels-of-access).

- **Permissions** offers only what you may hand on to tokens and apps. Your administrator sets this
  on your groups. See [What members may hand on](./users-and-groups.md#what-members-may-hand-on).
- An area that you cannot hand on shows **You can't hand this on.**
- A level that includes an ability that you cannot hand on is not available. Hold the pointer on it
  to see why.
- **Adjustments** on **Records** is not part of a level. To give it, switch it on by its name.

If nothing can be handed on, **Permissions** says that an administrator chooses what each group may
hand on, on **Users & Groups**. Then ask your administrator.

### What a token can do

A token never does more than both of these:

- the permissions that you selected for the token,
- what you may hand on to tokens and apps at the time of each request.

Thus when your administrator removes a permission from your group, or from what your group may hand
on, each of your tokens loses it immediately. The permissions that you have as extra permissions
are never handed on to a token.

### Replace or remove a token

- To replace the secret of a token, click **Regenerate**, and then click **Regenerate** again in
  the message. The new token shows above the list one time only. Click **Copy**, and then click
  **Done**. The old token stops working immediately. The name, the permissions and the expiry date
  of the token stay the same.
- To remove a token, click **Revoke**, and then click **Revoke** again in the message.
- To remove all your tokens, click **Revoke all N tokens** under the list, and then click
  **Revoke all** in the message. The link shows when you have two or more tokens.

An expired token has no **Regenerate** button. You cannot regenerate it. Make a new token
instead.

A program that uses a revoked token cannot connect any more. You cannot undo a revoke. You can
have 50 tokens or fewer. A new password revokes all your tokens.

A superuser can also see and revoke your tokens in **Users & Groups**, but cannot make a token for
you. See [Revoke the tokens of a user](./users-and-groups.md#revoke-the-tokens-of-a-user).

## Connected apps

The **Connected apps** tab shows each app that you let read your data, for example an AI
assistant. For each app, it shows:

- the name of the app,
- the access that you gave, for example `records:read`,
- the date of the connection and the date when it expires,
- **Last used**: the last time that the app read your data, or **Never**.

If no app is connected, the tab shows **No apps connected.**

To disconnect an app:

1. Click the **Connected apps** tab.
2. Find the app.
3. Click **Revoke access**.

Akaun shows **App access revoked**. The app cannot read your data any more. To use the app again,
connect it again.

A new password also disconnects all your apps. **Sign out** does not disconnect them.

A connected app also never does more than what you may hand on to tokens and apps at that time.

## Navigation

Use this tab to change the order of the main screens in the sidebar. You can also choose the
screens on the bottom bar of a phone. The list shows only the screens that you have the **View**
permission for.

1. Click the **Navigation** tab.
2. Drag an item by its handle to change the order.
3. Select **Show on mobile** for each screen that you want on the bottom bar.
4. Click **Save changes**.

Akaun shows **Navigation order saved**.

You can select **Show on mobile** for five screens or fewer. After the fifth, the other boxes are
not available.

See [Choose your navigation](../01-getting-started/finding-your-way.md#choose-your-navigation).

## Notes and limits

- The **Connected apps** tab is empty when the administrator did not enable OAuth. See
  [Connect AI assistants](./connect-ai-assistants.md).
- Your groups and permissions are not on your profile. Only a superuser can change them. See
  [Users and groups](./users-and-groups.md).
