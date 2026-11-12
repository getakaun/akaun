# Regression and authority matrix

Run `bun run test:release`. The manifest extends the phase 5 regression list
with phase 6 and phase 7 suites; it uses the isolated preload that refuses
`db/client.ts`. Database fixtures are migrated in memory or under OS temporary
directories. API adapter tests are not a running-network HTTP/browser test.

| Invariant / surface                                               | Primary evidence                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Saved defaults, splits, refunds, precise rounding                 | `expense-tax.spec.ts`, `tax-form.spec.ts`, application expense-tax suites                          |
| Closed record writes, imports, MCP, bulk and WAL readers          | `expense-tax-closing.spec.ts`, `closing-write-paths.spec.ts`, `account-tax-classification.spec.ts` |
| Intentional unclassified/review decisions and hard close blocker  | `tax-review-closing.spec.ts`, `account-tax-classification.spec.ts`                                 |
| Registration does not post purchases; duplicate and source guards | `fixed-assets.spec.ts`                                                                             |
| Approved depreciation, history, reversal, revoked authority       | `depreciation.spec.ts`                                                                             |
| Manual/manual, worker/manual and close/post races                 | `release-readiness.spec.ts`: independently staged processes against WAL                            |
| Same/different retry-key tax finalisation races                   | `release-readiness.spec.ts`: one command receipt and finalised result                              |
| Worksheet save/finalise atomicity, source hashes, deferred events | `tax-worksheet-save.spec.ts`, `tax-worksheets.spec.ts`                                             |
| Immutable scheme versions, amounts, jurisdiction/currency         | `asset-tax-schemes.spec.ts`, pure scheme/editor suites                                             |
| First-year repeats, unused allowances and pending amendments      | `first-year-allowance.spec.ts`, `asset-tax-schemes.spec.ts`                                        |
| Tax-only changes leave accounting unchanged; restore all evidence | `tax-worksheets.spec.ts`, `release-restore.spec.ts`                                                |
| Tax API/SSE requires tax.read; event bodies contain signals only  | `tax-stream.spec.ts`, `permission-coverage.spec.ts`                                                |
| No cross-book reads, overlapping IDs                              | `fixed-assets.spec.ts`, `tax-worksheets.spec.ts`, account-classification suites                    |
| Session-only finalise/amend, restricted preparer/reviewer         | `tax-worksheets.spec.ts`, `tax-worksheet-save.spec.ts`, explicit OAuth-marker regression           |
| Pending destructive tax upgrade refuses before changes            | `tax-upgrade-guard.spec.ts`; guarded production migrator                                           |
| Old migration semantics and generated constraints                 | migration 0041, 0043, 0046–0049 suites (raw migration fixture tests deliberately bypass startup)   |
| Legacy chart conversion and file-family integrity                 | `auto-upgrade.spec.ts`, account/legacy migration suites                                            |

## Route-to-authority review

| Entry point                                                    | Boundary / required authority                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/tax`, `/api/tax/:id`, adjustments and capital allowances | Shared tax application operations: `tax.read` plus create/update/review/finalise/amend as applicable. Combined completion requires update + review + finalise; finalise/amend refuse PAT/OAuth contexts. |
| Tax CSV / printable HTML and asset tax history                 | `tax.read` independently grants retained tax/P&L evidence. Record/asset navigation still requires its own permissions.                                                                                   |
| `/api/tax/schemes`, `/api/tax/settings`                        | Tax application read/update boundaries; canonical scheme validation and audit.                                                                                                                           |
| `/api/tax/stream`                                              | `tax.read`; signal-only events, no record bodies or tax amounts. Existing connected streams may retain invalidation signals until disconnect; subsequent data reads reauthorise.                         |
| Fixed asset registration/detail/stream                         | Existing account/record read requirements; writes require existing register authority.                                                                                                                   |
| Depreciation profile/post/reverse                              | `DEPRECIATION_WRITE` and current record/closing restrictions; unattended approval requires session authority. Worker reloads approver grants.                                                            |
| Account classification preview/apply                           | accounts.read/update + records.read/update; reason, scope and revision-bound 200-line batches.                                                                                                           |
| Record API / import / MCP                                      | Existing application record/import authority, saved classifications, period policy and generated-journal protections. No new tax MCP tools/scopes.                                                       |
| Month close/reopen                                             | reports.read + closing.close/reopen; signed session, transaction recheck, audited reason for reopening.                                                                                                  |

There is one book per configured database here; isolation tests use separate DB
contexts, not an invented tenant_id schema. Application invariants do not
protect against an external SQLite administrator deliberately modifying data.
