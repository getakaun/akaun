# Phase 3 completion report

**Phase:** 3 — fixed asset register, with no automatic depreciation.
**Commit / PR:** Branch `codex/fixed-assets-phase-3`, based on verified remote main `c3814e9` (merged phase 2). Published commit and PR identify the final revision. No production migration or deployment performed.
**Owner decision:** Pending walkthrough / acceptance. Phase 4 is not included.

## What changed

Accounts now links to `/assets`: an individual asset register, registration and reasoned correction form, dated GL reconciliation, unregistered positive capital lines and recent registration audit. Identity, name/description/category, acquisition/in-service dates, exact main-currency cost, source record/line, cost account, derived in-service status, optional business use, documentation reference, opening accumulated depreciation and optional book-profile suggestions are stored.

Existing purchase registrations require a non-void positive fixed-asset movement matching the cost, account and acquisition date. Opening-balance records must use the explicit legacy route. Unique source-line and asset identity indexes prevent duplicate registrations, including concurrent retries. Source IDs remain historical evidence without source FKs: later line rebuilds/deletions/voids do not erase the saved link and are flagged for review. No automatic relinking occurs.

Legacy registration requires an opening reconciliation date, explanation, existing-GL acknowledgement, gross cost and brought-forward depreciation. Non-zero prior depreciation requires a separate fixed-asset contra account; no sixth account type is introduced. No opening journal is generated. Cost and contra mappings cannot be mixed with existing register mappings. The GL reconciliation shows signed account balances, expected gross/contra amounts and exact differences separately. Pooled opening lines remain visible as unmatched evidence rather than being silently consumed by a legacy registration.

All writes pass through `application/fixed-assets.ts`, with injected book database, runtime validation, permission checks, immediate transaction, unique constraints, audit and post-commit SSE. Existing `accounts.read` + `accounts.update` govern registration/correction; purchase registration also requires `records.read`. Account update alone never edits a ledger record. Corrections require current version and reason; origin/source identity cannot be replaced. Source details/unregistered lines are withheld from register readers without record-read access. REST and page actions share the write boundary.

Amounts are safe integer cents, percentages integer basis points. Decimal text converts using BigInt without floating-point arithmetic or implicit rounding; excess precision is refused. Summation checks overflow. Form values preserve exact cents even near the safe integer limit.

## Changed files and migrations

- `src/lib/server/db/schema.ts`, `drizzle/0042_fixed_asset_register.sql`, `drizzle/meta/0042_snapshot.json`, `drizzle/meta/_journal.json`: additive register table, indexes, references and checks. Existing financial tables and data are unchanged; no historical backfill.
- `src/lib/fixed-assets.ts`: exact decimal input/display helpers.
- `src/lib/server/application/fixed-assets.ts`: authorization, validation, transactional registration/corrections, audit and events.
- `src/lib/server/queries/fixed-assets.ts`: dated totals, source exceptions, register/GL bridge and unmatched capital lines.
- `src/lib/server/audit.ts`: registration audit kind/permission/label.
- `src/lib/server/queries/accounts.ts`, `src/lib/server/services/accounts.ts`: mapped cost/contra/expense accounts are protected from deletion with an actionable refusal, including accounts without movements.
- `src/routes/(app)/assets/+page.server.ts`, `+page.svelte`: usable register, form, reconciliation and audit view.
- `src/routes/(app)/accounts/+page.svelte`: register link.
- `src/routes/api/assets/+server.ts`: GET report and POST registration; `src/routes/api/assets/[id]/+server.ts`: versioned PATCH correction; `src/routes/api/assets/stream/+server.ts`: SSE invalidation on asset/ledger/account writes.
- `src/lib/server/application/fixed-assets.spec.ts`: financial, authorization, integrity and migration tests; `src/lib/server/services/account-defaults.spec.ts`: extend its minimal account fixture with the new register references.
- `specs/010-fixed-assets/plan.md`, this report: implementation proposal and handover.

## Automated tests

Using temporary Bun 1.4.4 and the repository's existing safe preload (configured DB client is refused; all fixtures are in-memory/temporary):

```sh
bun test --preload ./scripts/mcp-test-preload.ts ./src/lib/server/application/fixed-assets.spec.ts
xargs -a specs/009-expense-tax/validation-files.txt bun test --preload ./scripts/mcp-test-preload.ts
bun run check
```

- New phase 3 suite: **13 passed, 0 failed**. Covers financial immutability even in closed months, purchase matching/duplicates, legacy gross/contra reconciliation, unregistered balances, permissions/credential ceiling/book isolation, invalid amounts/dates/mappings, changed/missing sources, stale corrections, audit failure rollback, exact decimal handling, mapped-account deletion protection and migration preservation.
- Additional account/reference/upgrade checks including phase 3: **47 passed, 0 failed across 5 files**.
- Existing phase 0–2 regression selection: **1,658 passed, 0 failed across 108 files**, 2 snapshots / 16,217 assertions.
- Svelte/TypeScript check: **0 errors, 0 warnings** (equivalent Node CLI used because Bun was initially absent).
- ESLint on all changed/new source files: **passed**.
- Repository-wide formatter stage of `bun run lint`: **231 files reported** in the existing formatting backlog; unrelated cleanup excluded. Changed source formatting is checked separately, including the Svelte plugin.
- Drizzle schema generation: **no schema changes, nothing to migrate**.
- `git diff --check`: **passed**.

## Manual walkthrough and UI locations

1. In a test book, create/use a Fixed asset GL account and an existing capital purchase of **12,000.00**. Open **Accounts → Fixed asset register and GL reconciliation** (`/assets`). Reconcile through its date: the GL difference should be **12,000.00**, and the positive purchase line should appear in the unregistered list.
2. Choose **Register this line**, enter a unique identity, name/category, service date, document reference and reconciliation note; acknowledge existing GL values and save. The purchase link should open the existing record. Registered cost should be **12,000.00**, its gross-account difference **0.00**, and the source should leave the unregistered list. Record count, bank balance and balance sheet must be unchanged.
3. Attempt a second registration of that source with a different identity. Save must refuse; only one registration and purchase should remain. An expense/cash line or mismatched cost/date/account must also refuse.
4. Prepare existing legacy GL evidence with **10,000.00** gross cost and **4,000.00** negative contra balance. Choose Legacy, enter old acquisition date and opening reconciliation date, cost **10,000.00**, prior depreciation **4,000.00**, separate contra account and explanation. Save should produce **6,000.00** cost less brought-forward depreciation and zero differences on those accounts without new opening entries. Select a date before the opening date: the legacy asset must be outside the comparison. Pooled opening movements may still require manual matching/review.
5. Inspect an unmatched balance or deliberately mismatched legacy figure. The exact GL-minus-register difference and declared legacy exception should stay visible. Do not treat zero aggregate difference as proof of individual matching.
6. Correct a registration with a reason; inspect its version and recent audit. Try a stale correction from another tab: save must refuse. Closed source records remain unchanged and use the existing audited reopen process for accounting corrections; registering/correcting independent register evidence needs no reopening.
7. In an open test period, change or void the linked purchase through the existing record workflow. Refresh the register: saved evidence must remain, with a source exception and visible GL difference. Registration never silently follows the changed ledger amount. Source relinking is deferred.
8. Enter a suggested straight-line method/life/residual/default expense and accumulated accounts. Save should store suggestions only: there is no schedule, approval or depreciation posting. Business-use percentage must not reduce gross GL cost.
9. Check permissions with a read-only account user, update-only user and restricted token. The shared write boundary must refuse insufficient access. Record links/unregistered details require record-read access. Open a second register tab and make a change: SSE should refresh the report without polling.

No screenshots or browser/dev-server testing were performed under `CLAUDE.md` verification policy. Visual/mobile/accessibility acceptance remains with the owner.

## Financial reconciliation evidence

Tests compare complete records, movements, settlements and closing settings before/after registration and correction. They remain identical. A 12,000.00 purchase registers against the existing 12,000.00 Asset debit; legacy cost 10,000.00 less 4,000.00 prior depreciation equals 6,000.00 with separate signed account comparisons. Migration rehearsal compares existing accounts, records, movements, settlements, settings and audit rows and verifies foreign keys. Audit insertion failure rolls the asset write back.

## Known limitations / deferred work

- No depreciation calculations/postings, disposals, capital allowances, tax-only adjustments or annual tax finalisation. In-service state is derived from the date; it does not claim disposal/lifecycle completeness.
- Book profile suggestions are entered per asset; reusable category templates are not provided. Source documents are references to existing evidence, not a new upload store.
- One entire source line per asset; splitting a pooled source across multiple registrations and relinking replaced source lines are unsupported. Legacy registration is explicitly manual; matching opening evidence is an accountant review task.
- Reconciliation uses current audited register values against GL through the selected date, not an immutable historical register version. Brought-forward accumulated depreciation is not a calculated current net book value.
- Full-book movements are read for this first release; larger-ledger pagination/performance hardening remains phase 7. Latest 100 registration audit events appear in the page; existing administrative Audit Log retains the full trail.

## Rollback plan

Before deployment, take the normal database-family backup. Prefer reverting the feature application code while retaining the additive register table and its audit evidence; no financial reversal is required because phase 3 creates no journals. Do not delete register/audit rows as part of rollback. To return to a pre-migration schema, restore a verified pre-release backup during a coordinated maintenance window; preserve/export any later register evidence and account for unrelated post-backup activity. Do not modify the migration journal or drop tables on a live book.
