# Phase 5 — annual tax worksheet

**Phase:** 5, annual tax preparation and tax-only adjustments.
**Commit / PR:** `codex/annual-tax-worksheet`, based on main `d4460f5`; see the pull request containing this report.
**Owner decision:** pending review. No phase 6 automation, deployment or live migration.

## What changed

Tax has its own navigation item, annual list and detail page. Choose YA and inclusive accounting dates explicitly. The worksheet retains canonical P&L inputs and saved expense classifications in the main currency; it never reads current account defaults as historical tax decisions. Expenses group by account, with unresolved lines shown first. The correction drawer shows saved treatment, annual treatment, calculated add-back and the change to the current worksheet. Reasons and evidence references are required.

Corrections are tax metadata, not ledger journals. One active correction per source line; replacing/withdrawing retains history. Each correction stores its calculated amount/direction as well as revised treatment; original treatment and signed expense remain in retained evidence and audit. Negative expenses and ordinary void pairs retain signed behaviour. Generated book depreciation already has a 0% saved classification and contributes one add-back, never two.

Other manual entries use increase/decrease plus a positive amount. Current-year capital allowance claims, brought-forward capital allowances and brought-forward losses have distinct categories. Carry-forward origin YA, reviewed balance and this-year utilisation are separate; only utilisation reduces the result. Duplicate active claims/balances for the same category/origin are refused. This is a preparatory bridge, with no statutory eligibility, ordering, tax-rate or payable calculation.

Draft -> Reviewed -> Finalised is separate from month close. Any content change returns to Draft. Accounting drift requires explicit refresh, with current-source hash confirmation; source corrections on changed or removed lines must first be withdrawn. Review/finalisation refuse unresolved lines and stale evidence. Finalisation requires a completed accounting period. Finalised evidence cannot be edited; Create amendment copies active entries into a new draft, retains the predecessor and records a reason. Optimistic versions increase across amendments so an old tab cannot match a new revision accidentally.

CSV and a standalone printable HTML view use retained evidence only, including the captured currency/company identity. Print uses the browser's Print / Save as PDF function. Exports do not depend on current ledger calculations succeeding. Text is escaped for HTML/spreadsheets. The UI uses existing detail frames, report cards, responsive drawers, audit trail and signal-only SSE; unsaved drawer edits and stale confirmation versions are protected.

## Migrations and data impact

`0046_annual_tax_worksheets.sql` adds `tax_worksheets`, `tax_worksheet_revisions` and `tax_worksheet_adjustments`. A revision's source JSON is the atomic source snapshot instead of a fourth source table. It has no cascading FKs into source records/movements. Unique indexes protect revision numbers, retry keys, active source corrections and manual claim identities. Checks enforce integer amounts, resolved source treatment/percentage combinations and revision states. Triggers protect finalised financial evidence and retained adjustment history. User identity FKs can become null when a user is deleted; copied actor names and the existing audit trail remain.

Migration creates no worksheets, changes no ledger rows/defaults/classifications, and enables no automation. Modern and legacy SQLite rename-mode migration tests compare accounts, journals, movements, settings, audit, depreciation, settlements and reconciliation before/after and check restart idempotence.

Permissions are new `tax.read/create/update/review/finalise/amend` leaves. `tax.read` explicitly exposes the worksheet's P&L and source expense evidence, independent of ordinary report/record access. Links to record pages require records.read. Finalise/amend are explicit, sensitive and non-delegable, with a session check at the application boundary. Review is sensitive. Existing seeded groups receive no new grants; administrators assign tax access deliberately. No OAuth scopes/MCP tools are added in this release. All tax writes use one permission-checked application boundary, immediate transactions, the existing append-only audit writer and post-commit signals.

## Automated tests

The environment initially had no Bun. Bun 1.3.11 was installed under `/workspace/work/phase5/tools`, outside the repository; no project dependencies changed. Commands below use `bun` for reproducibility with an ordinary Bun installation.

- Existing regression manifest plus depreciation/report-stream and the three new suites: **1,721 tests passed across 113 files**, 2 snapshots. After final export-isolation/exact-display and cross-amendment-version refinements, the three tax suites were rerun: **25 tests passed**, covering both added regressions. No claim that these overlapping counts are additive.
- Regression command: `bun test --timeout 20000 --preload ./scripts/mcp-test-preload.ts <files from specs/012-annual-tax/validation-files.txt>`.
- Final tax command: `bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/application/tax-worksheets.spec.ts src/lib/server/db/migration-0046.spec.ts src/routes/api/tax/stream/tax-stream.spec.ts`.
- `node node_modules/@sveltejs/kit/svelte-kit.js sync` and `node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json`: zero errors/warnings (final verification recorded before PR creation).
- Targeted ESLint and Prettier including the Svelte plugin: pass on changed/new source files.
- Drizzle generation: no pending schema differences. `git diff --check`: pass.
- Repository-wide formatting retains the existing **231-file** backlog; repository-wide ESLint reports **59 existing errors** outside this change. No repository-wide lint pass is claimed.

All financial tests use migrated in-memory books or existing temporary migration fixtures through the safe preload, which refuses importing the configured database client. No configured application, real book or receipt store was opened. No dev server was running. Browser/visual verification is assigned to the owner by `CLAUDE.md` Verification Policy; no browser test or screenshot is claimed.

## Manual walkthrough — owner validation

Use an isolated test book and a completed period, for example YA 2025 / 1 January–31 December 2025. Grant an accountant tax.read/create/update/review and explicitly tax.finalise/amend; grant record/closing permissions separately when exercising source records.

1. Create a January RM1,000 expense with saved 50% treatment, then close January. Open Tax -> New worksheet, confirm YA and dates, create, and open the new row. Expected original add-back RM500; source values reconcile to P&L.
2. Turn off Needs review only, expand its account and choose Change annual treatment. Choose Ordinary deductible / 100%, enter a reason and reference. Preview reduces the add-back RM500. Save. Original source remains 50%; worksheet effective add-back is zero. P&L, balance sheet, cash flow and reconciliation remain unchanged.
3. Replace that annual treatment with Partial / 25%. Expected effective add-back RM750, not RM1,250. Inspect withdrawn/replaced history and Activity. Retry a confirmed request using the same request key: no second adjustment or audit write.
4. Add Other tax adjustment using increase/decrease. Add a reviewed current-year allowance claim. Add YA 2024 brought-forward capital allowance balance RM5,000, utilisation RM600. Expected deduction is RM600, not RM5,000. Over-utilisation and duplicate category/origin entries refuse. Loss balances are separate. Withdraw/re-add a manual entry to correct it.
5. Include an unresolved historical expense. Review must refuse until annual treatment is resolved. Include a book depreciation journal: its saved 0% produces one add-back. Refunds reverse amounts; ordinary void pairs cancel and cannot receive annual source corrections.
6. Mark reviewed. In another session edit/add an open-period source. The tax page flags changes. Finalise refuses until explicit refresh and re-review. If a changed line has an annual correction, withdraw it first. A new accounting change after opening the refresh drawer refuses the stale confirmation.
7. Finalise a reviewed, completed period. Attempt edits via UI and API: refuse. Export CSV and Print / PDF. Reopen/correct an accounting month separately: the finalised worksheet and its exported files retain the original evidence, while the page flags divergence.
8. Create amendment with a reason. Expected new Draft with copied active entries and a higher version, predecessor still available. Refresh when appropriate, review and finalise. An old browser tab's previous-revision version must refuse writes against the amendment.
9. Test without each tax permission; report access alone does not grant tax access. A PAT cannot finalise/amend. Check mobile drawer scrolling, keyboard focus, close/discard confirmation, source/revision links and print layout.

## Financial reconciliation evidence

The closed RM1,000 / 50% fixture has original add-back 50,000 cents and correction -50,000 cents after annual 100% treatment. All saved movements and the P&L, balance sheet and cash-flow outputs are byte-identical before/after tax preparation. Refund fixtures retain negative add-backs and line rounding. The real depreciation posting fixture has P&L profit 166,667 cents plus one 33,333-cent depreciation add-back = 200,000 cents preparatory result. Manual linking and opening depreciation are not charged again.

Finalised CSV and print outputs remain identical after later source creation/deletion and amendment creation. Export evidence remains accessible even when a later ledger amount makes current report totals unsafe. Audit failures roll back the new adjustment, supersession, revision version and signals together.

## Known limitations / deferred work

- Preparatory annual worksheet only: no tax filing, jurisdictional rule engine, tax payable, automatic capital allowances, utilisation or rollover. Complex business-source/incentive/disposal computations remain accountant work.
- One immutable YA/accounting-period identity per worksheet, with non-overlapping accounting periods. There is no period/YA edit or draft-delete workflow; verify the creation dates. Fiscal restructuring and multiple basis periods require a later design.
- Evidence references are text; existing record attachments remain on their source record. No separate worksheet attachment uploader.
- The preparer may also review/finalise when explicitly authorised. No mandatory separation of people.
- Full snapshots and audit evidence prioritise reproducibility; large-book performance is phase 7 work.
- Owner browser/mobile/print validation is pending. Existing lint/format backlog remains.

## Rollback plan

Revert feature code while retaining migration 0046 and its data/constraints. Do not delete finalised worksheets, snapshots, adjustment history or audit entries. Tax writes create no GL transactions, so there are no financial journals to reverse. Re-enable the feature to regain worksheet access. Restoring a pre-feature database would lose tax evidence and requires a deliberate backup/recovery decision; it is not an automatic rollback step.

## Detail UI standardisation follow-up

Compared the annual tax detail and its drawers with AssetDetail, AssetDepreciation, InvoiceDetail, RecordDetail, ReportsPage and the shared detail/sheet styles. Removed nested card-body padding and mixed report-card chrome, using the existing detail card headings, definition rows, numeric alignment, action links and 16px content rhythm. The primary summary shows each amount once; an expandable breakdown retains original add-backs and corrections. Preparatory notes use the shared report note component below the content rather than crowding the hero.

Expense classifications now show all accounts initially, with a shared Needs review checkbox. The desktop view uses report table typography and contextual source actions; mobile uses the standard detail-row pattern. Adjustment and revision lists use ListExpand; source corrections display expense descriptions instead of internal movement identifiers, and historical versions have a clear Open latest revision action. Review controls use consistent small buttons with explanatory disabled-state text. Successes use the existing toast notifications. Drawer category/direction controls and reasons use the shared Select and Textarea; the existing unsaved-change, expected-version and idempotency behaviour is retained.

Review/capture/withdrawal times use the existing viewer-time activity formatting. Its date parser now accepts ISO timestamps as well as SQLite timestamps, with a regression covering UTC and explicit timezone offsets. Financial calculations, permissions, mutation operations and period locks were not changed.

Verification: 29 focused tax/migration/stream/activity tests pass; type checking reports zero errors/warnings; targeted ESLint and Prettier pass. Isolated server rendering using fixture data exercised draft, reviewed, finalised, reader, retained-revision and changed-source states, including visible expense data and permission-sensitive controls. No configured server or database was loaded. Browser/visual verification remains with the owner under the repository policy. Review the detail page and correction/manual drawers at desktop and phone widths, including long references, many adjustments, keyboard focus, filter toggling and revision navigation.
