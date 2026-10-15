# MCP: bookkeeping access for agents

Akaun serves MCP at **`https://<your-akaun-host>/mcp`**, alongside its existing REST API. It exposes read tools across the ledger, sales documents, reconciliation and Auto Import, two context resources and a description-review prompt — and, where the connection was granted change access, write tools for the same areas (phase two). It does not upload new import documents or bank statements, manage import profiles, or change account defaults.

## Connect with OAuth

Enable `OAUTH_ENABLED=true` and configure `ORIGIN` as Akaun's public HTTPS origin, then restart. Add `https://<your-akaun-host>/mcp` to the client with OAuth authentication. Dynamic registration supplies client credentials matching the client’s authentication method (public, Basic or form-based client secret). Akaun prompts for login and consent: read scopes are pre-selected, change (`:write`) and delete (`:delete`) scopes never are. Every request also checks the user's current group permissions. No OAuth token grants REST access.

Revoke connections in **Profile → Connected apps**. Access tokens last 15 minutes; refresh tokens rotate, with a maximum grant lifetime of 30 days. Password changes and administrator password resets revoke OAuth grants. Browser logout alone does not disconnect apps.

See [OAuth setup](OAUTH.md) for metadata endpoints, deployment configuration and verification.

## Connect with an API token

1. In **Users & Groups**, create a dedicated integration user and assign a group with **View** permissions for Records, Accounts, Contacts, Reports and Auto Import. Grant only the resources the agent needs. Do not make the user a superuser or grant Add/Change/Delete for read-only use.
2. Issue the user's API token and store the one-time reveal in your MCP client's secret configuration. Revoking/regenerating it immediately affects subsequent requests.
3. Configure a **Streamable HTTP** connection to `https://<your-akaun-host>/mcp`, with `Authorization: Bearer <token>`.

For Codex clients supporting remote HTTP MCP, the configuration is:

```toml
[mcp_servers.akaun]
url = "https://books.example.com/mcp"
bearer_token_env_var = "AKAUN_MCP_TOKEN"
```

Set `AKAUN_MCP_TOKEN` in the client's environment without committing its value. Other clients should use their own URL/header configuration. Configured bearer tokens remain supported alongside optional OAuth. No stdio bridge is bundled.

The token inherits the user's existing REST permissions. Over MCP, an API token sees **read tools only** unless the server sets `MCP_BEARER_WRITES=true`; then it sees every write tool its user's RBAC allows (an API token carries no scopes). That flag does not restrict the token's REST access either way, so use the dedicated restricted user above.

Use HTTPS for remote connections. For a desktop sidecar, use its actual local server address/port while the app is running; do not assume the Docker or desktop ports are identical.

## Available tools

| Tool                    | Inputs                                                                                                   | Permission                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `list_records`          | Date range, kinds, account/category/contact IDs, search, paid/cleared, amount bounds, sort, limit/offset | Records View                  |
| `get_record`            | `recordId`, optional `includeEvidence`/`includeSettlements`                                              | Records View                  |
| `get_attachment`        | `recordId`, `attachmentId`                                                                               | Records View                  |
| `list_accounts`         | Type, category toggle, search, archived toggle, limit/offset                                             | Accounts View                 |
| `get_account_statement` | `accountId`, optional dates, limit                                                                       | Records View                  |
| `list_contacts`         | Search, role, entity type, limit/offset                                                                  | Contacts View                 |
| `get_contact_balance`   | `contactId`                                                                                              | Contacts **and** Records View |
| `list_outstanding`      | `direction`: `owed-to-us` or `we-owe`, optional contact ID, limit/offset                                 | Records View                  |
| `get_financial_report`  | `type`, required dates or as-at date                                                                     | Reports View                  |
| `list_import_jobs`      | States, upload date range, duplicate-only toggle, limit/offset                                           | Auto Import View              |
| `get_import_job`        | `jobId`, optional evidence                                                                               | Auto Import View              |

Phase two adds these reads:

| Tool                   | Inputs                                                         | Permission                          |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------- |
| `list_invoices`        | Status, contact, dates, overdue toggle, search, limit/offset   | Invoices View                       |
| `get_invoice`          | `invoiceId` — includes `owedMovementId` for `record_payment`   | Invoices View                       |
| `list_quotations`      | Status, contact, dates, search, limit/offset                   | Quotations View                     |
| `get_quotation`        | `quotationId`                                                  | Quotations View                     |
| `list_bank_statements` | Optional `accountId`                                           | Reconciliation View                 |
| `get_bank_statement`   | `statementId`, `includeCandidates` (movements + suggestions)   | Reconciliation **and** Records View |
| `get_audit_history`    | `recordType`, `recordId`, `limit`                              | View on the item's own resource     |

Every `get_*` (and `list_accounts`, `list_contacts`) returns a `version` for each item: the token a write must send back as `expectedVersion`.

Tool discovery reflects the authenticated user's permissions. Calls also enforce permissions, including direct calls to tools not listed for that user. Authentication and permissions are evaluated afresh on each HTTP request.

Record kinds are `expense`, `income`, `transfer`, `payment`, `opening_balance`, `invoice_issue`, and `journal`. Import states use `queued`, `extracting`, `processing`, `pending_review`, `confirmed`, `imported`, `skipped`, and `failed`. Account types use `asset`, `liability`, `equity`, `revenue`, and `expense`.

Report types:

- `profit-loss`, `cash-flow`, `partner-statement`: require `dateFrom` and `dateTo`.
- `balance-sheet`: requires `asAt`; does not accept period dates.

Example tool arguments:

```json
{
  "name": "get_financial_report",
  "arguments": {
    "type": "profit-loss",
    "dateFrom": "2026-09-01",
    "dateTo": "2026-09-30"
  }
}
```

Successful results expose the same envelope in structured MCP content and text:

```json
{
  "data": { "...": "tool-specific result" },
  "meta": {
    "observedAt": "2026-10-03T00:00:00.000Z",
    "mainCurrency": "MYR",
    "minorUnitScale": 100
  }
}
```

## Write tools

One tool per action; a lifecycle step gets its own tool wherever its MCP annotations differ (issuing an invoice is not destructive, voiding one is), so a client can tell which calls to confirm with the user. Scope is the OAuth scope a token must hold; RBAC is the app ability the user must have. Both are listed in one table, `src/lib/server/mcp/tool-requirements.ts`.

| Area             | Tools                                                                                                                                                                                                     | Scope (RBAC)                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Records          | `create_record` (from/to accounts, optional `extraSides`, `dryRun`), `record_payment` (with settlements, atomic), `update_record`, `settle_payment`, `attach_file`                                        | `records:write` (records add/change)                                                                                                                                               |
|                  | `delete_record`, `undo_settlement`, `delete_attachment`                                                                                                                                                   | `records:delete`                                                                                                                                                                   |
| Accounts         | `create_account`, `update_account` (archive with `active: false`), `set_opening_balance`, `delete_account`                                                                                               | `accounts:write`/`:delete`; the opening balance also `records:write` (records add or change)                                                                                      |
| Contacts         | `create_contact`, `update_contact` (incl. roles), `delete_contact`, `merge_contacts`                                                                                                                      | `contacts:write`/`:delete`; merge needs both                                                                                                                                       |
| Invoices         | `create_invoice`, `update_invoice`, `issue_invoice`, `void_invoice` (`reissue`), `delete_invoice`                                                                                                         | `invoices:write`/`:delete`; issue and void also `records:write` (records add / change)                                                                                            |
| Quotations       | `create_quotation`, `update_quotation`, `set_quotation_status`, `revise_quotation`, `convert_quotation_to_invoice`, `delete_quotation`                                                                    | `quotations:write`/`:delete`; convert also `invoices:write`                                                                                                                        |
| Reconciliation   | `update_statement_line`, `set_movement_matches`, `auto_match`, `record_transfer_from_line`, `delete_statement_line`                                                                                       | `reconciliation:write`/`:delete`; the transfer also `records:write` (records add)                                                                                                 |
| Auto Import      | `update_import_item`, `confirm_import`, `skip_import`, `discard_import_job`                                                                                                                               | `import:write`/`:delete` (import change/delete only — confirm deliberately needs no records ability, 006 FR-045)                                                                   |

Semantics every write tool shares:

- **Same rules as the app.** Each tool calls an authorized operation in `src/lib/server/application/`, the same one the REST route calls. Locks (settled or bank-matched records), sealed sent documents, archive-instead-of-delete, the adjustments gate and every other refusal come back as `REFUSED` with the app's own sentence.
- **Versions.** Updates, deletes and lifecycle steps take `expectedVersion`. A stale one is refused with `CONFLICT` and the `currentVersion`; re-read and check with the user. Versions are hashes of the item and its child rows (`application/version.ts`), not `updatedAt`.
- **Never movements.** `create_record` takes the two accounts money moved between; the kind is derived and `entry-builder.ts` builds the sides. `dryRun` returns the derived sides without saving.
- **Audit and events.** Writes are audited under the signed-in user and emit the same SSE events as the screens, after commit. An import confirm is audited under the confirmer; the record stays the uploader's.
- **Errors.** `FORBIDDEN`, `NOT_FOUND`, `INVALID_INPUT`, `REFUSED`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_UNAVAILABLE`.
- **Files.** `attach_file` takes the file as base64 (PDF/JPEG/PNG by content, 15 MB, 30 per user per 10 minutes). It is the one call allowed a body over 128 KiB (about 20.1 MiB); `inspectRpc` reads which tool is called before choosing the limit. `BODY_SIZE_LIMIT` must be at least `21M`.

## Reading the answers correctly

- Reports use canonical ledger movements in whole cents of the **main currency**. Never sum every record's displayed amount: transfers and payment records are different events, and original currencies can differ.
- Record `amount` is the original entered amount in `currency`; `mainCurrencyAmountMinor` and movement amounts use the stored exchange rate. Record amount bounds and sorting compare original entered amounts.
- Positive movement value enters the account. `list_accounts` exposes signed ledger `balanceMinor` and the app's normal-balance `displayBalanceMinor` separately. These are current all-time balances.
- Contact and outstanding queries show **current** remaining amounts after all saved settlements, including unallocated payment sides according to the existing app rules. They do not reconstruct past outstanding balances. Ageing uses UTC today.
- Report notes preserve warnings about incomplete history or accounts requiring classification. Keep those notes in any agent analysis.
- Date ranges are inclusive, in `YYYY-MM-DD`. Import date filters apply to upload dates, independently of document dates.
- Lists default to 50 rows, maximum 200. `pagination.total` describes the full filtered set, and `nextOffset` supports subsequent pages. Offset paging can shift if another user edits data; rerun the query when necessary. Account discovery reads the chart as one set before output paging.
- Statements default to 100 movements, maximum 500. They do not accept offset or arbitrary filters. When truncated, `periodClosingBalanceMinor` is null and `returnedClosingBalanceMinor` covers only returned movements. Narrow the dates for a complete statement.
- Stored evidence is optional, capped at 6,000 characters and labeled as untrusted content. Reads do not trigger OCR, extraction or provider calls. Attachment responses contain display metadata, not storage paths.
- `get_attachment` (`records:read`) returns one attached file: JPEG/PNG as image content, PDF as an embedded blob resource (`akaun://records/{id}/attachments/{attachmentId}`), xlsx/csv as cell text capped at 200,000 characters. The type is sniffed from content, not the name. Files over 5 MB are refused (`OUTPUT_TOO_LARGE`); 60 files per user per 10 minutes (`RATE_LIMITED`, in-memory). It reads through the `store` in `McpContext`, never `STORAGE_PATH`, so specs use a tmpdir store. No OCR, no paths, no audit row.
- Tool results are limited to 512 KiB of serialized data, except `get_attachment`, which is limited by file size; requests are limited to 128 KiB, except `attach_file`. Narrow the query if the output budget is exceeded. Raw server errors, tokens, file paths and provider settings are withheld.

## Description review

`akaun://description-policy` provides the same versioned wording guidance used by Auto Import. It favors short noun phrases, sentence case, consistent terminology, supported product/service details and no invented billing periods. Default output is English; existing Auto Import custom instructions can request another language or supply preferred vocabulary.

Use `review-record-descriptions` to ask the agent for a bounded before/after table with IDs, reasons, evidence and ambiguity flags. It is available to users who can read Records or Auto Import. The prompt tells the agent to change nothing until the user approves the table, then apply only approved rows with `update_record` (description only, each with its current `version`), reporting any conflict row by row. This replaces phase one's manual-only workflow and the persisted review/approve/undo batches the original phase-two proposal described.

`akaun://context` describes money/date conventions, capabilities and query limits. Clients need not support resources/prompts to use tools: essential semantics are also present in tool descriptions/results.

## Deployment and transport

`/mcp` is a single MCP protocol endpoint; tools are dispatched by `tools/call`, not individual REST paths. The server uses SDK v2's Web Standard `createMcpHandler`, with request-scoped servers supporting both modern (2026-07-28) and legacy (2025-era) clients.

- POST handles modern per-request traffic and legacy initialization, requests and notifications. Clients must send the protocol's JSON content type and Accept headers. Modern responses use JSON for Akaun's reads; the SDK's stateless legacy compatibility leg returns request results over SSE.
- GET, DELETE and other methods return 405 (`Allow: POST`). No session IDs or standalone event stream are issued.
- Cookie sessions are not accepted; missing/invalid bearer credentials return 401 with a Bearer challenge, without a login redirect. When OAuth is enabled the challenge advertises protected-resource metadata.
- Native clients may omit Origin. If provided, Origin must exactly match the application's public origin, including scheme and port. Configure the app's trusted public `ORIGIN` correctly behind a reverse proxy. Cross-origin browser access is not enabled.
- Responses use `Cache-Control: no-store`. Modern discovery, list and resource results also carry `ttlMs: 0` and `cacheScope: "private"`. No MCP change-notification capabilities are advertised, and `subscriptions/listen` is refused without opening a stream. Existing `/api/*/stream` endpoints continue serving browser SSE updates independently.

Reverse proxies need to forward `/mcp`, Authorization, Accept, Content-Type, `Mcp-Protocol-Version`, `Mcp-Method` and `Mcp-Name` without changing the request body or header values. Allow `text/event-stream` responses and avoid buffering the legacy compatibility responses. There is no standalone GET event stream.

## Implementation and verification

### Inspector schema portability

The ten data tools share the output envelope in `src/lib/server/mcp/common.ts`; `get_attachment` returns content blocks instead (see the limits above).
Its `data` field is a string-keyed record of JSON values (`z.json()`), including
scalars, null, arrays and nested objects. The previous `z.unknown()` value schema
emitted `additionalProperties: {}`, which accepts anything and triggers the
Inspector's unconstrained-schema portability warning. An object-only replacement
would reject valid results such as counts, lists and nullable balances.

The integration suite checks the schemas actually returned by `tools/list` for
unconstrained schema objects and exercises client validation of real results.
This is a shared JSON-value contract; tool-specific output schemas would provide
more precise field documentation and validation in a future change.

### Modern protocol support

Akaun uses `@modelcontextprotocol/server` v2 in production and
`@modelcontextprotocol/client` v2 in its integration tests. The v1 dependency
has been removed. `src/lib/server/mcp/http.ts` serves both eras through
`createMcpHandler(() => createServer(context))`, with `legacy: "stateless"`.
The factory captures only the current authenticated request's database and locals.
Bearer authentication, exact Origin checks, POST-only access, the 128 KiB request
limit (larger only for `attach_file`) and per-call permission checks apply to both eras.

In MCP Inspector, select **Streamable HTTP**, enter the `/mcp` URL and configure
the bearer header, then choose Protocol Era **Modern** or **Auto**. Auto probes
`server/discover` and selects the modern era. **Legacy** remains supported for
clients using the initialize handshake. Inspector defaults can vary by version;
choose the era explicitly when verifying this migration.

Modern revision **2026-07-28** removes the initialize handshake and protocol
sessions. Each request carries the protocol version and client capabilities in
`_meta`, with matching `Mcp-Method` and, where applicable, `Mcp-Name` headers.
SDK v2 handles discovery, wire `resultType`, server identity metadata, protocol
validation and response cleanup. Catalogs/resources have explicit private,
zero-TTL cache hints so clients re-evaluate current data and permissions.
Tool registration order is deterministic for each permission set.

For an SDK v2 client, opt into automatic negotiation:

```ts
const client = new Client(clientInfo, {
  versionNegotiation: { mode: "auto" },
});
```

For strict modern testing use `mode: { pin: "2026-07-28" }`; for legacy use
`mode: "legacy"`. The SDK's default client mode still uses the legacy handshake.
The API token and `/mcp` URL are identical across eras.

The HTTP integration suite runs the same schema, bookkeeping, permission,
concurrent-user and revocation scenarios in all three modes. It also checks the
actual modern request/response envelopes, discovery, headers, cache hints,
unsupported revisions and method/name mismatches. In-memory transport tests
exercise registration and error handling separately; they are legacy-only and
are not used as evidence of modern wire support.

Akaun does not use protocol subscriptions, sampling, roots, elicitation or
experimental tasks. List-change/subscription capabilities are explicitly disabled;
MCP subscription streams are not offered. Pino audit logging is separate from
MCP protocol logging.

Primary references (researched 2026-10-07):

- [2026-07-28 specification changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Official TypeScript SDK v1-to-v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [Explicit modern serving and negotiation](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)
- [Inspector protocol-era configuration](https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md)

The route and authentication hook connect callers to request-scoped tool registrations. Reads reuse existing query/report functions; contact counts and paged outstanding/import queries run against SQLite. No second database-owning service or model call is introduced.

The read suite (`mcp.spec.ts`) uses the official MCP client and exclusively in-memory SQLite fixtures with `PRAGMA query_only = ON` during reads. The write suite (`mcp-write.spec.ts`) covers discovery by scope and RBAC, call-time re-checks, conflicts, locks, the adjustments gate, payment atomicity, events after commit, audit attribution, request size and every domain's tools; files go to a tmpdir store. It covers transport negotiation, authentication, permissions, concurrent actors, date/limit validation, mixed currency and settlements, statement truncation, safe evidence projections and output budgets.

```sh
bun run check
bun run lint
bun run test:mcp
bun run test:oauth
```

`test:mcp` runs the MCP integration specs and relevant bookkeeping regressions directly with Bun. A small preload maps the shared Vitest assertion/hook imports to Bun's native test API, avoiding the current Vitest 4/Bun worker-startup failure. It also stands in for `$env/dynamic/private` with a temp folder (so `file-storage.ts` can load without ever pointing at `data/`) and makes any import of `db/client.ts` throw. The specs also remain usable by the normal Vitest runner when its workers are compatible. The adapter supports only the APIs these selected fixtures use; it is not a replacement for the repository's full test suite.

Not yet built: `aggregate_records`, description-candidate worklists, contact duplicate preview, and uploads of new import documents or bank statements.
