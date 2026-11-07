# Phase 3 implementation proposal

The supplied handover defines product scope; the owner request authorizes phase 3 only.
Baseline: verified remote main c3814e9 (phase 2 merged); advanced the local branch from ed38474 with feature edits preserved.

- Add `fixed_assets` in schema.ts and migration 0042, with unique identity and nullable unique source movement. No ledger alterations/backfill. Source record/id/account/cost are saved evidence, not recalculated historical values.
- New application/fixed-assets.ts validates and authorizes registration and reasoned metadata correction. Existing accounts.read/update permissions deliberately govern this chart-adjacent register; reads of source details additionally require records.read. Every write is transactional with audit. One installation is one book: the injected LedgerDb supplies book isolation.
- Purchase registration requires an active FixedAsset Asset account and positive, non-void capital movement, exact saved cost and acquisition date. Legacy registration requires reconciliation date/reason, no source purchase, explicit existing-GL acknowledgement and opening accumulated depreciation with contra-asset account. Never create opening journals. Whole cents and integer basis points only.
- Query module provides dated register totals and separate gross/accumulated GL comparisons, unregistered movements, changed/voided sources and legacy opening exceptions. Compare to actual signed GL, do not net away unexplained differences. Source IDs deliberately remain saved evidence without source FKs, so source rebuilds/deletions produce visible exceptions and do not erase audit links or interfere with ledger operations.
- `/assets` provides register, registration/edit form, dated reconciliation, source links and audit evidence; add Accounts link. Shared REST and page actions call the same application boundary. SSE invalidation follows existing event stream pattern.
- Metadata corrections require version and reason, retain audit, and never edit closed source records. No disposal, depreciation schedules/posting, tax allowances or tax-only adjustments.
- Tests use in-memory migrated books and the existing safe Bun preload. Run targeted financial/security/migration regressions, check, lint and diff review. No dev server/browser or real data access under repository verification policy.

Phase 3 will stop at completion; phase 4 needs separate authorization.
