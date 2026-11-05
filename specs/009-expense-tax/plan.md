# Expense tax classification — phases 0 and 1

Date: 2026-11-05. Requested scope: plan and implement both phases. The handover's intermediate approval gate is superseded by that explicit request. The original scope excludes phases 2–7. The owner subsequently approved the treatment-first UI and mandatory expense-tax close check described in `review-ux-plan.md`; other later-phase work remains deferred.

## Phase 0 — architecture audit and proposal (before implementation)

Baseline: `152708d17e132e0c7c3c2c65785b495f681ab332`, verified against remote main with `git ls-remote origin refs/heads/main`. Clean local branch `work`. No AGENTS.md found. The repository verification policy in `CLAUDE.md` prohibits starting a dev server or browser verification; UI validation is supplied as an owner walkthrough. Read month-closing spec/notes, schema, enums, entry builder, account/sign/report helpers, record/account services, application operations, HTTP routes, loaders and forms.

One installed SQLite database is one shared book, not a multi-tenant table model. Application operations take an injected `LedgerDb` and authenticated locals. Reuse `accounts.create/update`, `records.create/update/adjust`, and `reports.read`; never open a book in pure rules or operations. There are exactly five account types. Signed integer main-currency cents on `ledger_movements` are the canonical financial amounts; record amounts are original-currency display/audit values. Expense debits are positive and refunds/credits negative. Reports aggregate movements, including both halves of same-date void pairs (net zero).

`queries/ledger.ts` owns ordinary insert/update/delete, inside immediate transactions with `assertDatesOpen` checking old and proposed dates. Services combine audit and writes; compound imports, sales, reimbursements and corrections unwind the outer transaction on a close refusal. API, MCP, bulk record actions and import confirmation use those services. Attachment/invoice/OCR paths have separate existing close guards. Contact merge and account reclassification have existing master-data guards. The existing closing write-path/concurrency tests are the evidence for those paths; phase 1 will additionally test tax edits through the shared operation and lowest query boundary. Direct external SQLite writes are outside the application's authorization model.

Record edits preserve movement IDs by sort order. Tax snapshots must survive amount/label rebuilds against the same account; changing an expense account captures the new account default. Legacy/historical expense rows keep NULL snapshots and are shown as unreviewed, never inferred from today's defaults. Same-date voids must copy snapshots, including NULL, rather than reapply today's defaults. Negative ordinary journal lines use their saved percentage; a standalone credit note must explicitly use the original classification if its default has since changed (sales credit-note workflow is not present).

No asset register, tax deductibility fields, depreciation scheduler or annual tax worksheet currently exists. Sales header `taxAmount` is an unrelated consumption-tax placeholder. Asset subtypes already support fixed assets. An accumulated depreciation account can be an ordinary Asset with a negative signed balance; existing asset report presentation retains that negative amount, no sixth type needed. Specific contra-asset mappings and lifecycle are deferred.

Month closing is a calendar boundary in settings, not a fiscal year. Current reports default to calendar year-to-date with explicit date ranges. No per-book YA mapping/finalisation is available. Use inclusive date ranges only; defer tax-year decisions.

### Data flow and relationships

Account (optional default percentage and treatment) → new Expense movement (saved percentage, source, treatment, reason, actor, timestamp, provenance) → expense tax report over saved signed cents. Record → movements is 1:N; snapshot belongs to one movement, not the record or settlement. Account changes never recalculate existing snapshots. Reversal → original record already exists; reversal movements copy original classification.

### Exact implementation map / migration outline

- `src/lib/expense-tax.ts`: client-safe types, treatment labels, validation, integer basis-point policy and BigInt rounding.
- `src/lib/server/db/schema.ts`, `drizzle/0041_*`, `drizzle/meta/*`: nullable account defaults plus nullable JSON movement snapshot, with SQL validity/range checks. Additive migration; no data backfill or financial posting.
- `src/lib/server/ledger/types.ts`, `queries/accounts.ts`, `services/accounts.ts`, `application/accounts.ts`, `loaders/accounts.ts`: account default contracts, validation, audit and prospective edits.
- `src/lib/server/queries/expense-tax.ts`, `queries/ledger.ts`: central capture, retention, override and reversal-copy logic; snapshots exposed on record views and audits.
- `src/lib/server/services/ledger.ts`, `application/records.ts`, `application/version.ts`: creation/edit inputs, transactional validation and versions. `taxOverrides` select an account plus zero-based occurrence among that account's lines, allowing duplicate-account splits without ambiguous account-wide overrides.
- `src/lib/components/accounts/{AccountSheet,AccountDetail}.svelte`, `components/ledger/RecordForm.svelte`, new shared tax fields: defaults, per-expense-line saved values and reasoned overrides.
- `src/lib/server/queries/expense-tax-report.ts`, `loaders/reports.ts`, `components/reports/*`, `routes/api/reports/expense-tax/+server.ts`: dated estimate report and CSV with line-level provenance and separate unreviewed amount.
- New isolated tax rule and database/application tests; `components/ledger/journal-rules.ts` also preserves every extra line by movement ID when loading duplicate-account splits, with a pure regression test; existing closing, import, void, split-entry and financial report suites retained.

### UI sketches

Accounts → Add account / account detail: Expense only → “Default potential deduction (%)” (blank = unreviewed) and optional treatment. Hint: applies only to new lines.

Record create/detail → “Expense tax classification” card → one row per Expense line → saved/default percentage + treatment + source/review status; choose override with required reason. Closed/voided records read-only. Changes save with the existing record Save action.

Reports → “Expense tax” → existing date controls and CSV → signed expense, potential deduction, potential add-back and unresolved expense amount. Missing percentages/requires-review amounts are unresolved, not zero-deductible. All classifications are estimates, never accountant approvals.

### Decisions adopted for phase 1

Percentages use integer basis points: 0–10000 = 0.00–100.00%, at most two decimal places. Calculate signed cents × basis points using BigInt and round halves away from zero per line; add-back = signed expense minus rounded deduction. Sum rounded lines, never re-round an aggregate. Unknown/requires-review lines show null deduction/add-back and a separate unresolved total. Ordinary=100%, partial=strictly between 0 and 100%, non-deductible/capital-expenditure=0%; requires-review may hold a tentative percentage but contributes only to unresolved totals. A configured percentage without treatment derives the consistent treatment.

Historical NULL snapshots remain unreviewed on unrelated edits, including amount rebuilds. Account changes are explicit reclassifications and capture new defaults. No approval claims or silent bulk review. Imports automatically capture configured defaults through the same query boundary; otherwise remain unreviewed. Existing audit channel/request metadata records provenance of API/import/system callers. The snapshot also retains actor/time and origin. Reversals retain the original snapshot exactly, so the pair cancels tax totals too.

### Questions deferred beyond authorized scope

Who may approve depreciation or tax finalisation; fiscal year/YA mapping and LHDN rule sources; asset category/account defaults; annual tax-only adjustment workflow; warning/blocking close checklist policy; reviewed bulk classification. No new accounting primitives or tax-law rules are assumed for these.

### Baseline and validation

Existing server suite and static check run before feature changes; results recorded in the completion report. Tests use in-memory or explicitly temporary SQLite databases with the existing migrator; no dev server, browser session, credentials or real `data/` are used. Required checks: focused tax tests, full server regressions, `bun run check`, formatting and ESLint on changed code, repository lint baseline comparison. UI walkthrough is for owner execution per repository verification policy.
