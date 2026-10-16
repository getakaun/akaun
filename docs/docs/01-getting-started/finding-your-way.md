---
sidebar_position: 4
---

# Find your way around

This page tells you about the parts of the Akaun screen. Read it after your first sign-in. It
applies to all screens in Akaun.

## The first screen

After you sign in, Akaun opens the **Records** screen. If you cannot see records, Akaun opens the
**Dashboard**. If you cannot see the **Dashboard** either, Akaun opens **Settings**.

## The sidebar

On a computer, the sidebar is on the left side of the screen. From the top to the bottom, it
has these parts.

**Workspace** shows the main screens:

- **Dashboard**
- **Records**
- **Quotations**
- **Invoices**
- **Contacts**
- **Auto Import**
- **Accounts**
- **Reports**

You see only the screens that you have the **View** permission for. A superuser sees all of
them. You can change the order on your profile. See [Choose your navigation](#choose-your-navigation).

The number next to **Records** is the number of expense records that are not fully paid.

Bank reconciliation has no item in the sidebar. To reconcile an account, open the account and
click **Reconcile**. See [Bank reconciliation](../07-bank-reconciliation.md).

**Administration** shows **Users & Groups**. Only a superuser sees this part. See
[Users and groups](../09-administration/users-and-groups.md).

Below these parts are three more items:

- **Settings** opens the settings of the book. It shows only if you have the **View** permission on
  **Settings**. See [Settings reference](../09-administration/settings-reference.md).
- **Light** or **Dark** shows the current theme. Click it to change to the other theme.
- **Collapse** makes the sidebar narrow, with icons only. To make it wide again, click the arrow
  at the same position. On a small screen, such as a tablet, the sidebar is narrow at the start.

At the bottom, the sidebar shows your name and email. Click the user menu button (three dots)
next to your name to open the user menu:

- **Profile** opens your profile. See [Your profile](../09-administration/your-profile.md).
- **Sign out** ends your sign-in on this browser.

Under your name, the sidebar shows the version of Akaun, for example `v0.1.7`. Give this version
when you report a problem.

## On a phone

On a screen narrower than 768 pixels, Akaun does not show the sidebar. It shows these items
instead:

- The bottom bar. It shows up to five main screens. At the start, it shows **Dashboard**,
  **Records** and **Auto Import**, if you can see them.
- The menu button (☰) at the top left. It opens a menu with the other main screens under
  **More**. The menu also has **Settings**, the theme item (**Light mode** or **Dark mode**),
  **Users & Groups** for a superuser, **Profile** and **Sign out**.

### Choose your navigation

You can choose the order of the main screens, and the screens on the bottom bar.

1. Open the user menu and click **Profile**.
2. Click the **Navigation** tab.
3. To change the order, drag an item by its handle.
4. For each screen that you want on the bottom bar, select **Show on mobile**. You can select
   five screens or fewer.
5. Click **Save changes**.

Akaun shows **Navigation order saved**. The sidebar and the bottom bar use the new order.

### Add Akaun to the home screen of a phone

You can open Akaun from an icon on the home screen of your phone, as an app.

1. Open the address of Akaun in the browser of the phone.
2. Sign in.
3. In the menu of the browser, choose the item that adds the page to the home screen. Its name
   is different in each browser, for example "Add to Home Screen" or "Install app".

The Akaun icon shows on the home screen. Akaun opens in its own window, on the **Dashboard**. If
you cannot see the **Dashboard**, Akaun opens **Settings**.

Akaun does not work offline. The phone must connect to your Akaun server. Some browsers show the
install item only for an HTTPS address.

## Live updates

Akaun shows the changes of other users without a reload. This also applies to your changes in a
different browser tab. These screens update live: **Records**, **Contacts**, **Accounts**,
**Quotations**, **Invoices**, **Dashboard** and **Auto Import**.

If the connection to the server stops, the browser connects again by itself. If a list does not
look correct, reload the page.

## Lists

Each main screen starts with a list, for example the list of records. On the **Records** screen,
the filters are part of the address in the browser. You can copy the address to give the same
list to a different user.

The first cell of each row is a link. Click the row to open the item. To open the item in a new
browser tab, hold Ctrl (Cmd on a Mac) and click the link. You can also click the link with the
middle mouse button.

## Detail pages

Each record, account, contact, quotation and invoice has its own page and its own address. You
can copy the address and send it to a different user. That user also needs the permission to
see the item.

On a wide screen, the page has two columns. The left column shows the item. The right column
shows the related items, for example the attachments, the payments and the **History**. On a
narrow screen, the two columns show one above the other.

### Change an item on its page

You change an item directly on its page. There is no separate edit screen.

1. Open the item.
2. Change the fields.
3. In the save bar at the bottom of the page, click **Save changes**. On some pages, the button
   is **Save**.

The save bar shows only after you change a field. It shows **Unsaved changes**. To remove your
changes, click **Discard**.

If the fields do not let you type, you do not have the **Change** permission, or the record is
locked. See [Locked records](../02-concepts/locked-records.md).

### Leave a page with unsaved changes

If you go to a different page in Akaun before you save, Akaun shows **Leave without saving?**.

- Click **Cancel** to stay on the page and keep your changes.
- Click **Discard and leave** to lose your changes and go to the other page.

The **Settings** page asks the same question with different labels: **Keep editing** and
**Discard changes**.

Akaun does not ask when you reload the page or close the browser tab. Your changes are then
lost. Save before you do this.

### Make a new item

- A new record, payment, quotation or invoice opens on a full page. After you save it, Akaun
  opens the page of the new item. A payment that you start from an invoice is different: after
  you save it, Akaun opens the invoice again.
- A new account, contact or opening balance opens in a panel at the side of the screen. After
  you save it, you stay on the same screen. A new account or contact shows in the list.

## Go back

At the top left of each detail page is a back link, for example **Records**. Click it to go back
to the previous page. Akaun keeps the filters and the position in the list.

If you opened the page from a different page, the link shows **Back**. If you opened the page
from a shared address, the link opens the list.

## Next step

Read [Records](../02-concepts/records.md) to learn how Akaun keeps your books.
