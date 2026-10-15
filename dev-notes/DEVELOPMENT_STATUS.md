# Akaun Web — Development Status

> Reference: [`DEVELOPMENT_PLAN.md`](./DEVELOPMENT_PLAN.md)  
> Last updated: 2026-06-26

---

## Phase 1 — Foundation ✅ Complete

All planned tables are present in `src/lib/server/db/schema.ts`. Additional tables beyond the plan:

- `exchangeRates` — historical rate cache for multi-currency support
- `contacts`, `contactRoles`, `contactSearchText` — full contacts module (see Beyond Plan)
- `userPermissions` — per-user permission overrides (in addition to group permissions)
- `userPreferences`, `userNavPreferences` — per-user KV and nav-order preferences

`client.ts` includes two startup utilities not in the plan:
- `ensureDefaultAdmin()` — creates the `admin` user on first boot if absent
- `ensureGroupSeed()` — seeds the four default groups and assigns ungrouped users to Administrators

**Drizzle migrations** (`drizzle/`):
- `0000_rich_post.sql` — full baseline schema
- `0001_magical_rick_jones.sql` — adds `user_preferences` table

**Server utilities** — all planned files exist plus:
- `logger.ts` — pino-based structured logger (`createLogger(name)`)
- `rate-limit.ts` — in-memory token bucket (used by login)
- `date.ts` — date utilities
- `currency/` — exchange rate provider, DB caching, form helpers (Frankfurter API)
- `navPreferences.ts`, `userPreferences.ts` — per-user preference helpers
- `loaders/` — shared SvelteKit load-function helpers per resource
- `services/` — thin event-emitting service layer wrapping queries

---

## Phase 2 — Authentication ✅ Complete

- **`hooks.server.ts`**: Bearer token + session-cookie auth, CSRF origin check for mutating API calls with cookie auth, security headers (CSP, `X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`)
- **Login page**: argon2 verification, per-IP+username rate limiting (5 attempts / 15 min), show/hide password, progressive enhancement via `enhance`
- **Logout**: `POST /logout` deletes session row and clears cookie
- **Sessions**: 30-day expiry; `auth.ts` sweeps expired rows on each session lookup
- **`scripts/create-admin.ts`**: CLI to create additional admin users (username + password; slightly different from the email-based approach in the plan)
- **macOS Akaun migration scripts**: removed once the one-time migration was complete; recoverable from git history if ever needed again *(not in plan)*

---

## Phase 2.5 — User Management & Permissions ✅ Complete

- `permissions.ts`: `getEffectivePermissions` (superuser short-circuit + group union), `hasPermission`. Resources covered: `dashboard`, `expenses`, `income`, `claims`, `import`, `contacts`, `users`, `groups`, `settings`
- **User-level permission overrides** (beyond plan): individual users can have per-resource overrides in `userPermissions`, managed via `/api/users/[id]/permissions`
- Bearer tokens prefixed `akn_`, with regenerate/revoke actions
- Seed groups: Administrators (is_superuser), Bookkeeper, Data Entry, Reviewer

**API endpoints** — all planned, fully implemented:

| Endpoint | Methods |
|---|---|
| `/api/users` | GET, POST |
| `/api/users/[id]` | GET, PATCH, DELETE |
| `/api/users/[id]/groups` | GET, PATCH |
| `/api/users/[id]/permissions` | GET, PATCH *(beyond plan)* |
| `/api/groups` | GET, POST |
| `/api/groups/[id]` | GET, PATCH, DELETE |
| `/api/groups/[id]/permissions` | GET, PATCH |

**UI**: `/users-groups` — single admin page (not separate sub-routes), superuser-only.

---

## Phase 3 — Core CRUD API ✅ Complete

All planned endpoints are live. Every resource also has an SSE stream endpoint (see [Real-Time Updates](#real-time-updates) below).

| Resource | Endpoints |
|---|---|
| Expenses | `GET/POST /api/expenses`, `GET/PATCH/DELETE /api/expenses/[id]`, attachment POST/DELETE, SSE `/api/expenses/stream` |
| Income | `GET/POST /api/income`, `GET/PATCH/DELETE /api/income/[id]`, attachment POST/DELETE, SSE `/api/income/stream` |
| Claims | `GET/POST /api/claims`, `GET/PATCH/DELETE /api/claims/[id]`, attachment POST/DELETE, SSE `/api/claims/stream` |
| Settings | `GET/PATCH /api/settings` |
| Contacts | Full API — see [Beyond Plan](#beyond-plan-features) |

**Additional endpoints not in plan:**
- `/api/records/[id]/attachments/[attachmentId]`, `/api/reconciliation/statements/[statementId]/file`, `/api/company/[image]` — serve stored files by id, each behind its own permission (replaced `/api/files/[...path]`)
- `/api/exchange-rate` — live rate lookup from Frankfurter API, used by forms
- `/api/dashboard/stream` — SSE stream that emits `data-changed` across income/expense/claim events

---

## Phase 4 — Web UI ✅ Complete

All planned pages implemented under the `(app)/` layout group. **Structural deviation**: Settings is a single tabbed page at `/settings` (tabs: General, Intelligence, Categories, Advanced) rather than the planned sub-routes.

**Page routes:**

| Route | Notes |
|---|---|
| `/dashboard` | Charts: BarChart, DonutChart, TrendBars (Chart.js) |
| `/expenses`, `/expenses/[id]` | Deep-link pattern |
| `/income`, `/income/[id]` | Deep-link pattern |
| `/claims`, `/claims/[id]` | Deep-link pattern |
| `/import` | Import queue UI with SSE |
| `/settings` | Single page, 4 client-side tabs |
| `/users-groups` | Superuser-only admin page |
| `/contacts`, `/contacts/[id]` | *Beyond plan* — deep-link pattern |
| `/profile` | *Beyond plan* — logged-in user's own details |

**Component library** — all planned components built, plus beyond-plan additions: `BottomNav`, `BulkActionBar`, `ContactSelect`, `EmptyState`, `FilterDropdown`, `LazyChart`, `MobileDrawer`, `MobileUserMenu`, `NavProgress`, `StatCard`, `DatePicker`, scanner components.

**Per-user nav preferences** *(beyond plan)*: sidebar item order and mobile bottom-nav visibility are persisted per-user in the DB and editable via drag-and-drop.

---

## Phase 5 — Auto Import ✅ Complete

- **`import/worker.ts`**: 3-concurrent-job tick loop (2s interval), recovers stale `extracting`/`processing` rows to `queued` on startup
- **`import/extractor.ts`**: text PDFs (`unpdf`), scanned PDFs (page images → Tesseract.js), JPEG/PNG (Tesseract.js); AVX workaround included for NAS hardware
- **`import/llm.ts`**: OpenRouter with structured JSON schema output, dynamic category hints in system prompt, 3-retry exponential backoff, prompt-injection hardening (`<document>` tags around raw text)
- **`import/duplicate-detector.ts`**: three signals — filename match, reference number match, amount+date+supplier match (via contacts join)
- **`import/events.ts`**: `importEvents` EventEmitter; `/api/import/stream` sends full snapshot on connect then incremental `job-update`/`job-deleted` events

**Import worker enhancements beyond plan:**
- Auto-resolves a contact candidate from the supplier name (queries contacts table during processing)
- Fetches the exchange rate for the document's currency at the document date

**Import UI**: drag-drop file upload, camera/scanner button (opens `ScannerOverlay`), live SSE-backed job list, inline-editable review cards (date, amount, currency, contact, category), confirm/skip per job.

---

## Phase 6 — Backup & Advanced ⚠️ Intentionally Deferred

- **God Mode**: ✅ toggle in Settings → Advanced, persisted in the `settings` table, respected by `locking.ts` guards
- **Backup export/import**: deferred — the app runs in a Docker container; backups are handled at the infrastructure level by snapshotting the data volume. In-app export/import may be revisited in future.
- **Reset** (`/api/reset/`): deferred — directory stub and `ResetScope` enum (`settings | data | everything`) exist; no implementation yet. May be added in future.

---

## Real-Time Updates

All features use Server-Sent Events (SSE), not polling. Pattern established in `CLAUDE.md`:

| Stream | Snapshot on connect? | Events |
|---|---|---|
| `/api/import/stream` | Yes (small finite job set) | `job-update`, `job-deleted` |
| `/api/expenses/stream` | No (SSR provides initial state) | `expense-update`, `expense-delete` |
| `/api/income/stream` | No | `income-update`, `income-delete` |
| `/api/claims/stream` | No | `claim-update`, `claim-delete` |
| `/api/contacts/stream` | No | `contact-update`, `contact-delete` |
| `/api/dashboard/stream` | No | `data-changed` (generic, triggers re-fetch) |

Client-side: `src/lib/sse.ts` singleton with 45-second grace-period reconnect and `mergeById` utility for incremental list updates.

---

## Beyond-Plan Features

### 1. Contacts Module
Full contacts management including:
- CRUD with role tagging (client, supplier, employee, etc.)
- Fuzzy duplicate detection using union-find clustering across name/email/phone/registration number
- Merge preview + merge execute (repoints all FK references then hard-deletes losers)
- Usage-count guard (DELETE returns 409 if contact is referenced by existing records)
- SSE stream
- 7 API endpoints: `/api/contacts`, `/api/contacts/[id]`, `/api/contacts/[id]/roles`, `/api/contacts/duplicates`, `/api/contacts/merge`, `/api/contacts/merge/preview`, `/api/contacts/stream`
- Import worker auto-resolves or creates contacts by supplier name during processing

### 2. Document Scanner
In-browser scanning overlay accessible from the Import page:
- `ScannerOverlay.svelte` + `EditView.svelte`: camera capture with OpenCV.js page-boundary detection
- `pdf-assembly.ts`: assembles scanned pages into a PDF client-side
- Resulting PDF is submitted to the import queue, flowing through the normal LLM extraction pipeline

### 3. Multi-Currency & Exchange Rates
- `exchangeRates` DB table caches historical rates from [Frankfurter API](https://www.frankfurter.dev)
- `currency/rates.ts`: `getExchangeRate(date, from, to)` with DB-level caching
- `/api/exchange-rate`: exposed to the frontend for form-level currency conversion
- Import worker fetches the rate for the document's currency at the document date
- `currency-state.svelte.ts`: reactive `formatMoney` / `formatMoneyAmount` used globally
- Main currency is locked in Settings → General once any transaction exists (prevents retroactive mismatch)

### 4. Per-User Nav Preferences
- Sidebar item order is drag-to-reorder, persisted in `userNavPreferences` table
- Mobile bottom-nav visibility (which items show in the bottom bar) stored in `userPreferences`
- Defaults defined in `src/lib/nav-config.ts` (`DEFAULT_NAV_ITEMS`, `DEFAULT_MOBILE_VISIBLE_IDS`)

### 5. User-Level Permission Overrides
Beyond the group permission grid, individual users can have per-resource permission overrides stored in `userPermissions`. Managed via `/api/users/[id]/permissions`. The resolver in `permissions.ts` ORs group permissions and user-level overrides together.

### 6. Data Migration from macOS Akaun
A one-time import from the original macOS app's SwiftData SQLite store (`default.store`) migrated users, expenses, incomes, claims, and attachment file paths into the new schema. The scripts that did it (`scripts/migrate-from-akaun.ts` + `.sh`) have since been removed — retrieve them from git history if the migration ever needs re-running.

### 7. Profile Page
`/profile` — logged-in user's own profile management, separate from the superuser-only Settings page.

### 8. Structured Logging
`src/lib/server/logger.ts` — pino-based, `createLogger(name)` factory used throughout the server layer.
