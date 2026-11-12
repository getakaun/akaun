# Phase 7 — hardening and release evidence

**Phase:** 7, hardening/migration/release readiness.
**Commit / PR:** `codex/phase-7-release-readiness`, based on `e7d16a1` (phase 6,
PR #72). See the pull request containing this report. No deployment, tag or
release publication performed.
**Owner decision:** HOLD for release. Implementation is reviewable; scalability,
real-copy rehearsal and owner UI acceptance are not cleared.

## What changed

- New allowance schedules use the maximum available amount automatically up to
  eligible same-business income, before brought-forward losses. The ordinary MY
  single-business basis includes saved expense add-backs and annual corrections.
  Mixed income, multiple businesses and complex adjustments need reviewed limits.
- The claim summary shows automatic usage and unabsorbed carry-forward without a
  **Use available** action. Advanced settings retain reviewed income limits and
  reasoned reductions. Deliberately unclaimed amounts are separate from carry;
  year-specific restrictions/limits reset on rollover. Saved manual schedules
  retain their evidence; their new YA starts automatically. Finalised exports stay
  fixed, and utilisation creates no ledger postings.

- Added a read-only preflight before writable startup/chart conversion. Pending
  0049 upgrades with any earlier capital schedule or manual allowance adjustment
  stop with affected/finalised revision counts. Withdrawn/inactive and older
  retained evidence are included. There is no destructive bypass.
- Startup uses the guarded migration runner. It rechecks evidence and migration
  receipts after acquiring the immediate writer lock, and validates foreign keys
  before commit. Busy startup restores FK enforcement; failed migrations roll
  back. A two-process regression reproduced 51 receipts instead of 50 with the
  old pre-lock ordering and passes with the corrected ordering.
- Explicit OAuth markers now refuse tax finalise/amend at the application
  boundary and suppress those controls in the loader, matching session-only
  policy even when a caller supplies broad locals.
- Reduced repeated snapshot decoding/hashing and claim-history scope. Tax writes
  reuse bookkeeping/asset reads within the transaction only; success and failure
  discard that scope. Tax revisions, schemes and authority are not cached.
- Added migration/concurrency/recovery fixtures, a safe regression manifest and
  synthetic benchmark. Bun 1.3.11 is pinned for app CI; the Docker base/runtime
  image is pinned to its multi-platform digest. The registry manifest includes
  amd64 and arm64; no container/desktop build certification is claimed here.
- Added public tax/asset guidance, corrected live-file backup advice and supplied
  impact/recovery instructions, support messages, limits and owner walkthrough.

See plan.md and coverage-matrix.md for the file-level implementation map and
entry-point authority review. No new tax rules, rates, disposal workflow or
accounting primitives were introduced.

## Migrations and data impact

No new migration or schema change. Existing migration SQL/hashes are unchanged.
The startup guard prevents pending 0049 cleanup from deleting evidence; it does
not recover evidence already removed by an earlier installation. Affected owners
need a separately reviewed preservation/conversion path and their prior backup.
Books already recording 0049 retain current scheme workings and may restart.

No configured application client, live database, real receipt store or deployment
was opened. Tests used in-memory or explicit OS-temporary books/storage; the
preload refuses `db/client.ts`. The standalone preflight opens only its explicit
copy, read-only, and refuses the repository data directory.

## Automated tests — commands and results

Original phase 7 verification at `46feca8` on Bun 1.3.11:

- `bun run test:release`: **1,867 passed, 0 failed across 129 files**, 2 snapshots (230.72s).
- `bun run check`: zero errors and warnings.
- ESLint on every changed/new TypeScript file: pass.
- Prettier on changed/new supported files and `git diff --check`: pass.
- `bun run lint`: fails on the existing 231-file formatting backlog. No global
  lint pass is claimed; unrelated formatting was not rewritten.

Automatic utilisation follow-up verification on Bun 1.3.11:

- `bun run test:release`: **1,888 passed, 0 failed across 130 files**, 2 snapshots (174.61s).
- `bun run --shell=system check`: zero errors and warnings; direct `svelte-check`
  also passes.
- ESLint on all changed/new TypeScript and Svelte files: pass.
- Prettier on changed/new supported files and `git diff --check`: pass.
- `bun run lint` still stops at the existing 231-file formatting backlog.

The 21 added regressions cover income caps and loss years, signed add-backs and
annual corrections, loss ordering, separate business income, stale reviewed
limits, oldest-origin allocation, manual restriction versus unabsorbed carry,
asset/source edits, canonical server recalculation, save/finalisation, frozen
exports, legacy preservation and rollover. The stopped-book restore rehearsal
now exercises automatic usage against synthetic eligible trading income.
Comparison, authority and scope are documented in
[automatic-utilisation-plan.md](automatic-utilisation-plan.md).

The manifest covers migrations, tax/depreciation/assets, period locks, API/MCP/
import/bulk permissions, separate-book isolation and financial reporting.
New process tests use independent connections and a shared WAL book, not just
serial retries. The restore/guard suites were also rerun after adding the
attachment metadata assertion. Results overlap and must not be added together.

The original Vitest/browser project, configured server, Docker/desktop builds and
visual checks were not run. Browser/visual acceptance belongs to the owner under
CLAUDE.md's verification policy. Type checks, safe fixture tests and static review
are not substitutes for those checks.

## Manual walkthrough and UI locations

Follow [owner-walkthrough.md](owner-walkthrough.md), recording PASS/FAIL/NOT RUN
and the candidate version for each step. Locations: Accounts/default cleanup,
Records/classifications, Assets/register/depreciation, Settings → Tax, Tax/annual
worksheet, CSV/print and audit history. No screenshots or owner behavior/visual
acceptance are claimed.

The walkthrough covers historical upgrade refusal, classification splits and
refunds, close/reopen, registration without purchase duplication, posting and
reversal, annual tax-only correction, scheme claims, utilisation, YA rollover,
amendments, roles, keyboard/mobile/print behavior and isolated restore.

## Financial reconciliation evidence

- Historical fixtures entering after migrations 0040, 0045, 0046, 0047, 0048 and
  0049 retain original account/record/movement/close/audit values. Finalised
  unaffected revisions remain unchanged. Repeated startup changes no evidence.
- Affected pending upgrades refuse atomically, including withdrawn phase 5
  adjustments, inactive phase 6 schedules and older finalised revisions. The
  read-only WAL inspection preserves database and WAL bytes.
- Concurrent depreciation posting leaves one January asset/month posting and a
  balanced book. Close/post races cannot both accept stale previews. Competing
  tax completions produce one receipt; identical retries replay safely.
- The stopped-book restore retains statement/register outputs, journal and
  attachment links, depreciation runs/postings, tax revisions, capital evidence,
  command receipts, audit history, finalised CSV/HTML and receipt bytes. Integrity
  and foreign-key checks pass.
- The synthetic RM12,000 asset posts RM333.33 January book depreciation. A
  separately labelled arithmetic scheme (20% first-year + 10% original cost)
  yields RM3,600 allowance; RM1,000 eligible trading income automatically uses
  RM1,000, leaving RM2,600 unabsorbed and
  RM8,400 residual for the next YA. Tax preparation changes no accounting
  statements. These percentages are fixtures, not recommended Malaysian rates.

## Performance and remaining release gates

The recorded performance measurements precede the automatic utilisation follow-up
and do not establish its performance. The release decision remains HOLD.

See [performance.md](performance.md) and benchmark-results.json for reproducible
inputs, query counts, timings and memory. The small fixture meets screening
targets. At 100,000 movements/1,000 assets, detail takes 2.836s and claim
finalisation 6.699s, above proposed targets; read+save is 6.072s. Exports take
under 0.4s. Three samples are screening evidence, not an established p95 SLA;
finalisation has one sample.

The million-movement/10,000-asset run was stopped at about 12.72 GiB RSS, above a
12 GiB process safety budget on a 16 GiB executor. Reads took roughly 10–38s;
save/finalisation/export did not complete. Do not claim large-ledger readiness.
The benchmark retains multiple fixture results, so this is not an assertion that
one production request necessarily uses the same memory.

| Gate                                                       | Status                                  |
| ---------------------------------------------------------- | --------------------------------------- |
| Financial/security/concurrency regression                  | Verified by the manifest                |
| Safe refusal before destructive pending upgrade            | Verified                                |
| Synthetic stopped-book restore                             | Verified                                |
| Medium/stress performance acceptance                       | HOLD; see measured bottlenecks          |
| Owner non-production real-copy upgrade/restore             | NOT RUN; no copy provided               |
| Owner mobile/accessibility/print walkthrough               | NOT RUN                                 |
| Distribution/real-book use of earlier versions             | Unconfirmed; conservative guard applies |
| Release artifact build and explicit owner release approval | Pending                                 |

## Known limitations and rollback

Read [limitations.md](limitations.md) for unsupported tax/disposal/currency/
utilisation features and the preparatory tax notice. Custom schemes remain
unverified. Large-ledger response growth and per-asset queries need further work;
no silent partial computation, year splitting or arbitrary production data cap
was introduced to pass a benchmark.

Follow [recovery.md](recovery.md). No phase 7 data migration needs undoing.
Reverting code removes the protective guard and must not be used to run destructive
0049 cleanup. An older manual-schema application cannot safely run against a
post-0049 book. Restore the coordinated database/storage backup into its matching
application version; retain failed/current evidence and identify writes since
the backup before deciding to restore. Keep posted journals, finalised tax
evidence and audit history; use audited accounting corrections rather than deletion.

**Owner decision:** APPROVE / REQUEST CHANGES / HOLD — release remains HOLD until
the outstanding gates have explicit evidence and owner approval.
