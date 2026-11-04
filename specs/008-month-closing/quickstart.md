# Validation guide: Month closing

Do not start the application against real books. Use the isolated SQLite fixtures in the new closing and master-data tests.

1. Run the new financial policy/state tests first; they must fail before implementation.
2. Run focused server tests for ledger, accounts, contacts, invoice void, imports, corrections and closing.
3. Run `bun run check`, `bun run lint`, and `bun run test`.
4. Inspect the final diff for every mutation's permission, validation, atomic audit and post-commit SSE.

Maintainer UI review using a disposable book: open Accounts → Month closing, select October, wait for automatic checks and confirm closing once; check boundary in forms/reports; attempt recategorization and backdating; post a November payment against an October invoice; reopen October in a book closed through December and confirm full range and reason; correct and close again. Check mobile widths. Existing paid/matched statuses are live and are not historical snapshots.

## Execution evidence

- `bun run check`: zero errors and zero warnings.
- `bun run test`: 147 server files / 2,224 tests and 6 client files / 21 tests passed. The isolated client test runner used the installed system Chromium through a scratch Playwright browser path; the default cache had no downloaded browser. Local test listeners required the execution environment's network allowance. No application dev server or real book was used.
- Changed-file Prettier (including the Svelte plugin), changed-file ESLint and `git diff --check`: passed.
- `bun run lint`: fails on existing formatting debt, 236 files in the feature branch versus 242 in unchanged main. Other pre-existing ESLint issues remain outside this change; the changed files pass their focused checks. See the plan's validation-baseline exception; these are not feature-code failures.
- New financial protection tests were exercised against isolated databases, including a real two-connection WAL race. A missed import refusal, partial contact-profile update, classification warning and partner rounding instability were reproduced and corrected with regression tests.
- Independent source review completed with no remaining financial-correctness blockers. Live visual review remains with the maintainer under repository policy.

Pull request: [getakaun/akaun#62](https://github.com/getakaun/akaun/pull/62).

Follow-up UI review: verify neither closing nor reopening uses a native month input; check the shared popover month grid, keyboard focus, disabled out-of-range months, theme colors, button spacing and mobile layout. Confirm Accounts main offers the action while individual account pages and Reports do not. Old `/closing` links redirect. Pending drafts and timing notices do not require acknowledgment or block otherwise valid closing.

The simplification regressions initially produced six failing cases against the checklist-based API. With the revised server contract, all 16 closing-state tests and all 68 focused financial protection tests pass. Both native month inputs and all manual acknowledgment controls have been removed.
