---
sidebar_position: 6
---

# Contacts and their balances

A contact is a person or a business that you work with. Akaun uses contacts to show who owes
money, and to whom. This page tells how Akaun calculates the balance of each contact.

## What a contact is

Each contact has an entity type: **Individual** or **Business**.

A contact can also have one or more roles. The roles are **Customer**, **Supplier**, **Employee**
and **Partner**. For example, a business that buys from you and also sells to you is a customer
and a supplier. A contact can also have no role.

A record can name one contact. A payment to several contacts names a contact on each allocation.

## When a record must name a contact

A record that uses **Accounts Payable** or **Accounts Receivable** must name a contact. These two
accounts hold the money that is owed. The contact tells who owes the money, or to whom it is owed.
On such a record, the **Contact** field shows a star (*), and you cannot save the record without
a contact.

On all other records, the contact is optional.

## How Akaun calculates a balance

Akaun does not keep a separate account for each contact. It calculates the balance of a contact
from the records that name the contact:

- The receivable is the money that the contact owes you. It comes from records on **Accounts
  Receivable** that are not paid yet.
- The payable is the money that you owe the contact. It comes from records on **Accounts Payable**
  that are not paid yet.

Payments reduce the balance. You cannot type a balance. Thus the balance of a contact always
agrees with the records.

For example, a customer gets an invoice of 500.00 and pays 200.00. The balance of the customer is
a receivable of 300.00.

If a contact has a receivable and a payable at the same time, Akaun shows the difference as one
balance.

## Where you see the balance

- The **Contacts** screen has a **Balance** column. Each balance has the tag **Receivable** (the
  contact owes you) or **Payable** (you owe the contact). A dash (—) shows that nothing is
  outstanding.
- If something is outstanding, the **Contacts** screen shows two totals under its title:
  **Payables** and **Receivables**.
- The page of a contact shows the balance at the top. The text beside it is **Receivable**,
  **Payable** or **nothing outstanding either way**.
- On the page of a contact, **See everything with this contact** opens the **Records** screen with
  only the records of this contact.

You see balances only if you have the permission to see records.

## Related

- [Contacts](../06-contacts.md)
- [Bills you pay later](../03-everyday-tasks/bills-you-pay-later.md)
- [Getting paid](../05-sales/getting-paid.md)
- [Outstanding, partially paid and paid](./owed-and-paid.md)
- [Find records](../03-everyday-tasks/find-records.md)
