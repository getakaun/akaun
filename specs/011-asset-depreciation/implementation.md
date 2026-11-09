# Phase 4 — book depreciation

Approved scope: straight-line monthly schedules, explicit schedule approval, review-before-posting or unattended monthly posting, current book values, month-close warnings, prospective estimate changes, controlled reversals and stopping future charges. Reuse Assets, Records and Accounts closing. Registration remains metadata only. This implements the owner's approved proposal; the earlier handover is supporting context, not independent authorisation.

## Owner walkthrough

1. Open a registered asset. In its Depreciation card, choose **Set up depreciation**. Confirm the start month, remaining useful life in months, residual value (initially zero), depreciation Expense account and separate accumulated-depreciation Asset account. Existing settings suggest values but never activate posting without approval.
2. Choose **Review before posting** (default) or **Auto-post monthly**. Preview the entire schedule, account mappings and remaining balance, then approve. The policy is full monthly straight-line charges, integer cents, with the remaining rounding cents in the last period. RM12,000 over 36 months at zero residual produces 35 × RM333.33 and a final RM333.45. There is no daily proration or business-use multiplier.
3. For legacy assets, first confirm a reconciled month-end opening balance. Start after that opening month and enter remaining life, not historical original life. Existing cost/depreciation ledger balances must reconcile; approving a profile never creates an opening entry.
4. Open **Assets → Depreciation**, select a completed month, review the whole-book batch and exceptions, then **Post depreciation** and confirm. Earlier due months must be handled first. Each successful invocation creates one balanced journal, with one expense/contra pair and posting key per asset. Multiple approvers or later catch-up groups can legitimately produce several runs in one month; their journals are listed separately.
5. Inspect the journal from Records or the asset schedule. Debit Depreciation Expense / credit Accumulated Depreciation. Expense lines save an explicit Non-deductible / 0% tax classification and reason; capital allowances remain separate. Ordinary record edit/delete/void and tax-override paths cannot alter generated journals. The depreciation run is the correction boundary.
6. Automatic mode checks on server startup and hourly while running, using the configured server business timezone (`TZ`, consistent with month closing). It catches up completed, open months after downtime. Nothing runs while the application is offline. Each run is attributed to its approving user, whose current permissions are checked again; delegated credentials cannot grant unattended authority. Revoked approvals, changed sources, missing accounts, earlier gaps and closed months remain visible rather than posting into another date.
7. Asset detail separates actual posted balances from projected schedule values. The register's net book value and reconciliation follow the selected as-at date. A mid-month as-at excludes month-end journals. Reversals affect balances only from their own posting date.
8. **Change future depreciation** creates another approved profile version, based on remaining NBV, effective after all posted and reversal months. Earlier charges are unchanged. Normal asset metadata saves cannot change approved estimates. If the financial basis changes, review and approve the remaining schedule again. Account transfers and opening-depreciation rewrites after posting require a separate reviewed accounting correction.
9. **Stop future depreciation** requires an effective month and reason. This is not a disposal. For a posted mistake, use **Reverse whole run** from the monthly tab, choose a completed open correction month and give a reason. Reverse later active runs for the affected assets first. The original journal remains intact, a linked opposite journal records the correction, and every unposted charge under the affected schedules stops. Reversed asset/month keys remain reserved; resumption requires a new approved profile after the correction month. Closed original periods are not rewritten.
10. Accounts closing warns about due but unposted approved charges, with links to the relevant depreciation month. The warning is informational. Closing still prevents those charges from subsequently posting until the month is explicitly reopened.

## Persistence and write boundaries

- Additive migration `0044_asset_depreciation.sql` adds profiles, runs and per-asset monthly allocations. It changes no existing table or historical row and activates no automation. CHECK columns use unqualified identifiers to avoid the SQLite rename compatibility problem encountered in 0043.
- Approved profile versions retain financial basis, remaining life, residual, accounts, posting mode, approving user and reason. Same-start revisions are permitted while wholly unposted; schedule selection uses the latest approved version at that month. Posted history always retains its original profile.
- A unique `(asset_id, month)` allocation prevents duplicate runs, including after a reversal. Immediate transactions serialize preview revalidation, closing guards, journal/allocations and audit writes. Any failure rolls back the whole invocation; SSE emits happen only after commit.
- Preview hashes cover the current asset/profile/history, reviewed settings and closing boundary. The UI freezes the preview settings and version used by approval/post confirmation. Automatic runs use the same posting operation and transaction boundaries as manual runs.
- Generated original and correction journals have internal ledger provenance, protected service mutations and restrictive run links. They do not use the ordinary same-date void-pair relation: excluding an original/correction pair from history would incorrectly hide expenses in an earlier closed month.
- Profile account references participate in account deletion/merge checks. Historical profile references remain retained. Direct schedule posting requires accounts.read, records.read, accounts.update, records.create and records.adjust; reversal additionally requires records.void.

## Verification and limits

Run isolated migrated database tests using the existing safe preload, plus type checking, targeted lint/formatting, schema-generation consistency and the existing regression manifest. Financial tests cover cents, final residuals, tiny and safe-integer bases, duplicate keys/retries, stale previews, batch atomicity, tax classification, closing, legacy openings, prospective revisions, immutable journals, cross-period/same-period reversal history, stopping, revoked approvals and separate automatic approvers.

Do not start the application against the configured book or run browser UI checks: repository policy leaves visual/interaction verification to the owner. No deployment, live migration or automatic live posting is performed during development.

Disposal/sale accounting, impairment, revaluation, declining balance, daily proration, tax capital allowances and fiscal-year tax preparation remain outside this phase. Manual ledger depreciation stays an explained reconciliation difference until reviewed; it is never silently assigned to an asset or treated as an automatic posting.

Approval and further posting pause when the selected accumulated-depreciation account has unexplained manual balances. This avoids charging again over existing manual depreciation. Resolve those differences through the existing record/opening-evidence workflows first; the engine does not silently convert historical manual entries.

## Recorded checks

- 1,659 existing regression tests pass across 108 files.
- 49 focused tests pass across depreciation, fixed assets, account defaults and startup migration compatibility. This includes 20 depreciation tests covering the financial and authorisation behaviours above.
- Type checking reports zero errors/warnings. Targeted ESLint and formatting pass; repository-wide lint retains its existing formatting backlog.
- Drizzle generation reports no pending schema differences. The existing startup migration tests also exercise the additive 0044 migration in modern and legacy SQLite rename modes, preserving fixture books and restart idempotence.
- Browser/visual checks are left to the owner under repository policy. The application was not started against a configured book; no deployment or live posting was performed.
