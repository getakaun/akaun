import { plugin } from "bun";
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Vitest 4's worker startup is currently incompatible with Bun in this
// workspace. The MCP fixture specs use only these shared test APIs, so they
// can also run directly under Bun, without changing the default Vitest suite.
// This adapter deliberately provides no mocking or browser-test emulation.
plugin({
  name: "akaun-mcp-test-api",
  setup(builder) {
    builder.onResolve({ filter: /^vitest$/ }, () => ({
      path: "vitest",
      namespace: "akaun-mcp-test-api",
    }));
    builder.onLoad({ filter: /.*/, namespace: "akaun-mcp-test-api" }, () => ({
      contents:
        'export { afterEach, beforeEach, describe, expect, it } from "bun:test";',
      loader: "js",
    }));
  },
});

// SvelteKit's `$env/dynamic/private` does not exist outside Vite, so a module
// that reads `STORAGE_PATH` or `DATABASE_PATH` at load (`env.ts`, and through
// it `file-storage.ts`) could not be imported here at all. It is stood in for
// with a fresh folder under the OS temp dir — never the real `data/` that
// `.env` names (CLAUDE.md, Verification Policy). (A Bun plugin cannot resolve
// a specifier that names no file; `mock.module` can.)
const sandbox = mkdtempSync(join(tmpdir(), "akaun-mcp-test-"));
mock.module("$env/dynamic/private", () => ({
  env: {
    STORAGE_PATH: join(sandbox, "storage"),
    DATABASE_PATH: join(sandbox, "never-opened.db"),
  },
}));

// The one module that opens the configured database. Nothing a spec imports
// may reach it: fail loudly rather than open anything.
const refuseDb = () => {
  throw new Error(
    "MCP tests must not load db/client.ts: it opens the configured database.",
  );
};
mock.module(resolve(import.meta.dir, "../src/lib/server/db/client.ts"), refuseDb);
mock.module("$lib/server/db/client.js", refuseDb);
