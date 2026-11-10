# Phase 5 — annual tax preparation

Owner authorised implementation and a pull request after reviewing the handover and market comparison. Build an Akaun-native annual worksheet inspired by Intuit's book/adjustment/tax comparison and Xero's review and completion controls. No phase 6 automation or filing integration.

## File and migration map

- `src/lib/tax-worksheet.ts`: schemas, signed integer-cent calculations and shared presentation types.
- `src/lib/server/queries/tax-worksheets.ts`: canonical P&L and expense source snapshots, change comparison, totals and reproducible CSV.
- `src/lib/server/application/tax-worksheets.ts`: permission-checked atomic creation, refresh, correction, review, finalisation and amendment.
- `src/lib/server/db/schema.ts`, additive migration 0046 and Drizzle metadata: worksheets, versioned revisions with retained source JSON, append-only adjustment history. Source JSON replaces a separate source table: one atomic snapshot, no live-source foreign keys or cascades.
- Tax API, loaders, list/detail routes, drawer and report components; navigation and signal-only SSE.
- Explicit tax permission leaves; finalise/amend are sensitive and session-only. No OAuth scope or MCP tools in this release.
- Existing append-only audit writer and UI support for worksheet history.

## Invariants and decisions

One confirmed YA and non-overlapping inclusive accounting period per worksheet in the installation's book database. Dates/YA are explicitly chosen, not inferred tax law. Main-currency cents; stored expense percentages in basis points; existing half-away-from-zero line rounding. Never infer historical approval. Draft -> Reviewed -> Finalised; all content changes return to Draft. Reviewed source hashes revalidate in the finalisation transaction. Finalised snapshots and exports stay fixed; amendments create a new revision, retaining the predecessor. Source changes require explicit refresh; affected active corrections must first be withdrawn with a reason. Refunds/void pairs retain signed arithmetic, generated depreciation has one existing add-back only.

Corrections replace a source line's annual treatment, never its ledger snapshot. One active correction per source per revision; immutable prior entries and retry keys prevent duplicate application. Other adjustments use a direction plus positive amount. Manual current capital-allowance claims, brought-forward balances and amounts utilised remain distinct; losses and allowances are separate. No automatic utilisation, rollover, tax rates or statutory computation ordering. Preparatory result is not a filing-ready taxable-income determination. Reviewed manual entries require reason and evidence reference. Finalise and amend require named grants; reviewing one's own preparation is permitted.

## Validation and release

Use migrated in-memory books via the safe Bun preload. Cover closed source correction, no financial statement movement, signed refunds/voids, depreciation add-back, rounding, repeat requests, supersession, stale previews, atomic finalisation, immutable prior revisions, permissions, separate book contexts, source deletion, exports and migrations. Run type checking and lint; report pre-existing failures separately. Repository policy assigns browser/visual verification to the owner; do not start the configured application. No live migration or deployment. Rollback code while retaining additive tax tables; do not discard finalised evidence. Completion notes include exact checks, manual walkthrough and limits.
