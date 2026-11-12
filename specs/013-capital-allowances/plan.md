# Phase 6 — scheme-based asset tax deductions

The annual tax worksheet calculates asset deductions from registered assets, declared tax basis and reusable schemes. The owner authorised implementation and removal of all unreleased manual allowance paths. Country-specific scheme verification follows software acceptance.

## Delivery scope

- Keep configuration in Settings → Tax: default tax jurisdiction and immutable scheme versions with name, effective tax years, calculation basis, rates and optional remark.
- Populate worksheet asset candidates from its actual accounting period and matching finalised predecessor. Selecting a scheme previews the deduction immediately.
- Calculate first-year and regular deductions in integer minor units. Require a configured scheme for every claimed asset; users cannot enter or override deduction totals.
- Keep qualifying cost, business use, opening tax residual and additions separate from annual claim utilisation. Attribute unused balances to business source and origin tax year.
- Show current bookkeeping in editable drafts through SSE. Stage expense corrections, adjustments and asset choices under one **Save draft** action. **Finalise worksheet** saves, reviews and locks when ready and permitted.
- Retain finalised evidence and saved exports independently of later bookkeeping changes. Amendments create new revisions; source, asset and predecessor hashes prevent stale saves.
- Remove worksheet configuration hyperlinks, mode switches, old working drawers and manual disposal/balancing calculations. An exceptional currency rollover uses a small dedicated drawer.

## Boundaries

Tax writes never post accounting journals. General tax adjustments and brought-forward business losses remain separate features. The scheme library contains custom, unverified calculations; it does not supply statutory eligibility, filing, tax payable, national pools, statutory limits or tax-currency conversion.

Migration 0049 clears all prior unreleased asset tax workings and their affected command receipts, removes manual allowance adjustment data and resets affected latest worksheets to draft. Scheme definitions, financial records, ordinary adjustments and business losses remain. Owners must reselect asset schemes after upgrading. This reset is intentional; there is no legacy manual-evidence compatibility layer.

## Verification approach

Use migrated in-memory or temporary fixtures with the safe preload. Verify scheme-only input rejection, exact arithmetic, first-year history and duplicate protection, independent country/currency, rollover, master-save rollback and retries, permissions, live-edit reconciliation and fixed exports. Check migration cleanup, reset audit evidence and financial preservation. Run type, lint and format checks. Repository policy assigns browser/mobile interaction checks to the owner and prohibits starting the configured application or touching real books.

Final validation results are recorded in [completion.md](completion.md).
