# Phase 7 — release readiness

Owner authorised implementation after reviewing the phase 7 proposal. Baseline:
`e7d16a1` (phase 6, PR #72). No deployment or real-book migration is authorised
by this implementation. Owner visual acceptance and final release approval remain
separate gates.

## Implementation map

| Area                   | Files and approach                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade safety         | `db/tax-upgrade-guard.ts`, `db/migrate-book.ts`, `db/client.ts`, transaction hooks in `db/auto-upgrade.ts`: read-only preflight before writable startup; repeat and read receipts under the migration writer lock; foreign-key validation before commit and enforcement restored after busy startup. |
| Impact inspection      | `scripts/tax-upgrade-preflight.ts`: explicit isolated copy only; counts, no reset option, no configured-client import.                                                                                                                                                                               |
| Migration rehearsal    | `db/tax-upgrade-guard.spec.ts`: pending 0041–0049, current restart, affected finalised/withdrawn/inactive evidence, WAL preservation, failed integrity rollback. Existing legacy-upgrade and 0041–0049 suites remain in the manifest.                                                                |
| Concurrency            | `application/release-readiness.spec.ts` and explicit-path fixture children: independent processes/connections, shared WAL book, staged previews and a start barrier.                                                                                                                                 |
| Restore/reconciliation | `application/release-restore.spec.ts`: stopped synthetic book and receipt store, statements/register, posted depreciation, scheme claim, utilisation, YA rollover, retained exports and audit evidence.                                                                                              |
| Permissions            | Existing granular permission suites plus explicit OAuth session-boundary regression; fix tax finalise/amend guard and loader controls.                                                                                                                                                               |
| Performance            | `scripts/release-benchmark.ts`: synthetic books only; counts, hardware/runtime, timings, query counts, memory and source-snapshot size. Optimise only measured bottlenecks.                                                                                                                          |
| Reproducibility        | `.bun-version`, package scripts, validation manifest, Docker/desktop CI and pinned image version. No publish commands run here.                                                                                                                                                                      |
| Operations             | Recovery/limitations/owner walkthrough documents and updated public backup instructions.                                                                                                                                                                                                             |

## Migration decision

Do not edit 0041–0049 or claim the existing 0049 cleanup is safe for accepted
data. Before 0049 is applied, any saved schedule (including inactive schedules)
or manual allowance adjustment (including withdrawn history) blocks startup.
This is intentionally conservative; there is no automatic disposable-data
inference or destructive bypass. Affected owners retain the prior application
and request a separately reviewed preservation/conversion path.

Books already recording 0049 may restart with current scheme workings. This
does not establish that earlier evidence was preserved. Recovering previously
deleted evidence requires a pre-upgrade backup. Do not reverse migration receipts.

No new migration is required. Ordinary accounting, source tax classifications,
close boundaries, financial amounts and tax claims are not rewritten by phase 7.

## Release gates

1. Safe upgrade paths pass, and affected evidence is retained or upgrade refuses.
2. Regression manifest passes; no new type/lint errors in changed source.
3. Balanced journals, no duplicate asset/month postings, immutable retained tax
   evidence and atomic writes survive the independent-process scenarios.
4. Synthetic restore/reconciliation passes; an actual deployment backup is
   rehearsed separately by the owner before a live upgrade.
5. Medium-book targets are assessed against measured data: p95 reads/previews
   2s, save/finalise 3s, export 10s. Unmet targets are explicit release blockers
   for that volume, not silently relaxed. Three samples provide screening only.
6. Owner completes mobile, keyboard, print and multi-period walkthrough.
7. Owner explicitly approves a pinned release artifact. Never infer approval
   from a merged PR, passing test run or draft worksheet finalisation.

## External guidance

Reviewed via official source repositories: SQLite Online Backup API
(`sqlite/sqlite`, `src/sqlite.h.in`), OWASP Authorization Cheat Sheet
(`OWASP/CheatSheetSeries`), W3C WCAG Understanding financial error prevention,
target size and focus visibility (`w3c/wcag`). They inform backup consistency,
per-request permissions and owner QA. Direct LHDN access was unavailable; no
jurisdictional rate, eligibility or filing-compliance verification is claimed.
