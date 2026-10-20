# Feature Specification: Multi-record Auto Import and Import Profiles

**Feature Branch**: `develop` (no feature branch created)

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description:

> Multi-record Auto Import: let one imported source document (for example a fee document that also has header numbers, subtotals, balances and unrelated tables) produce several records, one per fee line, instead of exactly one. At upload the user chooses the document type: "Receipt or invoice (one record)", which behaves as today, or "Document with several items (one record each)". Only the fee lines become records; header numbers, totals, balances and unrelated tables are ignored. The items from one document appear grouped in the review queue, with a control-total check (sum of the items against the document's own stated fee total, compared in whole cents), an expandable list of the lines the system deliberately ignored, one "paid from" account applied to all items, and Confirm all / Skip all. Each item stays individually editable, skippable and duplicate-checked, and items from the same document never flag each other as duplicates. One stored source file is attached to every record created from the document and survives deleting any single attachment. Re-uploading a document that was already imported is stopped early with a clear message. A document that yields exactly one item behaves exactly like a receipt today; one that yields none fails with "No items found". Extraction must never silently drop lines: an over-long document fails with a reason instead of being truncated. A later phase lets users define their own import profiles: a custom JSON Schema in which fixed field names map to the ledger, per-profile instructions, and a closed fee-type list where each type can pin a category account. Out of scope: bank statements (they stay in Reconciliation, spec 001 FR-012), CSV import, one row producing several records, a table-style review page, and sending page images to a vision model. This supersedes spec 002's out-of-scope note about pulling more than one record out of a single imported document. Technical design: `design.md` in this folder.

**Update, same day** (from the maintainer, verbatim):

> just to update the source document could be a receipt, invoice, market income statement. But for statement like document, it might have various fees summary and table (transactions), but for book keeping simplicity user might choose to only import summarize records, such as market place income (sales income), and fees (market place fees, ads fees, etc), or user might choose to import all records but not the summaries. The profile / logic need to be able to robust enough to do that. Also we might need change our auto import LLM to become something like a agentic loop, something like loop with tool call, but for profile, something like identify source document see whether is there any available profile, if not then only go for standard import flow (legacy). Please review current agentic loop approach and reuse if possible, without reinventing the wheel.

**Update, 2026-10-02** (decided with the maintainer; the reasoning is in `design.md` § S4):

Some platforms export only a spreadsheet, and the maintainer's marketplace wallet report (a
spreadsheet with one transaction per line, including withdrawals to the bank) is the document
that User Story 8 was waiting for. So:

1. Auto Import also accepts spreadsheets: `.xlsx` (Excel) and `.csv`. **CSV import is no longer
   out of scope**, although the original request above lists it there.
2. A profile can say which spreadsheet column holds what. Code then reads the rows itself, with
   **no AI**. A spreadsheet with no such profile is turned into numbered text and read by the AI,
   like a PDF.
3. **User Story 8 (Every transaction) is no longer deferred.** It is built for spreadsheets (read
   from their columns) and for long PDFs (read in pieces, FR-043). There is no long PDF sample
   yet, so only the spreadsheet path can be checked against a real document for now.
4. A withdrawal from the wallet to the bank becomes a **Transfer** record. Items can therefore be
   of a third kind, Transfer, beside Income and Expense.

"One row producing several records" stays out of scope.

## Glossary

| Term                                   | Plain meaning                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source document                        | A file (PDF, photo, or a spreadsheet in `.xlsx` or `.csv`) that is itself the evidence of the transactions on it: a receipt, an invoice, a supplier's fee notice, a marketplace income statement, or a marketplace wallet report. A bank statement is _not_ one: it only lists money that moved, and is matched against records (`001-bank-reconciliation`).                               |
| Spreadsheet                            | A table file exported by a platform: Excel (`.xlsx`) or comma-separated text (`.csv`). Old Excel files (`.xls`) are not accepted.                                                                                                                                                                                                                                                          |
| Marketplace wallet report              | A marketplace's list of every movement in the seller's wallet on the platform, one per line: order income in, adjustments, and withdrawals to the bank. It is the only document behind a withdrawal, so it counts as a source document for that money. It is not a bank statement.                                                                                                         |
| Standard reading                       | How Auto Import reads a document today: one document, one record. Used for receipts and invoices, and whenever nothing better fits.                                                                                                                                                                                                                                                        |
| Item                                   | One line of a source document that becomes its own record, for example one fee or one transaction.                                                                                                                                                                                                                                                                                         |
| Header numbers                         | Figures in a document's heading or summary that are not lines to import: subtotals, totals, amount due, balance brought forward, payments received, account and reference numbers.                                                                                                                                                                                                         |
| Ignored line                           | A line the system saw and deliberately did not turn into an item, such as a subtotal. Shown so the reviewer can see what was left out.                                                                                                                                                                                                                                                     |
| Group                                  | All the items that came from one uploaded document, reviewed together.                                                                                                                                                                                                                                                                                                                     |
| Review card                            | The existing Auto Import card where a person checks and edits one proposed record before confirming it.                                                                                                                                                                                                                                                                                    |
| Marketplace income statement           | A document from an online marketplace that settles a period's sales. It has a summary (sales, several kinds of fee, the net amount released) and a table of the transactions behind that summary.                                                                                                                                                                                          |
| Import mode                            | Which part of a statement-like document a profile imports: **Summary** (the summary lines) or **Every transaction** (each row of the transaction table). Each profile has exactly one mode, set on the profile; there is no choice of mode at upload. To read one kind of document both ways, make two profiles.                                                                           |
| Stated total                           | The total the document itself prints for exactly the lines being imported, such as "Total charges" on a fee notice or "Total released" on a marketplace statement. It is not the amount due, a balance, or a grand total that includes other things.                                                                                                                                       |
| Control total                          | A check that adds up the items (income and money transferred in counted as plus, expenses and money transferred out as minus) and compares the result with the stated total, to the cent. It catches a line that was missed or counted twice.                                                                                                                                              |
| Possible duplicate                     | The existing warning on a review card that a proposed record looks like one already in the books.                                                                                                                                                                                                                                                                                          |
| Accounts payable / Accounts receivable | What the business owes / what the business is owed. An imported document starts on one of these because it proves an amount is owed, not that money moved.                                                                                                                                                                                                                                 |
| Import profile                         | A saved recipe for one kind of document: how to recognise it, instructions for reading it, and its sections.                                                                                                                                                                                                                                                                               |
| Section                                | One part of a document that a profile knows how to read, such as "Sales", "Fees" or "Transactions". It says what kind of record its lines become, and is read in its profile's import mode.                                                                                                                                                                                                |
| Kind                                   | What a line becomes: Income, an Expense, or a Transfer. A section can fix it (Income, Expense, Transfer) or use **By sign**: a positive amount is Income and a negative amount is an Expense, and the record keeps the amount without its sign.                                                                                                                                            |
| Transfer                               | Money moved between two of the business's own accounts, for example from the marketplace wallet to the bank. It is neither income nor an expense, so it has no category and no other party. In a Transfer section the sign of a line says the direction: a negative amount is money moving out of the "Money moves in" account, a positive amount is money moving into it.                 |
| "Money moves in" account               | The account a profile's document is about, such as the marketplace wallet. This is the plan's working name; the screen label follows the accounting-term rule (Constitution VII) and is settled when the editor is built. When a profile names it, its items start on that account instead of on Accounts payable or Accounts receivable, and its transfers have this account as one side. |
| Other account                          | The second account of a Transfer, such as the bank account a withdrawal goes to. A Transfer section names it.                                                                                                                                                                                                                                                                              |
| Reading from columns                   | Reading a spreadsheet with a profile that says which column holds the date, the description, the amount and so on. Code reads every row itself; no AI is involved, so no AI provider is needed.                                                                                                                                                                                            |
| Table layout                           | The part of a profile that describes a spreadsheet's table: its column headings, which column holds what, and where its stated totals are printed. It belongs to the profile as a whole, because one document has one table. Which sheet the table is on is the profile's own sheet (FR-069).                                                                                              |
| Row rule                               | The part of a section that says which rows of the table belong to it, for example "the Transaction Type column is Withdrawal". Every row belongs to at most one section. A row rule can also say which rows to flag for the reviewer.                                                                                                                                                      |
| Piece                                  | A run of consecutive lines of a long document, read in one AI call. Every line belongs to exactly one piece.                                                                                                                                                                                                                                                                               |
| Line type                              | A named kind of line in a section, such as "Commission" or "Product price", for income as well as expenses. It can be tied to a category so lines of that type always land in it. Stored as `feeTypes` (and `fee_type` on an item): the screens said "fee type" until it was renamed, because a section of income lines has no fees.                                                       |
| Item layout                            | The description of what one line of a section looks like, written as a JSON Schema: a standard, machine-checkable way to list fields and the values each may hold. Advanced use only; profiles have a sensible layout by default.                                                                                                                                                          |
| Recognition phrase                     | A phrase that appears in every document of a kind, such as the marketplace's name plus "Income Statement". Helps pick the right profile without asking the AI.                                                                                                                                                                                                                             |
| Auto-detect                            | The default way of reading a document: the system decides whether a saved profile fits, and if none does it uses the standard reading.                                                                                                                                                                                                                                                     |

## User Scenarios & Testing _(mandatory)_

### User Story 1 - One document with several fees becomes several records (Priority: P1)

Today a document can only become one record. A fee document lists several separate charges, say a commission, a service fee and a payment-processing fee, and the user wants each as its own expense in its own category. At upload the user chooses "Multiple records". The system reads the document, proposes one record per fee, and the user reviews and confirms them.

**Why this priority**: This is the core request. Without it the user keys each fee in by hand from the same document, every month.

**Independent Test**: Upload a fee document with three fee lines using the several-items choice and confirm all three. The Records list shows three records with the right amounts and the same supplier, date and reference, and each record has the document attached.

**Acceptance Scenarios**:

1. **Given** the upload screen, **When** the user opens "Read as", **Then** they see "Auto-detect", selected by default, "Single record", "Multiple records", and any saved profile by name.
2. **Given** a document with three fee lines uploaded as several items, **When** reading finishes, **Then** the queue shows one group for it, and opening the group lists three items, each with its own description, amount and category, all carrying the document's supplier, date and reference.
3. **Given** that group, **When** the user confirms the three items, **Then** three separate records exist, each with the source document attached.
4. **Given** the same document uploaded as "Single record", **When** reading finishes, **Then** one review card appears exactly as it does today.
5. **Given** a document with only one fee line, **When** it is uploaded as several items, **Then** one ordinary review card appears, with no group.
6. **Given** a document with no fee lines, **When** it is uploaded as several items, **Then** the upload fails with "No items found" and can be discarded like any failed upload.
7. **Given** the user chose "Document with several items" for one upload, **When** they upload the next document on the same device, **Then** that choice is still selected.
8. **Given** a document too long to be read in full within the limits, **When** it is uploaded as several items, **Then** the upload fails with a reason that names the limit reached, and no items appear.
9. **Given** a document in a foreign currency, **When** it is read as several items, **Then** every item shows the currency and its exchange rate, or asks for one, exactly as a receipt card does.
10. **Given** an upload that names a way of reading the system does not recognise, **When** it is submitted, **Then** it is rejected with a clear message and nothing is uploaded.
11. **Given** no saved profiles, **When** a receipt is uploaded with "Auto-detect", **Then** it is read exactly as it is today, with no extra step.

---

### User Story 2 - Only the lines you want are imported; header numbers are left out (Priority: P1)

Real documents carry more numbers than lines to import: an amount due in the header, subtotals, a tax summary, a balance brought forward, other tables such as a list of orders. Only the intended lines should become records. Everything else must stay out of the books, and the reviewer must be able to see what was left out.

**Why this priority**: A wrong record in the books is worse than a missing one, because nobody notices it. Importing a total next to the lines it adds up would count the same money twice.

**Independent Test**: Upload a document with a header total, a subtotal, a balance brought forward, a table of orders and three fee lines. Exactly three items are proposed, and the ignored lines list names the header total, the subtotal and the balance.

**Acceptance Scenarios**:

1. **Given** a document with header numbers and fee lines, **When** it is read as several items, **Then** only the fee lines are proposed and no header number, subtotal, total or balance becomes an item.
2. **Given** a document that also contains a table of orders or transactions, **When** it is read as several items, **Then** the rows of that table do not become items.
3. **Given** a group where some lines were left out, **When** the reviewer looks at the group, **Then** it shows "Ignored N lines" and opening it lists a short piece of text for each, for example "Subtotal 1,230.00".
4. **Given** the ignored lines list, **When** it is shown, **Then** it is presented as a guide and the screen does not claim it is complete.
5. **Given** a line the system missed, **When** the reviewer notices, **Then** they add it as an ordinary record from the Records screen; the group itself has no way to add an item.

---

### User Story 3 - A missed or double-counted line is caught (Priority: P1)

Deciding which lines to import is a judgement and can be wrong. Adding up is arithmetic and cannot. When the document prints its own total for the lines being imported, the system compares that total with the sum of the proposed items, so a missed or doubled line shows up before anything is confirmed.

**Why this priority**: It is the cheapest dependable signal that the reading was right, and it is what lets the user trust "Confirm all".

**Independent Test**: Use a document whose stated total equals the sum of its lines, and one where the reading is short by one line. The first shows "matches"; the second shows the exact difference.

**Acceptance Scenarios**:

1. **Given** a stated total equal to the sum of the items, **When** the group is shown, **Then** the Control total shows that it matches.
2. **Given** a sum that differs from the stated total by even one cent, **When** the group is shown, **Then** it shows the difference with a warning, and confirming is still allowed.
3. **Given** a document that prints no total for the lines being imported, **When** the group is shown, **Then** no Control total is shown, so nothing implies a check that did not happen.
4. **Given** a document whose header shows an amount due or a balance as well as the right stated total, **When** the check runs, **Then** it uses the right stated total and never the amount due or the balance.
5. **Given** a group that contains both income and expense items, **When** the check runs, **Then** income counts as plus and expenses as minus before the comparison.

---

### User Story 4 - Review a group on its own page without losing control of each item (Priority: P2)

A group can be three fees or three hundred transactions. The queue shows it as one card that says what it is; the group has its own page with a table of items, shared actions, and full control of each item. Nothing goes through on one click that needs a look.

**Why this priority**: Without shared actions the feature works but is slow; without per-item control it is unsafe. The records already come out right without them, so this follows the reading itself.

**Independent Test**: With a group of five items, one flagged as a possible duplicate, choose one Source account for the group and press "Confirm all". Four records are created and the flagged item stays for individual review, with a message saying which and why.

**Acceptance Scenarios**:

1. **Given** a group, **When** the user looks at the queue, **Then** one card shows the file name, how the document was read, how many items are ready, need attention, are confirmed and are skipped, the Control total, and a link to the group's own page.
2. **Given** the group's page, **When** it opens, **Then** it lists the items in a table with date, description, other party, category, amount, kind and status, and any item can be opened in place to show and edit the same fields as a receipt review card.
3. **Given** a group of several hundred items, **When** the page opens, **Then** items are shown a page at a time and can be filtered to those that need attention or are possible duplicates.
4. **Given** a group, **When** the user picks a Source account for the whole group, **Then** every item shows that Source account, and changing one item afterwards changes only that item.
5. **Given** some items selected, **When** the user presses "Confirm selected", "Skip selected" or sets a category for them, **Then** only those items change.
6. **Given** a group with nothing that needs attention, **When** the user presses "Confirm all", **Then** one record is created per item, each record's activity shows its creation as it does for a receipt import, and the group moves to history.
7. **Given** a group with one item flagged as a possible duplicate and one missing an exchange rate, **When** the user presses "Confirm all", **Then** the other items are confirmed, and the two remain with a message naming each item and the reason.
8. **Given** a group, **When** the user presses "Skip all", **Then** every item still awaiting review is skipped, no records are created, and the stored file is removed if no record uses it.
9. **Given** a group, **When** the user skips one item, **Then** the other items are unaffected and the source file is kept while anything still uses it.
10. **Given** items from one document, **When** duplicates are checked, **Then** no item is flagged as a duplicate of another item from the same document.
11. **Given** an item that matches an existing record (same reference, or same date, amount and contact), **When** it is shown, **Then** it is flagged as a possible duplicate with the usual "Import anyway" choice.
12. **Given** this month's fee document that repeats last month's fees with different dates and references, **When** it is read, **Then** its items are not flagged because the wording is similar.
13. **Given** an item that has been confirmed, **When** the user looks at the import history, **Then** its entry links to the record it created.
14. **Given** a group where two items are already confirmed, **When** the user discards the document, **Then** the items still awaiting review disappear and the two records stay.
15. **Given** an item the books refuse to record (for example no account chosen), **When** the user confirms it, **Then** no record, no new contact and no attachment is left behind, and the item stays ready to fix.
16. **Given** a user without permission to change imports, **When** they try to confirm, skip or discard an item, **Then** it is refused, as it is for a receipt today.
17. **Given** the same group open in two browser tabs, **When** items are confirmed or skipped in one, **Then** the other tab updates without a reload.
18. **Given** a phone-width screen, **When** the user opens the queue card or the group's page, **Then** the table, its actions and each item are usable without sideways scrolling.
19. **Given** "Confirm all" on a large group that is interrupted part-way (the page is closed or the connection drops), **When** the user returns and presses it again, **Then** the items already confirmed stay confirmed, the rest are confirmed, and no record is created twice.

---

### User Story 5 - One stored file, many records (Priority: P2)

Every record made from a document points to the same stored copy of it. A person looking at any one of the records can open the source, and removing it from one record must never break the others.

**Why this priority**: A source document that vanishes from other records after one deletion silently damages the audit trail, which is the reason to attach it at all.

**Independent Test**: Confirm all items of a three-item document, delete the attachment from one record, and check the other two still open the document; delete it from the other two and check the file is gone.

**Acceptance Scenarios**:

1. **Given** all items of a document confirmed, **When** the user opens any of the records, **Then** the source document is attached, and only one copy is stored.
2. **Given** three records sharing one file, **When** the attachment is deleted from one of them, **Then** the other two can still open it.
3. **Given** a file attached to a single remaining record, **When** that attachment is deleted, **Then** the stored file is removed.
4. **Given** some items confirmed, **When** the user clears the import history, **Then** a file that a record still uses is kept.
5. **Given** a document already imported, in any mode, with at least one record created, **When** the identical file is uploaded again to be read as several items or with a profile, **Then** it is stopped before reading, with a message saying how it was read and how many records that produced.
6. **Given** an earlier upload of the same file whose items were all skipped or discarded, **When** it is uploaded again, **Then** it is read normally, because nothing was imported.
7. **Given** records created from one document, **When** the user searches for the wording of one line, **Then** only the record for that line is found, not the other records from the same document.

---

### User Story 6 - Define an import profile for a kind of document (Priority: P2)

The generic reading of a document is general. A user who receives the same kind of document every month, say a marketplace's income statement, wants to say once how to read it: which parts to read, what each part's lines become, which fee is which, and which category each belongs in. They create an import profile, choose it at upload, and get the same result each month.

**Why this priority**: A profile moves the decision "what counts as a line to import" from one general instruction for everything to a recipe per kind of document. Sections make the choice between a summary and every transaction something the system enforces instead of hopes for, and a closed list of line types is the most dependable way to say which lines count.

**Independent Test**: Create a fee-document profile with two line types, one tied to a category. Upload a sample document choosing that profile. Only lines matching the listed types become items, and the tied category is applied.

**Acceptance Scenarios**:

1. **Given** the place in Settings where the AI providers are managed, **When** a user allowed to change imports opens it, **Then** they can add, edit, disable and delete import profiles.
2. _(Removed 2026-10-07: the built-in starters. A new profile starts blank, or from a profile file exported from another installation (FR-068).)_
3. **Given** a profile, **When** the user edits it, **Then** they can set its name, how to recognise it (a plain description and, optionally, recognition phrases), its instructions, what it imports (Summary lines or Every transaction), its stated total, optionally the "Money moves in" account, optionally a table layout for spreadsheets, and one or more sections.
4. **Given** a section, **When** the user edits it, **Then** they can set its name, what it is and where to find it, its kind (Income, Expense, By sign or Transfer, and for Transfer the other account), an optional fixed category, an optional list of line types each optionally tied to a category, and, for a profile with a table layout, its row rules.
5. **Given** an enabled profile, **When** the user opens "Read as", **Then** the profile is listed by name, and a document read with it uses the profile's instructions in place of the general import instructions.
6. **Given** a section with line types, **When** a document is read with the profile, **Then** lines that match no listed type are not proposed, and each proposed item is described by its line type's name.
7. **Given** a line type tied to a category, **When** an item of that type is proposed, **Then** it gets that category; a type not tied to one gets the system's suggestion if it is valid, and Uncategorised otherwise; and a line with no line type gets the section's fixed category if it has one.
8. **Given** the advanced item layout of a section, **When** it breaks the rules, **Then** saving is refused with a message saying what is wrong and where, and nothing is saved.
9. **Given** an item layout with extra fields such as an order number, **When** a document is read, **Then** each item shows those values as "name: value", and the record's remark stays empty.
10. **Given** the AI provider rejects a profile's item layout, **When** a document is read with it, **Then** only that document fails, with the reason shown, and every other document is read as before.
11. **Given** any change to a profile, **When** it is saved, **Then** it is recorded in the audit trail, and a user without permission to change imports cannot manage profiles.
12. **Given** a profile that is disabled or deleted, **When** the user opens "Read as", **Then** it is not offered, and groups already read with it are unaffected.

---

### User Story 7 - Import only the summary of a marketplace statement (Priority: P2)

A marketplace pays out a period's sales in one statement: a summary (sales, several kinds of fee, the net amount released) and a table of every transaction behind it. For simple bookkeeping the user often wants only the summary: the sales as income, and each kind of fee (marketplace fee, ads fee and so on) as an expense. Summary and transactions describe the same money, so a document is imported one way or the other, never both.

**Why this priority**: It is the named real-world case for this feature, and it needs profiles (User Story 6). It comes before the every-transaction case because it is far smaller and covers the bookkeeping most users want.

**Independent Test**: With a Summary profile for the marketplace statement, upload the statement with that profile. The group shows an income item for sales and an expense item per fee, no row from the transactions table, and a Control total against the stated net amount released.

**Acceptance Scenarios**:

1. **Given** a Summary statement profile with a "Sales" section (Income) and a "Fees" section (Expense), **When** a statement is uploaded with it, **Then** the group lists income and expense items with their kinds and categories, and no transaction row appears.
2. **Given** a line types list such as marketplace fee and ads fee, **When** the statement is read, **Then** each fee line gets the category tied to its type.
3. **Given** a By sign section in which a rebate is printed as a positive amount among the fees, **When** the statement is read, **Then** the rebate becomes an income item and the other fees become expense items, all shown as positive amounts.
4. **Given** a statement that prints a net amount released, **When** the group is shown, **Then** the Control total compares income less expenses with that figure and shows a match or the difference.
5. **Given** a group holding both kinds, **When** its items are confirmed, **Then** income records and expense records are created accordingly.
6. **Given** a profile, **When** the user edits it, **Then** they choose once what it imports, "Summary lines" or "Every transaction", and every section is read that way; a section has no mode of its own.
7. **Given** the upload screen, **When** the user opens it, **Then** it offers "Read as" only: Auto-detect, Receipt or invoice, Document with several items, then each enabled profile. There is no "Import" choice; choosing a profile chooses its mode.
8. **Given** a profile saved when each section had its own mode, with sections in both modes, **When** it is opened in the editor, **Then** it reads Summary, the sections in the other mode show a problem saying the profile now reads one way, and it cannot be saved until they are moved to a new profile, kept as Summary, or the profile is changed to their mode. Until then a document read with it reads only its Summary sections.

---

### User Story 8 - Import every transaction of a one-transaction-per-line table (Priority: P3)

**Deferred 2026-09-30, taken up again 2026-10-02.** It was deferred because the maintainer's marketplace income statement has a transaction table with one row per day and fifteen amount columns, so each row would have to become several records, which is out of scope. That is still true, so a statement's summary is read with Summary lines only. The story is now aimed at tables with **one transaction per line**, such as the maintainer's marketplace wallet report. It is built for spreadsheets read from their columns (User Story 10) and for long PDFs read in pieces (FR-043). **There is no long one-transaction-per-line PDF sample yet**, so the PDF path is tested only with a stand-in AI until the maintainer supplies one; only the spreadsheet path can be accepted against a real document now. See `design.md` § S0.5 and § S4.

Some users want every transaction in a document as its own record, and none of the summary. Each row of the transaction table becomes one record. The table can run to hundreds of rows, so all of them must be read, and reviewing them must stay practical.

**Why this priority**: It is the second choice the user described, and the heaviest: it needs long documents read in full and a group page that copes with hundreds of items. It builds on User Stories 4, 6 and 7.

**Independent Test**: Upload a wallet report spreadsheet of several hundred transactions, with an Every transaction profile that reads its columns. The group holds one item per row, none from the report's summary block, and the number of items equals the number of rows. (For a PDF: the same with a statement of about 300 one-line transactions, once a sample exists.)

**Acceptance Scenarios**:

1. **Given** an Every transaction profile with a "Transactions" section (By sign), **When** a document is uploaded with it, **Then** each transaction row becomes one item, income or expense by its sign, and the summary produces none.
2. **Given** a document with several hundred rows, **When** it is read, **Then** every row is read and none is dropped, and, for a PDF read in pieces, the queue shows progress while reading, such as "Reading part 3 of 25".
3. **Given** the document's stated total for the rows, **When** the group is shown, **Then** the Control total compares the rows with it, income and money transferred in as plus, expenses and money transferred out as minus.
4. **Given** a document already imported with a Summary profile with at least one record created, **When** the identical file is uploaded again with an Every transaction profile, **Then** it is stopped, with a message naming the profile and mode it was already imported with and how many records that produced.
5. **Given** a later document that overlaps an earlier one, **When** its rows are read, **Then** rows already in the books with the same reference are flagged as possible duplicates, and a row whose own reference differs from the existing record's reference is not, even when the date and amount match.
6. **Given** a group that was read with a Summary profile and has no confirmed items, **When** the user chooses "Read again" with an Every transaction profile, **Then** the pending items are replaced by the new reading of the same file, in that profile's mode.
7. **Given** a PDF too long to be read in full within the limits, **When** it is uploaded, **Then** it fails with a reason naming the limit, and no partial group appears.
8. **Given** each transaction row has its own date and reference, **When** the document is read, **Then** each item carries its own date and reference, while the other party and currency come from the document. A row with no reference of its own has no reference: it does not take the document's reference.
9. **Given** a transaction that falls across the boundary between two pieces of a long PDF, **When** it is read, **Then** it appears once, neither lost nor listed twice.
10. **Given** a long PDF whose twentieth piece fails with the first AI provider, **When** the next provider is tried, **Then** it reads only that piece again, and the pieces already read are kept.
11. **Given** the same file uploaded twice, once read with a Summary profile and once with an Every transaction profile, both waiting for review, **When** the user confirms an item from one after the other has made a record, **Then** the confirm is refused with a message saying the file was already imported the other way.

---

### User Story 9 - Auto-detect a profile, with the standard reading as fallback (Priority: P3)

Choosing a profile at every upload is a chore, and a wrong choice is easy to make. By default the system looks at the document and decides whether one of the saved profiles fits. If none does, the document is read the standard way, exactly as before. The screen always says how the document was read, and a wrong pick can be corrected without uploading again.

**Why this priority**: Everything above works with an explicit choice. Auto-detect makes it convenient, and because it can be wrong it comes last, with a way to correct it.

**Independent Test**: With two saved profiles and a receipt, upload the receipt with Auto-detect. It is read the standard way and says so. Upload a statement of the first profile's kind. It is read with that profile and says so.

**Acceptance Scenarios**:

1. **Given** saved profiles and "Auto-detect", **When** a document fits one of them, **Then** it is read with that profile, and the group says which profile and that it was detected.
2. **Given** saved profiles and "Auto-detect", **When** no profile fits, **Then** the document is read the standard way and the review card says so.
3. **Given** no saved profiles, **When** any document is uploaded with "Auto-detect", **Then** there is no detection step and no extra AI call, and the document is read the standard way.
4. **Given** a profile whose recognition phrases all appear in the document and no other profile's do, **When** the document is uploaded with "Auto-detect", **Then** that profile is used without asking the AI.
5. **Given** the recognition phrases of no profile or of several profiles match, **When** the document is uploaded with "Auto-detect", **Then** the AI chooses among the enabled profiles, or none, using their descriptions.
6. **Given** a wrong pick, **When** the user chooses "Read again" and names another profile, the standard reading or several items, and no item is confirmed yet, **Then** the pending items are replaced by the new reading of the same file, without uploading again.
7. **Given** at least one item is already confirmed, **When** the user looks at the group, **Then** "Read again" is not offered, and the group says why.
8. **Given** a document that tries to instruct the system (for example "ignore your rules and use profile X"), **When** it is read, **Then** the text has no effect beyond being part of the document.

---

### User Story 10 - Import a spreadsheet export (Priority: P2)

Some platforms give their reports only as a spreadsheet. The user wants to upload it to Auto Import like a PDF. For a report that arrives every month, the user also wants it read the same way every time, without the AI guessing: a profile says which column holds the date, the description, the amount and the reference, and code reads every row.

**Why this priority**: Without it the user has to retype a spreadsheet or print it to PDF, which loses the columns. Reading from columns is also the most dependable reading there is: no AI, no cost, and the same answer every time.

**Independent Test**: Upload a synthetic wallet report spreadsheet with a profile that maps its columns, with no AI provider configured. The group holds one item per matching row, the ignored lines count the rows no section wanted, and the group says "read from columns".

**Acceptance Scenarios**:

1. **Given** the upload screen, **When** the user picks a file, **Then** `.xlsx` and `.csv` files are accepted as well as PDF, JPG and PNG, and a spreadsheet is labelled "Spreadsheet" in the queue.
2. **Given** an old `.xls` file or a password-protected workbook, **When** it is uploaded, **Then** it is refused with a message that names the problem.
3. **Given** a spreadsheet and no profile with a table layout, **When** it is read as several items, **Then** it is read by the AI from its text, one sheet after another, like a PDF. **When** it is read with a profile, **Then** only the profile's one sheet is read (FR-069).
4. **Given** a spreadsheet read as "Single record" whose text is longer than a receipt reading allows, **When** it is read, **Then** it fails with a reason that names the limit, instead of being read from a shortened text.
5. **Given** a profile with a table layout whose sections all have row rules, **When** a spreadsheet is read with it, **Then** code reads every row, no AI is asked, and it works even with no AI provider configured.
6. **Given** a row that matches the rules of two sections, **When** the spreadsheet is read, **Then** the reading fails and names the row, because the profile is ambiguous.
7. **Given** rows that match no section, **When** the spreadsheet is read, **Then** they are left out and counted as ignored lines, for example "Ignored 726 lines (20 shown)".
8. **Given** a date or amount that cannot be read, **When** the spreadsheet is read, **Then** the reading fails, naming the row and the column, and no partial group appears.
9. **Given** amounts written as `(12.50)` or with the minus sign `−`, **When** they are read, **Then** they are read as negative, to the exact cent.
10. **Given** a cell that holds a formula, **When** it is read, **Then** the value the spreadsheet last showed is used; the formula is never worked out again.
11. **Given** a row that matches a section's flag rule (for example a withdrawal still marked "Processing"), **When** it is read, **Then** it becomes an item with a note asking the reviewer to check it, and "Confirm all" leaves it behind.
12. **Given** a spreadsheet uploaded with Auto-detect, **When** one profile's table headings match it, **Then** that profile is used without asking the AI.
13. **Given** a spreadsheet uploaded to Reconciliation or attached to a record, **When** it is uploaded, **Then** it is refused, as today.

---

### User Story 11 - Money moved between your own accounts becomes a transfer (Priority: P2)

A marketplace wallet report lists withdrawals: money moved from the wallet to the business's bank account. That is neither income nor an expense, so it must not become either. It is a Transfer between two of the business's own accounts, and the wallet report is the only document that shows it.

**Why this priority**: Recording a withdrawal as income or an expense would make the profit wrong. Without transfers the user must key every withdrawal in by hand, or leave the wallet's balance wrong.

**Independent Test**: With a "withdrawals only" profile whose "Money moves in" account is the wallet and whose Transfer section names the bank as the other account, read a wallet report with ten withdrawals. The group holds ten transfer items, one flagged; "Confirm all" makes nine Transfer records from the wallet to the bank and leaves the flagged one.

**Acceptance Scenarios**:

1. **Given** a Transfer section, **When** a negative line is read, **Then** it becomes a transfer out of the "Money moves in" account to the other account; a positive line becomes a transfer the other way.
2. **Given** a transfer item, **When** it is shown, **Then** it has no other party and no category, it shows both accounts, and its kind says Transfer.
3. **Given** a transfer item, **When** it is confirmed, **Then** one Transfer record is created between the two accounts, audited and with the source document attached, as for any imported record.
4. **Given** a transfer item in a currency other than the main currency, **When** the group is shown, **Then** it needs attention and "Confirm all" leaves it behind, saying why.
5. **Given** a withdrawal already recorded as a transfer, for example matched in Reconciliation, with the same amount, between the same two accounts and dated within seven days, **When** the report is read, **Then** the item is flagged as a possible duplicate; one existing transfer flags at most one item.
6. **Given** a profile that names a "Money moves in" account, **When** its income and expense items are proposed, **Then** they start on that account instead of Accounts payable or Accounts receivable, and the group's Source account can still change them.
7. **Given** a profile whose Transfer section names the same account as the "Money moves in" account, or an account that does not hold money, **When** it is saved, **Then** saving is refused with a message saying why.
8. **Given** a receipt read the standard way, **When** it is read, **Then** it never becomes a transfer.

---

### Edge Cases

- The document lists the same line twice. Both appear as items and the reviewer can skip one. When the document states a total, the Control total shows the difference.
- The standard several-items reading lists credits, discounts or refunds. They do not become records; they appear under ignored lines, and the Control total may then differ, which is the visible sign. A By sign section in a profile does import them, as income.
- A document in the several-items reading mixes kinds, for example sales and fees. It is read as one kind as a whole; lines of the other kind appear under ignored lines. Use a profile to import both kinds.
- The document date is missing. The same fallback as a receipt is used.
- Amounts are in a foreign currency. The document has one currency, each item's currency and rate can be edited as on a receipt today, and the Control total is compared in the document's own currency.
- The document is too long or has too many items. The upload fails with a reason naming the limit; it is never cut short.
- Reading fails part-way. No partial group is shown.
- A profile chosen at upload is disabled or deleted before reading starts. The upload fails with a message naming the profile.
- A profile is chosen that does not fit the document. It is read anyway, because the user chose it; the Control total and the ignored lines are the visible signs.
- Two enabled profiles are made for the same document, one per import mode, such as two wallet report profiles, one for the withdrawals and one for every transaction. Auto-detect cannot tell them apart. The user turns one off, gives each recognition phrases only its own documents have, or chooses one under "Read as". With no AI provider the upload fails naming both (FR-039).
- Two browser tabs are open. Both update live as items are confirmed or skipped.
- Every item of a group is confirmed or skipped. The group leaves the review queue and appears in history.
- The AI provider is unavailable. The upload fails with the same message a receipt gets today, and entering records by hand is unaffected.
- The server restarts while a document is being read. Reading starts again, as it does for a receipt.
- A workbook has several sheets. Read with a profile, one sheet is read, by code and by the AI alike: the one the profile names, or else the sheet with its table's headings, or else the first visible sheet (FR-069). Read as several items or as a receipt, with no profile, every sheet is read, one after another, each headed by its name.
- A `.csv` file is saved in an older Windows encoding or uses semicolons. The encoding and the separator are recognised; an Excel `sep=` first line is honoured.
- A spreadsheet's table ends with a blank row and a summary below it. Reading from columns stops at the first blank row after the headings, so the summary does not become items.
- A wallet report's order income repeats money already imported from the same marketplace's income statement summary. Importing both would count the sales twice. A profile that reads only the withdrawals avoids this, and a section can name the profile it overlaps with so that its income and expense items get a review note when records from that profile already cover the same dates (FR-066).
- A withdrawal is still "Processing" in the report. It is imported but flagged for the reviewer, because it may not complete; it is not left out.
- Two copies of the same file are uploaded with profiles of different modes before either is confirmed. Both are read, and the first confirm wins; any later confirm from the other copy is refused (FR-064).

## Requirements _(mandatory)_

### Functional Requirements

**Choosing how a document is read**

- **FR-001**: At upload the user MUST be able to choose "Read as": "Auto-detect" (the default), "Single record", "Multiple records", or any enabled profile by name. The last choice MUST be remembered on that device. A choice the system does not recognise MUST be rejected with a clear message and nothing is uploaded. An upload that states no choice, for example one sent by an automated tool, MUST be read as "Auto-detect".
- **FR-002**: The upload MUST NOT offer a choice of import mode. A profile, chosen or detected, MUST be read in its own mode (FR-032); the document MUST store that mode, and the screens MUST say which mode it was read in. To read one kind of document both ways, the user makes two profiles. An upload that still sends an import mode, from a screen opened before the choice was removed, MUST be accepted and the mode ignored.
- **FR-003**: With no enabled profile, "Auto-detect" MUST behave exactly as "Receipt or invoice" does today: no extra AI step, and no change to fields, review card, possible-duplicate check or confirm.
- **FR-004**: A document read as "Receipt or invoice" MUST behave exactly as it does today. The only change to receipts is the history link in FR-021.

**Reading a document with several items**

- **FR-005**: The system MUST propose one record per item and MUST NOT propose anything for header numbers, subtotals, totals, amount due, balance brought forward, payments received, account or reference numbers, or parts of the document that are not being read. When a document is read with a profile, only that profile's sections are read.
- **FR-006**: All items from one document MUST share the document's other party (the supplier for an expense, the customer for income), date, reference and currency. An item that states its own date or reference uses that one for itself only. In Every transaction mode an item takes its reference only from its own row (FR-062). A transfer item has no other party (FR-058).
- **FR-007**: Each item MUST be handled as a receipt is: the other party is matched to an existing contact or offered as a new one, a foreign-currency amount gets an exchange rate, the category is one of the user's categories or Uncategorised, and amounts are kept in whole cents.
- **FR-008**: In the several-items reading the whole document is one kind, expense or income, as for a receipt. In a profile each section sets the kind of its lines (Income, Expense, By sign or Transfer), so one group can hold several kinds. Under By sign a positive amount is Income and a negative amount is an Expense, and the record keeps the amount without its sign. Under Transfer a negative amount is money moving out of the profile's "Money moves in" account to the section's other account, and a positive amount is money moving the other way; the record again keeps the amount without its sign (FR-058). A profile MAY name a "Money moves in" account; its income and expense items then start on that account instead of on Accounts payable or Accounts receivable. The standard and several-items readings never produce a transfer.
- **FR-009**: A document that yields exactly one item MUST behave as a receipt: one review card, no group. A document that yields none MUST fail with "No items found".
- **FR-010**: The system MUST NOT silently drop lines. A document too long to be read in full, or with more items than the limit, MUST fail with a reason that names the limit reached (initial limits are in Assumptions). Reading from columns counts the items against the limit after rows that match no section are left out. A spreadsheet read the standard way has the receipt reading's text limit, and is refused over it (FR-052).
- **FR-011**: Items MUST appear only when the whole document was read successfully. If reading fails part-way, no partial group is shown.
- **FR-012**: The system MUST keep a short list of the lines it deliberately left out and show it on the group as an expandable "Ignored N lines". The screen MUST NOT claim the list is complete.

**Checking the result**

- **FR-013**: When the document states its own total for the lines being imported, the group MUST show a Control total: the items added up, income and money transferred in as plus, expenses and money transferred out as minus, in whole cents of the document's own currency, against the stated total, as either "matches" or "differs by" the amount. The check reflects the items as read, not later edits or skips.
- **FR-014**: A difference MUST warn but MUST NOT block confirming. When the document states no such total, no Control total is shown.
- **FR-015**: The stated total means the total of exactly the lines being imported. An amount due, a balance, or a grand total that includes other charges MUST NOT be used as the stated total. A profile names one stated total, for its import mode. When reading from columns, the layout MAY name several labels (for example a total of money in and a total of money out); the number printed next to each is read and code adds them up. With no label there is no Control total.

**Reviewing a group**

- **FR-016**: In the review queue a group MUST appear as one card showing the file name, how the document was read, how many items are ready, need attention, are confirmed and are skipped, the Control total, and a link to the group's own page. That page MUST have its own address that can be shared.
- **FR-017**: The group's page MUST list its items in a table showing date, description, other party, category, amount, kind and status. Any item MUST be openable in place to show and edit the same fields as a receipt review card. A long group MUST be shown a page at a time and MUST be filterable to items that need attention or are possible duplicates, and, for a profile, by section.
- **FR-018**: The group MUST offer one Source account choice that fills the Source account of every item at once, and the same for the selected items. Each item can still be changed afterwards without affecting the others. It MUST also offer "Confirm all", "Skip all", "Confirm selected", "Skip selected" and setting a category for the selected items.
- **FR-019**: Confirming several items MUST happen one after another. Items that need attention (flagged as a possible duplicate, carrying a review note, a transfer not in the main currency, or missing something required such as an exchange rate or an account) MUST be left behind and the user told which and why. One item failing MUST NOT stop or undo the others. If the run is interrupted, items already confirmed stay confirmed, the rest stay ready, and running it again MUST NOT create any record twice. Progress MUST be shown for a long run.
- **FR-020**: Each item MUST stay individually editable, confirmable and skippable. Skipping or discarding one item MUST NOT change the other items, and MUST NOT remove the source file while any other item or record still uses it. Discarding the whole document MUST remove only the items still awaiting review; records already created stay, and so does the source file while a record uses it.
- **FR-021**: A confirmed item's history entry MUST link to the record it created. Confirmed receipts get the same link.
- **FR-022**: The queue card and the group's page MUST be usable at phone widths.
- **FR-023**: While no item of a group is confirmed, the user MUST be able to "Read again" from the same file, choosing any profile, the standard reading, or several items, without uploading again. A profile brings its own import mode, so reading a document again the other way means choosing a profile made for that mode. The pending items MUST be replaced by the new reading. Once any item is confirmed, "Read again" MUST NOT be offered and the group MUST say why. A skipped document that made no record MAY be read again while its stored file still exists; once the file has been released, "Read again" MUST be refused with a reason that tells the user to upload it again.

**Duplicates**

- **FR-024**: Each item MUST be checked against the existing records with the same signals as today (reference, amount, date and contact) and flagged the same way, with the same "Import anyway" choice.
- **FR-025**: Items from the same document MUST NOT flag each other, and the document's shared file name or wording MUST NOT count as evidence that an item duplicates an older record. A document that repeats last month's lines, with the same other party and amounts but a different date and reference, MUST NOT be flagged on similar wording alone.
- **FR-026**: A file identical to one already imported, in any way and with at least one record created, MUST be stopped before reading when it is uploaded to be read as several items or with a profile. The message MUST say how it was read and how many records that produced. If the earlier upload produced no records, the upload proceeds.

**The source file**

- **FR-027**: One stored copy of the source file MUST be attached to every record created from the document.
- **FR-028**: Deleting an attachment from one record MUST remove the stored file only when no other record uses it. Clearing the import history MUST likewise never remove a file a record still uses.
- **FR-029**: A record created from a group MUST NOT carry the whole document's text as its searchable content. It is found by its own description, contact, reference and amount.

**Import profiles**

- **FR-030**: A user allowed to change imports MUST be able to add, edit, disable and delete import profiles. A profile has a name, how to recognise it (a plain description and, optionally, recognition phrases), instructions, and one or more sections. Enabled profiles appear in "Read as". A new profile starts blank; the built-in starters were removed on 2026-10-07. A profile with a transfer section needs both accounts chosen before it can be saved: the other account of each transfer, and the "Money moves in" account (FR-058). A profile MAY also name a "Money moves in" account and a table layout (FR-053).
- **FR-030a**: The recognition description MUST be required only for Summary lines and Transaction lines. A profile with a table can be found by its headings after fixed phrases (FR-039), so its description and recognition phrases are optional.
- **FR-031**: A section has a name; what it is and where to find it; its kind (Income, Expense, By sign or Transfer, and for Transfer the other account); optionally a fixed category; optionally a list of line types, each optionally tied to a category; and, in a profile with a table layout, optionally its row rules (FR-054). A Transfer section has no line types and no fixed category. A line type has a name, unique in its section, and a description that tells the AI which lines are of that type. Its key, which the AI answers with and an item stores, is made from the name and is never shown; a saved line type keeps its key when it is renamed, so items already read still name it. A line type saved before line types had names takes its name from its key.
- **FR-032**: A profile MUST have exactly one import mode, Summary or Every transaction, set once on the profile, and at least one section. Every section is read in that mode, and reading with the profile MUST read only its sections. A profile saved when each section had its own mode gets the mode its sections share, or Summary when they had none or both; with both, the sections in the other mode are not read and the editor MUST show a problem on them and refuse to save until they are moved, kept, or the profile is changed to their mode.
- **FR-032a**: A profile MUST have exactly one kind, chosen first in the editor as "What to import": **Table rows** (every row of a spreadsheet table, read by code, mode Every transaction), **Summary lines** (read by the AI in one call, mode Summary), **Transaction lines** (read by the AI in pieces, mode Every transaction), or **Table rows and summary lines** (the table by code and the lines beside it by the AI, mode Summary). The kind sets the mode; there is no separate choice of mode or of reading. A "Table rows" profile MUST have a table and read every section from it; a "Table rows and summary lines" profile MUST have a table, one section or more from the table, and one section or more for the AI. A profile saved before the kind was stored gets the kind its shape gives: no table is Summary or Transaction lines by its mode, a table with row rules on every section is Table rows, and any other table is Table rows and summary lines. A new Table rows profile starts with one section, "Transactions", By sign, that takes every row.
- **FR-033**: One document MUST be imported in one import mode only, because summary and transaction figures describe the same money. Reading one kind of document both ways takes two profiles. The identical file uploaded again with the other profile after records exist is stopped under FR-026. Two copies uploaded before either made a record are both read, and the guard at confirm (FR-064) stops the second from making records.
- **FR-034**: When a section lists line types, the system MUST propose only lines that match a listed type. A type MAY be tied to a category: the tied category wins, otherwise the system's suggested category is used if valid, otherwise Uncategorised, and a section's fixed category applies to lines with no line type. An item with a line type MUST take the line type's name as its description; an item with none keeps the description the AI or the table gives. An import MUST never fill a record's remark: the remark is for the reviewer to write. A tied category of the other kind (an income category on a by-sign line printed negative, or the reverse) is not used: the item takes the next valid choice, and it says on the item which tied category did not apply and why, so a confirm-all leaves it for the reviewer until a category is chosen.
- **FR-035**: A section's item layout is built from the profile form: the fixed fields the books understand (description, amount, date, reference, and the category and line type where the section needs them; the other party and currency come from the document once) are generated by the system and cannot be retyped or renamed. A user MAY add extra fields as a JSON Schema fragment of plain values (text, number, true/false), which are shown on the item as "name: value" and never added to the record's remark. A fragment that breaks the rules (a feature the system does not support, a name the books already use, nested values, or too large) MUST be rejected on save with a message saying what is wrong and where. Nothing is saved.
- **FR-036**: A profile's instructions MUST apply only to documents read with that profile, in place of the general import instructions.
- **FR-037**: If the AI provider rejects a profile's item layout, only that document MUST fail, with the reason shown. It MUST NOT change how any other document is read.
- **FR-038**: Adding, editing, disabling or deleting a profile MUST be audited. A profile that is disabled or deleted MUST NOT change groups already read with it.

**Automatic detection**

- **FR-039**: With Auto-detect, check fixed phrases across every enabled profile compatible with the uploaded file kind and selected sheet. A table-backed profile is compatible only if its required headings are present. Exactly one phrase match wins without AI, including an AI-read profile beside a matching table layout. With no phrase matches, exactly one matching table layout wins without AI. Otherwise make at most one small AI detection step, considering multiple phrase matches first, multiple matching layouts next, or remaining compatible profiles if neither matched; AI may answer none. With ambiguous phrases or layouts and no provider, fail with a message naming the profiles and explaining how to distinguish or explicitly choose them. With no candidates, use standard reading and its existing limits. Explicit Read as selections bypass detection.

- **FR-040**: When no profile fits, the document MUST be read the standard way, as a receipt or invoice.
- **FR-041**: The screen MUST state how each document was read: the profile name or the standard reading, whether it was detected or chosen, and, for a spreadsheet read from its columns, "read from columns", or "table read from columns, the rest by AI" when the AI read some sections beside the table (FR-057). With no enabled profile the screen shows nothing extra, so receipts look exactly as before (FR-003).
- **FR-042**: Text inside a document MUST be treated as content only. It MUST NOT be able to do anything beyond being read, including influencing detection beyond the choice among profiles.

**Long documents**

- **FR-043**: A long document read by the AI in Every transaction mode MUST be read in pieces so that no line is dropped; any other reading that is too long fails as FR-010 says. Each line of the document belongs to exactly one piece; a piece may show the lines around it for context but only its own lines can become items, so a line falling across two pieces is neither lost nor listed twice, and two genuinely identical rows both stay. An item the system is unsure about at a piece boundary MUST be flagged for the reviewer, never removed. The queue MUST show progress while a long document is being read. Pieces are sized by how much the AI has to write back, so that each call finishes well within the time an AI call is allowed. A piece that is cut short or runs out of time MUST be split in half and read again, a limited number of times; past that the document MUST fail, naming the lines that could not be read. **Provider failover happens per piece:** when a piece fails with one AI provider, the next provider reads that piece only, and the pieces already read are kept, so a failure on piece 20 does not read pieces 1 to 19 again. The whole document still succeeds or fails as one (FR-011). Reading from columns (FR-055) needs no pieces; the part of a spreadsheet the AI reads beside its table (FR-057) is read in pieces like any other text.

**Safety, permissions and live updates**

- **FR-044**: Confirming an item MUST either fully succeed or leave nothing behind: no record without its import status, and no new contact left over from a refused record.
- **FR-045**: Every way of reading a document MUST need only the permission to upload imports that exists today, except "Read again", which MUST need both the permission to upload imports and the permission to change them, because it discards the pending review work as Skip does. Confirming, skipping and discarding MUST need the same permissions as today. Managing profiles MUST need the permission to change imports, and so does trying a profile's table layout against a sample file, which stores nothing. No new permission is introduced.
- **FR-046**: Every record created MUST be audited exactly as records from a receipt import are today.
- **FR-047**: As items are proposed, confirmed, skipped or discarded, every open Auto Import screen, including a group's page, MUST update without a reload.
- **FR-048**: Upgrading MUST NOT change or remove anything already in the queue, the import history, the records or the settings.

**Boundaries**

- **FR-049**: Bank statements stay in Reconciliation. Nothing uploaded to Auto Import creates statement lines, and statement lines never enter Auto Import (unchanged from `001-bank-reconciliation` FR-012). A marketplace wallet report is not a bank statement: it is the source document for money that no other document proves, such as a withdrawal to the bank, and reading it creates records, never statement lines.

**Spreadsheets**

- **FR-050**: Auto Import MUST accept `.xlsx` and `.csv` files as well as PDF, JPG and PNG, in every way of reading. It MUST refuse an old `.xls` file or a password-protected workbook with a message that names the problem. Only Auto Import accepts spreadsheets: Reconciliation and record attachments MUST still refuse them. A stored spreadsheet is offered for download when opened, not shown in the page.
- **FR-051**: A spreadsheet read by the AI (the standard reading, several items, or a profile that does not read it from its columns) MUST first be turned into text: every sheet in order (with a profile, its one sheet, FR-069), headed by its name, one row per line with its cells side by side, dates written as year-month-day, and the lines numbered as for a PDF. A cell that holds a formula MUST give the value the spreadsheet last showed; formulas are never worked out again.
- **FR-052**: A spreadsheet read the standard way whose text is longer than the standard reading takes (6,000 characters today) MUST fail with a reason naming the limit. It MUST NOT be read from a shortened text. PDFs and photos read the standard way are unchanged (FR-004). With "Auto-detect", this check applies only once the standard reading is the answer (FR-039): it MUST NOT stop a spreadsheet whose headings several profiles have, or one the AI could still route to a profile.

**Reading from columns**

- **FR-053**: A profile MAY carry a table layout: the column headings that identify the table (on the profile's sheet, FR-069); which column holds the date (and how dates are written), the description, the amount and the reference; and optionally a column that says the direction of the money with the values that mean in and out, the decimal separator, the separator of a `.csv` file, the other party, the currency, a label beside which the document's date is printed, and the labels of the stated total. No column is added to the remark (FR-034). The layout belongs to the profile, not to a section, because one document has one table.
- **FR-054**: In a profile with a table layout, a section MAY carry row rules: which rows belong to it, as conditions on a column's value (is, is not, is one of, contains, is empty, is not empty); additional keep-matching filters independent of section assignment, using the same comparisons; and which column holds the line type, with each line type listing the cell values that mean it.
  - The editor exposes **Import rows only when** in every table section, including **Every row**. Every filter condition must match; no filters impose no restriction. Filters are preserved when assignments or reading methods change.
  - A row is accepted only when both assignment and filter conditions match. Rejected rows are counted once as ignored before date/amount extraction, and remain excluded from mixed-profile AI input. Preview and import share this behavior. Stored profiles without filters retain their prior behavior; portable exports use version 3 to prevent older readers silently dropping filters.
- **FR-055**: Each section of a profile with a table layout is read one of two ways, chosen in the editor: from the table's rows by code, with row rules, or by the AI, with its description. A section read from the table needs no description. When every section is read from the table, a spreadsheet read with that profile MUST be read from its columns by code, with no AI call and without needing an AI provider. The reading of the table MUST:
  - find the table by its column headings, and read the rows below them up to the first blank row;
  - fail, naming the row, when a row matches the rules of more than one section;
  - leave out a row that matches no section, and count it among the ignored lines;
  - fail, naming the row and the column, when a date or an amount cannot be read, so no partial group appears (FR-011);
  - read amounts as exact decimals, never as rounded numbers, with an amount in brackets or with a minus sign (including the typographic `−`) read as negative;
  - leave out a row whose line type is not listed (FR-034);
  - read each stated total from the number printed next to its label, and add them up in code;
  - give each item the row's line number in the text of FR-051, so the reviewer can find it.
- **FR-056**: A reading from columns can leave out hundreds of rows. The group MUST show how many were left out and a sample of them, such as "Ignored 726 lines (20 shown)".
- **FR-057**: When some sections are read from the table and others by the AI, the table MUST be read by code first, as FR-055 says, and the AI MUST then read the other sections from the spreadsheet's text (FR-051) **with the table's data rows left out**: the table's rows are never sent to the AI. The heading row stays, every other line keeps its number, and one unnumbered line marks where the rows were. The two readings are joined into one group before any item is made, so signs, categories and the control total are worked out once over every section:
  - the other party, the currency and the document's date are the layout's where it gives them, and the AI's otherwise; the reference is the AI's, and an item read from the table takes only its own row's;
  - the stated total is the layout's labels, read by code, when it names any; otherwise the figure the AI read beside the profile's own stated total label;
  - the item limit (FR-010) counts both parts together, and the ignored lines are the table's, then the AI's.

  Such a reading needs an AI provider. A section with no row rules in a profile with no table layout is read by the AI, as before.

**Transfers**

- **FR-058**: A section of kind Transfer MUST name its other account. It MUST be saved only when the profile names a "Money moves in" account, and the two MUST be different accounts that hold money (such as a bank account, cash or a marketplace wallet), checked when the profile is saved. A transfer item has no other party and no category; the group's table shows the other account where other items show a category, and its kind says Transfer. The reviewer MAY change either account of one transfer item, within the same rule.
- **FR-059**: Confirming a transfer item MUST create one Transfer record between its two accounts, audited and with the source document attached as for any imported record (FR-027, FR-046). A transfer MUST be in the main currency: a transfer item in another currency needs attention and is left behind by "Confirm all". A document read the standard way never produces a transfer.
- **FR-060**: A transfer item MUST be flagged as a possible duplicate when an existing Transfer record has the same amount, the same two accounts and a date within seven days, including one created in Reconciliation. One existing transfer MUST flag at most one item of a reading.

**Rows to check, references and the same money twice**

- **FR-061** (removed): Profile-defined row review flags are no longer supported. Matching rows are imported normally; legacy flag rules are ignored. Other attention checks, including duplicates and overlaps, still apply.
- **FR-062**: In Every transaction mode an item MUST take its reference only from its own row. When a row has none, the item has none; it MUST NOT take the reference printed in the document's header.
- **FR-063**: For items read from columns, or read by the AI in Every transaction mode (in pieces or in one call), an item that has its own reference MUST NOT be flagged as a duplicate of an existing record that has a different reference, even when the date, amount and other party match. Two transactions with different references are different transactions. Every other reading keeps the check of FR-024 unchanged.
- **FR-064**: Confirming anything from a document read as several items or with a profile (an item of a group, or the one review card of a reading that found a single item) MUST be refused when another upload of the identical file has already made a record. The refusal MUST say how the file was already imported. The check MUST happen in the same step that writes the record, so two confirms arriving together cannot both pass it. A document read the standard way keeps today's behaviour (FR-004).
- **FR-065**: When a long document is read in pieces, an item with no line number, or with a line number outside the lines its piece was shown, MUST be kept and flagged for the reviewer, never removed. An item read from the context lines of a piece is dropped only when the piece that owns that line listed it too; otherwise it is kept and flagged (FR-043).
- **FR-066**: A section MAY name another profile whose records describe the same money (for example a wallet report's order income and an income statement's sales). When records made with that profile already cover the same dates, the section's income and expense items MUST get a review note saying the money may be counted twice. Transfers are not affected.
- **FR-067**: A PDF or a photo read with a profile that has any section read from a table MUST fail, saying the profile reads a spreadsheet's table and the file is not a spreadsheet. It MUST NOT be read without those sections, which would import part of the document as if it were all of it. The upload's "Read as" list marks a profile that reads one kind of file "spreadsheets only" or "PDFs and photos only" (FR-070). A spreadsheet uploaded as text, with no cells, fails the same way.
- **FR-068**: A saved profile MUST be exportable as one JSON file, and such a file MUST be importable into another installation, so that a profile built and tried on a test copy does not have to be typed again. The file MUST name each account and category by its code and name and each same-money profile by its name, never by id, because an id from another installation is meaningless or names a different account. An import MUST look each one up by code first, then by name. One that is not found is left empty and listed for the user to choose. An import MUST save nothing by itself: it fills the profile editor, and Save adds the profile or, when a saved profile has the same name, replaces that one, with the same checks, permission (`import.change`) and history as an edit by hand. Exporting needs only `import.view`.
- **FR-069**: A profile MUST read **one sheet** of a workbook, and both its table (FR-055) and its AI part see that sheet and no other. The profile MAY name the sheet; the name matches whatever its case and spacing. A profile that names none reads, when it has a table, the sheet the table's headings are on (visible sheets first), and otherwise the first visible sheet. A workbook without the sheet a profile names MUST fail before any AI call, naming the sheets it has, and Auto-detect MUST NOT choose such a profile; a profile that names its sheet is recognised by that sheet's words only. Auto-detect's AI call is shown the start of every visible sheet, not only the first. Every piece of a long reading of a sheet (FR-043) is also shown the sheet's name and its column headings, which are no piece's own lines. When the file has more than one sheet, the reading says which it read ("sheet "Income""). _Why one:_ the sheets of a marketplace report are mostly views of the same money, one file is imported one way only (FR-026), and the AI is never sent a sheet it does not need. **Known limit:** a workbook whose sheets hold _different_ money cannot be imported in full, since the same file cannot be imported twice; that needs the repeat-file check to know the sheet, and is left until a real file needs it. A CSV file is one sheet. Readings without a profile still read every sheet (FR-051).
- **FR-070**: A profile MUST say which files it reads: **PDF files and photos**, **spreadsheets** (Excel and CSV together, so one profile reads both exports of a report), or both. Table rows and Table rows and summary lines read only spreadsheets (FR-067), and the editor shows this without a choice. Summary lines and Transaction lines MUST have at least one ticked; a profile saved before the choice existed reads both. The Sheet field (FR-069) is shown only for a profile that reads spreadsheets, and a profile that does not read them keeps no sheet; a CSV file has one sheet. Auto-detect MUST NOT choose, match by phrases or offer the AI a profile that does not read the uploaded file's kind (FR-039). A file read with a chosen profile that does not read its kind MUST fail before any AI call, saying what the profile reads. _Why only two:_ the reading branches there and nowhere else — a PDF and a photo go the same way to the AI, and Excel and CSV are the same workbook to every reader.

### Key Entities _(include if feature involves data)_

- **Source document**: The uploaded file. It keeps how it was to be read (standard, several items, or a profile and import mode), whether that was chosen or detected, whether it was read by the AI, in pieces or from columns, its stored copy, the stated total, the ignored lines and how many lines were ignored.
- **Item**: One proposed record from a source document. It has the same details as today's proposed record, plus its group, its kind (Income, Expense, or Transfer out of or into the "Money moves in" account), for a transfer its other account, and, for a profile, its section and line type. It ends confirmed, skipped or discarded.
- **Group**: The items of one source document, reviewed together on the group's own page. It exists only when a document yielded more than one item.
- **Ignored line**: A short piece of text for a line the system saw and left out, kept with the source document for the reviewer.
- **Import profile**: A named recipe: how to recognise the document, its one import mode, instructions, one stated total, sections, and optionally a "Money moves in" account and a table layout for spreadsheets. It can be enabled or disabled.
- **Section**: A part of a document a profile can read: its kind (and for a transfer, its other account), its optional fixed category, its line types, its item layout, and, with a table layout, its row rules.
- **Line type**: A named kind of charge in a section, optionally tied to a category. When reading from columns, it lists the cell values that mean it.
- **Table layout**: The description of a spreadsheet's table on a profile: sheet, column headings, which column holds what, and the labels of its stated totals.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can turn a document with ten fee lines into ten confirmed records with no edits in under two minutes of hands-on time (upload, choose, "Confirm all"), instead of entering ten records by hand.
- **SC-002**: On the maintainer's sample documents (at least three real documents that carry header numbers and tables, including a marketplace income statement), no header number, subtotal, total or balance is ever proposed as an item.
- **SC-003**: On the same samples, every intended line is proposed, or the group shows a visible warning (a Control total difference, or an ignored line the reviewer can see should not have been left out). No sample produces a wrong set of items with no sign of it.
- **SC-004**: When a document states a total for the lines being imported, a difference of even one cent between it and the items is shown every time.
- **SC-005**: Receipts and invoices uploaded the usual way behave as before, apart from the history link in FR-021: every existing import scenario passes unchanged, items already in the queue or history before the upgrade look and behave as they did, and with no saved profiles there is no extra AI call.
- **SC-006**: After "Confirm all" on N items there are exactly N new records and one stored file. After the attachment is deleted from one record the other N−1 still open the file, and after it is deleted from the last one no stored file remains.
- **SC-007**: No item is flagged as a duplicate of another item from its own document, and a document repeating last month's lines is not flagged on wording alone (checked with a two-month example).
- **SC-008**: The same file uploaded twice is stopped before reading every time the first upload created at least one record, whichever mode it was imported in.
- **SC-009**: On a sample marketplace statement, importing the Summary gives income and expense items whose total (income less expenses) equals the stated net amount released. On a sample with one transaction per line (the maintainer's wallet report), importing Every transaction gives exactly one item per row of the transaction table.
- **SC-010**: A statement of several hundred rows is read completely, and its group page opens and pages without a noticeable wait (each page of items appears in under two seconds).
- **SC-011**: Pressing "Confirm all" again after an interruption never creates a record twice.
- **SC-012**: On the maintainer's sample documents, Auto-detect uses the intended profile for every document that has one and the standard reading for the rest. A wrong pick is always visible on screen and can be corrected with "Read again" without uploading again.
- **SC-013**: A user can create a profile for a new kind of document and import its first document without any change to the software, in under fifteen minutes.
- **SC-014**: On the maintainer's wallet report spreadsheet, with no AI provider configured: a "withdrawals only" profile gives one transfer item per withdrawal (ten), the one still processing is flagged, and "Confirm all" makes a Transfer record from the wallet to the bank for each of the others; a full "every transaction" profile gives one item per row (736) and a Control total that matches the report's own totals of money in and money out.
- **SC-015**: Reading the same spreadsheet with the same profile twice gives the same items every time, because no AI is involved.
- **SC-016**: A withdrawal already recorded as a transfer in Reconciliation is flagged as a possible duplicate when the wallet report is imported.
- **SC-017**: A long one-transaction-per-line PDF is read in pieces with every row read once and none dropped. _Not checkable on real data until the maintainer supplies such a PDF;_ until then it is shown with tests that use a stand-in AI.

## Assumptions

- **Sources are receipts, invoices, marketplace income statements and marketplace wallet reports** (confirmed with the user; wallet reports added 2026-10-02). A statement has a summary and a table of transactions, and the user chooses to import one or the other, never both.
- **A marketplace wallet report is a source document for money that has no other one** (confirmed with the user, 2026-10-02). A withdrawal from the wallet to the bank is proved by nothing else the business receives, so the report is its evidence. It is not a bank statement: it never creates statement lines (FR-049), and the bank side of the same withdrawal is still matched in Reconciliation against the record it made.
- **A wallet report's order income usually repeats the income statement** (from the maintainer's samples). The same sales appear in the income statement's summary and, line by line, in the wallet report. The recommended use is the summary from the income statement and only the withdrawals from the wallet report. Importing every row of the wallet report as well would count the sales twice, which is why FR-066 adds a review note.
- **Spreadsheets are `.xlsx` and `.csv` only** (confirmed with the user, 2026-10-02). Old `.xls` files, password-protected workbooks and other formats are refused with a reason, and can be saved as `.xlsx` by the user. The spreadsheet is read by code written for this feature, with no new library (Constitution II).
- **Every transaction means one record per row** (confirmed with the user). Fees that are already inside a row's amount stay inside it; the user reads with a Summary profile when fees should be booked separately.
- **Scope is source documents, not bank statements** (confirmed with the user). A bank statement only lists money that moved, and is matched against records in Reconciliation (`001-bank-reconciliation` FR-012). Importing it as records would risk counting the same spending twice.
- **The standard reading is the fallback** (confirmed with the user): detect a profile first, and if none fits read the document as today.
- **The document is not necessarily a table** (confirmed with the user). Fees may be described in sentences or sections.
- **Each profile reads one import mode** (decided 2026-10-02, replacing a choice at upload). A profile already says which part of a document it reads, so a separate "Import" choice only got in the way: it had to be overridden for every profile whose sections were all in one mode. A new profile reads Summary, the simpler bookkeeping, until the user changes it. Reading one kind of document both ways takes two profiles, such as one for a wallet report's withdrawals and one for its every transaction.
- **The several-items reading treats the whole document as one kind** (expense or income). Profiles are the way to import both kinds from one document.
- **Credits, discounts and refunds** are not turned into records by the several-items reading. A profile imports them with a By sign section.
- **One table for every group.** A group is reviewed in a table on its own page whether it holds three items or three hundred, rather than cards for small groups and a table for large ones. This replaces the earlier plan for cards.
- **A missed item is added by hand.** The group has no "add item"; the reviewer uses the ordinary new-record screen.
- **Initial limits are about 200,000 characters of document text and 1,000 items per document.** They are starting values, to be adjusted after real use. The text limit applies to what the AI reads; reading from columns has no AI and is bounded instead by caps on the size of the file, the number of rows and the size of a cell. A spreadsheet read the standard way is bounded by the standard reading's 6,000 characters (FR-052).
- **Only the text of a document is sent to the AI provider, not page images.** Tables can come out scrambled on some PDFs. This is checked on real sample documents, including a marketplace statement, during planning, before any screen is built. If it proves inadequate, sending page images is a separate feature.
- **Imports keep starting on Accounts payable or Accounts receivable, as today,** unless the profile names a "Money moves in" account (confirmed with the user, 2026-10-02). A wallet report is about money already in the wallet, so its items start on the wallet. The group's Source account changes either for all items at once.
- **A transfer is in the main currency.** The books record a transfer between two accounts at one rate, so a transfer in another currency is left for the reviewer rather than guessed.
- **Pieces are for long documents read by the AI in Every transaction mode.** A spreadsheet's table read from its columns is read whole by code and never in pieces. A spreadsheet read by the AI is read like a PDF, so a long one is read in pieces too, and so is the part beside a table that code reads (FR-057), though with the table's rows cut out it is usually short enough for one call. Every other reading of a document that is too long fails with the limit named (FR-010).
- **The general import instructions still apply** to the several-items reading. A profile's instructions replace them for that profile.
- **No new permission.** The existing import permissions cover reading, confirming, skipping and discarding. Managing profiles uses the permission to change imports.
- **An AI provider is still optional**, as today. Without one, imports fail as they do now, and entering records by hand is unaffected. The exception is a spreadsheet read from its columns, which needs no AI provider at all.
- **Profiles are written by hand.** Drafting a profile from a sample document with AI help is out of scope.
- **This supersedes three earlier statements, for source documents only:** the note in `002-double-entry-ledger` that pulling more than one record out of a single imported document is out of scope, the design note in `docs/DEVELOPMENT_PLAN.md` that a receipt is one file and one record, and this spec's own first draft, which treated profiles, a table review page and mixed kinds as out of scope. `001-bank-reconciliation` FR-012 is unchanged.
- **Delivery is in stages.** User Stories 1 to 3 first, then 4 to 7, then 9, then spreadsheets, transfers and every transaction (User Stories 8, 10 and 11; `design.md` § S4). User Stories 10 and 11 are P2 but come last, because they were found after the earlier stages were built. Each stage stands on its own.

## Out of Scope

- Bank statements, which stay in Reconciliation.
- One row producing several records, for example a sale plus its fee columns. For this reason Every transaction is not offered for a table with one row per day and many amount columns.
- Old Excel (`.xls`) files, password-protected workbooks, and spreadsheet formats other than `.xlsx` and `.csv`.
- Working out a spreadsheet's formulas. The value the spreadsheet last showed is used.
- Accepting spreadsheets in Reconciliation or as record attachments, which keep accepting PDF and images only.
- Transfers in a currency other than the main currency.
- Drafting a profile from a sample document with AI help.
- Sending page images to a vision model.
- Adding a missed item inside a group.
- Confirming without review.
- Who is allowed to change Settings in general, noted separately from this feature.
