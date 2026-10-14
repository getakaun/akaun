---
sidebar_position: 1
---

# Quotations

A quotation offers a price to a customer before you do the work. A quotation does not change the
books. Use it when a customer asks for a price in writing. When the customer agrees, make an
invoice from the quotation.

:::info

To make a quotation, you need the **Add** permission on quotations. To change one or its status,
you need **Change**. To delete one, you need **Delete**. To revise one, you need **Add** and
**Change** on quotations. To make an invoice from a quotation, you need **Change** on quotations
and **Add** on invoices.

:::

## The Quotations list

Open **Quotations** to see all quotations. Each row shows the customer, the quotation number, the
status, the date, the expiry date and the amount.

The tabs above the list filter it by status:

- **All**
- **Draft**
- **Sent**
- **Accepted**
- **Declined**
- **Converted**
- **Superseded**
- **Expired**

Each tab shows the number of quotations in it. An expired quotation shows only on the **Expired**
tab. It does not show on the **Draft** tab or the **Sent** tab.

To find a quotation, use these controls:

- **Date**: choose a **From date** and a **To date**. The list shows quotations with an issue date
  in that range.
- The search box (**Search QT#, customer, ref…**): type a word. Akaun finds it in the quotation
  number, the customer name, the reference, the notes, the terms and the line items.
- **Clear**: removes the date filter and the search, and shows the **All** tab again. It shows only
  when a filter is on.

Above the list, four cards show totals in the main currency: **Sent**, **Accepted**,
**This month** and **All recorded**. Below the filters, **Filtered total** shows the total of the
rows on the list.

## Make a quotation

1. On the **Quotations** screen, click **New quotation**.

   The **New quotation** page opens. **Issue date** shows today. **Expiry date** shows a date
   that comes from **Settings**. See [Default terms](#default-terms).

2. Optional: to change the expiry date, click a button below **Expiry date**: **None**, **15d**,
   **30d** or **60d**. Or choose a date in **Expiry date**.

   **None** removes the expiry date. **30d** sets the expiry date to 30 days after the issue date.

3. In **Customer**, type a part of the name of the customer.
4. Choose the customer from the list.

   The list shows only contacts with the role **Customer**. If the customer is not in the list,
   click **Create "Acme Sdn Bhd"** (with the name that you typed). When you save the quotation,
   Akaun adds a new contact. The new contact is a **Business** with the role **Customer**.

5. If the price is in a foreign currency, choose the currency in **Currency**.

   A rate field shows, for example **Rate (1 USD = ? MYR)**. Akaun tries to find the rate for the
   issue date. If it finds no rate, type the rate.

6. Optional: in **Reference**, type a reference, for example the order number of the customer.
7. In **Line items**, in **Description**, type what you sell.
8. In **Qty**, type the quantity.
9. In **Unit Price**, type the price of one unit.

   **Total** shows the amount of the line. **Subtotal:** shows the total of all lines.

10. To add a line, click **+ Add line**.
11. Optional: in **Notes**, type a note for the customer.
12. Optional: in **Terms & conditions**, type your terms.
13. In the bar at the bottom of the page, click **Create quotation**.

A quotation must have a customer and at least one line with a description. If one is missing, the
bar at the bottom tells you what to add. A line with a price must have a description. The
quantity must be more than zero, and the price cannot be less than zero.

To remove a line, click the bin icon at the end of the line. A quotation always keeps one line.
When you save, Akaun removes each empty line.

If you click a button below **Expiry date** and then change the issue date, the expiry date
moves with the issue date.

## Result

Akaun saves the quotation and opens its page. Akaun gives the quotation a number, and its status is
**Draft**.

The page shows the **Line items** and the **Details**. **History** in the rail shows who made each
change, and when.

## Change a quotation

1. Open the quotation.
2. Click **Edit**.
3. Change the fields.
4. In the bar at the bottom of the page, click **Save changes**.

Nothing is saved until you click **Save changes**. To leave without saving, click **Cancel**. A
change of the issue date does not change the exchange rate. If necessary, type a new rate.

After a quotation leaves **Draft**, the customer has a copy. From then on, you can change only the
expiry date, the reference, the notes and the terms and conditions. The customer, the issue date,
the currency, the rate and the line items are fixed. To change them, revise the quotation. See
[Revise a quotation](#revise-a-quotation).

You cannot change a converted or a superseded quotation. On these, **Edit** does not show.

## Change the status of a quotation

The status tells where the quotation is with the customer. The buttons at the top of the
quotation page change the status. Each status shows different buttons:

| Status | Buttons |
|---|---|
| **Draft** | **Mark as sent**, **Mark accepted** |
| **Sent** | **Mark accepted**, **Mark declined**, **Revise**, **Convert** |
| **Accepted** | **Undo acceptance**, **Revise**, **Convert** |
| **Declined** | **Reopen**, **Revise** |
| **Converted** | none |
| **Superseded** | none |

1. Open the quotation.
2. Click the button for the new status.

Akaun saves the new status at once. **History** shows the change.

**Mark as sent** does not send an email. It records that the customer has the quotation. Give the
PDF to the customer yourself. See [Print a quotation](#print-a-quotation).

**Undo acceptance** and **Reopen** put the quotation back to **Sent**. A quotation never goes back
to **Draft**. To change a quotation that the customer has, revise it.

## Revise a quotation

Revise a quotation when the customer asks for a different price, other items or other terms
before you make the invoice. Akaun keeps the quotation that the customer has, and makes a new
version of it. The customer can then see which version replaces which.

**Revise** shows on a quotation with the status **Sent**, **Accepted** or **Declined**.

1. Open the quotation.
2. Click **Revise**.
3. In the dialog, click **Revise**.

Akaun makes a new draft quotation and opens its page. The new quotation has the same number with
`-R1` at the end, for example `QT20261009-001-R1`. A revision of that has `-R2`, and so on. The new
quotation has the same customer, currency, rate, line items, reference, notes and terms. Its
issue date is today, and its expiry date comes from **Settings**.

The old quotation gets the status **Superseded**. It does not change in any other way. On the old
quotation, the **Replaced by** card opens the new one. On the new quotation, the **Revision of**
card opens the old one.

Change the new quotation, and then mark it as sent.

If you delete the draft revision, the old quotation goes back to **Sent**. If the customer had
accepted or declined it, mark it again.

### After the invoice

When the quotation is converted, it is closed. If the customer asks for a change after you make the
invoice, do not revise the quotation. Change the invoice: while it is a draft, edit it. After you
mark it as sent, cancel and reissue it. See
[Cancel and reissue an invoice](./invoices.md#cancel-and-reissue-an-invoice).

## Make an invoice from a quotation

**Convert** shows on a quotation with the status **Sent** or **Accepted**. It makes a draft
invoice from the quotation. A sent quotation that has expired cannot be converted. Change its
expiry date, or revise it, first.

1. Open the quotation.
2. Click **Convert**.

Akaun makes a draft invoice and opens its page. The invoice gets these values from the quotation:

- The customer.
- The currency and the exchange rate.
- The line items.
- The reference, the notes and the terms and conditions.

The issue date of the invoice is today. The due date comes from **Invoice due in (days)** in
**Settings**. See [Default terms](#default-terms).

The status of the quotation is then **Converted**. On the quotation page, the **Became** card in
the rail opens the invoice. On the invoice page, the **Came from** card opens the quotation.

A draft invoice does not change the books. Check it, and then mark it as sent. See
[Invoices](./invoices.md).

### Undo a conversion

You cannot change, delete or change the status of a converted quotation. To undo a conversion,
delete the draft invoice. The quotation then goes back to **Accepted**, and you can convert it
again. You cannot delete the invoice after you mark it as sent. See
[Delete a draft invoice](./invoices.md#delete-a-draft-invoice).

## Print a quotation

1. Open the quotation.
2. Click **Print**.

A PDF of the quotation opens in a new browser tab. Use the browser to print it or save it.

The PDF shows these items:

- Your company name, address and registration number. These come from **Settings**, on the
  **Company** tab. If **Header** on the **Templates** tab is **Letterhead**, your letterhead prints
  at the top in place of the company name.
- The customer under **Bill to**, with the address, registration number and phone of the contact.
- The issue date, **Valid until** (the expiry date) and the reference.
- The line items, **Subtotal** and **Total**.
- The notes and the terms and conditions.

All amounts on the PDF are in the currency of the quotation. The headings of the price and amount
columns name the currency, for example **Unit price (USD)**. **Total** shows the currency code after
the amount, for example `1,000.00 USD`.

The colour of the PDF comes from **Accent color** in **Settings**, on the **Templates** tab.

A superseded quotation prints with the word **SUPERSEDED** across each page.

## Delete a quotation

On a converted quotation and on a superseded quotation, **Delete** is disabled. Akaun keeps a
superseded quotation, because it is what the customer has.

:::caution

You cannot undo a delete. Akaun removes the quotation permanently.

:::

1. Open the quotation.
2. Click **Delete**.
3. In the dialog, click **Delete**.

Akaun removes the quotation from the list.

## When a quotation expires

**Expired** shows that the expiry date is in the past. Only a quotation with the status **Draft**
or **Sent** can expire. Akaun calculates this from today's date. You do not mark a quotation as
expired.

An expired quotation shows only on the **Expired** tab. Its page shows the buttons of its status.
For example, you can still click **Mark accepted** or **Convert** on an expired quotation that was
sent.

A quotation without an expiry date never expires.

## Default terms

A new quotation gets an expiry date from **Quotation valid for (days)** in **Settings**, on the
**Templates** tab. The default is 30 days. If the setting is empty, a new quotation has no expiry
date. You can change the expiry date on each quotation.

See [Settings reference](../09-administration/settings-reference.md#templates).

## Notes and limits

- A quotation does not change any account or any contact balance.

## Related

- [Invoices](./invoices.md)
- [Contacts](../06-contacts.md)
- [Foreign currency](../02-concepts/foreign-currency.md)
- [Settings reference](../09-administration/settings-reference.md)
