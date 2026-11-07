# Phase 3 — consolidated implementation plan

PR #66 is the canonical Phase 3 implementation. The duplicate implementation from PR #65 (`82caf374`) is merged into its branch with explicit conflict resolution; it is not a second register to deploy.

- Keep one `fixed_assets` table and the original `0042_fixed_assets.sql` migration from #66. Do not apply #65's incompatible alternate 0042 migration.
- Keep the current authorized application operations and `/api/fixed-assets` routes. Retain source snapshots, duplicate/source-slot checks, audited source acknowledgement, version checks and deletion protection.
- Retain the standalone `/assets` module and standardized UI: Accounts-style lists/mobile cards, create-only drawer, shared form controls, `/assets/[id]` detail pages with Activity and related records, and Reports-style reconciliation.
- Adapt useful coverage from #65: migration preservation, narrowed credential permissions and exact near-limit money values. Retain its account-dependency accounting and adapt the minimal account-default fixture to the canonical column names. Surface invalid accumulated-depreciation mappings.
- Adapt #65's stronger SQL integer checks through follow-up migration `0043_fixed_asset_integer_checks.sql`. This upgrades an existing canonical 0042 database instead of rewriting that migration. Preserve asset rows, IDs, financial rows, closing settings and audit history.
- Keep book profile fields preparatory and optional. No automatic depreciation, disposal, annual tax worksheet or capital allowance claims.

The full current implementation and manual walkthrough are in [the Phase 3 implementation note](../../dev-notes/FIXED_ASSETS_PHASE_3.md). [The consolidation review](consolidation.md) records retained and rejected differences.
