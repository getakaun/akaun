# Phase 2 — month-close integration and tax auditability

Date: 6 November 2026. Scope: the user's request to plan and implement phase 2.

## Verified baseline and policy

The supplied checkout was at `152708d`, before the completed tax work. GitHub PR #63 is merged into main at `ed384741f0ba4c76ab54562686cee535f400a468`. Its 53 changed files were imported through the GitHub connector and checkpointed locally; shell Git transport could not reach its configured proxy. This is the phase 2 implementation baseline.

The attached handover is product context. Its proposed warning-only close policy conflicts with the subsequent owner-approved mandatory check recorded in `review-ux-plan.md`, `completion.md`, and the merged month-closing specification. Preserve the existing mandatory check unless the owner explicitly requests its removal. Phase 2 does not introduce a new close policy or annual tax adjustment UI.

## Existing implementation to retain

Saved tax snapshots belong to Expense movements. Account default edits are prospective. `queries/ledger.ts` checks original and proposed dates inside immediate transactions before insert/update/delete; imports, HTTP and MCP use the same boundary. `replaceMovements` is private. No separate classification writer or bulk classification endpoint exists. Bulk deletion uses individual record operations. Closed/voided forms already disable tax fields and SSE closing discards unsaved form drafts. Audit changes contain before/after movement classifications. Close/reopen require their existing sensitive permissions, and reopening requires a reason. The tax completeness check participates in the close revision and audit transaction.

## Implementation map

1. `src/lib/components/ledger/RecordForm.svelte`, `src/lib/components/tax/ExpenseTaxLines.svelte`, `TaxLineEditor.svelte`: show the reason directly beside read-only tax values, including the inclusive closing boundary; a locked editor always displays saved values rather than an outstanding draft.
2. `src/lib/server/application/expense-tax-closing.spec.ts`: exercise actual close → prospective default change → refused HTTP/application/query/MCP edits → permissioned reasoned reopen → correction → re-close. Assert classification provenance, audit channel/actor/reason, stable report/CSV totals and unchanged accounting amounts. Add import and bulk deletion refusal checks, no success events on failure, and two-connection WAL concurrency coverage.
3. `dev-notes/MONTH_CLOSING.md`, phase 2 completion report: document the audited workflow, existing mandatory-policy exception, UI locations, validation and rollback.

No new migration, backfill, ledger posting, annual tax lock, or production-data operation is needed. Existing migration 0041 remains the tax foundation. This installation is one shared book per injected database; isolation tests must use independent temporary databases rather than invent tenant columns.

## Validation and acceptance

The baseline passed 117 tests across the existing expense-tax, tax-review-close, closing-write-path, closing, month-closing and lock-policy suites using the existing Bun test adapter. All fixtures use in-memory or temporary SQLite and temporary storage. Run new targeted tests, then the previously documented compatible server regression list, `bun run check`, `bun run lint`, changed-source ESLint and diff checks. Do not start a dev server, open the real book or run browser UI checks (repository verification policy). Supply an owner walkthrough instead.

Acceptance: closed tax edits refuse without changing record/version/movements/audit/events; March defaults do not change January snapshots or totals; only authorised reasoned reopening enables correction; the old override and every close/reopen/correction remain auditable; re-closing freezes the corrected snapshot; settlement/reconciliation and financial reports remain intact. Later phases remain outside this change.
