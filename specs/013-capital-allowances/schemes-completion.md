# Reusable asset tax schemes — implementation and structure review

**Scope:** owner requested software changes and maintainability review before verifying a Malaysian scheme. This follow-up extends PR #72; it does not introduce approved national tax rules or a filing engine.

## Result and workflow

**Settings -> Tax -> Asset tax schemes** manages reusable definitions, independently of annual worksheets. Tax -> worksheet -> **Asset tax deductions** has a **Scheme settings** shortcut. Create a named custom scheme with an explicit jurisdiction, effective tax years, first-year rate, regular rate and an optional remark. The library starts empty; no Malaysian or other statutory rates are seeded. All schemes are visibly **custom and not jurisdiction-verified**.

Jurisdiction and book currency are independent. New schedules use the retained worksheet currency and an explicitly selected jurisdiction; currency no longer implies country. Unknown jurisdiction remains Needs review. This supports custom/manual workings across book currencies, not conversion into a country's filing currency. Version-1 MYR schedules retain their historical meaning until an editable revision is deliberately changed.

In asset workings, choose a custom scheme. Enter the qualifying tax basis and business use, or explicitly reuse the purchase cost for an asset acquired in this period. That action copies the purchase fact and suggests zero opening residual/business-use-adjusted additions; it does not assert legal eligibility. First-year application is an explicit checkbox. Calculated first-year/regular amounts and closing residual update immediately. Manual entry remains available; overriding a scheme requires an explanation. The server independently reproduces every submitted preview using the book's immutable definition.

**Deductions used and evidence** separates availability from utilisation, provides **Use available amount** for each source/origin, and previews the annual result before saving. Available amounts alone do not change the result. Actual utilisation is never automatically elected. Country changes clear prior scheme applications and return affected assets to review. Asset-source changes, accounting drift, retry keys, permission boundaries, annual finalisation and amendments retain their existing safeguards.

Scheme edits create a new immutable version. Each applied row retains its exact definition, version, jurisdiction, effective years, reference, first-year choice and override decision. New template versions do not alter applied rows, finalised evidence or exports. Rollover carries the retained definition as a reviewed starting point, but leaves the new regular deduction unconfirmed and first-year application off. Currency-mismatched rollover is refused. Jurisdiction/currency are shown in its preview.

## Structure review and refactor

The original transaction and evidence controls were sound, but commands and UI responsibilities had accumulated together. The planned refactor is in [schemes-plan.md](schemes-plan.md).

- `application/tax-worksheet-boundary.ts`: one shared authority/session check, immediate transaction, refusal mapping, version/draft helpers, audit and after-commit invalidation. No ledger posting.
- `application/tax-worksheets.ts`: annual source corrections and worksheet lifecycle. Reduced from roughly 1,000 lines to roughly 630. Existing capital/event exports remain compatibility aliases.
- `application/capital-allowances.ts`: schedule preparation, changes, replacement, rollover and server-side scheme reconciliation, independent of the annual command implementation.
- `application/asset-tax-schemes.ts` / `queries/asset-tax-schemes.ts`: immutable version library, validation, permissions, retry protection and audit.
- `asset-tax-scheme.ts`: client/server pure validated definitions and precise scheme arithmetic; `capital-allowance.ts` remains the schedule/reconciliation rules.
- `asset-tax-export.ts`: retained export rendering independent of database queries. `server/tax-evidence.ts` centralises the existing evidence-hash algorithm without changing old hashes.
- `CapitalAllowanceSheet.svelte`: command orchestration, reduced from 855 lines to roughly 350. `CapitalAssetFields.svelte` owns asset inputs/previews, `CapitalUtilisationFields.svelte` owns utilisation/result preview, and `AssetTaxSchemesSheet.svelte` owns scheme editing.
- `TaxWorkingsDrawer.svelte`: shared drawer, submission, pending/error feedback, navigation and unsaved-change guards. `TaxJurisdictionField.svelte` is reused by setup, utilisation and schemes. `asset-tax-form.ts` is a pure form adapter shared by rendering/tests rather than duplicating financial logic in event handlers.

The review also corrected exclusion handling: explicitly excluding an asset clears incompatible scheme/disposal decisions rather than trapping the user behind hidden disposal inputs. This affects editable tax evidence only and is audited.

## Calculation contract

Only configurable full-period percentage arithmetic is implemented:

- First-year deduction: rate times business-use-adjusted qualifying additions, only when explicitly selected.
- Regular deduction: rate times either business-use qualifying cost or remaining tax residual after first-year deduction.
- Each amount is rounded precisely in integer minor units, halves away from zero, and capped by the remaining tax residual.
- Gross qualifying expenditure/business use explains the basis. Opening residual/additions and entered overrides are already business-use adjusted, so an allowance is not adjusted a second time.
- No implicit legal eligibility, prorating, national pools, MACRS conventions, annual statutory limits, optimisation, special incentives or approved disposal rules.

UK and US are jurisdiction choices for custom/manual preparation; this is not a certified UK or US tax engine. Malaysian scheme verification is intentionally left for the owner/accountant after software review.

## Migration and preservation

`0048_asset_tax_schemes.sql` adds an empty immutable scheme-version table and broadens the schedule envelope to support version-2 evidence with independent three-letter book currency. It rebuilds the schedule table by copying the original JSON text unchanged. All finalisation/history/duplicate-claim triggers are explicitly restored, including the trigger on manual adjustments that references the rebuilt table. Immutable scheme versions have update/delete guards.

No existing schedule, finalised snapshot, ledger entry, classification, asset, depreciation or setting is reclassified or recalculated. No historical scheme application or legal verification is inferred. Tests stage both supported SQLite rename modes, compare phase 1–6 evidence before/after, assert byte-identical version-1 JSON, and verify the restored finalisation/claim guards and restart idempotence. A draft worksheet/schedule currency mismatch is flagged, excluded from annual totals and refused at review; amounts are never silently relabelled. An explicit manual switch or matching-currency rollover is required.

## Validation

- Original extraction baseline: 40 existing annual-tax/capital tests passed before feature changes.
- **Final full regression run: 1,768 tests passed across 118 files**, 2 snapshots and 16,931 assertions, including the final currency guard. Command: `bun test --timeout 20000 --preload ./scripts/mcp-test-preload.ts <files from specs/012-annual-tax/validation-files.txt> src/lib/server/application/capital-allowances.spec.ts src/lib/server/db/migration-0047.spec.ts src/lib/asset-tax-scheme.spec.ts src/lib/server/application/asset-tax-schemes.spec.ts src/lib/server/db/migration-0048.spec.ts`.
- Focused coverage includes exact rounding/caps, incomplete inputs, original/reducing bases, manual/automatic form previews, multiple assets, immutable version edits, stale writes/retries, authority, year/jurisdiction constraints, server rejection of tampered previews, sanitised retained definitions, override explanations, currency separation/rollover refusal, transitive annual dependencies, GL neutrality and audit-failure rollback.
- Type checking reports zero errors/warnings. Changed-file ESLint/Prettier, schema consistency (no pending Drizzle differences), and diff checks pass. Existing unrelated full-repository formatting/lint backlog remains outside scope.
- Isolated server rendering exercises the scheme editor, live calculated asset fields, utilisation actions/result preview and schedule command drawers. No configured application, live book or receipt store was opened. Browser/mobile/interaction checks remain with the owner under `CLAUDE.md` Verification Policy.
- The original version-1 capital export function and the extracted renderer produce byte-identical retained lines for the same evidence. No scheme library read is required for retained exports.

## Owner walkthrough

Use an isolated test book; do not treat test inputs as verified national tax rates.

1. Open Settings -> Tax -> Asset tax schemes. Create a custom scheme, choose Malaysia explicitly, set effective tax years, enter your own test rates and an optional remark, and save. It remains labelled custom/unverified. You can verify the Malaysian rates/conditions later by saving a new version.
2. Prepare an asset tax schedule and select its jurisdiction. Open an asset, choose the scheme, enter business use and explicitly reuse its purchase cost when appropriate. Confirm opening residual and additions. Select first-year application only when intended. Deduction numbers and closing residual should update without manually typing those amounts.
3. For a purely illustrative workflow test: qualifying cost 10,000, business use 100%, opening 0, additions 10,000, first-year rate 20%, regular original-cost rate 10%, first-year selected -> deductions 2,000 + 1,000 and closing tax residual 7,000. These are arithmetic test inputs, not an approved Malaysian scheme.
4. Save the asset workings, then open Deductions used and evidence. Available deduction is 3,000; use is initially zero. Choose Use available amount, inspect the annual-result preview, enter the shared working-paper reference/reason and save. The preparatory result now decreases by 3,000; P&L, balance sheet and book depreciation stay unchanged.
5. Apply the same scheme to a second asset. Edit the scheme into a new version and verify existing rows retain the previous version/amounts. Select the new version explicitly on an editable asset when wanted. Finalised revisions require amendment, as before.
6. Try a non-MYR book and explicitly choose a jurisdiction. The UI must retain the book currency, show the selected jurisdiction and never infer national compliance. Verify mismatched year/jurisdiction schemes and cross-currency rollover are refused.
7. Change source evidence, try another browser tab's stale save, and exercise pending/error/discard behaviour. Review then finalise the annual worksheet once. Create an amendment and verify the earlier revision's figures/exports remain unchanged.
8. Owner checks: desktop/mobile field layout, long scheme names, keyboard focus, rate/basis previews, the new scheme picker, first-year/override controls, utilisation preview, export and print. No owner-browser check is claimed by the agent.

## Limits and rollback

Custom schemes are percentage tools, not an international statutory rules engine. Verification of Malaysian rates and conditions is deferred as requested. Tax currency conversion, UK pools/AIA limits, US MACRS/Section 179/bonus rules, pro-rating and complex incentives/disposals remain unsupported. Manual tax-only adjustments are still available for accountant-prepared totals.

Revert application code while retaining migrations 0047/0048, definitions, receipts, audit and finalised evidence. Do not delete scheme versions or rewrite version-2 JSON into old MYR-only evidence. The old application understands only version-1 schedules, so disabling the newer UI is safer than forcing old code to read new evidence; restore access with the updated code. No new GL journals exist to reverse. No deployment/live migration performed.

**Owner decision:** pending software acceptance and subsequent Malaysian scheme verification.

## Settings placement follow-up

Reusable scheme configuration now lives at `/settings/tax`, linked from the main Settings navigation. The editor no longer depends on a worksheet: new setups start with explicit jurisdiction/effective-year inputs, and existing definitions can be opened directly for a new version. The annual worksheet keeps scheme selection, tax-basis previews and annual utilisation, with a shortcut to Scheme settings.

The focused Settings page exposes only tax definitions and uses existing tax.read/tax.update permissions; general/admin settings are not exposed to tax-only users. Users with general Settings access return there; tax-only users return to Annual tax. The real route transition also preserves the existing unsaved-change navigation guards instead of silently switching away from an embedded editor. No migration, calculations or financial writes changed. Validation: 14 scheme permission/versioning/currency tests pass; type checking reports zero errors/warnings; relocated/new modules pass ESLint. Isolated Settings rendering covers empty first-time setup without a worksheet and read-only definitions, alongside the worksheet calculation surfaces. The main Settings page retains its three pre-existing lint findings; its action formatting and unrelated controls were preserved. These checks validate the relocation; visual checks remain with the owner.

## Simpler scheme setup and consistent Settings UI

The scheme editor now has one optional **Remark**, replacing separate source/reference, conditions and version-reason inputs. Name, jurisdiction, effective years, calculation basis and rates remain because they control selection or arithmetic. New schemes and edits can be saved without a remark or reason. Existing reference and condition text is combined for display/editing; older saved definitions, applied versions, request receipts and finalised evidence are not rewritten. Audit entries continue recording before/after definitions and the actor automatically. The API accepts the older supporting fields for compatibility; no database migration is needed.

The page now uses the same `set-section`, `set-rows`, typography and shared buttons as Settings. Each scheme shows its country, effective years, rates, basis and optional remark, with a simple Edit action. Removed the redundant scheme selector and retained-version list from the editor. The shared tax drawer uses the standard 500px desktop/full-screen mobile dimensions, a flex-column form with a scrolling body, the existing `sheet-foot` footer (correcting an undefined `sheet-footer` class), standard form errors and shared buttons. Its field spacing is self-contained so opening Settings directly does not depend on worksheet CSS. Escape/outside interaction is blocked while saving. Annual worksheet evidence and the explanations required for overrides/exclusions are unchanged.

Validation for this follow-up: **64 tests passed across four files**, including saving/applying schemes without supporting metadata, optional remarks, legacy text compatibility and preservation of already-applied definitions after remark edits. Svelte checking reports zero errors/warnings. Changed-file ESLint and formatting pass. Isolated server rendering covers empty/read-only Settings and the existing calculated asset, utilisation and drawer components. Browser/mobile interaction review remains with the owner under the repository Verification Policy; no development server or live book was opened.
