# Phase 3 — consolidated completion report

**Canonical PR:** #66. **Superseded PR:** #65.

The duplicate branch has been reviewed and integrated with conflict resolution, retaining one register, one application boundary, one initial schema and the standardized Assets module. See [the review decisions](consolidation.md) and [the current implementation walkthrough](../../dev-notes/FIXED_ASSETS_PHASE_3.md).

## Validation

- The final phase 0–2 regression run passed **1,659 tests across 108 files**, with migration 0043 included (2 snapshots, 16,223 assertions).
- Targeted checks passed **36 tests across 3 files**: 18 asset tests, the adapted account-default fixture and database upgrade coverage.
- Migration preservation tests compare accounts, records, movements, settlements, closed-period settings and audit before/after 0042. The 0043 upgrade test additionally preserves an existing canonical asset row and rejects fractional SQL writes.
- UI verification passed **17 browser checks**: 12 interactions covering shared controls, create-only drawers, detail-page save/discard and responsive list cards, plus 5 comparative Accounts/Assets previews.
- Final type checking, lint, schema-generation consistency and diff checks are recorded in the PR.

## Limitations and rollback

No depreciation posting, disposal, tax allowance or annual tax computation is included. Live data was not opened or deployed. The alternate #65 database layout is not automatically converted; consult the compatibility section in the consolidation review before using a database created from that branch.

Prefer reverting application code while retaining registered asset and audit evidence. Do not delete financial or register rows to undo this code consolidation. A schema rollback requires the existing verified-backup process.

## Registration and review simplification

- The Fixed assets section in Record detail reuses the shared relation-card shape, title/subtitle styles and status badges. Each unregistered line places its compact Register action below the description/amount, with consistent spacing. Unsaved record edits disable registration until saved or discarded.
- Purchase registration shows a read-only date/account/cost summary and editable name/type. Type suggestions follow a matching purchase account name, otherwise Other; Computer equipment is no longer the universal default. Serial number, description and in-service date are collapsed under More details.
- New registrations do not ask for business-use percentages or future depreciation settings. Purchase registration reuses source documents. Existing optional values remain preserved; a previously populated depreciation profile can still be inspected/corrected in a collapsed detail-page section.
- Existing-asset registration retains opening cost/date/account, opening as-at and depreciation (initially zero). A depreciation mapping appears when opening depreciation is positive. Evidence can be selected by searching the existing Records API, restricted to the selected account and opening date with voided records excluded, or provided as a document reference. No raw record ID entry is required.
- Asset detail has a dedicated review section with a registered/current comparison and changed-field labels. Acceptance opens a focused confirmation with a required reason and frozen register/source versions; normal detail saves cannot acknowledge purchase changes. Missing/voided/ineligible sources and invalid mappings offer resolution links instead of inappropriate acknowledgement controls. Concurrent changes still fail through the existing server version checks.
- These changes use the existing pages and API operations, with no new migrations or accounting entries. The test fixtures verify separate descriptive edits, optional-value preservation, review eligibility and unchanged financial rows.

The earlier browser verification above predates this follow-up. This follow-up follows the repository's code-only UI verification policy; visual/interaction review is left to the owner, without starting the application against a configured book.

Follow-up validation: 1,659 Phase 0–2 regression tests and 23 targeted asset/migration tests pass. Type checking reports zero errors and warnings; changed files pass targeted ESLint and formatting checks. Repository-wide lint remains blocked by its existing formatting backlog.
