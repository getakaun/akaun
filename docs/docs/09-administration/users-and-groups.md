---
sidebar_position: 1
---

# Users and groups

Use the **Users & Groups** screen to add the people who work in your book. A group controls
what each person can do. Do these tasks after the first sign-in, and each time a person joins or
leaves.

:::info

Only a superuser can open **Users & Groups**. The screen needs **Manage** on **Users & Groups**, and
only a superuser group has it. Akaun does not open the screen for other users. In the sidebar, the
screen is under **Administration**.

:::

## How access works

- A permission lets a user do one thing in one area, for example **Add** on **Records**. See
  [Permissions explained](./permissions-explained.md).
- A group is a set of permissions. A user can be in more than one group.
- A user gets each permission that one or more of their groups gives. A group cannot remove a
  permission that a different group gives.
- A group with the **Superuser** switch on gives all permissions in all areas. Its members are
  superusers.
- You can give one user extra permissions. Extra permissions only add. They cannot remove a
  permission that a group gives.
- Each group also sets what its members may hand on to their tokens and apps. See
  [What members may hand on](#what-members-may-hand-on).

## The groups that Akaun makes

Akaun makes four groups. At each start of the server, Akaun makes each of these groups again if
it is missing. **Administrators** is a superuser group. Its members can do all actions in all
areas, and they can open **Users & Groups**.

The other three groups give these permissions:

| Area | **Bookkeeper** | **Data Entry** | **Reviewer** |
|---|---|---|---|
| **Records** | View, Add, Change | Add | View |
| **Auto Import** | View, Upload | Upload | View |
| **Contacts** | View, Add, Change | View, Add | View |
| **Quotations** | View, Add, Change, Revise, Convert | Add | View |
| **Invoices** | View, Add, Change, Send, Void | Add | View |
| **Reconciliation** | View, Add, Change, Match | none | View |
| **Accounts** | View, Add, Change | none | View |
| **Reports** | View | none | View |
| **Dashboard** | none | none | none |
| **Settings** | View | View | View |
| **Users & Groups** | none | none | none |

Read these notes before you choose a group:

- No group except **Administrators** gives **Delete**, **Adjustments** on **Records**, **Merge** on
  **Contacts** or **Manage** on **Settings**.
- **Bookkeeper** does not have **Change**, **Confirm** or **Profiles** on **Auto Import**. Thus a
  Bookkeeper can upload files, but cannot confirm or skip the items. To let a Bookkeeper confirm
  items, give **Confirm** on **Auto Import**.
- Only a superuser can change the settings. To let a different user change them, give **Manage** on
  **Settings**.
- Each of the three groups lets its members hand on to tokens and apps all the permissions that the
  group gives, except **View** on **Settings**.
- A screen opens only for a user with **View** on its area. **Data Entry** has **View** on
  **Contacts** only. Thus a Data Entry user cannot open **Records**, **Auto Import**,
  **Quotations** or **Invoices**.
- No group except **Administrators** has **View** on **Dashboard**.
- The description of **Administrators** mentions backups and reset. Akaun has no backup or reset
  in the screens. See [Backups and upgrades](./backups-and-upgrades.md).

## The Users tab

The **Users** tab shows one row for each user, with these columns:

- **User**: the name and the email.
- **Groups**: the groups of the user. **No groups** shows that the user is in no group.
- **Access**: **Superuser**, **Standard** or **No access**.
- **Tokens**: the number of active personal access tokens of the user, for example **2 active**,
  or **None**.
- **Created**: the date when the user was added.

## Add a user

**Email**, **Username** and **Temporary password** are necessary. Each user must have a different
email and a different username.

:::caution

Select one or more groups for each user. At each start of the server, Akaun puts each user with no
group into **Administrators**. That user then becomes a superuser.

:::

1. In the sidebar, click **Users & Groups**.
2. On the **Users** tab, click **Add user**.
3. In **Full name**, type the name of the person.
4. In **Email**, type the email address.
5. In **Username**, type the name that the person types to sign in.
6. In **Temporary password**, type a password for the first sign-in.
7. Under **Group membership**, select one or more groups.
8. If the person needs more permissions than the groups give, choose them under
   **Extra permissions**. See [Give a user extra permissions](#give-a-user-extra-permissions).
9. Click **Create user**.

Akaun shows **User created**, and the user shows in the list. Give the username and the
temporary password to the person. Tell the person to change the password on the **Security** tab
of the profile. See [Your profile](./your-profile.md).

## Change a user

:::caution

Do not change the username of the `admin` user. At each start, Akaun looks for a user with the
username `admin`. If it finds none, it adds a new `admin` user with the password `akaun-admin`.
This new user is a superuser, and anyone who knows the default password can sign in.

:::

1. On the **Users** tab, click the row of the user.
2. If necessary, change **Full name**, **Email** or **Username**.
3. If the user needs a new password, type it in **Reset password**.
4. Under **Group membership**, select or clear the groups. Keep one or more groups selected.
5. Click **Save changes**.

Akaun shows **User saved**. If **Reset password** is empty, the password does not change. A new
password also disconnects all the connected apps of the user, and revokes all the tokens of the
user.

## Give a user extra permissions

Use extra permissions when one person needs one more ability than their groups give.

1. On the **Users** tab, click the row of the user.
2. Under **Extra permissions**, find the area.
3. Select a higher level for the area, or select **Custom** and switch on the ability that the user
   needs. See [Choose the permissions](#the-permission-tree).
4. Click **Save changes**.

**Extra permissions** already shows what the groups of the user give:

- An ability that a group gives is on and shows **From a group**. You cannot switch it off there.
  To remove it, change the groups of the user.
- A level that is lower than what the groups give is not available. Hold the pointer on it to see
  **A group already grants more than this.**

Extra permissions work only when the user is in one or more groups. The **Extra permissions**
section does not show for a superuser, because a superuser has all permissions.

Extra permissions are never handed on. The tokens and the connected apps of the user cannot use
them.

## The tokens of a user

A personal access token lets a program connect to Akaun as a user. Only the user can make a token,
signed in as themselves, on the profile. See [Your profile](./your-profile.md#access-tokens). You
cannot make a token for a different user. You can see and revoke the tokens of a user.

1. On the **Users** tab, click the row of the user.
2. Look under **Personal access tokens**.

Each row shows the name, the last four characters, what the token can do in each area, the expiry
date and the date of the last use. If the user has no tokens, the section shows **No access tokens
yet**. The **Tokens** column of the list shows the number of active tokens of the user.

For a program that does not act for one person, for example a shared AI assistant, add a separate
user with only the permissions that the program needs. Then sign in as that user, and make the
token on the profile of that user. See [Add a user](#add-a-user) and
[Make a token](./your-profile.md#make-a-token).

### Revoke the tokens of a user

:::caution

A program that uses a revoked token cannot connect any more. You cannot undo this.

:::

1. On the **Users** tab, click the row of the user.
2. Under **Personal access tokens**, find the token.
3. Click **Revoke**.
4. In the message, click **Revoke**.

To revoke all the tokens of the user, click **Revoke all N tokens** under the list, and then click
**Revoke all** in the message. The link shows when the user has two or more tokens.

The token buttons act immediately. You do not need **Save changes** for them.

A new password in **Reset password** also revokes all the tokens and the connected apps of the
user.

## Stop the access of a user

:::caution

Do not leave a user in no group. The panel says that such a user sees an empty app. This is true
only until the next start of the server. At each start, Akaun puts each user with no group into
**Administrators**. That user then becomes a superuser.

:::

To stop the access of a user safely, put the user in a group with no permissions:

1. On the **Groups** tab, make a new group with no permissions, for example `No access`. See
   [Make a group](#make-a-group).
2. On the **Users** tab, click the row of the user.
3. Under **Group membership**, clear all the groups.
4. Select the `No access` group.
5. Under **Extra permissions**, select **None** for each area.
6. In **Reset password**, type a new password that the person does not know.
7. Click **Save changes**.
8. Under **Personal access tokens**, make sure that no token shows. If a token shows, click
   **Revoke all N tokens** or **Revoke**. See [Revoke the tokens of a user](#revoke-the-tokens-of-a-user).

The **Access** column shows **Standard**. The user cannot sign in with the old password. The new
password revokes all the tokens and disconnects all the connected apps of the user. If the user is
still signed in, the user cannot open the screens of the book. The records of the user stay in the
book.

## Remove a user

:::caution

You cannot undo the removal of a user. Do not remove the `admin` user: at the next start, Akaun
adds a new `admin` user with the password `akaun-admin`. If the user made records or other items,
Akaun can refuse the removal and show **Failed to delete user**. Then use
[Stop the access of a user](#stop-the-access-of-a-user) instead.

:::

1. On the **Users** tab, click the row of the user.
2. Click **Remove**.
3. In the message of the browser, click **OK**.

Akaun shows **User removed**, and the row goes from the list. You cannot remove yourself. If you
try, Akaun shows **Cannot delete your own account**.

## The Groups tab

The **Groups** tab shows the list of groups on the left. Each item shows the number of members and
the number of permissions. Click a group to see its details on the right.

### Make a group

1. On the **Groups** tab, click **New group**. Akaun adds a group with the name **New group** and
   opens it.
2. At the top of the group, type a name for the group.
3. In the description box, type what the group is for.
4. Under **Members can**, choose a level for each area that the group gives. See
   [Choose the permissions](#the-permission-tree).
5. Under **Members may hand on to tokens & apps**, choose what the tokens and the apps of the
   members can do. See [What members may hand on](#what-members-may-hand-on).
6. Click **Save changes**.

Akaun shows **Group saved**. **Save changes** and **Reset** show only when the group has unsaved
changes. **Reset** removes your changes.

### Choose the permissions \{#the-permission-tree}

**Members can**, **Members may hand on to tokens & apps** and **Extra permissions** use the same
editor. It shows one row for each area, for example **Records** or **Invoices**. Each row has a
level picker with **None**, **View**, **Edit**, **Full** and **Custom**. A sentence under the name
of the area tells what the choice allows, for example "Can see, add, change and send invoices.
Cannot delete or void."

- **View** gives the **View** ability only.
- **Edit** gives **View** and each ability that adds or changes items. For example, on **Invoices**
  it gives **View**, **Add**, **Change** and **Send**.
- **Full** gives all the abilities of the area, also **Delete**, except **Adjustments**.
- **Custom** shows a switch for each ability of the area, with a description. Use it to give one
  ability.

See [Levels of access](./permissions-explained.md#levels-of-access) for the abilities in each
level.

- An area with one ability, for example **Reports** or **Dashboard**, offers only **None** and
  **View**.
- A set of abilities that is not the same as a level shows as **Custom**. For example, **Data
  Entry** has **Add** on **Records** but no **View**.
- **Adjustments** on **Records** is never part of a level. It has its own switch under **Records**,
  so you give it only on purpose.
- A warning sign shows an ability that gives a lot of power, for example **Adjustments** on
  **Records** and **Manage** on **Settings**.
- A level that includes an ability that you cannot choose is not available. Hold the pointer on it
  to see **Includes something that cannot be chosen here.**

The line above **Members can** shows the number of abilities that the group gives, for example
**15 of 41 granted**. **Users & Groups** does not show in the editor. Only a superuser group has
it.

The levels only help you choose. Akaun keeps each ability on its own, as before.

See [Permissions explained](./permissions-explained.md).

### What members may hand on

**Members may hand on to tokens & apps** is a second list of areas under **Members can**. It is the most that
the personal access tokens and the connected AI apps of a member can do. Each member chooses less
for each token or app. A member cannot choose a permission that is not in this list.

- You can choose only what the group gives under **Members can**. An area that the group does not
  give shows **Not granted to this group.** When you remove a permission under **Members can**,
  Akaun also removes it here.
- When you give the group a new permission, Akaun does not add it here. Choose it here if the
  tokens and the apps of the members need it.
- A token or an app never does more than what its user may hand on at that time. When you remove a
  permission in either list, each token and each app of the members loses it on its next request.
- When a user is in two or more groups, the user may hand on each permission that one or more of
  these groups allow.
- A permission that a user has as an extra permission is never handed on.

:::caution

Do not let members hand on **Adjustments** or **Manage** on **Settings** unless a program must do
these things. A program with a token acts without a person who checks each step.

:::

A superuser group does not show this list. The tokens and the apps of a superuser can have all
permissions except **Manage** on **Users & Groups**.

### The Superuser switch

:::caution

When you set **Superuser** to on, each member of the group becomes a superuser. A superuser can do
all actions in all areas. A superuser can also add users, remove users and make other users
superusers. Use it only for people that you trust with all the books.

:::

1. Click the group.
2. Click the **Superuser** switch.
3. Click **Save changes**.

The group shows **Superuser**. Under **Members can**, the group shows **Every permission**, and the
permission lists do not show.

### Protected groups

**Administrators** shows **Protected**. You cannot change its name, its description, its
**Superuser** switch or its permissions. You cannot delete it. You can change, rename and delete
all the other groups, also **Bookkeeper**, **Data Entry** and **Reviewer**.

### Keep one superuser

At least one user must stay in a superuser group. Only a superuser can manage users and groups.
Thus Akaun refuses a change that removes the last one, and shows **At least one user must stay in a
superuser group, or nobody could manage users and groups.** These changes can show it:

- You turn off **Superuser** on the only other superuser group that has members.
- You remove the last superuser from their superuser group.
- You delete the last superuser.

:::caution

Keep two or more trusted users in **Administrators**. If the only superuser forgets the password,
no screen in Akaun can give a new password to that user.

:::

### Delete a group

You can delete a group only when it has no members and is not protected.

1. Click the group.
2. Click the menu button (three dots) next to the name.
3. Click **Delete group**.
4. In the message of the browser, click **OK**.

Akaun shows **Group deleted**.

Akaun makes the default groups (**Administrators**, **Bookkeeper**, **Data Entry** and **Reviewer**)
one time only, when you install it. If you delete or rename **Bookkeeper**, **Data Entry** or
**Reviewer**, Akaun does not make it again. To get it back, make a new group and choose its
permissions.

## Notes and limits

- A change to the permissions applies on the next action of the user, and on the next request of
  each token and app of the user. The user does not need to sign in again.
- A user can have 50 personal access tokens or fewer.
- A sign-in stays valid in the browser for up to 30 days. A new password does not end a sign-in
  that is already open. To stop the access immediately, use a group with no permissions.
