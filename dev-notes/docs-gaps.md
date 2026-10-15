# Akaun Guide — gaps in the UI

These features are partly built. The guide (`docs/docs/`) does **not** describe them as
working. When you fix a gap, update the guide pages in its row and then delete the row.

| # | Gap | Guide pages that write around it |
|---|---|---|
| 3 | "Record a receipt" (money in from a customer, `/records/new/payment?direction=we-receive`) has no general link. The only way in is **Record payment** on a sent invoice (`?invoice=<id>`), so a receipt that settles anything other than an invoice cannot be reached (see gap 28). | `05-sales/getting-paid.md` |
| 5 | Settings is not gated by permission. All users see it, and the Company, Templates and Intelligence saves have no check. The Users & Groups screen says settings are superuser-only. | `09-administration/settings-reference.md` |
| 6 | Backup, restore and reset are not in the UI. The descriptions of the seeded groups mention them. | `09-administration/backups-and-upgrades.md` |
| 7 | **Forgot?** and **Ask your admin for access** on the login page do nothing. | `01-getting-started/first-sign-in.md`, `10-help/troubleshooting.md` |
| 8 | Reports cannot be printed. Only **Export** (CSV) is available. | `08-reports/*` |
| 9 | The default admin password shows only in the server log and in the seed data. There is no first-run wizard. | `01-getting-started/first-sign-in.md` |
| 10 | Out-of-date text: the README mentions Reimbursement Claims, claim PDFs and "Settings → Providers". CLAUDE.md mentions `/categories` and an "Accounts › Categories" tab. None of these exist. | none (the guide does not copy them) |
| 11 | **The record form does not offer Liability accounts** (Accounts Payable, credit card, loan) to a user without Adjustments. The account list is money accounts (Asset only, `isMoneyPotAccount`) plus categories (`loaders/records.ts`). So a Bookkeeper cannot enter a bill to pay later or a credit-card expense by hand. *Checked in source.* | `03-everyday-tasks/bills-you-pay-later.md`, `02-concepts/owed-and-paid.md` |
| 12 | **Paid by a third party** can never be chosen. `AccountSelect` defaults to `required = true`, so the option never shows. The label is placeholder text only. *Checked in source.* | none (removed from the glossary) |
| 13 | The Accounts screen and the account page show the raw sign: Liability, Equity and Revenue balances show a minus. The reports show them as positive. | `02-concepts/how-an-entry-works.md` |
| 15 | **Keep me signed in** on the login page does nothing. A session always lasts 30 days. *Toggle state checked; session length not checked.* | `01-getting-started/first-sign-in.md` |
| 16 | No UI resets the password of the last superuser. `scripts/create-admin.ts` imports `$env` and may not run outside SvelteKit. | `01-getting-started/first-sign-in.md`, `10-help/troubleshooting.md` |
| 17 | The PWA manifest opens `/dashboard` (*checked*), but no seeded non-superuser group has the `dashboard` permission. Such a user goes to Settings. | `01-getting-started/finding-your-way.md` |
| 18 | Deployment traps: a wrong `ORIGIN` gives "Forbidden (CSRF origin check failed)". `NODE_ENV=production` makes the cookie HTTPS-only, so sign-in over plain HTTP on a LAN fails. Without `BODY_SIZE_LIMIT`, uploads over 512K fail. The README covers none of these. | `01-getting-started/install.md` |
| 19 | A reload, or closing the tab, drops unsaved edits on a detail page without a prompt (only in-app navigation is guarded). | `01-getting-started/finding-your-way.md` |
| 20 | The numbering help in Settings still lists the `CL` prefix (now used for payments) and does not explain it. | `09-administration/settings-reference.md` |
| 23 | On a record page, a failed upload shows no error, and **Add** (attachment) shows to a user without the Change permission. | `03-everyday-tasks/attach-receipts.md` |
| 24 | Deleting an attachment (X) and **Take this back** happen at once, with no confirm step. | `03-everyday-tasks/attach-receipts.md`, `03-everyday-tasks/edit-delete-undo.md` |
| 25 | On a payment that is not yet settled, Amount, Date and the accounts look editable, but the save sends only description, reference and remark. | `03-everyday-tasks/edit-delete-undo.md` |
| 26 | For a user without Adjustments, an imported bill's page probably shows "Select account" on the **out of** line, because `AccountSelect` does not offer Accounts Payable (follows from gap 11). Not confirmed. | `03-everyday-tasks/bills-you-pay-later.md` |
| 27 | **Export CSV** exists only on the account statement view. The full Records list has no export. | `03-everyday-tasks/find-records.md` |
| 28 | Accounts Receivable *is* offered on a new record (`isMoneyPotAccount` counts it as a money account), so a normal user can save an Outstanding income. Gap 3 then leaves no way to settle it. The guide does not describe this path. | `03-everyday-tasks/record-expense-or-income.md` |
| 29 | The **Category hints** switch (Settings › Intelligence) is saved, but nothing reads it. | `04-auto-import/connect-an-ai-provider.md` (says it has no effect) |
| 30 | The import queue heading always says "x/3 workers active", whatever **Parallel tasks** is set to. | `04-auto-import/import-receipts.md` |
| 31 | A default expense card says "Marked as paid personally — owed to the contact above until reimbursed", but the code treats the item as a supplier bill that is not paid yet (Accounts Payable). | `04-auto-import/review-and-confirm.md` |
| 32 | **Clear history** and **Discard** empty the list on screen even when the server refuses (no Delete permission). **Clear history** also removes the list for all users. | `04-auto-import/import-receipts.md` |
| 36 | The contact **Delete** tooltip says "Archive it instead", but contacts have no archive control. | `06-contacts.md` |
| 37 | A merge runs at once when **Merge into selected** is clicked. There is no confirm dialog, and a merge cannot be undone. | `06-contacts.md` |
| 38 | **Not duplicates** hides the group on screen only. Nothing is saved, so the group shows again on the next visit. | `06-contacts.md` |
| 39 | **Partners' Equity:** no control links an Equity account to a partner, so **Contributions** and **Drawings** always show 0.00 in a new book. Only **Share of profit** (split equally) works. `ensurePartnerAccounts` is a no-op. | `08-reports/partners-equity.md`, `06-contacts.md` |
| 40 | Report drill-down opens the account page, not Records, and loses the report dates. Cash Flow lines cannot be clicked. | `08-reports/*` |
| 41 | The match screen lists records from every account that has a statement, not only this statement's account. Records from other accounts can never match. | `07-bank-reconciliation.md` |
| 42 | The report CSV export leaves out the P&L **Summary** (Gross profit, Operating income) and the Balance Sheet Current/Non-current groups. | `08-reports/profit-and-loss.md`, `08-reports/balance-sheet.md` |
| 43 | The statement extraction error says "add the transactions manually", but no UI adds a statement line. | `07-bank-reconciliation.md` |
| 44 | **Security.** At every start, `ensureGroupSeed` (`db/client.ts`) puts each user with no group into **Administrators**. Removing all of a user's groups to take away access gives that user full access at the next restart. The screen says such a user "sees an empty app". *Checked in source.* | `09-administration/users-and-groups.md` |
| 45 | **Security.** `ensureDefaultAdmin` (`db/client.ts`) creates `admin` / `akaun-admin` whenever no user has the username `admin`. If the admin user is renamed, a known password returns at the next start. *Checked in source.* | `01-getting-started/first-sign-in.md` (caution added) |
| 46 | **Issue API token** in the user row menu makes a token that is never shown. | `09-administration/users-and-groups.md` |
| 47 | **Remove user** probably fails ("Failed to delete user") for a user who made records, accounts or contacts: the foreign keys have no delete rule. Not seen at runtime. | `09-administration/users-and-groups.md` |
| 48 | Seeded grants: **Bookkeeper** has no Change on Auto Import, so it cannot confirm or skip imported items. **Data Entry** has View on Contacts only. | `09-administration/users-and-groups.md` |
| 49 | **Migration results** names `data/backups`, but the copy is in `pre-chart-<stamp>/`. | `09-administration/backups-and-upgrades.md` |
| 50 | The search index **Rebuild** (Settings › Advanced) has no permission check. | `09-administration/settings-reference.md` |
| 51 | A password change or reset does not end the user's open sessions. **Security.** | `09-administration/your-profile.md` |
| 52 | **Confirm & import** and **Skip** show to a user without Change on Auto Import. The server then refuses the action (403). Extends gap 48. | `04-auto-import/review-and-confirm.md`, `10-help/troubleshooting.md` |
| 53 | **Money usually comes from** (Settings › General) has no effect. `saveGeneral` writes `ledger_default_account_id`, but nothing reads it; `defaultAccountId()` reads the Books **Default transaction account** instead (`settings/+page.server.ts` ~242). | `09-administration/settings-reference.md`, `10-help/glossary.md`, `01-getting-started/set-up-your-book.md` |
| 54 | The Settings unsaved-changes guard does not cover the Books **Default accounts** lists (not part of `isDirty`). | `09-administration/settings-reference.md` |
| 56 | The **Partner** hint in the New contact drawer says "A partner gets two accounts…", but `ensurePartnerAccounts` does nothing (`ContactsPage.svelte:579`). See gap 39. | `06-contacts.md` |
| 57 | **History** (AuditTrail) does not refresh after an attachment is added or deleted (`AttachmentManager.svelte`, `RecordDetail.svelte`). | `03-everyday-tasks/attach-receipts.md` |
| 58 | Deleting an attachment does not update the record's search text (`api/records/[id]/attachments/[attachmentId]/+server.ts`). | `03-everyday-tasks/find-records.md` |
| 59 | The Contact field on a record, invoice or quotation lists only contacts with the matching role (Supplier or Customer). A contact without the role is missing, and **Create** then makes a duplicate. | `03-everyday-tasks/record-expense-or-income.md`, `05-sales/*` |
| 60 | With no saved import profiles, Settings says "Select New profile to start from an example, or from blank", but the new-profile page always opens blank (`settings/+page.svelte` ~1868, `settings/import-profiles/new/+page.svelte`). | `04-auto-import/import-profiles.md` |
| 61 | The missing-contact message differs between client and server: "Say who this money is owed to, or owed by, before saving it." (`components/ledger/journal-rules.ts:109`) vs "Say who this is owed to or by." (`server/ledger/sides-from-accounts.ts:94`). | `10-help/troubleshooting.md` |
| 62 | "Today" is the local day only for quotations and invoices (`src/lib/local-date.ts`: overdue, expired, the sales forms' issue date). The rest of the app still takes today in UTC (`toISOString().slice(0, 10)` in `RecordForm`, `PaymentForm`, `OpeningBalanceSheet`, `queries/settlements.ts` days late, Auto Import, and others). East of UTC, a new record or receipt defaults to yesterday before 08:00 MYT, and a bill is counted a day late or early. *Checked in source.* | none |
| 63 | **Settling after the Receivable default changes.** Paid state now finds the owed side by account subtype, but `createSettlements` (`services/settlements.ts`) still requires the payment's side to be on the *current* Receivable default and the owed side on that same account, and the outstanding-items list (`queries/settlements.ts`, `savedAccountId`) reads only the current default. An invoice sent before the default changed does not show in **Allocation**, **Record payment** ticks nothing, and a settlement is refused. *Checked in source.* | `05-sales/invoices.md`, `05-sales/getting-paid.md`, `09-administration/settings-reference.md` |
| 64 | **Leftover cents on foreign-currency invoices.** The issue posts `toMinor(total, invoiceRate)` in the main currency; the receipt is always in the main currency. A payment at a different rate leaves a few cents outstanding (or unallocated on the payment). There is no exchange gain/loss account, so a user without Adjustments cannot clear it, and the invoice can no longer be cancelled (something is paid). *Checked in source.* | `05-sales/invoices.md`, `05-sales/getting-paid.md`, `02-concepts/foreign-currency.md` |

Gaps 13–61 come from the writer agents. Gaps 62–64 come from the quotations and invoices refinement.
Not a gap: a deleted or renamed seeded group (Bookkeeper, Data Entry, Reviewer) returns at the next start. `users-and-groups.md` says so.
Gap 21 (removing a bank match) was withdrawn: untick the lines on the matched record and save. Unless marked *checked*, confirm a gap before you fix it.

## Open decisions

- **Gap 11 — Accounts Payable in the record form (asked 2026-10-09, not answered yet).** Should
  the record form offer Accounts Payable (and credit-card and loan accounts) to a user without
  Adjustments, or should the guide keep writing around the gap? Until this is decided,
  `03-everyday-tasks/bills-you-pay-later.md` describes only the paths a user can reach: a bill
  that Auto Import created, and its payment through **Record a payment** or **Pay all
  outstanding**. It does not tell the user to choose Accounts Payable on a new record.
