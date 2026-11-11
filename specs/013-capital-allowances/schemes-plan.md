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

## Settings placement follow-up

Reusable scheme definitions belong under Settings -> Tax, independently of any annual worksheet. Move the management surface to `/settings/tax`, linked from Settings navigation and from the worksheet. Keep selection, tax-basis previews and annual utilisation in the worksheet. Preserve `tax.read` / `tax.update` authority: the focused Settings subpage exposes no general/admin settings and does not require an accountant to gain unrelated settings privileges. Decouple the editor from worksheet data and preserve its immutable versions, retry/audit and unsaved-change guards. No migration or financial calculation changes.

## Approved inline worksheet follow-up

Replace routine asset and utilisation drawers with one staged inline table and claim summary. Keep scheme management in Settings. Reuse the asset form for expanded details, suggest visible cost/business use/first-year treatment for new pending assets, and keep exceptional operations under More options. Commit asset workings and explicit claim allocations once through the existing guarded save command. Preserve per-source/per-origin balances, untouched legacy manual workings, immutable scheme snapshots and finalised evidence. Make version-2 remarks optional without fabricating evidence; retain version-1 interpretation. Protect drafts against navigation and SSE updates, and prevent annual review/finalisation over unsaved inputs. Validate pure staging, transactional save/retry/finalisation, source/permission constraints, read-only rendering and responsive structure; owner performs browser checks under repository policy.
