---
sidebar_position: 1
---

# Install Akaun

Use this page to install Akaun on your own server. You do this one time, before the first user
signs in. After the installation, each user opens Akaun in a web browser.

## Before you start

You need:

- A computer or server that stays on. All users connect to it.
- The address that the users will type in the browser, for example `http://192.168.1.20:6969`
  or `https://books.example.com`.
- For a Docker installation: [Docker](https://docs.docker.com/get-docker/) with Docker Compose.
- For an installation from the source code: [Bun](https://bun.sh) version 1.2 or later, and Git.

You can install Akaun in two ways. Docker is the easier way, and we recommend it.

## Install with Docker

1. Make a new folder for Akaun on the server.
2. In this folder, make a file with the name `docker-compose.yml`.
3. Copy this text into the file:

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
         - PUID=1000
         - PGID=1000
         - BODY_SIZE_LIMIT=21M
   ```

4. Change the value of `ORIGIN` to the address that the users will type.
5. On Linux, type `id -u` and `id -g` to find your user ID and group ID.
6. Change the values of `PUID` and `PGID` to these two numbers.
7. In the same folder, type this command:

   ```sh
   docker compose up -d
   ```

8. Open the address in a web browser.

The sign-in page opens and shows **Welcome back**. Docker makes a `data` folder next to
`docker-compose.yml`. This folder holds all the data of your book.

To add more settings, add more lines under `environment:`. The
[environment variables](#environment-variables) table gives each setting.

## Install from the source code

1. Get the code:

   ```sh
   git clone https://github.com/getakaun/akaun.git
   ```

2. Go into the folder of the code:

   ```sh
   cd akaun
   ```

3. Install the packages:

   ```sh
   bun install
   ```

4. If `bun install` stops with an error about `argon2`, install Python 3, `make` and a C++
   compiler. Then do step 3 again.
5. Build the application:

   ```sh
   bun run build
   ```

6. Copy the file `.env.example` to a new file with the name `.env`.
7. Open `.env` and add a line for `ORIGIN`, for example `ORIGIN=http://192.168.1.20:3000`.
8. Change the other values in `.env` if necessary. The
   [environment variables](#environment-variables) table gives each setting.
9. In the same folder, start the server:

   ```sh
   bun server.js
   ```

10. Open the address in a web browser.

The server shows `Listening on http://0.0.0.0:3000`. The sign-in page opens and shows
**Welcome back**.

Always start `bun server.js` from the folder of the code. Akaun finds its database changes in
this folder. With the default settings, Akaun also keeps the data in the `data` folder here.

The command stops when you close the terminal. Use the service manager of your server, for
example systemd, to start Akaun again after each restart of the server.

## Environment variables

Bun reads the `.env` file in the folder of the code. For Docker, put each setting under
`environment:` in `docker-compose.yml`.

| Variable | Default | What it does |
|---|---|---|
| `ORIGIN` | (none) | The full address that the users type, for example `https://books.example.com`. Akaun refuses sign-in and saves from a different address. |
| `PORT` | `3000` (Docker: `6969`) | The network port that Akaun listens on. |
| `HOST` | `0.0.0.0` | The network address that Akaun listens on. `0.0.0.0` accepts connections on all network addresses. |
| `DATABASE_PATH` | `./data/akaun.db` (Docker: `/app/data/akaun.db`) | The location of the database file. A relative path starts at the folder where you start the server. |
| `STORAGE_PATH` | `./data/storage` (Docker: `/app/data/storage`) | The folder for the files that users upload, for example receipts and attachments. |
| `BODY_SIZE_LIMIT` | `21M` in `.env.example` and in Docker | The largest request that the server accepts. Akaun accepts files up to 15 MB. An AI assistant sends a file in a larger, encoded form, so a 15 MB file needs about 21 MB. Do not set a value smaller than `15M`; below `21M`, assistants cannot attach the largest files. If you remove this setting, the limit is 512 KB and most uploads fail. |
| `LOG_LEVEL` | `info` in `.env.example` and in Docker | How much the server writes to its log: `trace`, `debug`, `info`, `warn` or `error`. A `trace` log can contain your financial data. Use it only for a short time. |
| `SSL_ENABLED` | `false` | Set to `true` to serve Akaun over HTTPS without a reverse proxy. |
| `SSL_KEY_PATH` | (none) | The path to the private key file. Necessary when `SSL_ENABLED` is `true`. |
| `SSL_CERT_PATH` | (none) | The path to the certificate file. Necessary when `SSL_ENABLED` is `true`. |
| `OAUTH_ENABLED` | `false` | Set to `true` to let AI assistants connect with OAuth. See [Connect AI assistants](../09-administration/connect-ai-assistants.md). |
| `PUBLIC_BASE_URL` | the value of `ORIGIN` | The public address for OAuth. If you set it, it must be the same as `ORIGIN`. |
| `AUTH_ISSUER` | the public address | For OAuth only. If you set it, it must be the public address. |
| `MCP_RESOURCE` | the public address with `/mcp` | For OAuth only. If you set it, it must be the public address with `/mcp` at the end. |
| `PUID`, `PGID` | `1000` | Docker only. The user ID and group ID that own the `data` folder. |

:::caution

Make sure that `ORIGIN` is the exact address in the browser, with `http` or `https` and the
port. If the two are different, sign-in fails with `Forbidden (CSRF origin check failed)`.

:::

The Docker image sets `NODE_ENV=production`. Then the browser keeps the sign-in only on an
HTTPS address or on `localhost`. If the users connect over plain HTTP to a different address,
use HTTPS.

## Where your data is

Akaun keeps all the data of your book in two places:

- The database: the file at `DATABASE_PATH`, for example `akaun.db`. Two more files
  are next to it: `akaun.db-wal` and `akaun.db-shm`. The three files are one database. The
  `-wal` file can contain changes that are not in `akaun.db` yet.
- The storage folder: the folder at `STORAGE_PATH`. It holds the receipts, attachments,
  uploaded documents and the company logo.

With the default settings, both are in one `data` folder.

:::caution

The `data` folder is the books of your business. Do not delete it, move it or edit it while
Akaun runs. Always copy the three database files and the storage folder together. A copy of
only `akaun.db` can lose recent records. Make a backup copy before you install a new version.
See [Backups and upgrades](../09-administration/backups-and-upgrades.md).

:::

## Notes and limits

- When a new version starts for the first time, Akaun updates the database by itself. You do not
  type a command.
- The server answers `GET /health` with a short status message. A monitor or a reverse proxy can
  use it.
- If you use a reverse proxy, for example nginx, disable buffering for the paths that end in
  `/stream`, and give them a long read timeout. Akaun sends live updates on these paths. If the
  proxy buffers them, other users' changes do not show until a reload.
- This guide does not cover the desktop app.

## Next step

[Sign in for the first time](./first-sign-in.md).
