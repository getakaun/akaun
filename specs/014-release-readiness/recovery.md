# Migration impact, backup and recovery runbook

## Impact and distribution

Source baseline: `e7d16a1`, PR #72. The earlier phase reports say no live migration
was performed during development; that is not evidence about every installation.
Distribution/real-book use is not assumed. The default guard protects all pending
books with affected evidence without asking them to identify as production.

0049 deletes all existing capital schedule rows and manual current-year/
brought-forward allowance adjustment history, removes affected command receipts,
and resets affected latest revisions to draft. Older retained revisions can lose
allowance evidence even when they remain finalised. A system audit entry is not
a substitute for the deleted calculations. Source GL preservation alone is not
sufficient migration acceptance.

Phase 7 does not edit historical SQL or its hashes, and does not add a schema
migration. The guard runs before writable startup/chart conversion and repeats
inside the immediate migration transaction. Foreign-key violations abort that
transaction before commit. Do not use the raw fixture migration helper as an
operational upgrade command.

## Inspect an isolated copy

1. Stop every process using the book, including automatic posting, import
   workers and any desktop instance. Record the old application version/commit,
   business timezone and migration level. Do not inspect credentials in reports.
2. Back up the entire database family and attachment store together, with
   configuration retained securely. Record file names, sizes, checksums and date.
   Restore the copy to a separate location, never over the original.
3. With Bun 1.3.11, run from the repository root:

   ```sh
   bun scripts/tax-upgrade-preflight.ts --copy /absolute/path/to/isolated-copy.db
   ```

   This opens only the explicit copy, read-only, and reports counts. Exit 0:
   no pending affected evidence, or 0049 already recorded. Exit 1: affected
   evidence or inspection error. Exit 2: invalid invocation. No deletion/reset
   option exists. The repository's real data directory is refused.

4. If `cleanupApplied` is true, compare pre-upgrade backups to establish whether
   earlier workings were removed. Zero reported pending rows is not a historical
   preservation certificate.
5. If affected evidence is present, leave the book and prior application intact.
   Retain exports and raw evidence from the compatible prior version. A separate
   preservation/conversion design is required before this book upgrades. Do not
   mark 0049 applied, delete adjustments, or use a raw SQL reset.
6. Otherwise rehearse the candidate on the isolated copy. Compare trial balance,
   P&L, balance sheet, cash flow, classifications, close state, asset register/GL
   differences, settlements, reconciliation, tax revisions/exports and files.
   Check database integrity and foreign keys. Explain every difference.

## Restoration

- Restore the database family and attachment store from the same stopped backup.
  Remove mismatched WAL/SHM files from the restore destination; never mix backup
  generations. Keep the current failed instance separately for investigation.
- Use the exact application version that made the backup first. Keep imports
  and unattended depreciation controlled during investigation. Opening the new
  application automatically attempts migrations and may run approved catch-up.
- Compare the same reports/dates and saved exports, verify receipt bytes, journal
  balance and audit history. Record actual restoration/reconciliation time.
- Rehearse the upgrade on another copy; do not repeatedly start a failing
  candidate against the original.

## Rollback of this phase

No phase 7 schema or data conversion needs undoing. The patch itself adds an
upgrade guard, checks and performance/security fixes. Reverting its code removes
the guard; it must not be used to let 0049 silently delete affected evidence.
Code expecting the old allowance schema cannot safely run on a post-0049 book.

Before any restore, identify all writes made since the backup. A restore loses
those writes; their preservation/re-entry requires a deliberate recovery plan.
Existing journals are corrected through audited reversals/open-period actions,
not deleted as part of rollback. Finalised tax evidence and audit history are
retained. Already-deleted allowance workings cannot be recreated by changing
migration receipts.

## Support messages

- **Upgrade blocked before migration 0049:** data protection is working. Keep
  the old version and backup; report only counts, version and migration level
  initially. Share a book only through an agreed secure support channel.
- **Worksheet changed / accounting or predecessor changed:** refresh and review
  the affected inputs; do not repeatedly submit stale confirmation data.
- **Closed accounting period:** use authorised audited reopening or an annual
  tax-only correction as appropriate. Tax finalisation is a separate lock.
- **Depreciation catch-up refused:** inspect source/account/grant/period issues.
  Never shift charges to another date automatically to avoid a refusal.

Synthetic restoration passes do not establish the recovery time or completeness
of a deployment backup. Owner real-copy rehearsal and release approval remain
pending until recorded in completion.md.
