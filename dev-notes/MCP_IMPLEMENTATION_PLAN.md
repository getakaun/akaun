# MCP and record-description standardization plan

Date: 2026-10-03; phase two revised 2026-10-15. Status: phase one implemented; phase two implemented as **direct, gated writes** (see "Phase two as built" below), replacing the review-batch design. See [MCP.md](MCP.md) for the implemented connection and tool contracts. The remaining sections preserve design intent; limits and interfaces in MCP.md describe the shipped behavior.

## Recommendation and pain points

Build a read-first MCP interface inside the existing SvelteKit/Bun backend. Reuse the ledger query and reporting functions, with shared authorization wrappers, rather than create another database-owning service or expose every REST endpoint as a tool. Deliver two phases: useful financial reads first, then broader analysis and a tightly controlled description-cleanup workflow.

The user's main working areas are Records, Accounts, Auto Import, and Contacts. The immediate needs are:

- Ask financial questions across those screens without manually filtering and exporting each one.
- Receive correct totals with supporting records, especially when payments, transfers, currencies, and outstanding amounts are involved.
- Standardize descriptions that are individually correct but use inconsistent vocabulary and detail.
- Clean existing descriptions in batches and keep future imports consistent.

MCP supplies data and actions to an external agent. It does not itself require an LLM inside the server. The app's existing provider integration can separately power an in-app cleanup assistant. Both should use the same description policy and review/apply service.

## Feature scan grounded in the current code

| Feature             | Current implementation                                                                                                                                                                     | MCP implication                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Records             | One ledger store for expense, income, payment, transfer, opening balance, invoice issue, and journal; filters by kind, account, category, contact, dates, amount, paid/cleared, and search | One records tool; human-readable enums translated at the boundary                                                         |
| Search and evidence | Search index includes record context and extracted document text; attachment text extraction exists                                                                                        | Reuse search; return bounded stored evidence on demand, without re-running OCR during ordinary reads                      |
| Accounts/categories | Both are account rows; balances come from movements; role/subtype and archived state are meaningful                                                                                        | Include categories in account discovery; do not invent a separate category model or account hierarchy                     |
| Account statements  | Existing statement query computes opening/running/closing balances, with limited rows and no offset                                                                                        | Preserve its rules; expose truncation and the balance through the last returned entry                                     |
| Contacts            | Directory, roles, fuzzy matching, duplicate detection and merge; contact balances derived from settlements                                                                                 | Read balances and linked records first; defer merging                                                                     |
| Auto Import         | Queue, OCR/PDF extraction, LLM extraction, contact/category matching, duplicate signals, review and confirmation                                                                           | Expose status, extracted fields, duplicate reasons and resulting record links; avoid upload/confirmation writes initially |
| Reports             | Profit and loss, balance sheet, cash flow and partner statements; JSON/CSV endpoints and report notes                                                                                      | One report tool with a report-type enum; keep all existing classification and completeness notes                          |
| Reconciliation      | Bank statements, lines, allocations, auto-match and transfer workflows                                                                                                                     | Phase two read diagnostics and suggestions; no automatic matching mutations in initial scope                              |
| Invoices/quotations | Dedicated services, issue/convert/status flows and PDFs                                                                                                                                    | Phase two reads; use source-document rules for generated ledger records                                                   |
| Security/history    | Bearer-token API auth, cookie sessions, resource/action RBAC, audit history, SSE change events                                                                                             | Bind each MCP call to a user; authorize each operation; use existing audit/event behavior for future writes               |

The README mentions reimbursement claims, but the current navigation and routes center on the unified ledger and settlements. Do not design a new standalone claims MCP surface from that older feature summary without establishing the intended current workflow.

## Phase one: read-only bookkeeping assistant

Priority A is the first vertical slice. Priority B completes the first release. All tools have read-only annotations; handlers enforce read-only behavior regardless of annotations.

| Priority | Tool                    | Principal inputs and result                                                                                                                       | Existing foundation                                                                |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A        | `list_records`          | Search, date range, kinds, account/category/contact, paid/cleared, bounded paging; compact records, total and links                               | `queries/ledger.ts:listRecords`                                                    |
| A        | `get_record`            | Record ID, optional evidence/settlements; record, movements, derived state, attachment metadata and bounded extracted text                        | `getRecord`, `listAttachments`, `settlementsForRecord`                             |
| A        | `list_accounts`         | Type, category/money role, search, archived toggle; IDs, codes, names, roles/subtypes and clearly labeled balances                                | `queries/accounts.ts:listAccounts`; extend filtering where needed                  |
| A        | `get_account_statement` | Account ID and date range, bounded limit; opening balance, chronological movements, running balance, returned-row closing balance and total       | `accountHistory`; reuse statement notes                                            |
| A        | `list_contacts`         | Search, roles, bounded paging; compact contact directory                                                                                          | `queries/contacts.ts:listContacts`; add query-level paging                         |
| A        | `get_financial_report`  | Type: profit-loss, balance-sheet, cash-flow, partner-statement; required period or as-at date; report totals, lines, notes and drill-down filters | `queries/reports.ts`                                                               |
| B        | `get_contact_balance`   | Contact ID; separately show owed-to-us and we-owe, net, contact link and record drill-down                                                        | `contactBalances`; phase-one values describe current outstanding amounts           |
| B        | `list_outstanding`      | Direction, contact/account filters and bounded paging; open items and outstanding minor units                                                     | `queries/settlements.ts:listOutstanding`; extend paging rather than load all items |
| B        | `list_import_jobs`      | State, date range, duplicate-only and bounded paging; statuses and concise issue summaries                                                        | Extract shared import reads from current routes                                    |
| B        | `get_import_job`        | Job ID; extracted fields, contact candidates, category, errors, duplicate signals, optional bounded source text and resulting record link         | Existing import job query and schema                                               |

Example questions supported:

- “Show this month's software expenses and the receipts behind them.”
- “What do we owe each supplier, and which records are still outstanding?”
- “Explain the difference between this month's profit and cash movement.”
- “Which imports failed or need review, and why were these flagged as duplicates?”
- “Find similar descriptions for this supplier and suggest consistent wording.”

For the last question, the phase-one agent reads records and proposes a table in its client. It cannot save edits through MCP. Existing manual editing remains available.

Expose small MCP resources for `akaun://context` and `akaun://description-policy`: main currency, date/time conventions, record kinds, account/category definitions, sign conventions, caller capabilities, supported filters, and the current style guide. Offer a cleanup prompt template if supported by the target client; correctness must not depend on clients reading resources or prompts. Tool descriptions/results must carry essential semantics.

### Financial and query contracts

- Aggregate canonical ledger movement `amount_minor` values using the app's existing accounting rules. Never sum record display amounts or count every money movement as an expense: settlement payments, transfers and opening balances require different treatment.
- Return original amount/currency separately from main-currency minor-unit amounts. Document signed ledger balances and display signs explicitly. Current record amount filters/sorts use the original entered amount, so mixed-currency comparisons require explicit semantics or a new base-currency query.
- Use required ISO dates for reports, inclusive boundaries, validated ordering and explicit as-at dates. Do not silently infer historical outstanding balances from today's settlements. Historical contact balance/ageing needs an intentional query extension.
- Default list size 50, hard maximum 200 as an initial proposal. Report and statement output needs its own budget. Return total, pagination state, truncation, requested filters and observation time. Prefer stable cursor paging for growing datasets; adapt current offset queries initially only with clear consistency limits.
- Existing `accountHistory` is capped, has no offset, and computes closing balance through returned rows. Never label that value the full period closing balance when truncated. For complete totals, separately calculate the full window or narrow dates; implement movement-aware cursor opening balances before allowing statement paging.
- Return structured MCP content plus concise text, record IDs and relative application paths. Build absolute links from trusted configured origin. Use allowlisted projections: do not return database rows wholesale, internal file paths, credentials or provider settings.
- A future `aggregate_records` tool can answer top suppliers and monthly trends efficiently. Its groupings and metrics must be allowlisted and derived from appropriate ledger sides, with record drill-down and distinct record counts. No arbitrary SQL tool.

## Backend and endpoint design

Use one MCP endpoint: **`https://<akaun-host>/mcp`**.

MCP sits beside REST. `hooks.server.ts` explicitly authenticates `/mcp` using the same bearer-token lookup as REST, without browser-session redirects. `/mcp` is a protocol endpoint: tools are selected by `tools/call` names, not `/mcp/list_records` paths.

Use the official TypeScript MCP SDK with Streamable HTTP. Prefer stateless, request-scoped operation for the first read-only release. Select a released SDK/version with compatible Web Request/Response transport for SvelteKit/Bun. Verify handshake, Accept headers, notifications, protocol versions and host adapter behavior in a small integration spike before building all tools.

- `POST /mcp`: protocol initialization, notifications and requests, including tool calls. Read tools still use POST; HTTP method alone cannot establish whether the operation changes bookkeeping data.
- `GET /mcp`: streaming only if used by the chosen transport; otherwise return protocol-appropriate 405. Phase one returns 405.
- `DELETE /mcp`: session termination only if sessionful transport is adopted; otherwise 405. Phase one returns 405.
- Existing `/api/<domain>/stream` endpoints remain browser change feeds. They are distinct from MCP transport streaming.

Suggested layout:

```text
src/routes/mcp/+server.ts                 # transport only
src/lib/server/mcp/server.ts              # SDK registration and request lifecycle
src/lib/server/mcp/context.ts             # authenticated actor and token capabilities
src/lib/server/mcp/schemas.ts             # validated inputs and compact output schemas
src/lib/server/mcp/tools/records.ts
src/lib/server/mcp/tools/accounts.ts
src/lib/server/mcp/tools/contacts.ts
src/lib/server/mcp/tools/reports.ts
src/lib/server/mcp/tools/import.ts
src/lib/server/mcp/resources.ts
src/lib/server/application/               # shared authorized operations where needed
src/lib/server/services/description-cleanup.ts  # phase two
```

Flow: MCP client → transport → authenticated request context → authorized operation → existing queries/services → SQLite. Existing REST routes and in-app AI workflows should call the same authorized operations. Do not make the in-process MCP server call its own HTTP REST endpoints, duplicate accounting calculations, or register a global user context that could leak across concurrent requests.

Authorization is currently concentrated in routes/loaders; directly calling a service does not automatically enforce RBAC or source-record edit restrictions. Extract small shared operations for the affected domains rather than rewrite the whole backend. MCP tools require the same resource/action permissions as existing routes. For composite reads, enforce the permissions for every included section or omit forbidden sections explicitly. In particular, contact-derived balances require records view; financial reports use reports view; import jobs use import view. Preserve the statement route's records-view gate.

Phase-one private/self-hosted clients that support configured Authorization headers can use a dedicated read-only user and the existing bearer-token mechanism. That token inherits all that user's REST abilities; disabling MCP writes does not make a broadly privileged token read-only. The current schema stores one raw token per user, without per-client scopes/expiry. Use a separate restricted identity initially; introduce hashed, revocable, scoped integration tokens when supporting multiple clients or cleanup writes.

Apply token scope AND user RBAC to each tool call, with permission changes checked on each request. Do not accept user ID/permission claims from tool arguments. Hide unavailable tools for usability, but also enforce checks on calls. Use request logs with tool name, actor, duration, outcome and bounded counts; omit raw descriptions, document text and tokens from routine logs.

For remote use, require HTTPS and validate Origin against configured allowed origins when present, including bearer requests; existing bearer auth skips the cookie CSRF check, which does not replace MCP Origin validation. Keep cookie CSRF protections intact if cookie authentication is supported. Confirm SvelteKit's own cross-origin POST behavior works with the selected MCP request content type.

For clients requiring OAuth discovery, add a supported OAuth authorization-server integration and protected-resource metadata under the appropriate `/.well-known/` routes, with explicit hook exemptions for public discovery. Static bearer setup is not universally compatible with remote MCP clients. Avoid hand-building an OAuth server for the MVP. Exact discovery paths follow the chosen auth integration and protected-resource URL.

For local desktop clients, offer an optional stdio bridge forwarding to this same authenticated backend; no separate SQLite connection or duplicated business rules. Confirm the Tauri sidecar's port/lifecycle before documenting a desktop connection URL. Only move MCP to a separate process when deployment constraints justify it; retain the shared authorized operation layer.

## Description standardization

### What exists and what is missing

`import/providers/shared.ts` already asks for a short `item_name`, aims below 60 characters, and truncates at 80. The confirm route copies `item_name` into record `description`. Settings already supports import custom instructions. This limits length but does not specify canonical vocabulary, language, casing, examples or how much detail to preserve. A changing LLM can therefore produce several correct variants.

Start with a versioned description policy. Apply it to new imports and existing-record suggestions. Do not treat truncation as standardization.

Suggested initial policy, subject to the user's examples:

- A short noun phrase describing the goods/service or purpose, in a chosen consistent language and sentence case.
- Prefer around 60 characters; preserve meaningful facts rather than blindly cutting them off; comply with the existing 500-character record API limit.
- Keep product names, meaningful models and supported service periods. Do not invent a billing month, purpose or merchant identity from a transaction date/category alone.
- Avoid amount, payment method, receipt number and redundant supplier names when those are already stored in separate fields, unless needed to understand the item.
- Maintain a small approved glossary and examples per category/supplier. Categories are context, not a replacement for the description: “Laptop purchase” and “Laptop repair” must remain distinguishable.
- Mark ambiguous records for human review; do not normalize distinct transactions into misleadingly identical labels.

Illustrative examples, only when supported by the source:

| Before                                          | Proposed                    |
| ----------------------------------------------- | --------------------------- |
| Monthly subscription payment for GitHub Copilot | GitHub Copilot subscription |
| Purchasing paper and ink for office use         | Printer paper and ink       |
| Electricity bill for September 2026             | Electricity — Sep 2026      |

### Workflow

1. Select a bounded batch by date, contact, category or description. Begin with expense/income records; skip invoice-generated records and unsupported kinds.
2. Read descriptions, linked context, approved examples and stored source text only where needed. Existing descriptions/OCR are untrusted content, never agent instructions.
3. Generate structured proposals: record ID, before, after, reason, evidence references and `needsReview`. A model's claimed confidence alone is insufficient for auto-acceptance.
4. Validate wording, length, factual preservation and no-op changes. Provide a before/after review table with accept/edit/reject per row and counts.
5. Apply only explicitly selected proposals through a description-only operation, with records-change permission, token scope and current source-record restrictions.
6. Preserve prior text in audit history and batch provenance. Offer undo through the same operation, only when the record still matches the applied version.

The existing service permits description changes on settled/reconciled ordinary records without rebuilding movements. The record REST route separately forbids edits to invoice-issue records; the cleanup service must preserve that restriction rather than bypass it through a direct `patchRecord` call. Support invoice-source edits later through the invoice service if desired.

## Phase two as built (2026-10-15)

The maintainer chose direct writes over the review-batch workflow proposed below: an agent with change access edits the books immediately, as the user could, instead of filing proposals for in-app approval. What makes that safe enough:

- **Two gates per call.** A write needs the OAuth scope (`<resource>:write`, or `<resource>:delete` for permanent removal) **and** the user's RBAC ability, checked at discovery and again at call time. Delete scopes are separate and never pre-selected. API tokens get writes only with `MCP_BEARER_WRITES=true`, so phase-one read-only tokens stay read-only.
- **One authorized operation per write**, in `src/lib/server/application/`, called by the REST route and the MCP tool alike. Moving the route-only rules there (adjustments gate, payment + settlements, sealing of sent documents, the new-contact check) closed several REST gaps at the same time: an explicit `kind: "journal"` now needs `adjustments:add`; a patch restating `extraSides` runs the everyday test; issuing an invoice needs `records:add` and a Revenue account; voiding needs `records:change`; a transfer from a bank line needs `records:add` and emits after commit; matching emits `record-update`; a matched line's amount and direction are locked; an opening balance needs `records:add`/`change` and emits ledger events; a new customer named on an invoice or quotation needs `contacts:add`. Import confirm stays on `import:change` alone (006 FR-045), but its audit row now names the confirmer.
- **Optimistic concurrency** with content-hash `version` tokens (`application/version.ts`), returned by every read and required by every update, delete and lifecycle tool.
- **Payment + settlements in one transaction**, with SSE emits deferred to commit.

The description-cleanup use case is served by the `review-record-descriptions` prompt plus `update_record`: the agent proposes a table, the user approves rows in the conversation, and the agent applies them with versions. No review tables were added. The reads in the table below that are not yet built (`aggregate_records`, `find_description_candidates`, contact duplicate preview) remain open.

## Phase two: deeper analysis and reviewed cleanup (original proposal, superseded)

Add tools in this order, based on observed phase-one use:

| Tool/capability                                | Purpose                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `aggregate_records`                            | Bounded monthly/contact/category trends and top spending, without downloading the ledger         |
| `find_description_candidates`                  | Inconsistency worklists and similar examples, with reasons rather than asserted errors           |
| `create_description_review`                    | Persist externally generated proposed edits as a review batch; does not update financial records |
| `get_description_review`                       | Read proposals and review status                                                                 |
| `apply_description_review`                     | Apply only selected, approved descriptions; narrowly scoped write                                |
| `undo_description_review`                      | Restore previously applied descriptions with conflict checks                                     |
| Reconciliation reads                           | Statements, unmatched/partially matched lines and possible-match evidence                        |
| Invoices/quotations reads                      | Search, status, detail and outstanding-document context                                          |
| Contact duplicate preview                      | Suggest directory cleanup; defer merge writes                                                    |
| Record audit/history and integrity diagnostics | Explain changes and investigate bookkeeping inconsistencies                                      |

Keep policy configuration and approval in the app initially. An optional in-app “suggest descriptions” action can use the existing provider factory, retries and rate limiting; the external-agent route can supply proposals directly, avoiding a second model call. Both use identical validation/review/application behavior.

Proposed REST paths for the shared cleanup workflow:

```text
GET    /api/records/description-policy
GET    /api/records/description-candidates
POST   /api/records/description-reviews
GET    /api/records/description-reviews/[batchId]
POST   /api/records/description-reviews/[batchId]/approve
POST   /api/records/description-reviews/[batchId]/apply
POST   /api/records/description-reviews/[batchId]/undo
```

The MCP apply tool cannot declare its own proposal approved. In-app approval should record the exact selected values and authenticated reviewer; changes to an approved proposal invalidate approval. A read-only agent identity may create review drafts only with a distinct draft scope if enabled; records-change permission is still required to approve/apply. No broad `update_record` MCP tool is needed for this use case.

Persist review batches/items with policy version, proposer/reviewer, source versions, before/after text, evidence, status and application result. Use a record revision or snapshot hash including relevant context; current `updatedAt` plus before-text can be an initial check but needs transaction-level comparison. Check/apply a small approved batch atomically, reject stale entries with a conflict report, and keep retries idempotent. Perform no LLM calls inside a database write transaction. Reuse audit and ledger SSE events; ensure events are published only after commit.

## Delivery sequence and acceptance

1. Define compact schemas and capability/context resource; spike SDK transport on `/mcp` using an isolated fixture database. Verify one report and one records read with the intended MCP client.
2. Build priority-A reads with shared authorization, bounded output, main-currency semantics and drill-down links. Confirm values match existing screens/report queries.
3. Complete priority-B outstanding/import tools. Add the description policy and approved examples to existing import custom instructions for immediate consistency; expose the same policy to agents.
4. Release phase one read-only. Collect representative questions, paging failures and description before/after samples. The agent can already return cleanup suggestions for manual review.
5. Implement persisted review/apply/undo with permissions, version/conflict checks, idempotency, audit and events. Apply the first small reviewed batch before scaling up.
6. Add aggregates and other phase-two read tools according to demand; use the same policy during future imports and validate changes on an agreed sample set.

Meaningful checks for implementation: protocol initialization/calls and unsupported methods; missing/revoked credentials; resource permission matrix and composite data leakage; concurrent actors; mixed currency and settlement/transfer double-counting; report notes and statement truncation; bounded queries/output; unsafe document instructions; proposed edits that invent facts; settled/reconciled description edits; invoice-issue rejection; stale approval conflicts; repeat apply/undo; audit/search-index/SSE consistency. Use temporary fixture databases, never production bookkeeping data. Run repository type/lint checks when implementing code; this planning-only change requires no runtime execution.

Phase one succeeds when the same question produces correct, traceable results consistent with existing reports and cannot change records. Phase two succeeds when reviewed batches reduce inconsistent wording, preserve financial values and source evidence, and can be reversed without overwriting later edits.

## Source map

- `src/lib/nav-config.ts`: current feature/navigation inventory.
- `src/hooks.server.ts`, `src/lib/server/permissions.ts`, `src/lib/server/db/schema.ts`: authentication, abilities and token/data model.
- `src/lib/server/queries/ledger.ts`, `src/routes/api/records/+server.ts`: record filters, indexed search, projections and query semantics.
- `src/lib/server/queries/accounts.ts`, `src/routes/api/records/statement/+server.ts`: account roles, balances, statements and truncation rules.
- `src/lib/server/queries/settlements.ts`, `src/lib/server/loaders/contacts.ts`: outstanding and contact balances with permissions.
- `src/lib/server/queries/reports.ts`, `src/routes/api/reports/`: canonical report computation and contracts.
- `src/lib/server/import/providers/shared.ts`, `src/lib/server/import/worker.ts`, `src/routes/api/import/[jobId]/confirm/+server.ts`: extraction policy and description creation.
- `src/lib/server/services/ledger.ts`, `src/routes/api/records/[id]/+server.ts`, `src/lib/server/ledger/record-permissions.ts`: description edits, locks and invoice-source restrictions.
- `src/lib/server/audit.ts`, `src/lib/server/ledger/events.ts`: audit and UI update integration.
