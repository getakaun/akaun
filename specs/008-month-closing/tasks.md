# Tasks: Month closing

## Phase 1: Specification and design

- [x] T001 Record accepted behavior in specs/008-month-closing/spec.md and validate checklists/requirements.md.
- [x] T002 Complete design, sources, contracts and constitution gates in specs/008-month-closing/plan.md and accompanying artifacts.

## Phase 2: Shared policy

- [x] T003 Write failing financial boundary/no-op/concurrency tests in src/lib/server/closing/policy.spec.ts.
- [x] T004 Implement shared exceptions, boundary reads and transactional ledger guards in src/lib/server/closing/policy.ts and src/lib/server/queries/ledger.ts.

## Phase 3: US1 Review and close

**Goal**: Review and protect a completed month without changing ledger amounts.
**Independent test**: Close through October with warnings acknowledged; reject stale/invalid/unauthorized reviews.

- [x] T005 [US1] Write isolated state/permission/review tests in src/lib/server/application/closing.spec.ts.
- [x] T006 [US1] Add permission leaves and audited close/preview operations in src/lib/permissions/catalog.ts and src/lib/server/application/closing.ts.
- [x] T007 [US1] Add thin authorized APIs and post-commit stream in src/routes/api/closing/ and src/lib/server/closing/events.ts.
- [x] T008 [US1] Build compact responsive page and shared boundary display in src/routes/(app)/closing/, app layout and src/lib/components/reports/ReportsPage.svelte.

## Phase 4: US2 Protect alternate writes and reports

**Goal**: Prevent financial changes through ordinary, specialist and master-data paths.
**Independent test**: Reclassifications, contact corrections, imports and voids refuse atomically; annotations/later payments remain available.

- [x] T009 [US2] Write failing master-data and application refusal/rollback tests in new closing-focused service/application test files.
- [x] T010 [US2] Protect account classification, partner roles and merges in src/lib/server/services/accounts.ts, services/contacts.ts and queries/contacts.ts; honor closing in startup repairs.
- [x] T011 [US2] Make ledger/account operations atomic and defer emissions in src/lib/server/services/ledger.ts and services/accounts.ts.
- [x] T012 [US2] Return actionable typed refusals after rollback from financial application operations and src/lib/server/mcp/common.ts.
- [x] T013 [US2] Verify all guarded entry points including invoice issue/void, opening balances, imports, reimbursements and specialist corrections in isolated integration tests.

## Phase 5: US3 Reopen deliberately

**Goal**: Correct earlier history with full affected-range disclosure and retained evidence.
**Independent test**: Reopen October through December, preserve history and require dedicated permission/reason.

- [x] T014 [US3] Add reopen state, reason/version/range and unauthorized tests in src/lib/server/application/closing.spec.ts.
- [x] T015 [US3] Implement reopen action/UI and history labels in src/lib/server/application/closing.ts, closing page and existing audit formatting.

## Phase 6: Verification and delivery

- [x] T016 Update README.md and dev-notes with closing behavior, operational-state limits and manual UI validation.
- [x] T017 Run required check/lint/test gates, verify changed files, review diff and record existing repository lint failures in specs/008-month-closing/quickstart.md.
- [x] T018 Commit, push 008-month-closing and open a PR against current main.

## Dependencies and parallel execution

T001 -> T002 -> T003 -> T004. UI/close T005–T008 and master data T009–T010 can run independently once the shared policy interface is agreed. T011/T012 follow core query guards. T013 integrates all write paths. T014/T015 reuse closing state/permissions. Final verification follows all stories.

Parallel examples: closing page and policy tests edit different files; account/contact guards and closing API edit different files. No simultaneous writers to the same file. Deliver the complete accepted scope; core protection is established before the management UI is considered usable.
