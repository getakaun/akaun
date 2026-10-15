# deploy/

Container build and runtime files. Everything here expects the **repo root** as
the Docker build context, not this directory.

| File                      | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `Dockerfile`              | Multi-stage build (deps → build → slim runtime on `oven/bun:alpine`) |
| `entrypoint.sh`           | Creates the `PUID`/`PGID` user, chowns `/app/data`, drops privileges |
| `docker-compose.yml`      | Local build-from-source stack                                        |
| `docker-compose.prod.yml` | Runs the published `ghcr.io/getakaun/akaun:latest` image            |

## Local build

Run from **this directory** — compose resolves `context: ..` and the `../data`
volume relative to the file's location, so the data dir lands at the repo root:

```sh
cd deploy
docker compose up -d --build
```

Or from the repo root, pointing at the file explicitly:

```sh
docker compose -f deploy/docker-compose.yml up -d --build
```

To build the image directly, the context must be the repo root:

```sh
docker build -f deploy/Dockerfile -t akaun .
```

## Notes

- `.dockerignore` stays at the repo root — Docker only honours it at the build
  context root.
- `server.js` also stays at the repo root: it's the application entry point,
  shared by this Dockerfile's `CMD` and by the Tauri desktop sidecar
  (`src-tauri/src/lib.rs` runs `bun server.js` with the staged payload as cwd).
- `docker-compose.prod.yml` is a standalone template meant to be copied to a
  server, so its `./data` volume is intentionally relative to wherever the user
  puts it. The self-hosting guide in the root `README.md` inlines this content.

## ChatGPT subscription sign-in

Remote deployments use device-code login in Settings → Intelligence. Enable
device code login in ChatGPT Security settings or the workspace permissions,
then open the verification link and enter the code shown in Akaun. The server
needs outbound HTTPS to `auth.openai.com` and `chatgpt.com`. No loopback port
exposure or callback forwarding is required. Pending sign-ins expire on a server
restart; completed connections must be saved within 30 minutes. Existing ChatGPT
providers from earlier releases must reconnect and choose an available model.
See the repository README for integration and credential storage details.

## Business timezone

Set `TZ` to an IANA timezone such as `Asia/Kuala_Lumpur` for server-side document
dates and overdue/expiry checks. The Compose templates pass `${TZ:-Etc/UTC}`;
set it in your shell or the Compose `.env` file, or replace the value in the
service's environment. The image includes `tzdata` and defaults to `Etc/UTC`.
For source installs, set `TZ` in Akaun's `.env`. Restart after changing it.
Browser date defaults use the device timezone, so configure devices accordingly.
