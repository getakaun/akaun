# Asset tax schemes and maintainability follow-up

Authorised: implement reusable custom schemes and an international foundation before Malaysian scheme verification, with a thorough structure review/refactor. Continue PR #72 on `codex/capital-allowance-schedule`; preserve the original feature and all finalised evidence.

## Review findings

- `application/tax-worksheets.ts` combines annual worksheet commands, shared transaction/audit/state helpers and capital schedule commands (~1,000 lines).
- `CapitalAllowanceSheet.svelte` combines asset inputs, utilisation, command confirmations and navigation guards (~850 lines).
- MYR is used as a proxy for tax jurisdiction, including a database JSON constraint; jurisdiction is not explicitly retained.
- Tax class is descriptive only. IA/AA must be typed manually, and available deductions do not change the worksheet until utilisation is entered; the UI does not make this progression clear enough.
- Existing immutable revisions, retry receipts, retained snapshots and GL separation are sound and must survive restructuring.

## Implementation sequence

1. Extract a shared tax write boundary (permissions, immediate transactions, versions, audit, committed events) and move capital commands into their own application module. Retain compatibility exports for existing callers. Separate export rendering from capital queries where useful.
2. Add pure, precisely rounded custom scheme calculations and form adapters. Support original-cost rates and reducing-balance rates only, with explicit first-year election, business-use basis and residual caps. This is a configurable arithmetic tool, not a UK/US or Malaysian statutory engine.
3. Add immutable, versioned book-local scheme definitions and an explicit jurisdiction on new schedule evidence. Currency remains the retained book currency, independent of jurisdiction; no cross-currency tax conversion. Migration preserves existing version-1 MYR evidence byte-for-byte and restores all immutability/overlap triggers.
4. Add scheme creation/new-version UI, selection and live preview in asset workings, a purchase-cost reuse action, and an explicit Use available amount action for annual utilisation. Split the asset and utilisation forms into focused components rather than extending the existing monolith. Scheme choices retain the exact definition/version; edits never rewrite applied or finalised amounts. Manual overrides require a reason.
5. Add country-neutral labels outside the legacy Malaysian view. All supplied schemes are custom and visibly unverified; no official Malaysian presets or statutory verification status will be asserted. UK pools, MACRS, special allowances and tax filing remain unsupported.
6. Verify pure arithmetic, server preview agreement, permissions, immutable scheme versions, concurrent/stale edits, cross-book isolation, rollover/jurisdiction/currency compatibility, GL neutrality, legacy exports and migration preservation. Run existing regression manifest, static checks and changed-file lint. Follow repository policy: isolated fixtures/SSR only; no configured server, live database or browser checks.

## Acceptance

A user can create a custom jurisdiction-specific scheme once, apply it to several assets, see calculated first-year/regular deductions immediately, explicitly select utilisation and observe the annual result. Finalised old versions and exports remain fixed. Code responsibilities are separated and documented. Owner validates the Malaysian scheme later; no legal rate assumptions are introduced in this change.
