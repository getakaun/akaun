# Phase 3 — fixed asset register

Approved flow: Records → Register asset → Assets. Registration is metadata only: no purchase, opening-balance, depreciation or disposal journals. Tax preparation remains deferred.

## Implementation map

- Add `fixed_assets` in `db/schema.ts` and additive migration `0042_fixed_assets.sql`. No historical backfill or financial data rewrite.
- Keep source record, movement identity, line order and a financial snapshot. One registration per source line. Source record deletion is restricted; movement rebuilding remains possible and is exposed as a review exception.
- Put authorized reads/writes in `application/fixed-assets.ts`, calculations in `queries/fixed-assets.ts`, validation/types in `lib/fixed-assets.ts`.
- REST endpoints at `/api/fixed-assets`, `/api/fixed-assets/[id]`, and a shared SSE invalidation stream. Reads require accounts.read + records.read; writes additionally require accounts.update. Metadata registration is permitted for closed purchases and never reopens or edits them.
- Reuse record attachments for linked purchases. Legacy entries retain a supporting-document reference and an optional existing opening record. Opening cost and accumulated depreciation are register values, never an instruction to post.
- Add a standalone Assets module at `/assets`, a shared asset form, create drawer and full detail page, links on purchase lines and fixed-asset account details. Separate registered, unregistered and reconciliation views; preserve as-at date in the URL.
- Reconcile gross cost and accumulated depreciation separately, on the same as-at date. Keep changed/voided sources and unallocated ledger movements visible. No current valuation inferred from brought-forward depreciation.

## Scope and limitations

One individual asset per purchase line; split bundles in Records before registration. Asset type is a descriptive classification with suggestions. Optional book profile fields are preparatory only. No automatic depreciation, disposal, revaluation, tax allowance, or asset bulk import. Registration edits are audited and version checked. A changed financial source needs an explicit, reasoned acknowledgement; it never silently refreshes the register.

## Verification and rollback

Use migrated in-memory databases, never the configured live book. Verify purchase and legacy registration preserve all ledger rows and report totals; duplicate/permission/version checks; source changes and voids; as-at reconciliation; audit rollback; independent-book isolation; opening and decimal validation. Run type checks and lint. Browser component tests use isolated fixtures without starting the application against a book.

Rollback: hide the new entry points and retain the additive table and audit history. Do not delete ledger records or discard registered asset data. No financial reversal is necessary because registration posts nothing.

## Completion walkthrough

1. Create a RM6,000 purchase in Records, from Bank to Computer equipment (Asset / Fixed asset), and attach its receipt. Save, then select **Register asset** in the Fixed assets card. Confirm the prefilled cost/account/date, enter the type and in-service date, and register. The card becomes **View asset FA-…**.
2. Inspect the purchase and bank/account balances: registration adds no journal, payment, expense, settlement or tax-classification change. Trying to register the same purchase line again is refused.
3. Open **Assets** from the main navigation. Check Registered assets, change the as-at date, and search by name, asset ID, type or serial number. From the Computer equipment account detail, follow **View linked assets and reconciliation** to the same register filtered to that account.
4. Create another capital purchase, then use **Unregistered purchases → Register asset**. It opens the same form. Opening-balance records and transfers are not purchase candidates; journal lines require checking that they actually represent purchases.
5. Use **Add existing asset** with original cost RM12,000, brought-forward depreciation RM4,000, acquisition date, opening as-at date, a separate accumulated depreciation Asset account, and a document/schedule reference. Optionally reference an existing opening record that includes the cost account. Save: no opening journal is created.
6. Open Reconciliation. Gross cost and accumulated depreciation are compared separately at the selected date. Missing ledger opening values appear as differences, and the linked records/evidence let the accountant investigate them. RM8,000 is labelled opening net book value on the asset's opening date, not current valuation.
7. Correct a source purchase through the existing Records workflow. The register retains its saved cost and flags the source for review. Open the asset, inspect the current line, select the acknowledgement checkbox, and provide a reason to accept corrected source values. A further source change before saving refuses the acknowledgement until refreshed. Voided/missing/ineligible sources cannot be acknowledged as valid purchases.
8. Edit legacy opening details or descriptive fields with a reason. Verify Activity records the before/after values. Two editors cannot overwrite each other using a stale register version. Purchase/legacy evidence records and mapped accounts cannot be deleted out from under the register; the UI and server provide refusal reasons.
9. Repeat registration from a closed-month purchase: it succeeds without reopening or editing the closed source. Users with accounts.read + records.read can inspect the register; accounts.update is additionally required to register or edit.

## Verification results

- Migration snapshot comparison: only `fixed_assets` was added; no existing table changed. Migration `0042_fixed_assets.sql` is applied by the existing startup migration mechanism, not manually against a live book during development.
- Migrated temporary/in-memory fixtures prove registration and reasoned metadata corrections leave ledger records, movements, settlements and saved classifications byte-for-byte unchanged as returned by the database.
- Final broad regression run: 150 passing tests across fixed assets, expense tax, tax close integration, closing/write paths, account/ledger services, audit and database upgrades; 230 additional MCP tests pass. Five Chromium component tests pass. The fixed-asset suite includes 14 database tests, including source reordering, source-review conflicts and independent-book isolation.
- Browser component coverage: purchase registration request, legacy opening evidence, unsaved-change protection, registration from the unregistered-purchases view, and read-only reconciliation access. The tests use system Chromium, mocked requests and fixtures, not an application server connected to a book.
- Type checking passed with zero errors and warnings. Changed TypeScript and new Svelte files pass targeted formatting/lint checks. Repository-wide `bun run lint` stops on existing unrelated formatting issues; those files were not reformatted as part of this feature.

## Known limitations

- No automatic depreciation, disposal, revaluation, capital allowances, annual tax worksheet, or Tax navigation in Phase 3.
- One individual asset per saved purchase line. Split multi-asset bundles before registration. Source line replacements/reordering require explicit review.
- Legacy supporting documents are references or attachments on the linked opening record; this phase does not introduce a second document-storage workflow.
- Accumulated depreciation reconciliation covers explicitly mapped accounts. Manually posted depreciation after the opening date remains an unallocated difference; the register does not invent asset-level allocations.
- The register is an audited metadata register, not a period-frozen valuation schedule. Historical register corrections remain visible in Activity.
- Browser checks use isolated fixtures with the real application stylesheet. No full application instance was started against the configured book.

**Owner review:** Ready for Phase 3 walkthrough. Phase 4 remains deferred.

## Assets module and styling follow-up

Assets now has its own navigation item and canonical `/assets` route. Record and account links still reach the same register; `/accounts/fixed-assets` redirects permanently and preserves asset IDs, as-at dates and account filters. Existing menu preferences automatically gain the Assets item, and users can pin it on mobile through the existing navigation settings. Visibility retains both required read permissions.

The create drawer follows AccountSheet. The module uses the shared topbar, list spacing and mobile row cards; reconciliation uses the existing Reports stylesheet. Forms use the shared Select, DatePicker, Input and Textarea components. Existing assets open on the standard DetailPage frame with related records and Activity in the rail.

Browser tests load the actual application stylesheet and check button size/padding, form scrolling, footer visibility after the phone animation, table spacing and module heading. Financial storage and posting behavior are unchanged by this follow-up.

## UI standardization review

Compared AccountsPage, AccountSheet, AccountDetail, ContactDetail and Reports against the asset surfaces. The earlier module-specific table/summary layout, native controls and combined create/edit drawer were replaced:

- Lists reuse `topbar`, `topbar-right`, header search, shared Button actions, counted `status-tabs`, `work-main`, `table-card`, `exp-row`, `EmptyState`, StatusBadge and `table-foot`. Registered assets open through real `/assets/[id]` links; the whole row also navigates like Accounts. Mobile uses the same header search toggle and row cards. The as-at date uses a compact shared DatePicker.
- `AssetForm` is shared by creation and detail editing and uses the same Select, DatePicker, Input and Textarea components as account/contact forms. Legacy-only opening fields are hidden on linked purchase registration.
- `AssetSheet` is create-only. Its header, body, footer, Cancel/Register actions and unsaved-change confirmation follow AccountSheet. Existing assets use `DetailPage` with the amount hero, asset fields, related-record cards, Activity rail and dirty-only Save/Discard bar. Back navigation uses the shared BackLink behavior.
- Reconciliation reuses `reports.css` (`rep-block`, `rep-table`, amount cells) and ReportNotes. It no longer introduces a second report-table appearance.
- Former `?asset=<id>` links redirect to the full asset detail route; account/record/audit links now point there directly. The redundant register button on the Accounts list was removed; the contextual link on a fixed-asset account remains and uses the existing relation-card shape.

Verification: 12 Chromium interaction tests cover shared control operation, creation, detail save/discard and mobile layout; 5 fixture previews compare Accounts with Assets on desktop and phone; 30 asset/audit tests pass. Test fixtures do not open the configured book. No financial data model, migration or posting behavior changed during this UI review.

## Duplicate branch consolidation

PR #65 (`82caf374`) has been reviewed and merged into the #66 branch with explicit conflict resolution. The canonical register, API and standardized UI are retained. The duplicate initial table migration and competing API/page implementations are excluded. Useful test coverage, account-reference accounting and the minimal account-default fixture are adapted to the canonical model.

Migration 0042 is unchanged. Follow-up `0043_fixed_asset_integer_checks.sql` upgrades a canonical 0042 register with stronger integer checks, preserving existing asset/financial/audit rows. An existing database created with #65’s alternative schema is not automatically converted. See [the full consolidation review](../specs/010-fixed-assets/consolidation.md) for compatibility decisions and final validation.
