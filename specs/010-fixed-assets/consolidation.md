# Review of duplicate Phase 3 implementations

Compared PR #65 / `codex/fixed-assets-phase-3` at `82caf374ba7336216538202542e154d26121a2a2` with PR #66 / `codex/fixed-assets-phase-3-e53635a`, including its UI standardization commit `d126baa`.

Both implementations provide the same Phase 3 capability. They both add `fixed_assets` in migration 0042, but use incompatible columns, operations and UI. Applying both initial migrations would collide; combining both route implementations would leave two competing write paths.

| Area                          | Consolidated decision                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial table/migration       | Keep #66's canonical 0042, schema and snapshot. Remove #65's competing initial migration.                                                                                                                    |
| Financial operations/API      | Keep `/api/fixed-assets` and its authorized register/update operations. Exclude #65's parallel `/api/assets` implementation.                                                                                 |
| Navigation and UI             | Keep the current standalone Assets module, shared list/form/report components and full detail routes. Exclude the duplicate monolithic page and extra Accounts-page navigation wrapper.                      |
| Source evidence               | Keep saved snapshots, source-slot reservations, explicit versioned acknowledgement and source/evidence deletion protection. Do not replace these with unguarded source-ID references or automatic relinking. |
| Asset identity                | Keep generated `FA-…` identities. Do not add a second required user-entered identity field.                                                                                                                  |
| Register account references   | Incorporate register references in the shared account dependency state, in addition to the existing explicit account-deletion refusal.                                                                       |
| Minimal test fixture          | Adopt #65's missing `fixed_assets` fixture with canonical cost/contra/expense column names.                                                                                                                  |
| Database integer checks       | Adapt `typeof(...) = 'integer'` checks for cost, opening depreciation, business-use basis points and residual value in follow-up migration 0043. Keep the existing canonical 0042 SQL unchanged.             |
| Additional verification       | Adapt migration-preservation, existing-register upgrade, credential-ceiling and exact-money tests to current operations. Add a review exception for an invalidated accumulated-depreciation account mapping. |
| Contra-account convention     | Retain the canonical requirement for a separate Asset account; do not require a new sixth account type or force valid non-current contra mappings into the duplicate's narrower subtype convention.          |
| Legacy workflow/book profiles | Keep explicit opening evidence and reasoned corrections. Do not add a second mandatory acknowledgement workflow or require a complete depreciation profile before Phase 4.                                   |

## Data compatibility and release boundary

This is a **code consolidation**, not a conversion of live books. No configured book is opened or migrated by this review. Migration 0043 upgrades the canonical #66 schema and preserves valid register/ledger/audit rows; it does not round or repair invalid fractional values.

A database already created with #65's incompatible 0042 schema needs a separately reviewed schema/data mapping before running the consolidated branch. That conversion is not silently inferred or performed here. Both original implementations remain available in Git history; the duplicate branch is not deleted.

PR #66 remains the review/release PR. PR #65 is superseded and is closed after the consolidated branch is pushed and verified. Neither PR is merged into main by this task.

## Startup migration compatibility correction

The reported startup failure came from migration 0043 introduced during consolidation. Its generated CHECK expressions qualified columns with the temporary table name `__new_fixed_assets`. SQLite's legacy table-rename behavior leaves these references invalid when renaming the table to `fixed_assets`, reproducing the reported `no such column: __new_fixed_assets.cost_minor` error. Repeated traces represent retries of this same failed migration.

Migration 0043 now uses unqualified CHECK columns, preserving the same constraints under either rename mode. This corrects the failing migration itself: a later migration cannot repair a startup blocked at 0043. Previously successful installations skip it normally; failed transactional upgrades can retry on restart without deleting data or resetting the migration journal. No application-wide SQLite settings are changed.

`migration-0043.spec.ts` exercises the production Drizzle migrator on temporary book files with `legacy_alter_table` both off and on, verifies preserved asset/ledger/settings/audit rows and foreign keys, checks integer enforcement, and reopens each file to verify restart idempotence. It also reproduces the original failing SQL in a transaction, proves rollback preserves the fixture and migration journal, and then retries the corrected migration. The regression failed before the correction and passes afterward. The configured live book is never opened by these tests.

Verification after this correction: all 1,659 Phase 0–2 regression tests across 108 files and all 34 targeted asset/migration/upgrade tests pass. Type checking reports zero errors and warnings; targeted ESLint, formatting and diff checks pass.
