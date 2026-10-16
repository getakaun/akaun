---
sidebar_position: 7
---

# Contacts

A contact is a person or a business that you work with, for example a customer or a supplier. Use
the **Contacts** screen to add contacts, change their details, see what they owe and merge
duplicate contacts.

To learn how Akaun calculates the balance of a contact, read
[Contacts and their balances](./02-concepts/contacts-and-balances.md).

:::info

To add a contact, you need the **Add** permission on contacts. To change one, you need **Change**.
To delete one, you need **Delete**. To find duplicates or merge contacts, you need **Merge**,
**Change** and **Delete**.

:::

## The Contacts list

Open **Contacts** to see all contacts in name order. Each row shows the name, the type, the roles
and the email. A contact without a role shows **no roles**.

The tabs above the list filter it by role:

- **All**
- **Customer**
- **Supplier**
- **Employee**
- **Partner**

A contact with two roles shows on both tabs.

To find a contact, use these controls:

- **Type**: choose **All types**, **Individual** or **Business**.
- The search box (**Search name, email, reg no…**): type a part of the name, the email or the
  registration number.
- **Clear**: removes the type filter and the search, and selects the **All** tab again. **Clear**
  shows only when a type filter or a search is active.

### Balances on the list

If you have the permission to see records, the list also shows the **Balance** column. Each
balance shows **Receivable** or **Payable**. **Receivable** is money that the contact owes to the
business. **Payable** is money that the business owes to the contact. A dash (—) shows that nothing
is outstanding.

Under the title, the screen shows two totals:

- **Payables**: the total that the business owes to all contacts.
- **Receivables**: the total that all contacts owe to the business.

The totals show only when one of them is more than zero.

## Add a contact

1. On the **Contacts** screen, click **New contact**.

   The **Add contact** panel opens.

2. In **Entity type**, click **Individual** or **Business**.
3. In **Legal name**, type the name of the contact.
4. Optional: in **Roles**, click each role that applies: **Customer**, **Supplier**, **Employee**
   or **Partner**.
5. Optional: type the **Registration no.**, the **Email** and the **Phone**.
6. Optional: type the **Address**.
7. Optional: in **Remark**, type a note for your team.
8. Click **Create contact**.

**Create contact** is not available until you choose an **Entity type**.

Akaun adds the contact to the list and closes the panel.

The **Partner** role does not make accounts for the partner. The **Partners' Equity** report
uses it to divide the profit. See [Partners' Equity](./08-reports/partners-equity.md).

:::tip

You can also add a customer when you write a quotation or an invoice. In **Customer**, type the new
name and click **Create "…"**. The button shows the name that you typed. When you save, Akaun adds
the contact as a **Business** with the **Customer** role. You need the **Add** permission on
contacts. The **Contact** field on a record has the same button.

:::

## The contact page

Click a contact on the list to open its page.

At the top, the page shows the entity type, the roles and the name. If you have the permission to
see records, it also shows the balance. The text beside the balance is **Receivable**,
**Payable** or **nothing outstanding either way**.

The page has these sections:

- **Contact details**: **Entity type**, **Legal name** and **Roles**.
- **Contact information**: **Email**, **Phone**, **Registration no.**, **Address** and **Remark**.
- **Contact ledger** (in the rail): **See everything with this contact**, with the number of
  records and invoices. Click it to open the **Records** screen with only the records of this
  contact.
- **History** (in the rail): who made each change, and when.

## Change a contact

1. Open the contact.
2. Change the fields in **Contact details** or **Contact information**.

   A bar shows at the bottom of the page.

3. Click **Save changes**.

To stop without a change, click **Discard**.

A change to the name shows on all records, quotations and invoices of the contact. A PDF that you
print after the change shows the new details.

## Find duplicate contacts

Duplicate contacts split the records and the balance of one customer or supplier into two. Use
**Find duplicates** to find them.

1. On the **Contacts** screen, click **Find duplicates**.

   The **Duplicate contacts** panel opens.

Akaun puts contacts in one group when they have one of these items in common:

- **Same name**: Akaun ignores capitals, punctuation and extra spaces.
- **Same email**: Akaun ignores capitals.
- **Same phone**: Akaun compares only the digits.
- **Same registration no.**: Akaun ignores capitals.

Akaun does not compare the entity type or the roles. Each group shows the reasons under its name.

If no contacts match, the panel shows **No duplicates found**.

If a group is not a set of duplicates, click **Not duplicates**. Akaun hides the group from the
panel. The group shows again the next time that you click **Find duplicates**.

## Merge contacts

When you merge contacts, you keep one contact. Akaun moves the records, quotations and invoices of
the other contacts to the contact that you keep.

The comparison table shows each contact in a column. Akaun marks each row that has different values. The
**Usage** row shows the number of records of each contact.

:::caution

You cannot undo a merge. Akaun deletes the other contacts permanently. Akaun merges the contacts
immediately when you click **Merge into selected**. No dialog asks you to confirm.

:::

1. In the group, at the top of the column, select the contact that you keep.

   Below the table, Akaun tells you which contact it keeps and which contacts it deletes. If records
   move, it also tells you how many.

2. Read this text.
3. Click **Merge into selected**.

   **Merge into selected** is not available until you select a contact.

Akaun merges the contacts. In the **Duplicate contacts** panel, Akaun removes the group. The
**Merge selected contacts** panel closes.

After the merge, the contact that you keep has these values:

- All roles of all the merged contacts.
- Its own **Registration no.**, **Email**, **Phone** and **Address**. If one of these is empty,
  Akaun copies it from a merged contact.
- Its own **Remark**. Akaun does not copy the remark of a merged contact.

### Merge contacts that you select

Use this when Akaun does not put two contacts in one group, for example two different spellings
of one name.

1. On the **Contacts** list, select the check box of each contact to merge.
2. In the bar at the bottom, click **Merge selected (2)**.

   The number is the number of contacts that you selected. The button is not available until you
   select two or more contacts. The **Merge selected contacts** panel opens.

3. Do the steps in [Merge contacts](#merge-contacts).

## Delete a contact

You can delete a contact only when nothing names it: no record, no quotation and no invoice. If
something names the contact, **Delete** is not available. Point to it to see the reason. To remove
a duplicate that has records, merge it into the correct contact.

:::caution

You cannot undo a delete. Akaun removes the contact permanently.

:::

1. Open the contact.
2. Click **Delete**.
3. In the dialog, click **Delete**.

## Notes and limits

- At this time, the screen cannot archive a contact. The tooltip on **Delete** says "Archive it
  instead", but the screen has no control for it.
- **Not duplicates** is not saved.
- When you select **Partner** in the **Add contact** panel, a note says that the partner gets two
  accounts. At this time, Akaun does not make these accounts.
- You see balances only if you have the permission to see records.

## Related

- [Contacts and their balances](./02-concepts/contacts-and-balances.md)
- [Invoices](./05-sales/invoices.md)
- [Getting paid](./05-sales/getting-paid.md)
- [Bills you pay later](./03-everyday-tasks/bills-you-pay-later.md)
- [Find records](./03-everyday-tasks/find-records.md)
