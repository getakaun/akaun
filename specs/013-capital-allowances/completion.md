# Phase 6 — capital allowance schedule

**Follow-up:** [Reusable schemes and international foundation](schemes-completion.md) supersedes the original MYR-only/manual-input limitations below. Earlier finalised evidence stays unchanged.

**Phase:** 6, manual Malaysian capital allowance preparation.

**Branch:** `codex/capital-allowance-schedule`, based on main `decc118`.

**Owner decision:** pending acceptance. No phase 7, deployment or live migration.

## What changed

Capital allowances live inside the existing Tax worksheet. Purchase registration remains unchanged. Prepare schedule captures registered assets acquired by the accounting period end, with eligibility, business use and allowance amounts initially unconfirmed. The compact desktop table and mobile list show opening tax residual, IA/AA, closing residual and review state. Selecting an asset opens its manual workings, with a live arithmetic preview. Allowance use and evidence has a shared working-paper reference and utilisation by business source and origin YA. Asset detail links to retained annual schedules for tax readers.

Users enter qualifying expenditure before business use; opening residual, qualifying additions, IA/AA and residual adjustments are already business-use-adjusted MYR amounts. The basis-point check uses integer arithmetic and halves away from zero; it does not multiply an accountant-entered allowance twice. No asset type implies tax eligibility, and no Malaysian statutory rate, disposal rule or utilisation ordering is inferred. Tax class, effective YA and individual/shared references are retained with calculation version 1. Unknown inputs remain Needs review.

Tax residual expenditure and unabsorbed capital allowances are distinct. Current-year allowances include any manually reviewed balancing allowance. Amounts used, including zero, are separately confirmed. Brought-forward balances are attributed to business source and origin YA; current-year amounts reconcile to asset workings. Only utilisation decreases the preparatory tax result; balancing charges increase it. Book depreciation keeps its existing add-back once. These writes never call ledger posting services.

Preparing or reactivating an asset schedule previews overlapping phase 5 manual capital allowance and brought-forward allowance entries and requires explicit confirmation to withdraw them with retained history. Database and application guards prevent overlapping allowance claims. Switching back to manual totals is explicit and preserves the inactive schedule. Other adjustments and brought-forward losses are unaffected. Existing phase 5 worksheets stay manual unless deliberately changed.

The existing Draft -> Reviewed -> Finalised lifecycle is reused, with no extra per-asset approval process. Mutations return the worksheet to Draft. Server transactions revalidate worksheet versions, asset/purchase evidence and predecessor dependencies at review/finalisation. Changed assets require an explicit capture and return affected workings to Needs review. Finalised source divergence is flagged without modifying evidence. Amendments copy schedule evidence into a new revision. Multi-year dependency checks detect amendments anywhere in the carried-forward chain.

Bring forward previews the most recent eligible preceding worksheet only when its latest revision and dependencies are finalised. It copies opening asset residuals and unabsorbed balances independently. Annual allowances and current-year utilisation require fresh review; no automatic yearly claim is created. Tax-disposed assets roll forward as excluded. Full tax disposal captures date, proceeds, evidence and reviewed balancing allowance/charge, removes the remaining tax residual and visibly explains that book disposal/depreciation need separate accounting work.

CSV and printable HTML contain all retained tax inputs, asset/purchase evidence, utilisation, calculations and references. Finalised exports do not need live asset/ledger reads. Existing phase 5 exports with no schedule remain byte-identical to the main baseline. Activity summaries use human-readable schedule descriptions; full evidence stays in append-only audit entries.

## Changed files and migration

- New shared rules: `src/lib/capital-allowance.ts`.
- New retained evidence/query/export module: `src/lib/server/queries/capital-allowances.ts`.
- Existing tax application/query and `tax-worksheet.ts`: new commands, totals, amendments, review/finalisation guards and exports.
- New `CapitalAllowances.svelte` and `CapitalAllowanceSheet.svelte`; integration in TaxWorksheetDetail/Sheet and AssetDetail; tax/asset loaders and permission descriptions.
- New `POST /api/tax/[id]/capital-allowances`; existing Tax SSE publishes committed signals. No new navigation, OAuth scopes or MCP tools.
- `src/lib/components/audit/audit-format.ts`: readable schedule history summaries.
- `drizzle/0047_capital_allowance_schedules.sql`, schema and metadata: `tax_capital_schedules` (revision-owned retained JSON) and append-only command receipts. SQLite triggers retain history, prevent finalised evidence edits/inserts/deletes and refuse overlapping manual claims. Existing tax snapshot format is unchanged.
- New capital allowance application and migration regression suites.

Migration adds empty tables/constraints only. It changes no accounts, journals, source classifications, assets, depreciation, settings or tax worksheet evidence. No eligibility or historical claim backfill occurs. All development used in-memory or temporary fixture books through the safe preload; no configured database or receipt store was opened.

## Verification

- Before changes: **25 phase 5 tests passed**.
- Full phase 5 regression manifest plus the new capital/migration suites: **1,742 tests passed across 115 files**, 2 snapshots, 16,846 assertions.
- Final focused capital/migration/annual-tax/activity run after adding multi-source and transitive-dependency cases: **43 tests passed across 4 files**, 205 assertions. These overlap the full run and are not additive totals.
- Command: `bun test --timeout 20000 --preload ./scripts/mcp-test-preload.ts <files from specs/012-annual-tax/validation-files.txt> src/lib/server/application/capital-allowances.spec.ts src/lib/server/db/migration-0047.spec.ts`.
- Final focused command: `bun test --timeout 20000 --preload ./scripts/mcp-test-preload.ts src/lib/server/application/capital-allowances.spec.ts src/lib/server/db/migration-0047.spec.ts src/lib/server/application/tax-worksheets.spec.ts src/lib/components/audit/audit-time.spec.ts`.
- Type checking reports zero errors/warnings; changed-file ESLint and Prettier checks pass. Repository-wide formatting retains the existing 231-file backlog; ESLint retains 59 existing errors outside this change. No full-repository lint pass is claimed.
- Drizzle generation: no pending schema differences. Migration tests preserve phase 1–5 financial/closing/finalised evidence in modern and legacy SQLite rename modes, reject invalid schedule envelopes, enforce finalised/history locks and verify restart idempotence.
- Isolated server rendering exercised the manual/active schedule and settings/manual/refresh/prepare drawers without starting the application. Browser interaction and visual checks remain with the owner.
- An isolated comparison against the original main export functions confirmed byte-identical CSV and HTML for a phase 5 worksheet without a schedule.

## Financial reconciliation evidence

An illustrative manual fixture has RM12,000 qualifying expenditure at 100% business use, RM2,400 entered IA and RM1,200 entered AA. These are test inputs, not prescribed tax rates. Tax residual closes at RM8,400. Reviewed utilisation of RM3,000 reduces the preparatory result by RM3,000 and leaves RM600 unabsorbed allowances. Accounts, journals, movements, settlements, reconciliation allocations, settings, P&L, balance sheet and cash-flow outputs remain byte-identical.

Rollover independently brings RM8,400 asset tax residual and RM600 unabsorbed allowances into the next YA, with no assumed new AA or utilisation. A separately reviewed RM600 balancing charge increases the result without changing the GL. Safe-integer overflow, duplicate claims, stale writes and invalid inputs are refused. An injected audit failure rolls back manual-entry withdrawal, schedule, command receipt, worksheet version and notifications together. Finalised exports remain unchanged after asset edits and amendment creation.

## Owner walkthrough / UI locations

Use an isolated MYR test book with registered assets and a completed annual period. Grant tax.read/update/review and explicitly tax.finalise/amend; grant tax.create for new worksheets. Asset/record permissions remain separate.

1. Open Tax -> a worksheet -> Capital allowances. Existing phase 5 manual totals remain active. Choose Prepare schedule. New rows show Needs review and do not imply eligibility. No source or financial statement changes.
2. If manual allowance claims already exist, inspect each amount/balance in the preview. The action refuses until Replace these manual allowance entries is selected. Save with a reason. Old entries remain visible as withdrawn; losses and other adjustments remain.
3. Open an asset row. Confirm tax class, named business source, qualifying expenditure, business use and reviewed opening/addition/IA/AA amounts. Inspect the closing-residual preview, enter notes as appropriate and save. A missing amount/reference or unexplained adjustment prevents annual review.
4. Open Allowance use and evidence. Add the common working-paper reference, enter this-year use for every source (including zero), and optionally add earlier-YA balances. Check available versus used versus unabsorbed amounts. Tax residual is shown separately in the asset table.
5. Verify the summary bridge and export CSV / Print-PDF. Mark the annual worksheet reviewed and finalise once. Attempts to edit schedule or insert overlapping claims through the API/SQL refuse. Tax updates have not posted journals or modified bank reconciliation.
6. Change an open source purchase or asset detail through its authorised workflow. The tax worksheet flags stale evidence. In a draft/amendment, Review updated asset evidence captures the current sources, resets affected rows and clears current-year utilisation for confirmation. A finalised revision keeps its original exports.
7. Create the next annual worksheet and choose Bring forward YA. Inspect opening asset residuals and unabsorbed balances before confirming. AA and current-year use remain unreviewed. Amend an earlier year and confirm that dependent schedules are flagged until their predecessor chain is reviewed again.
8. In an asset's optional disposal section, enter a full tax disposal and reviewed balancing allowance or charge. Check zero closing asset tax residual, the tax bridge and the visible notice to complete separate book disposal/depreciation work. No sale or GL journal is created.
9. Choose Use manual totals in an editable revision. The schedule stays visible but contributes zero to the bridge; replacement manual entries can then be added. Reactivation again previews/withdraws overlapping manual allowances.
10. Check read-only users, retained revisions and asset-history links. On desktop and phone widths, check long names/references, table/drawer scrolling, keyboard focus, required inputs, pending/error feedback, unsaved-change warnings and print output.

**Screenshots / browser checks:** owner validation pending. `CLAUDE.md` Verification Policy says “Do not test the UI in a browser” and “Do not start the dev server to check your work.” No configured application was started.

## Known limitations / deferred work

- Manual preparatory schedule only, MYR books. No filing, tax payable, statutory eligibility/rate engine, automatic utilisation ordering, automatic claims or unattended rollover.
- No special/accelerated allowances, hire purchase, partial disposal, transfers between business sources or complex incentives. Full tax disposal still needs separately reviewed book accounting; this feature does not claim a complete book asset lifecycle.
- Tax class/business source are explicit reviewed text labels, not a statutory classification engine. Use consistent business-source names. Evidence is reference text and existing purchase-document links; no new attachment uploader.
- Changes in business use, unusual tax residual adjustments and legacy opening balances require accountant evidence. Rollover is a reviewed starting point, not proof of eligibility or a substitute for statutory review.
- Snapshot/audit history prioritises reproducibility. Large-book performance and broader release hardening remain phase 7.

## Rollback

Revert feature code while retaining migration 0047, schedule/receipt rows, finalised worksheet revisions and audit. Do not delete financial or tax evidence to roll back the UI. No phase 6 GL journals exist to reverse. A pre-feature backup restore would discard tax evidence and requires the established deliberate recovery process; it is not automatic rollback.

**Owner decision:** APPROVE / REQUEST CHANGES / HOLD.
