# Account-based tax classification

6 November 2026. This supersedes the report-based bulk review flow. The feature is unshipped; migration 0041 and its schema snapshot are revised in place.

## User flow

1. Open an Expense account and save its tax default. This changes the default captured by future entries only.
2. Choose **Apply default to unclassified entries**. The action requires a saved, resolved default and no unsaved account changes.
3. Enter a reason and review a compact confirmation: account, saved default, eligible entry/record counts, dates, expense/refund totals, deduction/add-back estimates, protected counts and remaining backlog.
4. Confirm **Apply to N entries**. Each batch covers the next 200 eligible Expense movement lines, oldest first. Start another confirmation for any remaining entries.

Individual corrections stay on the record page. Expense tax reports retain filters, deep links and CSV export, but no selection or bulk mutation UI. Account saves and historical cleanup are separate actions; neither happens silently as a side effect of the other.

## Classification and migration

**Unclassified** means no treatment has been established. Historical NULL snapshots and unset Expense account defaults display Unclassified with no percentage. New entries capture an Unclassified snapshot if the account has no default. Migration 0041 adds the supported enum value without backfilling defaults or changing any historical values, amounts, IDs, allocations, audit or closing settings.

**Requires review** is an intentional unresolved decision on an individual record. It stays available in the record editor. Account editors offer Unclassified instead; an existing legacy Requires review account default remains readable and editable until replaced. Legacy tentative review percentages are preserved on read and excluded from estimates.

New entries capture their account default once. Applying a default to history captures another saved snapshot with actor, time, reason and `account_default_reset` provenance. Future default changes leave all resolved snapshots unchanged. This is explicit adoption of a default, not dynamic recalculation of historical tax amounts.

## Eligibility and protections

Eligible entries belong to this Expense account, are open and editable, and either have a historical NULL snapshot or an untouched unresolved snapshot from record creation/account change. Untouched legacy review snapshots qualify only when their source and provenance prove they came from default capture and have no reason.

The action preserves resolved classifications, explicit overrides (including Unclassified and Requires review), deliberate default resets, reasoned decisions, ambiguous provenance, closed-period entries, void pairs and read-only records. Protected entries are counted but never selected. The record editor can explicitly turn an inherited legacy review hold into an individual review choice, with a reason, even when its displayed values match.

Unclassified and Requires review continue to block month closing. Resolved 0% is valid. Review counts are independent of signed net amounts. Closed history requires the existing authorised, audited reopening process before correction; void pairs do not block closing.

## API and consistency

- `POST /api/accounts/:id/tax-classification/preview` accepts only `{ reason }`.
- `POST /api/accounts/:id/tax-classification/apply` accepts only `{ reason, revision }`.
- Both require `accounts.read`, `accounts.update`, `records.read`, and `records.update`. Neither requires report access or general journal adjustment permission. The server determines the account scope and saved treatment; caller-supplied selections and treatments are rejected.
- The confirmation revision binds actor, account version, reason, closing boundary, complete account scope and selected record versions. New entries, edits, default changes or closing changes require a fresh confirmation.
- Apply revalidates inside an immediate SQLite transaction, resolves stable movement IDs to saved display order, and updates each record once. A later failure rolls back the entire batch, including audit. Record/account/audit events emit only after commit.
- Audit retains per-record before/after snapshots and one shared batch ID with exact movement targets. Cleanup changes tax metadata only; financial postings, payment settlements and reconciliation allocations remain intact.
- Normal account saves now include a version token so a stale form cannot silently replace another user's saved default.

The former `/api/records/tax-classification/*` endpoints and report selection helpers/dialog are removed.

## Verification

Use the existing isolated adapter; do not start a dev server, open the real book or run browser checks:

```sh
bun test --preload ./scripts/mcp-test-preload.ts $(cat specs/009-expense-tax/validation-files.txt)
bun run check
bun run lint
```

Coverage includes revised migration preservation, Unclassified semantics, prospective defaults, individual decisions and resets, duplicate-account splits, signed refunds, exact rounding, paid/reconciled records, permissions and book isolation, stale confirmations, atomic audit failure, post-commit events, 200-entry batches, replay refusal and two-connection WAL contention. The project has an existing repository-wide formatting backlog; changed source is checked separately with ESLint and formatting. Owner UI validation remains pending under the repository's verification policy.

Final results: **1,658 tests passed across 108 compatible spec files**, with no failures. `bun run check` reports zero errors and warnings; changed-source ESLint and `git diff --check` pass. Drizzle reports no schema/snapshot drift. Full-project lint still stops at the existing 231-file formatting backlog.

## Owner walkthrough

1. In a disposable test book, inspect historical entries and unset Expense defaults: both should show Unclassified, with no implied deduction. Confirm month closing is blocked.
2. Set and save an account default. Verify old entries stay unchanged and a new record captures the saved default.
3. Apply the default with a reason. Check counts, signed totals, protected entries and the resulting record audit. Change the account default again; previously classified entries must retain their captured values.
4. Explicitly choose Requires review on one record and Unclassified on another. Apply the account default again; both decisions must remain protected and closing must stay blocked.
5. Open the confirmation in two sessions. Edit an entry, change the default or close the period in one; applying the other session's stale confirmation must fail without partial writes.
6. Try a backlog exceeding 200 entries. Verify the remaining count and explicitly confirm the next batch. Verify the report has no bulk editing controls.
7. Confirm resolved 0%, payment allocations and bank reconciliation links remain intact. Reopen closed history through the existing authorised process before correcting its tax data.

No real database or receipt storage is modified by these checks. The revised 0041 is intended for installations migrating from before this unshipped feature; a development database that already applied the old 0041 will retain its old SQL constraints and needs a separate, deliberate upgrade before use with Unclassified writes.
