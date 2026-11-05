# Phase 0 and phase 1 completion report — with approved tax-review follow-up

**Phase:** 0 — repository audit and design; 1 — expense tax classification foundation.  
**Commit / PR:** Branch `codex/expense-tax-phase-0-1`, based on verified remote main `152708d17e132e0c7c3c2c65785b495f681ab332`. See the branch commit and associated pull request for the published revision. No deployment or production migration performed.  
**Owner decision:** Pending owner walkthrough / acceptance. The owner-approved tax UI and strict tax-review close check are included; remaining later-phase work is deferred.

## What changed

Phase 0 produced `plan.md` before feature implementation: architecture/data flow, entity ownership, exact file map, migration design, decimal and historical-data policies, fiscal-year limitations, existing close/reopen entry points and deferred questions. The explicit request to implement both phases supplies authorization to proceed through the handover's intermediate gate.

Phase 1 adds optional Expense-account deduction defaults, saved per-movement effective tax snapshots, independent reasoned overrides (including duplicate-account splits), and a dated Expense tax report with CSV export. API and MCP record operations share the existing services. Import capture also passes through the central query boundary. Default edits affect new lines only. Overrides and default changes retain actor/time and existing audit-channel provenance; tax changes participate in record versions. Tax-only changes leave every financial movement amount unchanged.

Percentages are integer basis points: 0–10000 = 0.00–100.00%, with two decimal places. BigInt calculates line deductions from signed main-currency cents, rounding halves away from zero. Add-back is the exact line remainder; reports sum rounded lines. Ordinary treatment requires 100%, partial strictly between 0% and 100%, non-deductible/capital expenditure 0%; requires-review values are unresolved. Nothing is labelled accountant-approved.

## Approved treatment-first UX and mandatory close review

The owner approved Requires review as the fallback and a strict close blocker. Tax treatment is now selected first: Ordinary deductible fixes 100%; Non-deductible and Capital expenditure fix 0%; Partial alone accepts 0.01–99.99%; Requires review hides percentage and saves NULL. Account setup also offers No default, which leaves new lines requiring review. A valid partial value is retained only within the current draft when switching treatments. Client save guards and server validation prevent partial endpoints. Existing inferred defaults display their effective treatment; historical tentative review percentages and unrelated saves preserve stored evidence.

Records display Needs tax review badges. Reports show an unresolved warning driven by line count even at zero net amount, and an addressable Needs tax review filter; JSON/CSV export uses the same filter. True void pairs remain traceable in the full report but are excluded from actionable review counts.

Month closing now shows a separate mandatory tax check and links to affected records and the filtered report. It checks active Expense lines in the newly protected range, includes historical NULL snapshots, excludes true void pairs, and refuses unresolved lines even when their signed amounts cancel. The check is part of the stale-review revision and is recomputed inside the immediate close transaction. Successful closes retain `taxReviewCheck` audit evidence. Already closed periods remain frozen. This is the owner-approved exception to the handover's warning-only proposal; it does not add annual tax approval or finalisation.

## Migrations and data impact

`drizzle/0041_expense_tax_classification.sql` uses three additive `ALTER TABLE ADD COLUMN` statements:

- `accounts.default_tax_percentage_bps`: nullable integer with SQL type/range/Expense-only check.
- `accounts.default_tax_treatment`: nullable category with SQL enum/Expense-only check.
- `ledger_movements.tax_classification`: nullable JSON snapshot with SQL JSON/range/enum checks. Snapshot contains percentage, source, treatment, reason, actor, timestamp and origin.

The UX/strict-review follow-up requires no additional migration or data backfill. Nullable Requires-review overrides fit the existing snapshot schema.

The migration is registered in `_journal.json` with `0041_snapshot.json`. It does not backfill, infer historic approval, recalculate balances, change record/movement IDs or create journals. Historical NULL snapshots remain unreviewed even through unrelated open-period amount/label saves. New lines without a configured percentage also remain unreviewed. Explicitly changing an expense account captures that account's current default.

The generated migration was hand-corrected to additive ALTERs: Drizzle's generated table rebuild selected new columns from old tables. Rehearsal against a 0040 fixture with allocations, historical expenses, audit and a closed-month setting verifies preservation and foreign keys. Subsequent schema generation reports no changes.

## Automated tests — commands and results

- Baseline `bun run check`: **0 errors, 0 warnings**.
- Baseline selected ledger/account/closing/void suites using the repository Bun adapter: **89 passed, 0 failed** before feature changes.
- New tax rule, application and migration specs: **19 tests passed** as part of the final regression run. Includes the RM1,000 / 50% and RM600 / 100% + RM400 / 0% examples, duplicate-account splits, signed refunds, reversal snapshot copying, prospective defaults, historical NULL retention, stale versions, permissions, closed query/application boundaries, audit rollback, foreign-currency amounts, import confirmer attribution, invalid inputs, book isolation and unchanged financial totals.
- Additional targeted editor regression: **1 passed**, proving a five-line split retains every extra line, including duplicate-account labels/classifications. The editor now selects extra lines by movement identity; classification-only saves send only tax changes and never rebuild the journal.
- Final adapter run including the follow-up: **104 compatible server/shared-rule spec files: 1,603 passed, 0 failed; 2 snapshots; 15,958 assertions**. Four treatment-entry tests and ten mandatory-close tests cover null overrides, partial endpoints, transitions, net-zero review, void exclusions, historical/date scope, stale previews, permissions, audit rollback and filtered report/CSV output.
- Final `bun run check`: **0 errors, 0 warnings**.
- ESLint on every changed/new source file: **passed**.
- `git diff --check`: **passed**.
- `node node_modules/drizzle-kit/bin.cjs generate --name verify_tax`: **No schema changes, nothing to migrate**.
- `bun run lint`: existing formatter issues remain (**233 baseline files, 231 current files; no new file findings**). Separately run repository-wide ESLint reports **59 errors identical to the archived untouched baseline**. Unrelated lint cleanup is outside this feature.

The full adapter selection is recorded in `validation-files.txt`; run it with `xargs -a specs/009-expense-tax/validation-files.txt bun test --preload ./scripts/mcp-test-preload.ts`.

Reproduce the new feature tests:

```sh
bun test --preload ./scripts/mcp-test-preload.ts \
  ./src/lib/expense-tax.spec.ts \
  ./src/lib/server/application/expense-tax.spec.ts \
  ./src/lib/server/db/migration-0041.spec.ts \
  ./src/lib/components/ledger/journal-rules.spec.ts
bun run check
```

The normal `bun run test:unit -- --run --project server` failed at baseline before running tests: Vitest 4/Bun thread startup encountered `this._thread.stdout.pipe` on null. The existing `scripts/mcp-test-preload.ts` adapter was used, with explicit `./` file paths. It refuses loading the configured database client and supplies temporary storage. Vitest mocking-only suites and browser suites were not executed. All financial fixtures used in-memory or explicitly temporary databases. No real book or receipts were opened by these checks.

## Manual walkthrough — owner validation

1. In a development/test book, open **Accounts → Add account**, choose **Expense**, choose **Partial**, enter potential deduction **50.00%**, and save. The account detail should show the prospective default. Non-expense accounts should offer no tax defaults.
2. Open **Records → New**, create a **RM1,000** expense using that account and a bank account. The tax card should show the current 50% default before saving and a saved account-default snapshot afterward. Open **Reports → Expense tax**, selecting the transaction's date range: expense **RM1,000**, potential deduction **RM500**, potential add-back **RM500**, unresolved **RM0**.
3. Create a second expense. Enable **Override this line**, choose **Partial**, enter **25.00%** and give a reason. Save. The line should show a saved override and the account default should remain **50%**.
4. Choose **Ordinary deductible** on the account; its percentage must display read-only **100%**. Old records/reports should retain their saved 50% or 25%; a newly created expense should capture 100%. Saving an old record's amount/description should retain its saved percentage.
5. Create a split expense: **RM600 at 100%** and **RM400 at 0%** on two expense lines. The report should show **RM600** potential deduction and **RM400** add-back. Repeat with two lines on the same account; overrides should stay independent by occurrence.
6. Inspect a historical expense and a new line on an account without defaults. Both should say **Unreviewed**, with blank deduction/add-back and amounts included in the separate unresolved total. An explicit open-period override with a reason should classify only that line. Confirm an import: a configured default should snapshot on confirmation; an unconfigured one should remain unreviewed.
7. Change an account default, then void an older eligible expense. The reversal should copy the original tax snapshot and cancel both expense and tax totals. For a standalone refund/credit journal, enter a negative Expense line and explicitly override to the original transaction's treatment if defaults changed; deduction/add-back should be negative. There is no automatic credit-note matching in this phase.
8. With month-close permissions, close a month containing an expense. The record tax controls should be read-only; an API/MCP tax patch must refuse with no audit or version change. Account defaults should still be editable prospectively. Use the existing audited reopen process before correcting an original closed classification.
9. Download the report CSV. Verify dates, line IDs, signed expense, saved percentage, treatment, source, reason, actor/time/origin, review status and unresolved amounts agree with the screen. All figures must remain labelled estimates.
10. Check the record/account Activity trails. Default edits and tax overrides should be visible, including reasons. P&L, balance sheet, bank movements and settlement allocations must remain unchanged by tax-only edits.

11. Start a new Expense account: Requires review should be selected with no percentage field. Ordinary deductible must show a read-only 100%; Non-deductible/Capital expenditure a read-only 0%. Partial must reject blank, 0%, 100%, negatives and excess precision; accept 0.01% and 99.99%. Switch Partial 25% → Non-deductible → Partial and confirm 25% is restored; switching from a fixed value to Partial with no prior partial should require entry.
12. Choose Requires review on a record override with a reason and save without entering a percentage. Confirm the Needs tax review badge, unresolved report warning and unresolved-only filter/CSV. A historical tentative review percentage should remain visible as tentative evidence and excluded from estimates until explicitly changed.
13. Create unresolved positive/negative expense lines netting to zero. Month closing must list both and block in UI and API. Classify each, refresh checks and close successfully; confirm the successful tax check in audit. Voiding a true duplicate must remove that pair from the review queue; an independent refund must still need classification.
14. For a book already closed through an earlier month, verify only newly protected dates block a later close. Historical unreviewed lines in already closed periods remain immutable; correcting them requires the existing audited reopening process.

## Screenshots / UI locations

No screenshots were captured. Per `CLAUDE.md` verification policy, no browser or development server was started. Use the walkthrough above at `/accounts`, `/accounts/[id]`, `/records/new`, `/records/[id]` and `/reports/expense-tax`. The JSON/CSV endpoint is `/api/reports/expense-tax?dateFrom=2026-01-01&dateTo=2026-12-31` (append `&format=csv`).

## Financial reconciliation evidence

Automated assertions prove:

- RM1,000 at 50% = RM500 potential deduction + RM500 add-back.
- RM600 at 100% + RM400 at 0% = RM600 deduction + RM400 add-back.
- Converted expense RM4,500 at 50% = RM2,250 deduction + RM2,250 add-back.
- Every report satisfies signed expense = potential deduction + potential add-back + unresolved expense.
- Tax-only edits leave account financial totals identical.
- A void and its reversal net to zero even after the account default changes; historical NULL classifications remain NULL on both sides.
- Migration preserves original financial rows, allocation rows, audit and close boundary; foreign key check is empty.

## Known issues / deferred work

Owner UI/visual validation remains pending. The standard Vitest worker and repository-wide lint baseline limitations above remain. Historical entries are intentionally unreviewed; classify individually in an open month or use existing audited reopening. There is no bulk approval workflow, accountant approval state, annual tax worksheet/finalisation, tax-only annual adjustment, asset register, depreciation or capital-allowance calculation. No Malaysian tax-law determinations are encoded. A standalone credit note uses its saved/default treatment and needs an explicit original-treatment override if defaults changed. Repeated-account line overrides use zero-based occurrence, not an account-wide setting. The report includes void pairs for traceability; their monetary totals cancel, and actionable review counts exclude both rows.

## Rollback plan

Rolling back this follow-up removes the mandatory tax close gate; use explicit manual tax review before any close on older application code.

Before deploying, back up the complete SQLite family and receipt storage using the established backup process. Application rollback can retain these additive columns and their saved classifications; the old application does not read them. A previous version should not be used to edit tax-configured account types, and any new expense lines it creates will remain unreviewed when the feature is restored. Rehearse rollback on a copied book first.

Do not delete classification/audit evidence to roll back application code. To remove the schema permanently, first export saved tax classifications and stop the application; restore the pre-feature backup with the matching prior application, or perform an explicitly reviewed schema rollback and migration-history adjustment on a copy. Restoring a backup discards all later book changes, so reconcile/export those first. No production rollback was attempted or needed here.

## Changed files

- `.gitignore`
- `dev-notes/MONTH_CLOSING.md`
- `drizzle/0041_expense_tax_classification.sql`
- `drizzle/meta/0041_snapshot.json`
- `drizzle/meta/_journal.json`
- `specs/008-month-closing/spec.md`
- `specs/009-expense-tax/completion.md`
- `specs/009-expense-tax/plan.md`
- `specs/009-expense-tax/review-ux-plan.md`
- `specs/009-expense-tax/validation-files.txt`
- `src/lib/closing.ts`
- `src/lib/components/accounts/AccountDetail.svelte`
- `src/lib/components/accounts/AccountSheet.svelte`
- `src/lib/components/accounts/account-types.ts`
- `src/lib/components/ledger/RecordForm.svelte`
- `src/lib/components/ledger/journal-rules.spec.ts`
- `src/lib/components/ledger/journal-rules.ts`
- `src/lib/components/reports/ExpenseTaxReport.svelte`
- `src/lib/components/reports/ReportsPage.svelte`
- `src/lib/components/tax/ExpenseTaxLines.svelte`
- `src/lib/components/tax/TaxValuesFields.svelte`
- `src/lib/expense-tax.spec.ts`
- `src/lib/expense-tax.ts`
- `src/lib/server/application/accounts.ts`
- `src/lib/server/application/closing-refusal.ts`
- `src/lib/server/application/closing.ts`
- `src/lib/server/application/expense-tax.spec.ts`
- `src/lib/server/application/records.spec.ts`
- `src/lib/server/application/records.ts`
- `src/lib/server/application/tax-review-closing.spec.ts`
- `src/lib/server/application/version.ts`
- `src/lib/server/db/migration-0041.spec.ts`
- `src/lib/server/db/schema.ts`
- `src/lib/server/ledger/types.ts`
- `src/lib/server/loaders/accounts.ts`
- `src/lib/server/loaders/reports.ts`
- `src/lib/server/mcp/tools/accounts.ts`
- `src/lib/server/queries/accounts.ts`
- `src/lib/server/queries/expense-tax-report.ts`
- `src/lib/server/queries/expense-tax.ts`
- `src/lib/server/queries/ledger.ts`
- `src/lib/server/queries/tax-review.ts`
- `src/lib/server/services/accounts.ts`
- `src/lib/server/services/ledger.ts`
- `src/lib/tax-form.spec.ts`
- `src/routes/(app)/accounts/closing/+page.svelte`
- `src/routes/api/accounts/+server.ts`
- `src/routes/api/accounts/[id]/+server.ts`
- `src/routes/api/reports/expense-tax/+server.ts`
