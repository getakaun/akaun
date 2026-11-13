import { plugin } from "bun";
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { EvalSandbox, RealDataStat } from "./trial.ts";

/**
 * The safety preload of the MCP evaluation. Every process the runner starts —
 * the orchestrator (`run.ts`) and each trial (`trial.ts`) — loads it first:
 *
 *   bun --no-env-file --preload ./scripts/eval/preload.ts scripts/eval/trial.ts …
 *
 * It does what `scripts/mcp-test-preload.ts` does, for a running process
 * rather than a spec, and adds the guards a paid, model-driven run needs:
 *
 * 1. The sandbox is `AKAUN_EVAL_TRIAL_DIR`, refused unless it is inside
 *    `os.tmpdir()`; a process given none (the orchestrator) makes a fresh one
 *    there. SvelteKit's `$env/dynamic/private` points `STORAGE_PATH` and
 *    `DATABASE_PATH` inside it, so even a default path lands in a temporary
 *    folder — never the real `data/` that `.env` names (CLAUDE.md,
 *    Verification Policy).
 * 2. `db/client.ts` (which opens the configured database), the OAuth runtime
 *    (which imports it) and the default file store (`fileStore()`) throw.
 * 3. `fetch` reaches `https://api.anthropic.com` and nothing else.
 * 4. `LOG_LEVEL=warn`, so a trial's output is its own.
 * 5. The real book's files are stat-ed (size and mtime, never opened) now,
 *    and `checkRealData()` reports any change; the trial and the orchestrator
 *    call it before and after their work and abort on a change.
 *
 * Specs never import this file: they run under `scripts/mcp-test-preload.ts`
 * and start this one in a child process to test it.
 */

process.env.LOG_LEVEL = "warn";

// -- The sandbox --------------------------------------------------------------

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `dir`, made if missing and resolved through any symlink, or a thrown error
 * when it is not strictly inside the OS temp directory. Checked before the
 * folder is made and again on its real path, so neither `..` nor a symlink can
 * point a trial at another folder.
 */
function assertTrialDirectory(dir: string): string {
  const temp = realpathSync(tmpdir());
  const absolute = resolve(dir);
  if (
    !isAbsolute(dir) ||
    !(within(resolve(tmpdir()), absolute) || within(temp, absolute))
  )
    throw new Error(
      `AKAUN_EVAL_TRIAL_DIR must be an absolute path inside os.tmpdir() (${tmpdir()}), not ${dir}.`,
    );
  mkdirSync(absolute, { recursive: true });
  const real = realpathSync(absolute);
  if (!within(temp, real))
    throw new Error(
      `AKAUN_EVAL_TRIAL_DIR must be inside os.tmpdir() (${temp}); ${dir} resolves to ${real}.`,
    );
  return real;
}

const given = process.env.AKAUN_EVAL_TRIAL_DIR;
let sandboxDir: string;
try {
  sandboxDir = given
    ? assertTrialDirectory(given)
    : realpathSync(mkdtempSync(join(tmpdir(), "akaun-eval-process-")));
} catch (error) {
  console.error(
    `[eval preload] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(78);
}
/** Where a default `STORAGE_PATH` / `DATABASE_PATH` would land. Nothing should. */
const envStoragePath = join(sandboxDir, "env-default-storage");
const envDatabasePath = join(sandboxDir, "env-default-never-opened.db");

// -- Module stand-ins ---------------------------------------------------------

// The vitest adapter of `scripts/mcp-test-preload.ts`, so a module written for
// both runners can be loaded here too. It provides no mocking.
plugin({
  name: "akaun-eval-test-api",
  setup(builder) {
    builder.onResolve({ filter: /^vitest$/ }, () => ({
      path: "vitest",
      namespace: "akaun-eval-test-api",
    }));
    builder.onLoad({ filter: /.*/, namespace: "akaun-eval-test-api" }, () => ({
      contents:
        'export { afterEach, beforeEach, describe, expect, it } from "bun:test";',
      loader: "js",
    }));
  },
});

mock.module("$env/dynamic/private", () => ({
  env: {
    STORAGE_PATH: envStoragePath,
    DATABASE_PATH: envDatabasePath,
    LOG_LEVEL: "warn",
  },
}));
mock.module("$env/dynamic/public", () => ({ env: {} }));

const SERVER = resolve(import.meta.dir, "../../src/lib/server");
function refuse(what: string) {
  return () => {
    throw new Error(
      `The MCP evaluation must not load ${what}: it reaches the configured database or files.`,
    );
  };
}
mock.module(join(SERVER, "db/client.ts"), refuse("db/client.ts"));
mock.module("$lib/server/db/client.js", refuse("db/client.ts"));
mock.module(join(SERVER, "oauth/runtime.ts"), refuse("oauth/runtime.ts"));
mock.module("$lib/server/oauth/runtime.js", refuse("oauth/runtime.ts"));

// The default file store, `fileStore()`, throws; everything else in the
// module is the real code. Imported only now, after `$env` is stood in for.
const fileStorage = await import("../../src/lib/server/file-storage.ts");
const withoutDefaultStore = () => ({
  ...fileStorage,
  fileStore: () => {
    throw new Error(
      "The MCP evaluation must not use the default file store; pass ctx.store and ctx.storageRoot.",
    );
  },
});
mock.module(join(SERVER, "file-storage.ts"), withoutDefaultStore);
mock.module("$lib/server/file-storage.js", withoutDefaultStore);

// -- Network ------------------------------------------------------------------

const realFetch = globalThis.fetch;
function urlOf(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}
const guardedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  let url: URL;
  try {
    url = urlOf(input);
  } catch {
    return Promise.reject(
      new Error("The MCP evaluation refused a fetch with no valid URL."),
    );
  }
  if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com")
    return Promise.reject(
      new Error(
        `The MCP evaluation allows network calls only to https://api.anthropic.com; refused ${url.origin}.`,
      ),
    );
  return realFetch(input, init);
};
globalThis.fetch = Object.assign(guardedFetch, {
  preconnect: realFetch.preconnect,
}) as typeof fetch;

// -- The real book ------------------------------------------------------------

/**
 * The maintainer's live book, named here and nowhere else in the evaluation,
 * and only ever passed to `statSync`. The checkout this file sits in is
 * watched too, in case the book lives there.
 */
const REAL_DATA_DIRS = [
  ...new Set([
    "/Users/tanghaoquan/Code/akaun/data",
    resolve(import.meta.dir, "../../data"),
  ]),
];
const REAL_DATA_FILES = REAL_DATA_DIRS.flatMap((dir) =>
  ["akaun.db", "akaun.db-wal", "akaun.db-shm", "akaun.db-journal"].map((name) =>
    join(dir, name),
  ),
);

function statRealData(): RealDataStat[] {
  return REAL_DATA_FILES.map((path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat
      ? { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs }
      : { path, exists: false };
  });
}

const realDataBefore = statRealData();

function checkRealData(): string[] {
  const now = statRealData();
  return realDataBefore.flatMap((before, index) => {
    const after = now[index];
    if (
      before.exists === after.exists &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs
    )
      return [];
    return [
      `${before.path} changed during the evaluation (${JSON.stringify(before)} → ${JSON.stringify(after)}). The evaluation never opens it; a running Akaun app also writes it. Stopping to be safe.`,
    ];
  });
}

const sandbox: EvalSandbox = {
  dir: sandboxDir,
  isTrial: Boolean(given),
  envStoragePath,
  envDatabasePath,
  realDataBefore,
  checkRealData,
};
(globalThis as Record<symbol, unknown>)[Symbol.for("akaun.eval.sandbox")] =
  sandbox;
