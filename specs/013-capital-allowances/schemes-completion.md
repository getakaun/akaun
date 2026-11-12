# Scheme-only asset deductions

This report describes the final implementation, superseding the earlier unreleased manual workflows.

## Configuration and use

Reusable schemes and the default jurisdiction live in Settings → Tax, using the shared Settings navigation and existing tax permissions. A scheme contains its name, jurisdiction, effective tax years, original-cost or reducing-balance basis, first-year/regular rates and optional remark. Edits create immutable versions; new definitions do not change already saved worksheet calculations.

The annual worksheet automatically lists asset candidates for its accounting period. It carries matching finalised prior-year tax residuals and unused balances forward independently. Choose a scheme directly in the table; calculated values appear immediately. Asset details expose required tax basis facts, business use, optional remark and exceptional first-year treatment. Deduction amounts cannot be entered or overridden.

The claim summary shows current-year and earlier-origin allowances, explicit utilisation and remaining balances. Saving the worksheet confirms included first-year treatments together. **Save draft** and **Finalise worksheet** replace the separate setup, refresh, asset-save and review sequence for an owner with the required permissions. Independent review/finalisation authority remains supported.

The worksheet contains no configuration/navigation hyperlinks to Manage schemes, Asset register or Create scheme, no manual mode, and no routine asset drawer. A small rollover drawer remains only for a matching-currency exception.

## Arithmetic and safeguards

First-year deductions apply the scheme rate to business-use-adjusted qualifying additions. Regular deductions use either original eligible cost or the remaining residual after first-year deduction. Calculations use integer minor units and basis points, round precisely and respect the remaining residual cap.

The shared first-year policy checks dates, purchase linkage and retained prior claims. It recognises unused initial allowances and finalised claims alongside unfinished amendments. Unknown provenance can still produce an immediate proposal, confirmed by worksheet save. The server independently resolves policy and verifies exact scheme amounts; omitted metadata cannot enable repeated initial claims.

Live drafts follow bookkeeping changes while preserving user edits. Changed expense corrections require targeted resolution, and concurrent worksheet saves are rejected. Current source, asset and predecessor hashes are rechecked inside one transaction. Finalised exports read saved evidence and do not recalculate against current records.

## Intentional cleanup

Migration **0049** clears every pre-release saved capital schedule and affected receipt and removes manual allowance adjustment rows. It returns affected latest worksheets to draft and audits the reset. Owners must select schemes again. The schema has no persisted active/manual mode, and runtime code has no manual deduction overrides, disposal inputs or version-1 evidence interpretation. Scheme definitions and financial/general tax data are preserved; see [completion.md](completion.md) for the upgrade impact.

Tax writes do not create GL journals. Accounting depreciation, asset registration and book disposal remain separate. General tax adjustments and brought-forward business losses are retained.

## Remaining scope

Schemes are custom, unverified percentage calculations. Malaysian rules require owner/accountant verification after software review. Selecting UK or US does not provide national tax computation. National pools, AIA/annual statutory limits, MACRS conventions, Section 179/bonus, prorating, incentive eligibility, tax-currency conversion and disposal/balancing calculations remain unsupported. Akaun does not file this worksheet or calculate final tax payable.

## Validation

**228 tests passed across 15 files**, including migration 0049 reset/rollback, scheme arithmetic, first-year history, master saves, permissions, live staging, records and fixed assets. Type checking reports zero errors/warnings. Changed-file ESLint/format and isolated server rendering pass. Repository-wide lint still stops on its existing 231-file formatting backlog. No configured application, real book or deployment was opened; browser/mobile checks remain with the owner under repository policy.
