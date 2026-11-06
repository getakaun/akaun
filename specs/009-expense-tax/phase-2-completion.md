# Phase 2 completion — month-close integration and tax auditability

**Phase:** 2. Implementation and automated validation complete; owner UI acceptance pending.

**Commit / PR:** Branch `codex/expense-tax-phase-2`, based on remote main `ed384741f0ba4c76ab54562686cee535f400a468`. See the branch commit and associated pull request for the published revision. No deployment performed. The original supplied checkout was older than the phase 0/1 implementation; local checkpoint `404a54b` imports that already merged foundation from PR #63. The phase 2 pull request contains only the changes listed below.

## What changed

The Tax Classification card now explains that closed-period values are read-only, names the closed-through boundary and directs authorised corrections through reopening. A tax editor that becomes read-only displays saved values even if a caller still holds an unsaved draft. The existing form-level SSE close/reset behaviour remains in place.

The server audit confirmed that tax writes already pass through the guarded record query transaction. Phase 2 reuses those controls and supplies integrated regression evidence rather than adding another classification writer. Ten new tests cover prospective defaults; report/CSV stability; the full close/reopen/correct/re-close lifecycle; permissions and reason validation; original override provenance and subsequent audit evidence; HTTP operation/response handling; actual MCP requests; import rollback; bulk deletion/low-level movement replacement refusal; and stale-reader WAL concurrency. The reproducible server regression selection now includes the new suite.

The mandatory tax-review close check remains. The handover proposed warning-only behaviour, but phase 1 subsequently recorded explicit owner approval for a hard blocker in the merged specification and completion report. Phase 2 preserves that established policy. It introduces neither a new policy toggle nor annual tax-only adjustments.

## Changed files

- `src/lib/components/ledger/RecordForm.svelte`: pass the live inclusive boundary and read-only explanation to the tax card.
- `src/lib/components/tax/ExpenseTaxLines.svelte`: display the read-only explanation beside classifications.
- `src/lib/components/tax/TaxLineEditor.svelte`: suppress unsaved classification drafts in read-only rendering.
- `src/lib/server/application/expense-tax-closing.spec.ts`: ten integrated financial/audit/write-path tests.
- `specs/009-expense-tax/validation-files.txt`: include the new suite in the compatible regression selection.
- `specs/009-expense-tax/phase-2-plan.md`, this report, `dev-notes/MONTH_CLOSING.md`: implementation proposal, evidence and workflow documentation.

## Migrations and data impact

No additional migration or backfill. Existing migration 0041 belongs to phase 1 and was imported with its source. No production database or receipts were opened. Automated tests used in-memory or explicitly temporary SQLite/storage. No journals, accounting amounts, allocations, closed boundaries or historical tax snapshots are rewritten by this release.

## Automated tests — commands and results

The available Bun executable is `/workspace/.akaun-tools/node_modules/bun/bin/bun.exe` (not initially on PATH). Use that executable wherever `bun` appears below.

1. Baseline selected tax/closing suites: **117 passed, 0 failed**, 428 assertions.
2. `bun test --preload ./scripts/mcp-test-preload.ts ./src/lib/server/application/expense-tax-closing.spec.ts`: **10 passed, 0 failed**, 63 assertions.
3. Before appending the new suite, `xargs -a specs/009-expense-tax/validation-files.txt bun test --preload ./scripts/mcp-test-preload.ts`: **1,619 passed, 0 failed** across 105 compatible spec files, 16,016 assertions and 2 snapshots. Together with the separate phase 2 run: **1,629 passing tests**. The updated list reproduces both selections together.
4. `node node_modules/@sveltejs/kit/svelte-kit.js sync` and `node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json` (the commands underlying `bun run check`): **0 errors, 0 warnings**.
5. ESLint on all four changed/new source files: **passed**. Prettier on the new test/plan and changed tax components: **passed**. `git diff --check`: **passed**.
6. Repository-wide Prettier still fails on **231 existing files**; separately running repository-wide ESLint reports **59 errors**. Both counts match the phase 1 completion report. Broad formatting/lint cleanup is outside this phase. No passing repository-wide lint claim is made.

The existing Bun adapter supplies the compatible Vitest APIs and refuses loading the configured database client. Browser/Vitest-mocking-only suites are not part of this selection. The HTTP tests exercise the exact parser, application operation and response adapter used by the PATCH endpoint; they do not start an HTTP server. MCP tests use an actual in-memory client/server transport.

## Manual walkthrough — owner validation

Use a development/test book with permissions to edit records, update accounts, view reports, close and reopen months.

1. Set an Expense account's default to Partial / 50%. Create a January RM1,000 expense. In Reports → Expense tax, filter January: potential deduction RM500; add-back RM500.
2. Override that record to Partial / 25% with a reason and save. Inspect its record audit: the saved classification, source, actor/time and reason should be retained. Expected January deduction/add-back: RM250 / RM750.
3. In Accounts → Month closing, close January. Any unresolved Expense lines must first be classified under the existing approved policy. The record's Tax Classification card should show the saved 25% value and an explanation naming the boundary, with no editable override/default-reset controls.
4. Change the account default to Ordinary deductible / 100%, then create a March expense. March inherits 100%; January remains 25%, including its JSON/CSV tax report.
5. Attempt a January tax edit via the API: PATCH `/api/records/<id>` with `{"taxOverrides":[{"accountId":<expenseAccountId>,"occurrence":0,"percentageBps":7500,"treatment":"partial","reason":"Correct business use"}]}`. Expect HTTP 409 explaining the closed boundary. The record, version, audit and reports must be unchanged. Moving its date into March in the same patch must also refuse.
6. Reopen January with a reason using an authorised session. Missing reopen permission or a blank/short reason must refuse. The record becomes editable subject to its other dependency restrictions.
7. Correct the line to Partial / 75% with a reason, save, run closing checks again and re-close January. Expected deduction/add-back: RM750 / RM250; financial statement amounts unchanged. Verify that the original override, correction before/after evidence, both closes and reasoned reopen remain in history.
8. With two sessions, leave an unsaved tax draft in one and close the month in the other. The first session should show the saved classification read-only after the existing SSE boundary update. Reopen and verify normal authorised editing resumes.

## Screenshots / UI locations

No screenshots or browser run: the repository verification policy assigns visual/behaviour checks to the owner. Locations: Records → record → Tax Classification; Reports → Expense tax; Accounts → Month closing → History; record audit history.

## Financial reconciliation evidence

The RM1,000 / 50% fixture retains expense 100,000 cents, deduction 50,000 cents and add-back 50,000 cents after January closes and March defaults change. JSON report and CSV are identical. The corrected 25% → 75% fixture changes only tax estimates (deduction 25,000 → 75,000; add-back 75,000 → 25,000). Movement IDs, account IDs, signed amounts, P&L and balance sheet remain identical throughout close/reopen/correct/re-close. Refused writes preserve stored records, movement snapshots, audit, settings, sequences, queue and contacts; the closed import retains its receipt bytes.

## Known issues / deferred work

Owner visual acceptance remains pending. The existing mandatory check is retained despite the older handover's warning proposal. Direct writes by an external SQLite administrator are outside application authorization. Existing month-close/financial restrictions remain authoritative; this does not add a general bulk tax-classification workflow. Annual tax-only adjustments, annual finalisation, asset registration and depreciation remain later phases. Repository-wide lint has an existing backlog.

## Rollback plan

Revert the phase 2 pull request commit. Retain phase 1 migration 0041 and all saved classifications; no data rollback is needed. The pre-existing server locks, close/reopen permissions, audit trails and approved mandatory tax-review check remain available when phase 2 UI/test changes are reverted. Do not restore the original pre-phase-1 checkout over a database already using migration 0041.

**Owner decision:** APPROVE / REQUEST CHANGES / HOLD — pending review. No later phase has started.
