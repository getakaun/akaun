# Bulk expense tax classification

Date: 6 November 2026. User-approved follow-up to phase 2: retain mandatory tax classification before month close and provide reviewed bulk cleanup for existing unresolved Expense lines. No blanket default or automatic historical backfill.

## Using it

Open **Reports → Expense tax → Needs tax review**. Filter the account and dates. Select individual lines or use **Select eligible lines on this page**. The report shows 50 lines per page and retains selection across pages, up to 200 lines. Changing the account/date/review scope clears selection. Page selection excludes manual overrides; a manually flagged Requires-review line can be explicitly selected on its own. Closed and resolved lines are disabled. Duplicate account names are distinguished by account ID.

Choose **Classify selected**, then either **Apply each account’s current default** or **Set one treatment for the selected lines**. Account defaults remain separate and prospective; applying them to history is an explicit classification event. Supply a reason and preview. Unconfigured/Requires-review defaults remain unresolved and are listed as excluded. Fixed treatments use their required percentages; Partial accepts 0.01–99.99%. A bulk cleanup must resolve its eligible lines, not relabel them Requires review.

The preview names every selected line and its before/after treatment and source, shows prior reasons, lists excluded lines with reasons, and separates expenses from refunds even when their signed net is zero. Potential deduction/add-back changes use saved signed main-currency cents and the existing BigInt per-line rounding policy. Remaining unresolved counts are scoped to the selected account/date range; the month-close check still covers its entire newly protected period. Exclude exceptions in the drawer and preview again before applying.

Apply changes only eligible lines explicitly included in that preview. Lines already known to be ineligible stay excluded and visible in the preview counts. Any subsequent change to a selected record, selected default used by the action, request/reason or closing boundary invalidates the whole preview. A duplicate apply conflicts instead of posting duplicate audit entries. Cancel discards the draft. A failed/uncertain network response requires refreshing the report before retrying.

Open paid/reconciled expenses can be classified without altering their financial postings or allocations. Closed source records require the normal reasoned, authorised reopening. Voided pairs, source postings that are read-only, and resolved classifications remain protected. This release is an unresolved-line cleanup workflow; correcting an already-resolved treatment remains a normal reasoned record edit.

The existing closing report link leads to the same account/date-aware cleanup report. Successful batches refresh the report, and open closing pages with records-read access refresh checks through the existing record SSE stream. No polling or automatic close is introduced. The server close revision remains authoritative, including for sessions unable to subscribe to record events.

## Server contract and atomicity

Both endpoints require `reports.read`, `records.read` and `records.update` in the effective authenticated permissions. Tax-only changes do not grant account-edit, journal adjustment or close/reopen abilities. One injected database is one installed shared book; helpers never open a configured database.

- `POST /api/records/tax-classification/preview`: `{dateFrom, dateTo, accountId: number|null, movementIds: number[], reason, action}`. Action is `{kind: "account-default"}` or `{kind: "treatment", treatment, percentageBps}`. Strict schemas reject unrelated financial fields, duplicates, empty/oversized selections and inconsistent/unresolved treatments. Dates must be actual inclusive calendar dates.
- Response: opaque revision; before/after line details and exclusion reasons; eligible record/line and skipped counts; separate signed expense/refund totals; potential deduction/add-back totals; unresolved counts before/after. Preview is read-only and consistent.
- `POST /api/records/tax-classification/apply`: the exact preview input plus `revision`. Recomputes selected state and versions while holding an immediate SQLite write transaction. It never expands a client filter into additional selected rows. Unknown, out-of-scope and non-Expense movement IDs refuse.
- Selected stable movement IDs are mapped to the existing account-occurrence override contract inside the same write transaction. All selected lines for one record produce one update and one audit entry. Unselected movements, IDs, labels, amounts, accounts, settlements and reconciliation allocations stay unchanged.
- The existing record service now exposes its transaction-owned mutation helper. Bulk apply defers ledger, account and audit notifications until the entire transaction commits. A later typed refusal or failed audit aborts all earlier writes. Standalone record edits retain their existing application permissions and guards and now also defer their audit notification through their own commit.
- Each audit entry retains before/after snapshots, actor, channel, timestamp and reason, plus a server-generated `taxReviewBatch` ID and exact target movement IDs. Existing snapshot provenance (`line_override` / `account_default_reset`) describes the explicit historical action; nothing is labelled accountant-approved.

Tax completeness counting shares the exact unresolved/void predicate with month close. Bulk preview uses an aggregate query rather than loading the entire historical review backlog. Tax report account filters apply consistently to screen totals, JSON and CSV; display pagination does not limit exports or report totals.

## Implementation map and data impact

- `src/lib/bulk-expense-tax.ts`: strict shared preview/apply input and result contracts; 200-line limit.
- `server/application/bulk-expense-tax.ts` and new preview/apply HTTP routes: authenticated snapshot preview, transactional revalidation, grouped updates and deferred events.
- `server/services/ledger.ts`, `server/audit.ts`: reuse the guarded record mutation in caller-owned transactions; append batch evidence; defer notifications through commit.
- `server/queries/{expense-tax-report,tax-review}.ts`, `server/loaders/reports.ts`, report API: account-scoped report/export and aggregate completeness count with shared eligibility rules.
- Report components, `tax/BulkTaxDialog.svelte`, shared tax fields and selection helpers: account filters, bounded cross-page selection, accessible review drawer and current-state feedback. The treatment picker uses a higher popover layer inside the modal.
- Closing DTO/application/page: permission-aware record-event subscription to invalidate stale close confirmations and refresh checks after a batch.
- New isolated application/selection tests and the existing compatible regression list.

No schema migration or backfill. No production database, receipt store, dev server or browser was opened. No new tax-law rule, filing workflow, automatic classification, accounting journal, annual lock or general-purpose bulk record editor is introduced.

## Validation

Use the existing Bun adapter and temporary SQLite fixtures:

```sh
bun test --preload ./scripts/mcp-test-preload.ts \
  ./src/lib/server/application/bulk-expense-tax.spec.ts \
  ./src/lib/components/tax/bulk-tax-selection.spec.ts
xargs -a specs/009-expense-tax/validation-files.txt bun test --preload ./scripts/mcp-test-preload.ts
bun run check
bun run lint
```

The environment's Bun executable is `/workspace/.akaun-tools/node_modules/bun/bin/bun.exe`; the temporary `/workspace/work/bin/bun` alias enables the normal package commands. The adapter rejects configured database-client imports. Visual/browser validation remains with the owner under `CLAUDE.md`.

Coverage includes historical NULLs, explicit manual-review decisions, defaults without implicit backfill, duplicate-account split identity, signed refunds/net-zero review counts, strict inputs and permissions, account/date/book isolation, existing resolved/closed/void protections, stale defaults/records/requests and duplicate apply, full rollback on a later audit failure, post-commit event visibility, preserved settlement/reconciliation, precise 200-line rounding, and two WAL connections classifying/closing before a stale reader can apply. Selection tests cover manual-review exclusions, explicit selection, inclusive closure/reopening and cross-page selection at the cap. HTTP adapter tests verify 400/403/409 responses.

Automated results: **1,653 tests passed, 0 failed across 108 compatible spec files**, including 24 new bulk/application/selection tests. `bun run check` reports **0 errors and 0 warnings**. ESLint on all changed/new source passes, as do changed-file formatting and `git diff --check`. Full-project lint remains blocked by the existing 231-file formatter backlog; unrelated cleanup is outside this change. Browser/Vitest-mocking-only suites are outside the existing compatible adapter selection.

## Owner walkthrough

1. In a test book, open Expense tax for a period containing unreviewed historical/imported lines. Verify closing is blocked, then follow its unresolved-expense report link.
2. Select an account with no default. Select eligible lines and preview Apply account defaults: those without a resolved default must be excluded, with no implicit 100% treatment.
3. Choose an explicit treatment, supply a reason and preview. Check every proposed line and totals. Exclude an exception, preview again, and apply. Only the reviewed eligible lines change.
4. Use an account with an appropriate resolved default and classify another historical group through Apply account defaults. Inspect source, current actor/time/reason and audit evidence. Future default edits must not recalculate these saved snapshots.
5. Test a duplicate-account split with different line labels, selecting one line. Only that movement's classification changes. Include an expense/refund pair and verify both review counts remain visible even at zero net.
6. Mark a line Requires review manually. Page selection must leave it unselected. Select it explicitly, confirm its saved reason in the preview, and resolve it with a new reason. Previously resolved overrides must remain unchanged.
7. Move between 50-line pages and verify selections persist. At 200 selected lines, additional selections are disabled; deselection still works. Change the account or date scope and verify the selection clears. Account-filtered exports must agree with the full filtered report totals.
8. Verify open paid and reconciled expenses can be classified while payments/matches remain intact. Closed and voided lines must remain protected. A closed historical correction must first use authorised reasoned reopening.
9. Leave a preview open and change a selected record/default or close its period from another session. Apply must refuse atomically, with no partial classifications, new audit entries or success events. Refresh and review again.
10. Inspect record audit history: one update per affected record, exact movement targets, shared batch ID and original/new classification evidence. Finish the remaining review lines and verify refreshed closing checks pass; closing still refuses while any eligible unresolved line remains.

## Rollback and limits

Revert the feature code without removing saved tax snapshots or audit history; no database rollback is needed. Batch IDs identify affected records for investigation. Reverting a classification uses the normal reasoned correction path and, where necessary, authorised reopening. There is no automatic destructive batch undo, no overwrite of resolved classifications, and no background job for batches larger than 200 lines. Report pagination is client-side over the existing dated report result; a server-paginated report API remains future scalability work.
