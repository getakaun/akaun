# Akaun Web — Claude Code Notes

## Verification Policy

Do not test the UI in a browser. Do not start the dev server to check your work. Do not
read `.env` to get login details. Check your work by reading code only: read the diff, run
`bun run check` and `bun run lint`, and think about correctness. The user does all visual
and behaviour checks.

**`data/` is real. Never write a script that touches it.** `DATABASE_PATH` and
`STORAGE_PATH` are relative to the working directory, and `.env` sets them to
`./data/akaun.db` and `./data/storage`. Any process that starts in the project root
therefore writes to the maintainer's real books and receipts. If you set these two
variables inside your own script, the script is still not safe. This once deleted a real
`data/` directory and needed a full restore. A running dev server then did the same damage
a second time.

Before you do anything that can run application code:

1. **Look for a dev server**: `ps aux | grep "vite dev"`. `createDb()` in
   `db/client.ts` runs `upgradeDatabaseFile` at module load, so **the first start against an
   unconverted book converts it** and leaves the previous database family in
   `data/pre-chart-<stamp>/`. This is by design (002 FR-037: the installation upgrades
   itself, with no command and no setting). It happens on any start, including one your edits
   cause. If you do not want it now, stop the server before you edit, not after.
2. **The conversion takes its path as an argument**: `upgradeDatabaseFile({ databasePath })`
   in `db/auto-upgrade.ts`. A test must give its own path — `db/auto-upgrade.spec.ts` builds a
   fixture under `os.tmpdir()`. A temporary `DATABASE_PATH` is not enough on its own, because
   anything that imports `db/client.ts` reads the real one. This caused the first accident.
3. **Hash `data/akaun.db` before and after** each step you are not sure about. The check is
   cheap and the answer is clear. To read the real book, copy the whole family
   (`.db`, `-wal`, `-shm`) somewhere else and query the copy: a read-write connection sets
   `journal_mode` and checkpoints the WAL on close, which rewrites the file even when nothing
   logically changed.

## Delegation

**Use subagents often, to keep the main context window clean.** Give a subagent each task
that reads many files but returns a short answer: find code, search for a pattern, check
how a convention is used, or summarize a long file. The file contents then stay in the
subagent, and only the result comes back. Keep decisions and edits in the main thread. Keep
search output out of it.

**Give more resources to a difficult task.** Use a stronger model, more reasoning effort, an
instruction to be thorough, or several agents in parallel on separate parts. A weak agent
on a hard task returns a wrong answer, and the work must then be done again. That costs
more context than doing it correctly one time.

## Architecture Decisions

### Real-Time Updates: SSE-Only

Use **Server-Sent Events (SSE)** for all live UI updates. Do not poll. Polling wastes
requests and is slower, and the client code is simpler with SSE.

**Pattern**
- Add a `GET` endpoint at `src/routes/api/<feature>/stream/+server.ts`. It returns a
  `ReadableStream` with `Content-Type: text/event-stream`.
- Copy the singleton `importEvents` EventEmitter (`src/lib/server/import/events.ts`). Make
  one `<feature>Events` emitter for each domain.
- Each server action that changes state (POST, PATCH, DELETE) must call `events.emit(...)`
  after the DB write. All connected clients then see the change.
- In the client, open the EventSource in `onMount` and close it in `onDestroy`. Never do
  this in `$effect`: `$effect` runs again when a dependency changes, and it would close the
  connection.

**Client merge pattern** — `mergeServerJobs` on the import page is the reference:
- The stream sends a full snapshot when the client connects.
- Each later event is one change (`item-update`, `item-deleted`, and so on).
- Merge like `mergeServerJobs`: update the items you have, and add new items from other tabs
  at the start of the list.
- Do not add an item to local `$state` from the upload or create action. Let the SSE event
  add it. This removes the race between the fetch response and the SSE event.
- Do not put a `File` or a `Blob` in Svelte 5 `$state`. Keep such objects in a plain `Map`
  next to the reactive array.

**Snapshot or no snapshot**
- Import queue: send a full snapshot on connect. The set of active jobs is small, so a
  reconnect catches up by itself.
- Paginated lists (records, accounts): send **no** snapshot. SSR gives the first
  state, and SSE gives only the changes. If the connection stops, `EventSource` reconnects
  and the next event corrects the item. A page reload gets the correct state.

### The Ledger: One Record Store, Two Sides

Each record says where the money came from and where it went. `ledger_records` holds what
happened. `ledger_movements` holds each side of it, against an account in `accounts`.
Expenses and Income are **filtered views of this one store**. They have no tables of their
own.

- **Money is whole cents in a signed integer column** (`amount_minor`). Never do float
  arithmetic on money. A record also keeps the decimal `amount` that the user typed and the
  `exchange_rate` at that time. These two values are for display and audit only — **never
  add the decimal `amount` into a report total**. `ledger/money.ts` is the only converter.
- **A movement is positive when value goes INTO the account and negative when value leaves
  it. The movements of one record always add up to zero.** Money you owe, income and owner
  capital therefore have negative balances. `displaySign` in `ledger/account-type.ts`
  changes the sign for display, in **one** place. Do not change a sign anywhere else. A CSV
  export must show the same signs as the screen it comes from.
- **Build movements only in `ledger/entry-builder.ts`.** Screens describe the event in
  simple terms (`kind: 'expense'`, `paidFromAccountId`), and the builder makes the two
  sides. The builder is the only place that enforces the zero-sum rule. A route or a service
  that builds its own movements is a defect.
- **Payment state is never stored.** `paid`, `outstandingMinor`, `locked`, a contact balance
  and each account balance are calculated from the movements and the settlements. Two
  screens can then never show different values. There is no status column.
- **A category is an account**, with the role `ExpenseCategory` or `IncomeCategory`. The
  screens keep the word "category". The `categories` table is deprecated and nothing reads
  it.
- **Accounts have no hierarchy.** `parentId` (002/004: a user-built heading tree with
  rollups, one account per heading) predates `subType` (005: a fixed classification enum —
  Cash/Bank/Receivable/... — used only to bucket a report's Current/Non-current or
  COGS/Operating/Other lines). No real chart ever used `parentId`, and the two were never
  substitutes for each other, so it was removed outright — the column, the eligibility rule
  that blocked postings to a "heading", and the recursive rollup/depth code in the balance
  sheet and P&L, which are flat maps now. Report grouping is `subType` alone
  (`assetBucket`/`liabilityBucket`/`expenseBucket`/`revenueBucket` in
  `ledger/account-type.ts`). Do not reintroduce a parent/child concept for accounts.
- **One emitter for all record kinds**: `ledgerEvents` (`record-update`, `record-deleted`,
  `settlement-changed`), plus `accountEvents`. Both are in
  `$lib/server/ledger/events.ts`. One list of every kind means one stream too:
  `/api/records/stream` forwards everything the emitter carries with **no kind filter**, and
  the per-kind stream URLs retired with the screens they fed. With three emitters, a forgotten
  emit was silent; with per-kind filters, a record that was neither an expense nor an income
  appeared on no list until the page was reloaded.
- **`ledger/types.ts` is a frozen interface.** A change there is a change for every caller.
  Do not make such a change quietly.

**Which screen an account appears on.** One rule, and it is the balance-sheet /
income-statement line every accounting system draws: things with a balance a reader looks for
are **accounts** (`/accounts`); what money was earned and spent *on* is a **category**
(`/categories`). `ACCOUNT_ROLES` and `CATEGORY_ROLES` in
`components/accounts/account-roles.ts` are the one place that split is written.

Both are rows in `accounts` and both go through `accountsActions` — a category is an account
underneath, because double-entry needs both sides of a record to name one (002 FR-006a). Only
the screen differs, and it differs because a flat list of all of them failed in practice: a
real installation had 22 categories against 4 accounts that hold or owe money, so the list
read as nothing but categories. Equipment sits with the accounts (bought and kept, so it is on
the balance sheet — 002 FR-006b) even though the record form offers it beside the categories.

**The three ledgers.** `accounts` holds two of the books real bookkeeping keeps apart, and
`contacts` holds the third:

| Book | Where it lives | Shown on |
|---|---|---|
| What money was for | `accounts`, roles `ExpenseCategory` / `IncomeCategory` / `Equipment` | Accounts › Categories |
| Where money sits, and what is owed either way | `accounts`, the money-pot, Receivable/Payable, opening-balance and partner roles | Accounts › Money & owed |
| Who owes whom | `contacts` + the contact on each record | Contacts, and `/records?contact=` |

The third is the purchase and sales ledger. Real bookkeeping gives every supplier and customer
its own account behind a control account; here it is **derived from the movements** instead, so
adding a contact never touches the chart of accounts (002 FR-008a) and the per-contact figures
can never disagree with the ledger. **`contactBalances()` in `queries/settlements.ts` is its one
source** — do not add a second way to total what a contact owes.

A category is an account and a contact is not, and both are deliberate. See 002 FR-006a and
FR-008a before proposing either change; the reasoning, including why per-contact accounts make
the account list worse, is recorded there.

**Every kind has one list and one deep link.** Expense, Income, Payment, Transfer, OpeningBalance,
InvoiceIssue and Journal records all appear on the one Records screen and all open at
`/records/[id]`.

This replaced a named exception, and the reason it existed is worth keeping: Expense, Income and
Journal each had a list screen and a deep link, and the other four deliberately had neither, because
"a user does not look for these records by themselves". Each was reached from the record it belonged
to — a payment from the expense it settled, a transfer from either account's history, an opening
balance from its account's drawer. That was true while there were three screens; it stopped being
true when there was one list of everything that happened.

Result to remember: `canOpen` in `SettlementList.svelte` now returns true for every kind. It is kept
as a function rather than inlined, because it is still the one place to change if a kind ever stops
being openable.

**Reports (`/reports/*`) are full pages.** They are wide tables that the user reads column by
column and exports. This used to be a named exception to a drawer-only rule; it is now simply the
rule — see § Detail Page Standard.

`/accounts/[id]/history` is **gone**. An account's movements are the Records list narrowed to that
account: `/records?account=<id>`, with a running balance, an opening figure before the first row and
a closing figure after the last. It is the same rows read the same way, so it is one screen with a
filter on it rather than a page of its own. The account page at `/accounts/[id]` links to it with a
relation card. The running balance disappears the moment another filter is applied or the sort
changes, and the screen says why — a balance over a filtered subset would look like a bank balance
and not be one.

### Permissions (RBAC)

Gate every action on a resource with `hasPermission(locals, resource, action)`
(`src/lib/server/permissions.ts`). Never use a role check, and never rely on a hidden button
in the client.

- `ResourceName` is a closed union (`dashboard`, `records`, `import`, `contacts`,
  `quotations`, `invoices`, `reconciliation`, `accounts`, `reports`, `adjustments`).
  `ActionName` is `view | add | change | delete`. To add a resource, add it to
  `ResourceName` and `ALL_RESOURCES` in `permissions.ts` — `ALL_RESOURCES` duplicates the
  union rather than deriving from it, so both must change together.
- `records` is one ability over every kind of record. It replaced `expenses` + `income`, which
  were two names for one store: a transfer, a payment or an opening balance was checked
  against whichever screen it happened to be recorded from, and a record entered by hand was
  covered by neither.
- Two resources have extra rules. `reports` is **view-only**: never grant `add`, `change` or
  `delete` on it anywhere, because to see a figure is not the same as to change it. **No
  seeded group grants `adjustments`** (formerly `journal`): it allows a record between any two
  accounts and a third side, so a user who has it can make the books say anything and still
  have them add up. Grant it on purpose or not at all.
- `adjustments` is checked **after** the derivation, never before: whether a record needs it is
  a fact about the accounts it names, not about what the client sent. Enforced on the server
  (`sides-from-accounts.ts`), never by hiding a control.
- `hooks.server.ts` calls `getEffectivePermissions(db, userId)` one time for each request and
  puts the result in `locals.permissions` and `locals.isSuperuser`. Route code never queries
  permissions. It only calls `hasPermission`.
- The effective permissions are the group permissions (`groupPermissions`) plus the per-user
  overrides (`userPermissions`). An override can only add a permission, never remove one. A
  group with `isSuperuser: true` passes all checks, because `hasPermission` returns early on
  `locals.isSuperuser`.
- Each API route that reads or changes a resource must call `hasPermission(locals, resource,
  action)` and return `403` if it fails. `src/routes/api/records/+server.ts` is the reference:
  `view` for GET, and `add`, `change` or `delete` for the other verbs.

### Authorized Operations (`src/lib/server/application/`)

A write that both a REST route and an MCP tool can make is **one function** in
`application/<domain>.ts`, taking `(ctx: AppContext, input)` and returning an `AppResult`. It asks
for every permission itself (`requirePermissions`) and enforces every rule a route used to hold —
the adjustments gate, sealed sent documents, a payment and its settlements in one transaction. The
route parses and calls `toResponse`; the MCP tool calls `registerWrite`. A rule written in the
route alone is a hole the MCP tool walks through. That is how the explicit-journal and
invoice-issue gaps existed.

- **Nothing under `application/` imports `db/client.ts` or opens storage by default.** The database,
  `locals`, `store` and `storageRoot` arrive in the context. A file helper is always called with
  `ctx.storageRoot`, never its `STORAGE_PATH` default. `scripts/mcp-test-preload.ts` makes
  `db/client.ts` throw and points `$env` at a temp folder, so a spec that breaks this rule fails
  instead of touching `data/`.
- **Every update/delete takes an optional `expectedVersion`** (`application/version.ts`: a hash
  of the row and its children, never `updatedAt`). MCP tools require it; REST may omit it.
- **Each MCP tool has one entry in `mcp/tool-requirements.ts`** (OAuth scopes + RBAC). Discovery,
  the call-time check and the `insufficient_scope` challenge all read that table, and a spec fails
  when a registered tool is missing from it.
- **Deliberate exception:** import confirm needs only `import.change`, not `records.add` (006
  FR-045). Do not "fix" it.

### Settings Page Patterns

The Settings page (`src/routes/(app)/settings/+page.svelte`) has two patterns. Use them
again on other pages with many fields or with editable lists.

- **Unsaved-changes guard**: an `isDirty` `$derived` compares the live `$state` with the
  snapshot from the server. While the page is dirty, `beforeNavigate` stops in-app
  navigation and opens `ConfirmDialog` (`unsavedConfirmOpen`).
- **Stage locally, save one time**: an edit to a list (providers, categories, company logo)
  changes local `$state` only. Nothing goes to the DB until the single Save action runs.
  Mark a new row, so you can tell it from a saved row without a request to the server. The
  Category tab stages *account* rows and gives a new one `id: null`. The server then
  compares the staged list with the saved list and creates, renames or drops each row. A
  dropped category that has records is **archived, not deleted**, so its history stays.

### Detail Page Standard

**Read and edit one record on a page.**

That covers every screen, including the surfaces that used to be named exceptions: reports and the
reconcile workspaces were already pages because they were already things you read and work in.

**Create a new one in a drawer, unless the form has outgrown 500px.** Records, Payments, Invoices
and Quotations create on a full page too — each has either a dynamic, repeating section (extra
ledger lines, settlement allocations, invoice/quotation line items) or attachments, none of which a
drawer holds well — and a successful save on one of these pages navigates to the new record's own
page rather than staying on the list. Account, Opening Balance, Contact and the reconciliation
Transfer sheet stay as drawers: a handful of static fields fit 500px fine, and turning a three-field
form into a page would only add a round trip. A create page reuses the same `DetailPage` frame as
the detail page it hands off to (`hero`/`main`/`rail` snippets, the built-in unsaved-changes guard),
with `record={null}` (or the entity's equivalent) — see `records/RecordCreate.svelte` and
`ledger/RecordForm.svelte`'s create/edit split for the reference shape, mirrored by `PaymentForm`,
and `sales/SalesDocForm.svelte` (one form for invoices and quotations, `kind` prop; a sent invoice
renders its amount fields read-only). Each create page's loader gates
on `add`, not `view`, and redirects rather than rendering a form that would 403 on submit.

Every detail page is built on `DetailPage.svelte` (`$lib/components/ui`), which supplies the frame:
a topbar with `BackLink`, a hero, a two-column body (`.detail-grid` — the record on the left, a
`320px` rail of everything it touches on the right, collapsing to one column below `1100px`), and a
sticky save bar that appears only when the page is dirty. **A user must not be able to tell the
feature from the frame alone** — that requirement is unchanged; only the frame that carries it is.

References: `records/RecordDetail.svelte`, `accounts/AccountDetail.svelte`,
`contacts/ContactDetail.svelte`, `invoices/InvoiceDetail.svelte`,
`quotations/QuotationDetail.svelte`.

**Why this replaced the drawer standard.** The old rule was deliberate and had survived two
re-litigations (`specs/002/plan.md:276`, `specs/003/plan.md:305`), so the reason it was dropped
matters: the app had no read view for anything. Clicking a row opened the *form that edits the
record*, not the record. A drawer is 500px, a form fits in 500px, so "detail" quietly became "form"
everywhere. Both failure modes were visible at once — `AccountSheet` had shrunk to three fields
with its balance, movements and reconciliation links dropped (and its loader still computing data
for cards that no longer rendered), while `RecordSheet` was fifteen sections and ~2000px of scroll
in a 456px column, with the amount and status scrolling out of view before the first field.

**What survives from the old standard, unchanged:**

- **Every record keeps a real, shareable URL** — `/records/[id]`, `/accounts/[id]` and so on. That
  guarantee was the point of the deep-link rules; only the mechanism changed.
- **Mobile.** It already worked this way: the record sheet was `height:100dvh; border-radius:0` on
  a phone, which is a page wearing a drawer's clothes.
- **The `Sheet` spec below**, for create drawers.

**Editing in place.** Detail pages use the Settings page's pattern (§ Settings Page Patterns): an
`isDirty` `$derived` against the server snapshot, a save bar that appears only when dirty, and
`beforeNavigate` + `ConfirmDialog` guarding a navigation that would drop the edits. Fields render
read-only when `!canChange` or when the record is `locked` — the same conditions the drawer applied.

**Going back.** `BackLink.svelte` calls `history.back()` whenever `afterNavigate` says there is any
real previous in-app entry, and falls back to `goto(href)` only when there is not (a fresh load, a
reload, or a pasted link). It does not require that entry to be the list: a hop from a relation card
— an account, a contact, another record — leaves a real, useful entry underneath, and browser
history already knows what it is. The branch is load-bearing when the previous entry *is* the list:
the list's filters live in the address bar and its scroll position lives in the history entry, so
`history.back()` restores both and `goto` restores neither. `history.length` is not a usable signal
— it counts the whole tab session. The button's label falls back to a generic "Back" when we trust
history but don't actually know the previous page's name (i.e. it isn't `href`).

**Rows are real links.** The primary cell of a list row is an `<a href>` (class `row-link`), with
the row's `onclick` bailing out when the event came from inside an anchor. That gives hover
preloading (`data-sveltekit-preload-data` in `app.html` does nothing for a `<tr onclick>`), plus
Cmd-click and middle-click — which the drawer never supported.

**Loaders are split.** `/<feature>` calls `load<Feature>Page(locals)` and `/<feature>/[id]` calls
`load<Feature>Detail(locals, id)`. Do not go back to one loader serving both: that is what made a
deep link to a single record load a thousand rows and then *redirect away* from any record outside
them. A missing id redirects to the list rather than throwing — there is no `+error.svelte` in the
app shell to land on.

**Drawers for creating.** Below is the `Sheet` spec, which still governs every create drawer that
remains one: `AccountSheet`, `OpeningBalanceSheet`, the contact create form, and the reconciliation
Transfer sheet in `StatementMatch.svelte`. Records, Payments, Invoices and Quotations moved to a
full create page instead — see the carve-out above.

**Do not add `<Sheet.Portal>` or `<Sheet.Overlay>` around `<Sheet.Content>`.** `sheet-content.svelte`
already renders both. Every caller used to add its own, so each open drawer painted two `bg-black/35`
overlays and dimmed the app to ~0.58 instead of 0.35.

**Shell**
- Desktop: the sheet comes in from the right. `width: 500px; max-width: 95vw`.
- Always put `gap:0;` in the inline `style=` of `Sheet.Content`. The base
  `sheet-content.svelte` has a Tailwind `gap-4` (16px) flex gap between its children. The
  header, body and footer set their own padding, so this gap only adds empty space above the
  first field or the amount.
- Mobile: the sheet comes up from the bottom (`panelSide = isMobile ? 'bottom' : 'right'`).
  - A full-view sheet (record detail or edit, `height: 100dvh`) gets **square** corners. It
    covers the whole screen, so a radius looks like a fault.
  - A part-height sheet, such as a filter panel, keeps **rounded** top corners
    (`16px 16px 0 0`).

**Header** (`padding: 22px 22px 16px`, border at the bottom)
- Left: `.sheet-eyebrow` (a small grey label or icon) and `.sheet-title-text`.
- Right: the close button **only** (`Sheet.Close` with class `sheet-close` and the `X` icon,
  size 16). Never put a menu, a status badge or another action here. These go in the body or
  in the footer.

**Body** (`padding: 20px 22px`, scrollable, `flex: 1`)
- Forms use the `.field` and `.field-label` classes.
- A create drawer carries fields and nothing else. The amount hero, the status badge, the
  attachments and the audit trail belong to the detail **page** — a thing that does not exist yet
  has no attachments and no history.
- On a detail page, `AttachmentManager.svelte` and `<AuditTrail recordType="..." recordId={...} />`
  go in the rail. Each create, update and delete action must call `recordAudit` or `diffRecords`
  (`src/lib/server/audit.ts`) after the DB write. The client keeps a `bind:this` reference to
  `AuditTrail` and calls `.refresh()` after a successful save, so the trail updates without a
  page reload.

**Footer** (`.sheet-foot`, defined one time in `layout.css` — do not define it again on a
page)
- The footer is sticky. It is *outside* the scrollable body. In a form, the `<form>` element
  is the flex column (`flex:1; display:flex; flex-direction:column; overflow:hidden;`), and
  the scrollable fields div and the `.sheet-foot` are its children.
  `contacts/+page.svelte` is the reference.
- `.sheet-foot-note` is optional: grey 12px text above the buttons, for extra information.
- `.sheet-foot-actions` is a flex row, `gap: 8px`, aligned right. Use the shared button
  classes from `layout.css`:
  - `.sheet-btn` — the plain outline button.
  - `.sheet-btn-delete` — `.sheet-btn` with a gap for the icon. Always the `Trash2` icon
    (size 14) and the label "Delete". It is the first action on the left; use
    `margin-right:auto` to hold it at the far left when Cancel and Save are also there. If a
    relation blocks the delete, set `disabled` and add a `title` tooltip — for example a
    settled or reconciled record, a contact in use, or an account with movements. Do not
    hide the button.
  - `.sheet-btn-primary` — the filled primary button (Save, Record payment, and so on), last
    on the right.
- Delete always uses the shared `ConfirmDialog.svelte` (`danger` prop) and a hidden
  `<form method="POST" action="?/delete">` that you submit with `requestSubmit()`. Never a
  menu in the header.

**Status chips**
- Show each true lifecycle status with `StatusBadge.svelte` — paid, part-paid or owed for a
  record; draft, sent or paid for an invoice. Do not write an inline
  `<span class="statusbadge ...">`. Add a new tone or label to the `byLabel` and `byCode`
  maps in the component.
- A contact role badge is not a lifecycle status. It keeps its own pill style with
  `var(--secondary)`. This difference is deliberate. Do not "fix" it.

### Cross-Feature Relation Cards

A record-detail page often shows a reference to a *different* record — the history of an
account, or the payments that settled an expense. Use one of the two shapes below. **Both
shapes follow the same interaction rules.** A user must not see two references that look the
same but behave differently.

**Two shapes, same rules**
- **Single-record reference** (this record points to one other record) — icon box (`34×34`,
  radius 7, `background: var(--accent)`), title with status, grey second line, chevron at the
  end. Reference: `.ob-card` in `components/accounts/AccountDetail.svelte`.
- **List of many** (this record has many records of another type) — compact row, no icon box,
  main text and grey second line on the left, optional `StatusBadge` or amount, chevron at
  the end. Reference: `components/ledger/SettlementList.svelte`.

**Interaction rules (both shapes)**
- If the card or row has **one** action only (go to the related record), make the whole
  element a `<button type="button">`. Do not use a `<div>` with a link inside it.
- Add the shared `related-link` class next to the layout class. It is defined one time in
  `layout.css` and gives `cursor: pointer` and the hover style
  (`border-color: var(--primary); background: var(--accent);`). Do not write this hover rule
  again per feature.
- End with a `ChevronRight` (size 13–14, `color: var(--muted-foreground)`). It shows the user
  that the element is clickable, also without hover.
- Navigate with the deep-link pattern below. Never render the detail of the other feature
  inside this one.

**Rows with more than one action keep the same hover**
- A row with two or more independent actions also gets the `related-link` class — for example
  `.attach-item` in `AttachmentManager`, which opens a file and deletes it. The row then has
  the same `border-color` and `background` hover as a single-action card.
- Do not add the hover to the elements inside the row. The row hover is enough. Only an
  action with a different result keeps its own hover, such as the destructive hover of the
  delete button.
- **Exception to the `<button onclick={goto(...)}>` rule**: use a real `<a href>` when the
  main action opens a URL outside the app, such as an uploaded file. The browser then gives
  its normal behaviour — the context menu, Ctrl/Cmd-click for a new tab, and middle-click.
  Put everything except the other actions inside the anchor (see `.attach-link-area` in
  `AttachmentManager.svelte`). A `<button>` cannot be inside an `<a>`, so the delete button
  stays outside the anchor as its own click target. Use the `goto()` button only for
  navigation inside the app, where there is no real href.

**Deep-link pattern (each record has a URL the user can share)**

Each record detail has a real path, `/<feature>/[id]`, so a user can copy the URL and send it to
another person. It is a **real route with a real navigation** — no shallow routing, no `pushState`,
no second kind of route. `PageState.viaPush` is retired.

- Each feature has **two routes and two components**: `/<feature>/+page.svelte` renders
  `<Feature>Page.svelte` (the list), and `/<feature>/[id]/+page.svelte` renders
  `<Feature>Detail.svelte` (the page). Their `+page.server.ts` call `load<Feature>Page(locals)` and
  `load<Feature>Detail(locals, id)` respectively — see § Detail Page Standard for why these are
  split.
- **Records is the worked example**: `RecordsPage.svelte` + `RecordDetail.svelte` + `/records` +
  `/records/[id]` + `loaders/records.ts`. It is one screen where there were three — Expenses,
  Income and Journal were three copies of one pattern over one store.
- A row's primary cell is an `<a href={featureHref(id)}>`; the row's `onclick` bails when the
  event came from inside an anchor, so Cmd-click and middle-click behave.
- A button that goes to another feature calls
  `goto(resolve('/(app)/<feature>/[id]', { id: String(targetId) }))` directly, with no query
  string. Example: the "See every movement" card on the account page.
- **Only the detail route needs `actions`** where something still posts a form action — accounts
  (opening balance, deactivate, delete), contacts, invoices and quotations (delete). Records
  writes entirely through `/api/records`, so `/records/[id]` exports no actions at all.
- A create **drawer** that succeeds does **not** navigate. The SSE event puts the new row on the
  list; the user stays where they were. A create **page** (Records, Payments, Invoices,
  Quotations) does the opposite: it navigates to the new record's own page, since staying on
  `/records/new` after saving has nothing to show.

## Tooling

**`docs/` is the public Docusaurus site, not internal notes.** It is a separate Bun package
with its own `package.json` and `bun.lock`, the root ESLint/Prettier ignore it, and
`.github/workflows/docs-publish.yml` deploys it to `<org>/<org>.github.io`. Internal design
notes, plans and release notes live in `dev-notes/`.

**The two Vitest projects need two different runtimes, so `bun run test` runs them one after
the other.**

- The `server` project runs under **Bun** (`bun --bun vitest --project server`). The
  upgrade-conversion spec tests against a real temporary SQLite database, as the constitution
  requires, and that needs `bun:sqlite`.
- The `client` project runs under **Node** (`vitest --project client`). Playwright cannot
  start a browser under Bun. It fails after about one minute with `Failed to connect to the
  browser session … within the timeout`.

`bun run test` runs both. `bun run test:unit` is the Bun one, so add `--project server` when
you use it directly. A server spec under Node fails on `bun:sqlite`, and a client spec under
Bun stops at the browser.

Two more results of the Bun half:

- `vite.config.ts` sets `ssr.noExternal: ['zod']`. If zod stays external, Bun's CJS interop
  gives a namespace with no `z` on it, and **every** spec that imports a schema fails with
  `undefined is not an object (evaluating 'z.object')`. Production is not affected.
- Keep the normal `import { z } from 'zod'`. The fix belongs in the config, not in a hundred
  import statements.

**Prettier needs `.prettierignore` to be usable.** Without it, Prettier reads the whole tree
and reports about 3,900 files. About 3,600 of them are build output under `src-tauri/`, so
`bun run lint` can never pass. Prettier does not read `.gitignore`, so repeat there each path
that git ignores but that is still on the disk. There is still no Prettier config, so
`prettier-plugin-svelte` never loads and Prettier skips all `.svelte` files. The other ~200
failures in `src` are an old mix of tabs and spaces. Fix them as their own chore, not inside
a feature branch.

## Gotchas

**`bun run check` breaks a dev-server tab that is already open.** `check` runs
`svelte-kit sync`, which writes `.svelte-kit/generated/client/nodes/*.js`, `root.js` and
`matchers.js` again. Vite reloads these modules, but a tab that loaded before the change keeps
the old map from route to node. A route index can then load a different page component than
the server rendered. The symptoms do not look like a tooling problem:

- The page is **blank**. The URL is correct, but the `<title>` is wrong, or it is the
  root-layout title.
- The console shows an error from a component that you did not open — for example
  `ReportsPage.svelte:203 Cannot read properties of undefined (reading 'length')`, because
  `ReportsPage` got the data of another route.
- Before that error, the console shows `Failed to hydrate: HierarchyRequestError: Failed to
  execute 'appendChild' on 'Node'`, because the SSR HTML is for the route you asked for.

You can repeat this at any time: open a page, run `bunx svelte-kit sync`, and watch it break.
**A reload does not repair it** — the browser keeps the modules of the old optimizer hash. To
repair: stop the dev server, `rm -rf node_modules/.vite`, start the server, reload the page.
The app code is correct, so do not look for a bug in the component that the stack trace
names.

Rule: run `bun run check` when no dev client is open. If you cannot, expect to restart the
dev server after it.

**`$lib/server` cannot be imported in the client.** SvelteKit blocks each `$lib/server/*`
import in a `.svelte` file at build time. Some rules are needed on both sides: the record
lock (`ledger/locking.ts`), the display sign (`ledger/account-type.ts`), the derived paid
state (`ledger/settlement-rules.ts`), and the balance rule the record form shows live as extra
sides are added (`ledger/entry-builder.ts`). These rules are copied by hand into client files.
Each copy has a comment that explains the rule:
`// Mirrors src/lib/server/<file>.ts's <fnName> — ...`. See:

- `components/accounts/display-sign.ts` and `components/accounts/account-roles.ts` — **both
  deleted.** The display sign and the role groupings went with the six role headings when the
  chart became five fixed types; nothing mirrors them any more.
- `components/ledger/record-status.ts` — the derived paid state, and the cleared label.
- `components/ledger/journal-rules.ts` — the balance rule. It moved here from
  `components/journal/` when the Journal screen was folded into Records; the form that shows a
  running difference live is now `RecordSheet.svelte`.
- `components/ledger/account-kinds.ts` — which side of a record is a place money sits and which
  says what the money was *for*. Mirrors `isMoneyPotAccount` / `isCategoryAccount` in
  `ledger/account-type.ts`. It needs `MovementView.accountRole`, which is carried beside
  `accountType` for exactly this: **`type === Asset` is not the same question as "holds money"**,
  because equipment is an asset the record form offers beside the categories (002 FR-006b).
  Reading the type alone made a laptop purchase look like moving cash between two pots, so it
  derived to no everyday kind and demanded the `adjustments` ability no seeded group grants. The
  same split is applied on the server in `loaders/records.ts`, `queries/dashboard.ts`,
  `import/category-accounts.ts`, `settings/+page.server.ts` and `import/+page.server.ts` — always
  through those two functions, never a type list.

Keep the two copies the same by hand. No import enforces this, and any new client mirror needs
its own `// Mirrors …` comment.

Better: do not make a copy. `GET /api/records` already returns `paid`, `outstandingMinor`,
`locked` and `lockedReason` from the server, so a screen that only displays these values
needs no copy of the rule. Copy a rule only when it must run before a request to the server.
