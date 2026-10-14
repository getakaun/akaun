---
sidebar_position: 2
---

# Invoices

An invoice asks a customer to pay. You write the invoice as a draft, and then you mark it as sent.
When you mark it as sent, the customer owes the amount and Akaun adds a record to the books.

:::info

To make an invoice, you need the **Add** permission on invoices. To change an invoice, mark it as
sent or cancel it, you need **Change**. To cancel and reissue it, you need **Change** and **Add**.
To delete a draft, you need **Delete**. To record a payment from the invoice page, you need **Add**
on records.

:::

## The Invoices list

Open **Invoices** to see all invoices. Each row shows the customer, the invoice number, the
status, the date, the due date and the amount.

The tabs above the list filter it:

- **All**: all invoices.
- **Draft**: invoices that you did not mark as sent yet.
- **Sent**: sent invoices that are not fully paid.
- **Paid**: sent invoices that payments cover in full.
- **Cancelled**: invoices that do not count.
- **Overdue**: sent invoices with a due date in the past that are not fully paid.

Each tab shows the number of invoices in it.

The **Status** column shows **Draft**, **Sent**, **Part paid**, **Paid**, **Overdue** or
**Cancelled**. Akaun calculates **Part paid**, **Paid** and **Overdue** from the payments and the
due date. When you record a payment, the status on the list changes at once.

Above the list, four cards show totals in the main currency:

- **Sent**: the amount that is still owed on the invoices that wait for payment.
- **Overdue**: the amount that is still outstanding on overdue invoices.
- **Paid**: the amount paid on the paid invoices.
- **All recorded**: the total of all invoices, including drafts. Cancelled invoices are not in
  this total.

To find an invoice, use these controls:

- **Date**: choose a **From date** and a **To date**. The list shows invoices with an issue date
  in that range.
- The search box (**Search IV#, customer, ref…**): type a word. Akaun finds it in the invoice
  number, the customer name, the reference, the notes, the terms and the line items.
- **Clear**: removes the filters and the search, and shows the **All** tab again. It shows only
  when a filter is on.

**Filtered total** shows the total of the rows on the list.

## Make an invoice

1. On the **Invoices** screen, click **New invoice**.

   The **New invoice** page opens. **Issue date** shows today. **Due date** shows a date that
   comes from **Settings**. See [Default terms](#default-terms).

2. Optional: to change the due date, click a button below **Due date**: **None**,
   **On receipt**, **7d**, **14d**, **30d** or **60d**. Or choose a date in **Due date**.

   **None** removes the due date. **On receipt** sets the due date to the issue date. **30d** sets
   the due date to 30 days after the issue date.

3. In **Customer**, type a part of the name of the customer.
4. Choose the customer from the list.

   The list shows only contacts with the role **Customer**. If the customer is not in the list,
   click **Create "Acme Sdn Bhd"** (with the name that you typed). When you save the invoice,
   Akaun adds a new contact. The new contact is a **Business** with the role **Customer**.

5. If the invoice is in a foreign currency, choose the currency in **Currency**.

   A rate field shows, for example **Rate (1 USD = ? MYR)**. Akaun tries to find the rate for the
   issue date. If it finds no rate, type the rate.

6. Optional: in **Reference**, type a reference, for example the order number of the customer.
7. In **Line items**, in **Description**, type what you sell.
8. In **Qty**, type the quantity.
9. In **Unit Price**, type the price of one unit.
10. To add a line, click **+ Add line**.
11. Optional: in **Notes**, type a note for the customer.
12. Optional: in **Terms & conditions**, type your terms.
13. In the bar at the bottom of the page, click **Create invoice**.

An invoice must have a customer and at least one line with a description. If one is missing, the
bar at the bottom tells you what to add. A line with a price must have a description. The
quantity must be more than zero, and the price cannot be less than zero.

To remove a line, click the bin icon at the end of the line. An invoice always keeps one line.
When you save, Akaun removes each empty line.

If you click a button below **Due date** and then change the issue date, the due date moves with
the issue date.

Akaun saves the invoice as a draft and opens its page. A draft does not change the books. The
customer owes nothing yet.

You can also make an invoice from a quotation. See
[Make an invoice from a quotation](./quotations.md#make-an-invoice-from-a-quotation).

## Change a draft invoice

1. Open the invoice.
2. Click **Edit**.
3. Change the fields.
4. In the bar at the bottom of the page, click **Save changes**.

Nothing is saved until you click **Save changes**. To leave without saving, click **Cancel**. A
change of the issue date does not change the exchange rate. If necessary, type a new rate.

## Mark an invoice as sent

**Mark as sent** shows only on a draft invoice. **Mark as sent** does not send an email. It
records that the customer owes the amount. Give the PDF to the customer yourself. See
[Print an invoice](#print-an-invoice).

:::caution

After you click **Mark as sent**, the customer owes the amount and it appears in the books. You
cannot delete a sent invoice, and you cannot change its customer, issue date, currency or lines.
Check them before you mark the invoice as sent.

:::

1. Open the draft invoice.
2. Click **Mark as sent**.

   A dialog opens, for example **Mark invoice IV20261009-001 as sent?**. It says: "This records
   the amount in the books as owed to you by the customer, from the issue date. After this its
   customer, date, currency and line items are fixed, and it can be cancelled but not deleted."

3. Click **Mark as sent**.

If Akaun cannot record the invoice, it records nothing, and the invoice stays a draft. The page
shows the reason.

## Result

Akaun saves an **Invoice** record on the **Records** screen. The record has these values:

- The date is the issue date of the invoice.
- The description is "Invoice" and the invoice number. The reference is the invoice number.
- The amount goes into **Accounts Receivable**, with the customer as the contact.
- The other line is the revenue account that **Settings** › **Books** names for **Sales revenue**.

The invoice page then shows the **Settled** card in its rail:

- **Paid so far**: the total of the payments against the invoice.
- **Outstanding**: the amount that the customer still owes.

The balance of the customer on the **Contacts** screen increases by the amount. See
[Contacts and their balances](../02-concepts/contacts-and-balances.md).

Change the invoice, not its **Invoice** record. The page of the record is read only. Its rail
has an **Invoice** card that opens the invoice. See
[Locked records](../02-concepts/locked-records.md).

## Change a sent invoice

After you mark an invoice as sent, you can still change some of its fields.

1. Open the invoice.
2. Click **Edit**.

   A note says that the customer, date, currency and line items are fixed.

3. Change the **Due date**, the **Reference**, the **Notes** or the **Terms & conditions**.
4. In the bar at the bottom of the page, click **Save changes**.

If the customer, the date, the currency or a line is wrong, or the customer asks for a different
item or price, cancel and reissue the invoice. See
[Cancel and reissue an invoice](#cancel-and-reissue-an-invoice). Do not revise the quotation that
the invoice came from: after the conversion, the invoice is the document that counts.

## Record a payment from the customer

**Record payment** shows on a sent invoice that is not fully paid. It opens a receipt for this
invoice. See [Getting paid](./getting-paid.md#record-a-payment-from-an-invoice).

## Overdue invoices

An invoice is overdue when it is sent, its due date is in the past, and it is not fully paid. On
the invoice page, **OVERDUE** shows beside the **Due date**. On the list, the status of the invoice
is **Overdue**.

An invoice without a due date is never overdue. A draft, a paid invoice and a cancelled invoice
are never overdue.

## Cancel an invoice

Cancel an invoice that you sent by mistake, or that the customer will not pay. **Cancel invoice**
shows on a sent invoice when no payment is recorded against it.

If a payment is recorded against the invoice, take the payment back first. See
[Take a payment back](../02-concepts/owed-and-paid.md#take-a-payment-back).

:::caution

You cannot undo a cancellation. Akaun removes the **Invoice** record from the books. The amount
leaves the money that customers owe you and the income. This also changes the reports for the
period of the issue date.

:::

1. Open the invoice.
2. Click **Cancel invoice**.

   A dialog opens, for example **Cancel invoice IV20261009-001?**.

3. Click **Cancel invoice**.

   To close the dialog and keep the invoice, click **Keep it**.

The invoice keeps its number, and its status is **Cancelled**. The **Invoice** record is no
longer on the **Records** screen. The balance of the customer decreases by the amount. A cancelled
invoice cannot be changed or deleted.

If the invoice was made from a quotation, the quotation goes back to **Accepted**. You can convert
it again, or mark it declined.

## Cancel and reissue an invoice

Use **Cancel & reissue** to correct a sent invoice: a wrong line, a new price, or another item that
the customer asks for. Akaun cancels the invoice in the same way as **Cancel invoice**, and makes a
draft copy of it with a new number. **Cancel & reissue** shows where **Cancel invoice** shows, when
you also have the **Add** permission on invoices.

1. Open the invoice.
2. Click **Cancel & reissue**.
3. In the dialog, click **Cancel & reissue**.

Akaun opens the new draft invoice. It has the same customer, currency, rate, line items,
reference, notes and terms. Its issue date is today. Its due date is the same number of days after
the issue date as on the old invoice.

Change the draft, and then mark it as sent. Give the new PDF to the customer.

The old invoice is **Cancelled**, and its PDF prints with **VOID**. On the old invoice, the
**Replaced by** card opens the new one. On the new invoice, the **Replaces** card opens the old one.
If the invoice was made from a quotation, the quotation stays **Converted** and now points at the
new invoice.

If a payment is recorded against the invoice, you cannot cancel or reissue it. Take the payment
back first.

### An invoice cancelled in an earlier version

In an earlier version of Akaun, a cancelled invoice kept its amount in the books. Such an invoice
shows **Remove from the books** in place of **Cancel invoice**. Click it, and then click
**Remove from the books** in the dialog. Akaun removes the **Invoice** record in the same way.

## Print an invoice

1. Open the invoice.
2. Click **Print**.

A PDF of the invoice opens in a new browser tab. Use the browser to print it or save it.

The PDF shows these items:

- Your company name, address and registration number. These come from **Settings**, on the
  **Company** tab. If **Header** on the **Templates** tab is **Letterhead**, your letterhead prints
  at the top in place of the company name.
- The customer under **Bill to**, with the address, registration number and phone of the contact.
- The issue date, the due date and the reference. If the invoice is overdue, the due date shows
  "overdue".
- The amount that is due, or the date of payment if the invoice is paid.
- The line items, **Subtotal**, **Total**, and **Amount due** or **Amount paid**.
- The notes and the terms and conditions.

All amounts on the PDF are in the currency of the invoice. The headings of the price and amount
columns name the currency, for example **Unit price (USD)**. **Total**, **Amount due** and
**Amount paid** show the currency code after the amount, for example `1,000.00 USD`.

A draft prints with the word **DRAFT** across each page. A cancelled invoice prints with the word
**VOID** across each page. A cancelled invoice shows no **Amount due**.

The colour of the PDF comes from **Accent color** in **Settings**, on the **Templates** tab.

## Delete a draft invoice

You can delete an invoice only while it is a draft. On a sent invoice or a cancelled invoice,
**Delete** is disabled. A cancelled invoice keeps its number.

:::caution

You cannot undo a delete. Akaun removes the invoice permanently.

:::

1. Open the draft invoice.
2. Click **Delete**.
3. In the dialog, click **Delete**.

If you made the invoice from a quotation, the quotation goes back to **Accepted**. You can then
convert it again.

## The rail of an invoice

The rail on the right of the invoice page can show these cards:

- **Settled**: **Paid so far** and **Outstanding**. It shows after you mark the invoice as sent.
- **Payments**: each payment against the invoice. Click a payment to open its page.
- **Came from**: the quotation that the invoice was made from. It shows only when the invoice came
  from a quotation.
- **History**: who made each change, and when.

## An invoice in a foreign currency

You can mark an invoice in a foreign currency as sent. Akaun records the amount in the main
currency. It uses the exchange rate of the invoice. For example, an invoice is 1,000.00 USD and its
rate is 4.50. The **Invoice** record is 4,500.00 MYR.

The payment from the customer is in the main currency. If the rate on the day of the payment is
different, the payment does not match the invoice exactly. A small amount then stays outstanding
on the invoice. See [Notes and limits](#notes-and-limits).

## Default terms

A new invoice gets a due date from **Invoice due in (days)** in **Settings**, on the
**Templates** tab. The default is 30 days. If the setting is empty, a new invoice has no due date.
You can change the due date on each invoice.

See [Settings reference](../09-administration/settings-reference.md#templates).

## Notes and limits

- Akaun has no account for exchange gains and losses. On a foreign-currency invoice, a payment at a
  different rate can leave a few cents outstanding. Akaun cannot clear this difference. Because a
  payment is recorded, you also cannot cancel the invoice.
- Invoices have no tax. The PDF shows no tax line.
- If you change the **Accounts receivable** default account in **Settings**, a payment cannot
  settle an invoice that you sent before the change. The invoice still shows the correct
  status.

## Related

- [Getting paid](./getting-paid.md)
- [Quotations](./quotations.md)
- [Owed, part paid and paid](../02-concepts/owed-and-paid.md)
- [Contacts and their balances](../02-concepts/contacts-and-balances.md)
- [Locked records](../02-concepts/locked-records.md)
