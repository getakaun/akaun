# OAuth for MCP

Akaun supports OAuth authorization code with mandatory S256 PKCE for its read-only MCP server. Users sign in with their existing Akaun account and approve the client's read scopes. API tokens remain available for clients that use configured Authorization headers.

## Enable

Set the public HTTPS origin and restart the server:

```env
ORIGIN=https://books.example.com
OAUTH_ENABLED=true
```

For Docker Compose add these to the Akaun service's environment. The database migration adds OAuth tables automatically at startup. No new service, signing key or external identity provider is required.

| Variable          | Behavior                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `OAUTH_ENABLED`   | OAuth is disabled unless set to `true`                                  |
| `PUBLIC_BASE_URL` | Defaults to `ORIGIN`; must be the same public origin                    |
| `AUTH_ISSUER`     | Defaults to the public origin; only a matching root issuer is supported |
| `MCP_RESOURCE`    | Defaults to the public origin plus `/mcp`; must match that URL exactly  |

HTTPS is required for remote installations. HTTP loopback origins are allowed for local development. Do not use an internal Docker hostname or derive the issuer from incoming Host/forwarded headers. Changing the public issuer/resource invalidates existing OAuth tokens and requires reconnecting clients. Tokens and registrations persist in the existing SQLite database across ordinary restarts.

## Connect a client

1. Add `https://books.example.com/mcp` as a Streamable HTTP MCP server.
2. Select OAuth. A client supporting dynamic client registration discovers `/oauth/register` and receives credentials for its chosen method: `none` for public clients, or `client_secret_basic` / `client_secret_post` for confidential clients.
3. Sign in to Akaun when prompted. Review the client identity and approve selected read permissions.
4. Query your data. Open **Profile → Connected apps** to see scopes, connection/expiry/last-use times and revoke access.

A client name is supplied by that client and is not a verified brand identity. Use a restricted Akaun user if you want group permissions to place a second limit on access. Superusers are also limited by their approved scopes.

A client requiring a preconfigured ID can register ahead of time using the same endpoint:

```sh
curl --request POST https://books.example.com/oauth/register \
  --header 'Content-Type: application/json' \
  --data '{"client_name":"My MCP client","redirect_uris":["https://client.example.com/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
```

Use the returned `client_id` and the client's exact callback URL. This registration does not authorize any user data: login and consent remain required. For a client that requires a secret, request `client_secret_basic` or `client_secret_post` instead of `none`. Omitting the method defaults to `client_secret_basic` as specified by RFC 7591. Copy the returned secret into the client's secure configuration; Akaun stores only its hash and cannot reveal it again. Client credentials persist while a grant or consent flow is active. Unused registrations are reclaimed after 24 hours, or sooner when registration capacity is full; clients must register again if their credentials have been reclaimed. Client ID Metadata Documents (CIMD) are not implemented or advertised.

## Scopes and credential boundaries

Scopes come in three tiers per area: `:read`, `:write` (add and change) and `:delete` (permanent removal). The strings live in `$lib/permissions/oauth-scopes.ts`. Each scope expands on the server to permission-catalog leaves (`SCOPE_PERMISSIONS`); for example `invoices:write` expands to create, update, issue and void. An app's effective access is checked on every request:

```
expanded scopes ∩ the user's role ∩ their groups' delegation ceiling
```

Narrowing a group or its ceiling therefore applies at once to every app. See [PERMISSIONS.md](PERMISSIONS.md).

- **`reports`** is read-only. There are no scopes for dashboard, settings or users.
- **Omitted scope requests** default to reads only. Protected-resource metadata advertises reads only in `scopes_supported`. Change and delete scopes come through step-up: a 403 `insufficient_scope` challenge naming the missing scopes. The challenge is sent only when the user could grant them.
- **Consent page.** It offers only scopes the user may delegate, and says when an administrator's ceiling blocks one. Reads are pre-ticked; change and delete never are.

Tool discovery and calls go through one table (`mcp/tool-requirements.ts`) that lists each tool's scopes and catalog permissions. Description policy and review prompts need `records.read` or `import.read`. The context resource reports read, write and delete access per area after every restriction.

OAuth credentials are accepted only by `/mcp`, not `/api/*`. Personal access tokens (`akp_…`) work on both `/api/*` and `/mcp`, bounded by their own permissions; the old raw API tokens were revoked. Browser cookies never authenticate MCP requests.

## Discovery and lifecycle

| Endpoint                                    | Purpose                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` | Canonical MCP protected-resource metadata                                     |
| `/.well-known/oauth-protected-resource`     | Root alias for the same MCP resource                                          |
| `/.well-known/oauth-authorization-server`   | Issuer metadata                                                               |
| `/oauth/register`                           | Public client registration (JSON POST)                                        |
| `/oauth/authorize`                          | Browser login and consent                                                     |
| `/oauth/token`                              | Code exchange and refresh (form-encoded POST)                                 |
| `/oauth/revoke`                             | Revoke a client's grant using its access or refresh token (form-encoded POST) |

Authorization and token requests must specify the exact MCP `resource`. Redirects must exactly match a registered URI. Authorization transactions last 10 minutes, codes 2 minutes and access tokens 15 minutes. Refresh tokens rotate after every use; grants expire 30 days after consent. Reusing an old refresh token revokes the entire grant, including its access tokens. Clients should serialize refresh operations. To expand scopes, reconnect and consent again.

Revoking access in Profile, changing a password or resetting it as an administrator invalidates OAuth grants. Deleting a user cascades to their grants/tokens. Group-permission changes take effect on the next request. Logging out of the browser does not revoke connected apps.

Tokens, authorization codes and confidential-client secrets are stored as hashes. Registration/token/authorization endpoints apply rate limits; request bodies are limited to 16 KiB, registration to ten redirect URIs per client, total registrations to 1,000 and pending authorizations to 5,000. Expired pending transactions, codes and grants are pruned during registration/authorization. Unused registrations expire after 24 hours. At capacity, the oldest registration without an active grant or pending consent is reclaimed before accepting a new registration. Clients with active grants or consent flows are preserved; 503 is returned only when all registrations are in use. This is a single-instance deployment, matching Akaun's current SQLite architecture.

## Proxy and client verification

Cloudflare Tunnel, Nginx and Caddy can supply connectivity. Forward the discovery and OAuth paths, `/mcp`, Authorization, Content-Type, Accept and MCP headers. An additional Cloudflare Access login must not block discovery or token exchange. The public URL must match `ORIGIN`; ordinary OAuth use does not depend on Cloudflare identity.

A quick deployment check:

```sh
curl -i https://books.example.com/mcp
curl -i https://books.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://books.example.com/.well-known/oauth-authorization-server
```

The first response should be 401 with `resource_metadata` in `WWW-Authenticate`, and the metadata responses should be public JSON naming the public origin. Native/server clients can omit Origin. Cross-origin browser MCP access is not enabled in this release.

Manually verify in ChatGPT: connect with OAuth, log in, grant selected scopes, run an allowed tool, reconnect/refresh and revoke access in Akaun. Repeat behind a conventional reverse proxy to confirm portability. An inaccessible private hostname, blocked discovery, changed public issuer or client requiring CIMD-only registration will prevent linking.

## Automated verification

```sh
bun run test:oauth
bun run test:mcp
bun run check
bun run lint
```

The OAuth suite runs migrations and fixtures only in in-memory SQLite and does not import the production database singleton or start a dev server. It covers the request hook, official MCP SDK discovery/DCR/linking/refresh, PKCE and redirect validation, replay/races, expiry/revocation, browser CSRF, user/client isolation, REST rejection and scope restrictions for superusers. Real ChatGPT and proxy verification remain manual.

The protocol targets [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), using DCR and RFC 8414/RFC 9728 discovery. CIMD is recommended by that specification but not implemented or advertised here. The OAuth engine is pinned to `@node-oauth/oauth2-server` 5.3.0, with Akaun supplying persistent storage and MCP-specific policy.
