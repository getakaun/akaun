<!--
SYNC IMPACT REPORT
==================
Version change: 2.0.0 → 3.0.0
Bump rationale: MAJOR — a target surface is dropped. The Tauri desktop app is no longer
supported: `src-tauri/`, its build scripts, its release workflow and the `server.js` shutdown
hook it used are removed. Principle I now names three surfaces (browser, installable PWA,
mobile web), and the Desktop line is removed from the fixed technology constraints.

Modified principles:
  - I. One Codebase, Four Surfaces → I. One Codebase, Three Surfaces

Removed sections:
  - Technology Constraints → Desktop (Tauri 2)

Templates requiring updates:
  ✅ .specify/templates/tasks-template.md — Path Conventions no longer list desktop (Tauri)
  ✅ CLAUDE.md — the Prettier note no longer cites `src-tauri/` build output

==================

Version change: 1.2.0 → 2.0.0
Bump rationale: MAJOR — Principle VII is redefined incompatibly for one class of prose. It used
to require the everyday word everywhere, UI labels included ("What the business owes" over
"liabilities"). It now splits: documents keep the plain word, and **UI labels take the standard
accounting term**. Screens written to the old rule read "Money in and out" for Profit & Loss and
"What it is worth" for the Balance Sheet, which cannot be checked against a bank statement, an
invoice or an accountant's question. `004-standardize-chart-accounts` FR-004 already fixed the
vocabulary for the chart and the reports; this generalises it to every screen. Principle IV is
unaffected — identifiers were never in scope.

Added sections:
  - Core Principles → VII. Plain Language for a Non-Expert Reader

Modified principles: none

Removed sections: none

Templates requiring updates:
  ✅ .specify/templates/spec-template.md — reviewed, "describe this user journey in plain
     language" is prose guidance and stays correct under the split; no change needed
  ⚠️ CLAUDE.md — its own prose stays plain and is unaffected, but its § Ledger sections still
     name screens and labels that `004-standardize-chart-accounts` retired (Accounts ›
     Categories, /categories, the money-pot vocabulary). Stale for a different reason than this
     amendment; fix with the rest of the 004 documentation pass.
  ✅ .specify/templates/plan-template.md — reviewed, no prose-style guidance to correct
  ✅ .specify/templates/tasks-template.md — reviewed, task lines are imperative and already plain
  ✅ .specify/templates/checklist-template.md — reviewed, consistent
  ✅ CLAUDE.md — reviewed, consistent (holds pattern detail, not prose-style rules)

Follow-up TODOs: none

--- Previous amendment (1.1.0) ---
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR — a new principle (V. Test-First Where It Counts) was added and the
testing guidance in Development Workflow & Quality Gates was materially expanded. No existing
principle was removed or redefined incompatibly; v1.0.0's "targeted tests, no TDD ceremony"
guidance is narrowed rather than reversed (TDD is now mandatory inside a defined risk scope).

Modified principles:
  - V. Established Patterns Are Binding → VI. Established Patterns Are Binding (renumbered only,
    text unchanged, to seat the new test principle beside the code-quality principle)

Added sections:
  - Core Principles → V. Test-First Where It Counts

Removed sections: none

Templates requiring updates:
  ✅ .specify/templates/plan-template.md — "Targeted tests" gate replaced with a TDD scope gate
  ✅ .specify/templates/tasks-template.md — tests no longer blanket-OPTIONAL; red-green ordering
     made explicit for in-scope logic, still waived for UI/CRUD wiring
  ✅ .specify/templates/spec-template.md — reviewed, no constitution-driven changes needed
  ✅ CLAUDE.md — reviewed, consistent (static-verification policy governs UI, not unit tests)
  ✅ README.md — reviewed, consistent (no testing claims to update)

Follow-up TODOs: none

--- Previous ratification (1.0.0) ---
Initial ratification: template placeholders replaced with concrete, project-specific
principles (I. One Codebase, Four Surfaces; II. Lightweight by Default; III. Build What Is
Needed, Structure for What Is Next; IV. SOLID Boundaries, Clean Code; V. Established Patterns
Are Binding) plus Technology & Platform Constraints and Development Workflow & Quality Gates.
-->

# Akaun Constitution

## Core Principles

### I. One Codebase, Three Surfaces

Akaun ships to three surfaces — browser, installable PWA, and mobile web — from a single
SvelteKit application. There is one source tree, one router, one data model.

- Platform-specific forks of a route, component, or service are FORBIDDEN. Where a surface
  genuinely differs, branch on capability (viewport, `navigator.standalone`), never on a
  duplicated file.
- Every UI surface MUST be usable at mobile viewport widths. A feature that only works on a
  wide screen is incomplete, not "desktop-first".
- Offline/installability behavior belongs in the service worker layer, not scattered through
  feature code.

**Rationale**: Several surfaces multiply maintenance cost only if the code multiplies with them.
Keeping divergence at the edges is what makes supporting all three affordable for a small team.

### II. Lightweight by Default

Akaun MUST stay deployable on a Raspberry Pi, a home NAS, or a low-power VPS by a
non-specialist, with data in a single SQLite file plus a local folder.

- SQLite via Drizzle is the only datastore. Introducing a second database, an external cache,
  a message broker, or a background-worker service requires a constitutional amendment.
- No feature may make a network service mandatory for core operation (record expenses, income,
  claims, contacts, quotations, invoices). Third-party services — notably LLM providers for
  OCR extraction — MUST be optional, user-configured, and degrade to manual entry when absent.
- New runtime dependencies MUST be justified against their weight. Prefer the platform
  (web APIs, SvelteKit primitives, SQLite features) over a package.
- Self-hosted data stays local: financial records MUST NOT be transmitted to a third party
  except through a provider the user explicitly configured, for the purpose they configured it.

**Rationale**: "Lightweight and performant" is the reason SQLite was chosen. That choice only
holds if every later decision respects the same ceiling.

### III. Build What Is Needed, Structure for What Is Next

Implement the requirement in front of you. Do not build for hypothetical futures — but leave
the shape that makes the likely future a small change rather than a rewrite.

- YAGNI governs behavior: no configuration knobs, abstraction layers, plugin systems, or
  generalized engines without a present, named need.
- Structure governs placement: new logic goes in the layer it belongs to
  (`routes/` → `lib/server/services/` → `lib/server/db/`) even when the current implementation
  is three lines. Correct placement is not overengineering; premature indirection is.
- An abstraction is earned at the *second or third* concrete use, not the first. Duplicate
  twice, extract on the third — and extract from real cases, never from anticipated ones.
- When a foreseeable need is deliberately deferred, note it at the extension point in a comment
  rather than pre-building for it.

**Rationale**: The user's explicit mandate. Both failure modes are real — a speculative
framework nobody needs, and a shortcut that has to be unpicked from twenty call sites.

### IV. SOLID Boundaries, Clean Code

Layer responsibilities are fixed, and code MUST read clearly without a guide.

- **Single responsibility**: route handlers parse input, check permissions, and delegate.
  Business rules live in `src/lib/server/services/`; queries live in
  `src/lib/server/queries/` and `db/`. A route file that performs multi-step business logic
  inline is a defect.
- **Dependency direction**: services MUST NOT import from `routes/`. Shared logic moves down
  into `$lib`, never sideways between features.
- **Interface segregation**: a service exports the operations its callers need, with narrow,
  typed arguments. Avoid catch-all "manager" modules and boolean mode flags that make one
  function do two jobs.
- **Open/closed in practice**: extend behavior by adding a case to a typed union or a new
  service function; do not thread special-case conditionals through shared code paths.
- **Clean code**: names state intent; functions do one thing at one level of abstraction;
  no dead code, no commented-out blocks, no `any` used to silence the type checker.
- **Type safety is a boundary control**: all external input (form data, request bodies,
  LLM output, imported files) MUST be validated with Zod at the boundary before use.
- **Security gates are non-negotiable**: every route that reads or mutates a resource MUST
  call `hasPermission(locals, resource, action)` and return `403` on failure. Client-side
  hiding is never the control. Every create/update/delete MUST record an audit entry.

**Rationale**: SOLID here means enforceable placement rules, not ceremony. The rules that are
security- or correctness-critical (permissions, validation, audit) are stated as absolutes
because a single missed call is a real vulnerability, not a style lapse.

### V. Test-First Where It Counts

TDD is the default discipline for logic that can be wrong *silently*. Write the failing test,
watch it fail, make it pass, refactor. The scope is defined by risk, not by coverage.

**TDD is REQUIRED for:**

- Pure logic and business rules: currency conversion, running-number and sequence generation,
  date handling, duplicate detection, permission resolution, and any financial calculation.
- Service-layer functions in `src/lib/server/services/` that encode multi-step rules —
  state transitions, record-locking rules, claim/invoice lifecycle.
- **Every bug fix, without exception.** A test that reproduces the defect MUST fail before the
  fix and pass after. This is the single highest-value rule here: it is cheap, it is provable,
  and it is what stops a fixed bug from returning.

**TDD is NOT required — and MUST NOT be forced — for:**

- Svelte components, route wiring, drawer chrome, layout and styling. These are verified by
  static analysis plus the user's visual confirmation (see Development Workflow).
- Thin CRUD passthroughs that only validate input and delegate to a service.
- Schema definitions and generated migrations.

**Rules that keep it from becoming ceremony:**

- Tests exercise a module's public surface and observable behavior, never private internals.
- **No coverage percentage is set, and none may be introduced.** A coverage target manufactures
  tests for code that did not warrant them — the exact overengineering this constitution rejects.
- Do not mock the database to test a query. Use a real temporary SQLite database.
- A test requiring elaborate mocking is evidence the boundary is wrong. Fix the design
  (Principle IV), not the mock.
- Every test MUST assert something — the Vitest config enforces this (`requireAssertions`).
- Tests that no longer describe a real rule MUST be deleted, not maintained.

Tests live beside the module they cover: `*.spec.ts` runs in the `server` (node) Vitest project;
`*.svelte.spec.ts` runs in the `client` (headless browser) project. The `client` project exists
for the rare component with real logic worth pinning; it is opt-in and never the default.

**Rationale**: "TDD, but don't overdo it" resolved by scoping to silent wrongness. Red-green
where a wrong answer costs money and nobody notices; nothing imposed where a human looking at
the screen is already the better and faster check.

### VI. Established Patterns Are Binding

Where this codebase has already settled a recurring problem, that solution is the solution.
`CLAUDE.md` is the normative record of these patterns and MUST be followed:

- **Real-time updates use SSE, never polling** — per-domain event emitter, emit after every
  mutating write, `EventSource` opened in `onMount` / closed in `onDestroy`.
- **Detail and create/edit drawers use the shared `Sheet` standard** — the documented header,
  body, sticky footer, and button classes. A user MUST NOT be able to tell which feature they
  are in from the drawer chrome alone.
- **Every record is a shareable URL** — `/<feature>/[id]` via shallow routing, one shared page
  component and one shared loader per feature.
- **Cross-feature references use the relation-card contract** — shared `related-link` class,
  trailing chevron, deep-link navigation.
- Deviating from a documented pattern requires either amending `CLAUDE.md` in the same change
  or recording the exception and its justification in the plan's Complexity Tracking table.

**Rationale**: Consistency is the cheapest quality mechanism available. A second way to do a
solved thing costs more than the first way ever saved.

### VII. Plain Language for a Non-Expert Reader

Everything written for a human to read — specifications, plans, clarification questions,
recommendations, UI labels, error messages, commit and PR descriptions — MUST be readable by
someone who does not know the domain. The maintainer is not an accountant and is learning the
domain alongside the product; a document he cannot check is a document that cannot be reviewed,
and an unreviewed specification silently encodes whatever the author assumed.

- **In prose, prefer the everyday word.** "What the business owes" over "liabilities". "Money a
  partner takes out" over "drawings". "Add up from the movements" over "derive from the ledger".
  Name the accounting term once beside it, because that is the word the screen uses.
- **A UI label is the exception, and it takes the accounting term.** Every label, column
  heading, tab, report title, field name, status chip and record-kind name in the product MUST
  use the standard accounting word — Revenue, Expenses, Assets, Liabilities, Equity, Accounts
  receivable, Accounts payable, Contributions, Drawings, Net profit, Journal entry, Opening
  balance, Outstanding. Invented plain-language substitutes MUST NOT be used, however much
  easier they read: not "Money in and out" for Profit & Loss, not "What it is worth" for the
  Balance Sheet, not "Still owed to people" for outstanding payables, not "money in" / "money
  out" / "earned" anywhere. `004-standardize-chart-accounts` FR-004 fixes this for the chart and
  the reports; the same rule holds on every screen.
  - **The teaching moves to the sub-line, not the heading.** "Liabilities" as the heading with
    "What the business owes" as its sub-line — never the sub-line promoted to the heading.
  - **An exported file MUST carry the same words as the screen it came from.** A CSV header and
    its column on screen are one label in two places.
  - **Where the accounting term is genuinely ambiguous to a reader, take the plainer
    *accounting* term, not an invented one** — "From account" / "To account" on the transaction
    form rather than "Debit" / "Credit", which a bank statement labels the opposite way round.
- **A formal term in prose is allowed only when it is the term that must appear** — on a
  statutory filing, in a regulation, or in an established product convention. Pair it with its
  plain meaning once, at first use, and then use it consistently.
- **A document that needs more than a handful of domain terms MUST carry a short glossary
  table near the top**, giving each term's plain meaning in one line. `spec.md` for
  `002-double-entry-ledger` is the reference example.
- **Explain the "why", not just the rule.** A requirement a reader cannot evaluate is one they
  cannot disagree with, and agreement obtained that way is worthless.
- **When recommending a decision, state the tradeoff in plain terms and name what is given up.**
  Present the honest comparison, not only the preferred option.
- **This governs prose, not identifiers.** Code, schema and type names follow Principle IV and
  the domain's own vocabulary; renaming a correct technical identifier to something chattier is
  a violation of IV, not compliance with VII.
- **Correct, do not simplify away.** Plain wording MUST NOT drop a constraint, soften a MUST,
  or make a requirement untestable. If a sentence cannot be made plainer without losing
  precision, keep the precision and add the plain-language gloss beside it.

**Rationale**: A specification is a shared agreement, and an agreement only one party can read
is not shared. The cost of jargon here is not style — it is decisions approved without being
understood, and rework when the misunderstanding surfaces during implementation.

A screen is not a specification, and the cost runs the other way. Its figures are read next to a
bank statement, an invoice, a tax return and an accountant's question, all of which use the
accounting word. A product that renames the concepts makes the reader translate twice, and gives
them a number they cannot check against anything outside the app. The plain word teaches the
term once, in the sub-line; the label carries the term itself.

## Technology & Platform Constraints

The following are fixed and MUST NOT change without a MAJOR amendment:

- **Framework**: SvelteKit 2 with Svelte 5 runes (`$state`, `$derived`, `$effect`). New
  components use runes; legacy reactive syntax is not introduced.
- **Runtime & tooling**: Bun; Vite; TypeScript in strict mode; `@sveltejs/adapter-node` for
  the server build.
- **Database**: SQLite accessed exclusively through Drizzle ORM. Schema changes go through
  `drizzle-kit generate` with the migration committed alongside the schema change — never a
  hand-edited or hand-applied schema mutation.
- **PWA**: `vite-plugin-pwa`; the app MUST remain installable with a valid manifest and icons.
- **Styling**: Tailwind 4 plus the shared classes in `src/routes/layout.css`;
  `bits-ui` primitives for interactive components.
- **Auth**: Argon2 password hashing with server-side sessions.
- **Logging**: structured logging via `pino`. Financial amounts, credentials, and provider API
  keys MUST NOT be logged.

Server-only code MUST live under `$lib/server/**`. When a client component needs a rule that
also exists server-side, hand-duplicate the specific function with a
`// Mirrors src/lib/server/<file>.ts's <fn> — ...` comment; do not relax the boundary.

## Development Workflow & Quality Gates

- **Live-session verification is out of scope for agent work.** No driving the running app or
  dev server, no logging in as a user, no reading `.env` for credentials. Behavioral and visual
  confirmation of the UI belongs to the user. This restricts *how the running application is
  exercised* — it does not restrict the test suite: running `bun run test` is expected, and the
  `client` Vitest project may use its headless browser provider under Principle V.
- **Gates before a change is considered done**: `bun run check` (svelte-check),
  `bun run lint` (Prettier + ESLint), and `bun run test` MUST all pass. Formatting is settled
  by `bun run format` — style is never a review topic.
- **Testing discipline is governed by Principle V.** In-scope logic is developed test-first;
  every bug fix ships with a test that failed before it. Outside that scope no tests are
  required, and no coverage target exists to manufacture them.
- **Every mutation carries its obligations**: permission check, Zod validation, audit record,
  SSE emit. A change that adds a mutating endpoint without all four is incomplete.
- **Migrations are additive and reversible in intent.** Destructive schema changes MUST state
  their data-migration path, because users self-host and cannot be migrated for.
- **Feature work follows the spec-kit flow** (`/speckit-specify` → `/speckit-plan` →
  `/speckit-tasks` → `/speckit-implement`). The plan's Constitution Check gate MUST be
  completed before Phase 0 research and re-checked after Phase 1 design.

## Governance

This constitution supersedes other practices and conventions. Where it conflicts with a habit,
an older document, or an agent's default behavior, this document wins. `CLAUDE.md` is
subordinate to it and holds the operational detail of Principle VI; where the two disagree, this
constitution governs and `CLAUDE.md` MUST be corrected.

**Amendment procedure**

1. Propose the change with its rationale and the concrete problem it solves.
2. Assess impact on `.specify/templates/*` and `CLAUDE.md`; update them in the same change.
3. Record the version bump and a Sync Impact Report in this file's header comment.

**Versioning policy** (semantic):

- **MAJOR** — a principle or fixed constraint is removed or redefined incompatibly
  (e.g. replacing SQLite, dropping a target surface).
- **MINOR** — a principle or section is added, or existing guidance is materially expanded.
- **PATCH** — clarifications, wording, and non-semantic refinements.

**Compliance review**

Every plan MUST pass the Constitution Check gate. Any violation that is genuinely necessary
MUST be recorded in the plan's Complexity Tracking table with the simpler alternative and why
it was rejected — an unjustified violation blocks the plan. Reviewers verify the four mutation
obligations (permission, validation, audit, SSE) and adherence to the Principle VI patterns on
every change that touches a route or a detail sheet. On any change presented as a bug fix,
reviewers verify the accompanying failing-then-passing test required by Principle V. On any
specification, plan, or change to user-facing copy, reviewers verify Principle VII: in a
document, no unexplained domain term and a glossary where it needs more than a few; on a screen,
the standard accounting label with the plain wording beneath it, and the same words in any export
of that screen.

**Version**: 3.0.0 | **Ratified**: 2026-08-10 | **Last Amended**: 2026-11-04
