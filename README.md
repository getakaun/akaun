<p align="center">
  <img src="static/icons/icon-512.png" alt="Akaun logo" width="96" height="96">
</p>

<h1 align="center">Akaun</h1>

<p align="center">
  A self-hosted expense, income, and reimbursement tracker for small teams and freelancers.
</p>

## What is Akaun?

Akaun is a small web app for keeping track of money in and out of a business or household: expenses, income, who paid for what, and which expenses still need to be reimbursed. You run it yourself — on your own server, NAS, or VPS — and your financial data never leaves your machine.

Instead of typing every receipt in by hand, you can snap a photo or upload a scan and Akaun will read the amount, date, and supplier off it automatically (OCR + AI extraction), suggest a matching contact, and flag anything that looks like a duplicate before it's saved.

## Why self-host?

- **Your data stays yours** — everything lives in a single SQLite file and a local folder you control, no third party has access to it.
- **No subscription** — run it once on hardware you already own.
- **Small footprint** — designed to run comfortably on a low-power VPS, a Raspberry Pi, or a home NAS.

## Key Features

- **Expenses & Income** — record transactions with amounts, dates, categories, and linked contacts.
- **Receipt/Invoice Import (OCR)** — upload a photo or PDF and Akaun extracts the details for you, with fuzzy contact matching and duplicate detection. Structured extraction is powered by an LLM you bring the API key for (OpenRouter, Google AI Studio, or Groq — configured under Settings → Providers).
- **Reimbursement Claims** — group a batch of expenses into a claim for approval and repayment.
- **Quotations & Invoices** — draft quotations, convert accepted ones straight into invoices, and track their status (draft/sent/accepted/paid/etc.) through to payment.
- **Contacts Directory** — one shared list of suppliers, customers, and employees, reused across expenses and income.
- **Roles & Permissions** — invite teammates and control exactly what each person/group can view, add, edit, or delete.
- **Real-time Updates** — changes made by one person (or in another browser tab) show up instantly for everyone else, no refresh needed.
- **PDF Export** — customizable document templates (with your own company logo) drive printable/downloadable quotations, invoices, and claim summaries.

## Editing Rules: What You Can Change After a Record Is Settled or Reconciled

Once a payment has settled an expense or income, or a bank statement line has been matched to it during reconciliation, that record **locks** — this protects the numbers other records (the payment, the bank match) now depend on from being pulled out from under them.

- **Always editable, locked or not:** description, contact, reference, remark, and attachments.
- **Still editable once locked:** the **category** — what an expense or income was actually for. Fixing a miscategorized record (it was filed under the wrong expense/income account) never touches the money that was already paid or matched, so this stays open even after settlement or reconciliation.
- **Locked once settled or reconciled:** the amount, the date, the currency, and the account the money actually moved through (what it was paid from, or received into). Changing any of these after a payment or a bank line points at the record would make that payment or bank match wrong.
- **Deleting** a settled or reconciled record is blocked outright.

| Scenario                       | You CAN                                                                      | You CANNOT                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Nothing has happened to it yet | Change anything — amount, date, accounts, category, description, etc.        | —                                                                                  |
| A payment has settled it       | Fix the category, edit description/contact/reference/remark, add attachments | Change the amount, date, currency, or the account it was paid from/into; delete it |
| It's matched to a bank line    | Same as above                                                                | Same as above — plus unmatch the bank line before any of it applies again          |

**To unlock:** undo the payment (remove the settlement) or unmatch the bank statement line from the account's reconciliation screen. The record then goes back to fully editable.

## Screenshots

<!-- TODO: add screenshots once available (dashboard, expenses list, OCR import, claim detail) -->

## Self-Hosting with Docker (recommended)

The easiest way to run Akaun is with Docker. This is the recommended path even if you're not very technical — once Docker is installed, it's three steps.

**1. Install [Docker](https://docs.docker.com/get-docker/)** (includes Docker Compose on recent versions).

**2. Create a folder for Akaun and a `docker-compose.yml` inside it:**

```yaml
services:
  akaun:
    image: ghcr.io/getakaun/akaun:latest
    restart: unless-stopped
    ports:
      - 6969:6969
    volumes:
      - ./data:/app/data
    environment:
      - ORIGIN=http://localhost:6969
      - TZ=${TZ:-Etc/UTC} # Set to your business timezone, e.g. Asia/Kuala_Lumpur
      - PUID=1000 # Set to $(id -u) to match your host user
      - PGID=1000 # Set to $(id -g) to match your host group
      - BODY_SIZE_LIMIT=15M
      # - LOG_LEVEL=info
      # - SSL_ENABLED=true
      # - SSL_KEY_PATH=/app/data/ssl/key.pem
      # - SSL_CERT_PATH=/app/data/ssl/cert.pem
```

**3. Start it:**

```sh
docker compose up -d
```

Akaun is now running at `http://localhost:6969` (or your server's address, if `ORIGIN` is updated to match). All data — the database and any uploaded files — is stored in the `./data` folder next to your `docker-compose.yml`, so back up that folder to back up your whole instance.

**First login:** an `admin` account is created automatically on first boot with the password `akaun-admin`. Log in and change it right away from the Profile page.

**Running behind a different port, domain, or with HTTPS:** see the commented-out variables above and `.env.example` in this repo for details on every option.

### Reverse Proxy Notes

If you're fronting Akaun with nginx (including Nginx Proxy Manager) or a similar proxy, two settings matter:

**1. SSE endpoints need unbuffered, long-lived connections.** Akaun uses Server-Sent Events (`/api/*/stream`) for real-time updates. Add a location block for these paths with buffering disabled and a long read timeout, or the proxy will buffer/kill the stream:

```nginx
location ~ ^/api/.*/stream$ {
    proxy_pass http://<akaun-host>:<port>;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;
    proxy_read_timeout 24h;
}
```

**2. The default location needs a larger header buffer.** SvelteKit sends a `Link` response header preloading every JS module a page needs. Pages with many components (e.g. Expenses) can produce a `Link` header bigger than nginx's default `proxy_buffer_size` (commonly 4k–8k), which causes nginx to reject the response with `upstream sent too big header while reading response header from upstream` — a 502 on the affected page's direct/fresh load only (client-side in-app navigation to the same page won't reproduce it, since that doesn't trigger a full page render). Size the buffers up for the default location:

```nginx
proxy_buffer_size 16k;
proxy_buffers 4 16k;
proxy_busy_buffers_size 32k;
```

In Nginx Proxy Manager, add both blocks via the proxy host's **Advanced** tab. Don't use the "Websockets Support" toggle as a substitute for the first block — it applies `proxy_http_version 1.1` with `Upgrade`/`Connection: upgrade` handling to the _entire_ host including normal page traffic, which this app's server does not handle correctly and will make the whole site unreachable.

## Manual / From-Source Setup

For developers who'd rather run Akaun directly with [Bun](https://bun.sh):

```sh
git clone https://github.com/getakaun/akaun.git
cd akaun
bun install
bun run build
bun server.js
```

Configure the app via environment variables (copy `.env.example` to `.env` and edit, or export them directly):

| Variable          | Default           | Purpose                                                 |
| ----------------- | ----------------- | ------------------------------------------------------- |
| `DATABASE_PATH`   | `./data/akaun.db` | SQLite database file location                           |
| `STORAGE_PATH`    | `./data/storage`  | Where uploaded files (receipts, attachments) are stored |
| `BODY_SIZE_LIMIT` | `15M`             | Max upload size                                         |
| `LOG_LEVEL`       | `info`            | `trace` \| `debug` \| `info` \| `warn` \| `error`       |
| `SSL_ENABLED`     | `false`           | Serve over HTTPS                                        |
| `SSL_KEY_PATH`    | _(none)_          | Path to TLS private key, required if `SSL_ENABLED=true` |
| `SSL_CERT_PATH`   | _(none)_          | Path to TLS certificate, required if `SSL_ENABLED=true` |

Database migrations are generated with `bun run db:generate` and applied automatically on startup.

## ChatGPT subscription sign-in

In **Settings → Intelligence**, add or edit a **ChatGPT plan** provider and start
sign-in. Copy the one-time code, open **Open ChatGPT**, enter the code and approve.
Akaun connects automatically; select an available model and save the provider.
Enable **device code login** in your ChatGPT Security settings first. Managed
workspaces may require an administrator to enable it. Codes expire after at most
15 minutes. A server restart cancels pending sign-ins; start again if necessary.
Completed connections must be saved within 30 minutes.

This provider uses the Codex-compatible subscription device protocol, including
its public OAuth client, rather than the dynamic-client plan-sharing API. It
requires an eligible ChatGPT subscription/workspace and access to the offered
models. These compatibility endpoints can change independently of Akaun. Akaun
fetches the model catalog from the subscription backend; credentials are stored
server-side in the existing provider credential column. Protect database files
and backups as credentials.

After upgrading from the old ChatGPT integration, reconnect each ChatGPT provider
and select an available model. Provider names and priorities are preserved, but
old credentials cannot be reused with the new API. The old localhost callback
and callback-paste flow have been removed. No callback URL, extra inbound port,
or `ORIGIN` adjustment is needed for device login. `ORIGIN` should still match
Akaun's public URL for normal reverse-proxy operation.

The server needs outbound HTTPS access to `auth.openai.com` and `chatgpt.com`.
Deleting a provider disconnects it in Akaun; manage upstream sessions in ChatGPT.
See [Codex authentication](https://learn.chatgpt.com/docs/auth) for account and
workspace device-login requirements.

## Tech Stack

For the curious: Akaun is built with [SvelteKit](https://kit.svelte.dev/) (Svelte 5) and runs on the [Bun](https://bun.sh) runtime. Data is stored in **SQLite** via the [Drizzle ORM](https://orm.drizzle.team/), styling is [Tailwind CSS](https://tailwindcss.com/), and live updates are pushed to the browser over Server-Sent Events. Receipt import uses [Tesseract.js](https://github.com/naptha/tesseract.js) to OCR the raw text off a photo/PDF, then an LLM (via the [Vercel AI SDK](https://sdk.vercel.ai/), bring-your-own-key against OpenRouter, Google AI Studio, or Groq) turns that text into structured amount/date/supplier/category fields. PDFs (quotations, invoices, claim summaries) are generated with pdfkit/jsPDF from user-customizable templates.

## MCP access

Akaun exposes read-only bookkeeping tools at `/mcp`. Agents can query records, accounts, contacts, outstanding amounts, financial reports and Auto Import jobs, and suggest standardized descriptions for manual review.

### Connect using OAuth

For clients supporting MCP OAuth, enable it in the server environment and restart Akaun:

```env
ORIGIN=https://books.example.com
OAUTH_ENABLED=true
```

Use your own public HTTPS address. `PUBLIC_BASE_URL` defaults to `ORIGIN`; if set separately, it must match. Database migrations apply automatically on startup. A tunnel or reverse proxy must forward OAuth/discovery endpoints and `/mcp` without an additional access-login barrier.

Add `https://books.example.com/mcp` to your client's MCP settings and select OAuth. Clients supporting dynamic registration obtain their client ID automatically; Akaun supports public clients and clients using Basic or form-based client-secret authentication. Sign in with your Akaun account, then choose the read permissions to approve. OAuth scopes always limit access, including for superusers, and current group permissions still apply. These OAuth credentials work only on MCP.

Manage or revoke a connection under **Profile → Connected apps**. See [OAuth setup and verification](dev-notes/OAUTH.md) for configuration, client registration and deployment checks.

### Connect using an API token

1. Open **Users & Groups** in Akaun and create a dedicated integration user. Assign it a group with **View** permissions for Records, Accounts, Contacts, Reports and Auto Import, or just the features the agent needs. Keep it out of superuser groups and leave Add/Change/Delete permissions disabled.
2. **Issue an API token** for that user and copy the one-time reveal into your client's secret configuration. This token inherits the user's REST permissions too, so a restricted integration user matters even though MCP itself is read-only.
3. Add an MCP server to your client using these connection settings:

   | Setting        | Value                                                                   |
   | -------------- | ----------------------------------------------------------------------- |
   | Transport      | Streamable HTTP                                                         |
   | Server URL     | Your Akaun URL followed by `/mcp`, e.g. `https://books.example.com/mcp` |
   | Authentication | HTTP header `Authorization: Bearer <your-api-token>`                    |

MCP Inspector supports this endpoint with Protocol Era **Modern** (2026-07-28), **Auto**, or **Legacy**. Select **Modern** or **Auto** to verify modern support; the same URL and bearer token work in both eras.

For the default local Docker setup, the URL is `http://localhost:6969/mcp`. Use HTTPS for remote connections. The client must be able to reach the Akaun server; a client running on another machine needs that server's reachable address instead of `localhost`.

### Codex example

Add the following to your Codex MCP configuration, replacing the URL with your Akaun address:

```toml
[mcp_servers.akaun]
url = "https://books.example.com/mcp"
bearer_token_env_var = "AKAUN_MCP_TOKEN"
```

Set `AKAUN_MCP_TOKEN` to the issued token in the environment of the Codex process, then restart or reconnect the client so it loads the configuration. Keep the token out of committed configuration files.

Once connected, try asking: **“Show my expenses for September 2026 by category”** or **“Which suppliers still have unpaid records?”** The client discovers only tools allowed by the integration user's permissions.

### Connection troubleshooting

- **401 Unauthorized:** check the bearer token and whether it has been revoked or regenerated. Browser login cookies do not authenticate MCP.
- **403 Forbidden:** check the integration user's View permissions. If your client sends an `Origin` header, it must exactly match Akaun's public origin, including scheme and port; configure `ORIGIN` correctly behind a reverse proxy.
- **Client asks for OAuth login:** enable `OAUTH_ENABLED=true` with the correct public HTTPS `ORIGIN`, restart, then reconnect. Discovery endpoints must be publicly reachable.
- **GET returns 405:** the endpoint uses stateless Streamable HTTP with POST requests. Select Streamable HTTP in your client rather than a legacy SSE transport.

See [MCP setup and tool reference](dev-notes/MCP.md) for connection details, permissions, financial semantics and limits.

## Development

```sh
bun install
bun run dev        # start the dev server
bun run check      # type-check
bun run lint       # formatting + lint checks
bun run test       # unit tests
```

See `CLAUDE.md` for the project's architecture conventions (real-time update pattern, UI component standards, etc.) if you're contributing.

## License

Akaun is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. You're free to self-host, use, and modify it for personal or commercial purposes. The AGPL's key condition is that if you run a modified version of Akaun as a network service for others, you must make the complete source code of your modified version available to those users. See [`LICENSE`](./LICENSE) for the full terms.
