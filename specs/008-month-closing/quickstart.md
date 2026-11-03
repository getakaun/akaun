# Validation guide: Month closing

Do not start the application against real books. Use the isolated SQLite fixtures in the new closing and master-data tests.

1. Run the new financial policy/state tests first; they must fail before implementation.
2. Run focused server tests for ledger, accounts, contacts, invoice void, imports, corrections and closing.
3. Run `bun run check`, `bun run lint`, and `bun run test`.
4. Inspect the final diff for every mutation's permission, validation, atomic audit and post-commit SSE.

Maintainer UI review using a disposable book: review October, acknowledge checklist/warnings and close; check boundary in forms/reports; attempt recategorization and backdating; post a November payment against an October invoice; reopen October in a book closed through December and confirm full range and reason; correct and close again. Check mobile widths. Existing paid/matched statuses are live and are not historical snapshots.

## Execution evidence

- `bun run check`: zero errors and zero warnings.
- `bun run test`: 147 server files / 2,223 tests and 6 client files / 21 tests passed. The isolated client test runner used the installed system Chromium through a scratch Playwright browser path; the default cache had no downloaded browser. Local test listeners required the execution environment's network allowance. No application dev server or real book was used.
- Changed-file Prettier (including the Svelte plugin), changed-file ESLint and `git diff --check`: passed.
- `bun run lint`: fails on existing formatting debt, 237 files in the feature branch versus 242 in unchanged main. A separate full ESLint run also identifies 62 existing errors in unchanged files. See the plan's validation-baseline exception; these are not feature-code failures.
- New financial protection tests were exercised against isolated databases, including a real two-connection WAL race. A missed import refusal, partial contact-profile update, classification warning and partner rounding instability were reproduced and corrected with regression tests.
- Independent source review completed with no remaining financial-correctness blockers. Live visual review remains with the maintainer under repository policy.
