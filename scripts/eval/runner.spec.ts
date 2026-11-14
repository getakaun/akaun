import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { estimateRun, formatEstimate, parseArgs, usd } from "./run.ts";

// The runner end to end, each piece in a child process the way a real run
// starts it: no `.env`, no API key in the environment, books under
// os.tmpdir(). The scripted model (`fake:…`), `--null` and the refusals
// below never reach the network.

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SLOW = 180_000;
const CLI = [
  "--no-env-file",
  "--preload",
  "./scripts/eval/preload.ts",
  "scripts/eval/run.ts",
];

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NO_COLOR: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "akaun-eval-runner-spec-"));
}

function rows(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, "results.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("bun run eval:mcp", () => {
  it(
    "runs a scripted model against v2: a results row with metrics, a trace, the verifier's notes, and the real book untouched",
    async () => {
      const out = join(scratch(), "out");
      try {
        const result = await run([
          ...CLI,
          "--task",
          "D13",
          "--model",
          "fake:list_accounts",
          "--surface",
          "v2",
          "--out",
          out,
          "--yes",
        ]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "Surface v2 (akaun_verb_noun): 28 tools",
        );
        const state = JSON.parse(
          readFileSync(join(out, "_state.json"), "utf8"),
        );
        expect(state.train_ids).toHaveLength(20);
        expect(state.test_ids).toEqual(["H1", "H2", "H3", "H4", "H5", "H6"]);
        const [row] = rows(join(out, "v1")) as {
          prompt_id: string;
          grade: Record<string, number>;
          model: string;
          tool_calls: number;
          tool_errors: number;
          usage: { input_tokens: number };
          meta: {
            calls: {
              tool: string;
              isError: boolean;
              latencyMs: number;
              outputBytes: number;
            }[];
            notes: string[];
            safety: Record<string, boolean>;
            tool_surface_hash: string;
            stop: string;
          };
        }[];
        expect(row.prompt_id).toBe("D13");
        expect(row.model).toBe("fake:list_accounts");
        expect([row.tool_calls, row.tool_errors]).toEqual([1, 0]);
        expect(row.usage.input_tokens).toBeGreaterThan(0);
        expect(row.meta.calls[0]).toMatchObject({
          tool: "akaun_list_accounts",
          isError: false,
        });
        expect(row.meta.calls[0].outputBytes).toBeGreaterThan(100);
        expect(row.meta.stop).toBe("end_turn");
        expect(row.meta.tool_surface_hash).toMatch(/^[a-f0-9]{64}$/);
        // The verifier ran, and failed the scripted answer.
        expect(row.grade.pass).toBe(0);
        expect(row.meta.notes[0]).toMatch(
          /^FAIL: the answer should give August/,
        );
        // The data guard: the real book's files did not change, and no default path was used.
        expect(row.meta.safety).toEqual({
          real_data_unchanged: true,
          default_storage_used: false,
          default_database_created: false,
        });
        const trace = JSON.parse(
          readFileSync(join(out, "v1", "traces", "D13_rep0.json"), "utf8"),
        ) as { role: string; name?: string }[];
        expect(trace.map((turn) => turn.role)).toEqual([
          "system",
          "user",
          "tool_call",
          "tool_result",
          "assistant",
        ]);
        expect(trace[2].name).toBe("akaun_list_accounts");
        expect(
          JSON.parse(readFileSync(join(out, "v1", "tools.json"), "utf8")).tools,
        ).toHaveLength(28);
        expect(existsSync(join(out, "v1", "errors.jsonl"))).toBe(false);
        for (const file of [
          "results.jsonl",
          "summary.json",
          "tools.json",
          "traces/D13_rep0.json",
        ])
          expect(readFileSync(join(out, "v1", file), "utf8")).not.toMatch(
            /akp_[A-Za-z0-9]{6}/,
          );
      } finally {
        rmSync(join(out, ".."), { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "--null verifies the untouched book, and every task fails",
    async () => {
      const out = join(scratch(), "out");
      try {
        const result = await run([
          ...CLI,
          "--null",
          "--task",
          "D01,H2",
          "--out",
          out,
          "--yes",
        ]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          "every task failed on the untouched book",
        );
        const results = rows(join(out, "v1")) as {
          prompt_id: string;
          grade: { pass: number };
          tool_calls: number;
        }[];
        expect(
          results.map((r) => [r.prompt_id, r.grade.pass, r.tool_calls]).sort(),
        ).toEqual([
          ["D01", 0, 0],
          ["H2", 0, 0],
        ]);
      } finally {
        rmSync(join(out, ".."), { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "prints the cost estimate and starts nothing when --max-usd cannot cover a trial, or when there is no API key",
    async () => {
      const out = join(scratch(), "out");
      try {
        const capped = await run([
          ...CLI,
          "--task",
          "D01",
          "--model",
          "claude-sonnet-5-5",
          "--max-usd",
          "0.01",
          "--out",
          out,
        ]);
        expect(capped.code).toBe(1);
        expect(capped.stdout).toContain("Estimated cost");
        expect(capped.stdout).toMatch(
          /claude-sonnet-5-5\s+1 trials × ~\$\d+\.\d\d/,
        );
        expect(capped.stderr).toContain("does not cover even one trial");
        expect(existsSync(out)).toBe(false);

        const keyless = await run([
          ...CLI,
          "--task",
          "D01",
          "--model",
          "claude-sonnet-5-5",
          "--max-usd",
          "100",
          "--out",
          out,
        ]);
        expect(keyless.code).toBe(2);
        expect(keyless.stdout).toContain("Estimated cost");
        expect(keyless.stderr).toContain("ANTHROPIC_API_KEY is not set");
        expect(existsSync(out)).toBe(false);
      } finally {
        rmSync(join(out, ".."), { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

// A FAKE checkout under a fresh temp folder: a `.git`, a `package.json` and a
// `data/` holding a sentinel book. Nothing here names the real checkout.
function fakeCheckout(): { root: string; repo: string; data: string } {
  const root = realpathSync(scratch());
  const repo = join(root, "checkout");
  const data = join(repo, "data");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(repo, "package.json"), "{}");
  writeFileSync(join(data, "akaun.db"), "the real book");
  writeFileSync(join(data, "akaun.db-wal"), "its log");
  return { root, repo, data };
}

/** Every file under `dir` with its contents, to show nothing changed. */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, entry);
    out[entry] = statSync(path).isDirectory()
      ? "<dir>"
      : readFileSync(path, "utf8");
  }
  return out;
}

describe("the harness writes and deletes only its own temp folders (review M2)", () => {
  it(
    "TMPDIR at a checkout with a leftover AKAUN_EVAL_TRIAL_DIR at its data/: refused, nothing deleted",
    async () => {
      const fake = fakeCheckout();
      const before = contents(fake.repo);
      try {
        const result = await run(
          [
            ...CLI,
            "--null",
            "--task",
            "D01",
            "--out",
            join(fake.root, "out"),
            "--yes",
          ],
          { TMPDIR: fake.repo, AKAUN_EVAL_TRIAL_DIR: fake.data },
        );
        expect(result.code).not.toBe(0);
        expect(contents(fake.repo)).toEqual(before);
        expect(existsSync(join(fake.root, "out"))).toBe(false);
      } finally {
        rmSync(fake.root, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "TMPDIR at a checkout or inside its data/: refused before anything is made there",
    async () => {
      const fake = fakeCheckout();
      const before = contents(fake.repo);
      try {
        for (const tmp of [fake.repo, fake.data]) {
          const result = await run(
            [
              ...CLI,
              "--null",
              "--task",
              "D01",
              "--out",
              join(fake.root, "out"),
              "--yes",
            ],
            { TMPDIR: tmp },
          );
          expect({ tmp, code: result.code }).toEqual({ tmp, code: 78 });
          expect(result.stderr).toContain("temp");
        }
        expect(contents(fake.repo)).toEqual(before);
        expect(existsSync(join(fake.root, "out"))).toBe(false);
      } finally {
        rmSync(fake.root, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "run.ts refuses an inherited AKAUN_EVAL_TRIAL_DIR, even a safe one, and leaves it alone",
    async () => {
      const dir = realpathSync(scratch());
      const trial = join(dir, "leftover-trial");
      mkdirSync(trial);
      writeFileSync(join(trial, "keep.txt"), "keep");
      try {
        const result = await run(
          [
            ...CLI,
            "--null",
            "--task",
            "D01",
            "--out",
            join(dir, "out"),
            "--yes",
          ],
          { AKAUN_EVAL_TRIAL_DIR: trial },
        );
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("AKAUN_EVAL_TRIAL_DIR");
        expect(contents(trial)).toEqual({ "keep.txt": "keep" });
        expect(existsSync(join(dir, "out"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "--out into a checkout's data/ or anywhere in a checkout is refused, and nothing is written",
    async () => {
      const fake = fakeCheckout();
      const before = contents(fake.repo);
      try {
        for (const out of [
          fake.data,
          join(fake.data, "eval"),
          join(fake.repo, "work", "eval-mcp"),
          fake.repo,
        ]) {
          const result = await run([
            ...CLI,
            "--null",
            "--task",
            "D01",
            "--out",
            out,
            "--yes",
          ]);
          expect({ out, code: result.code }).toEqual({ out, code: 2 });
          expect(result.stderr).toContain("--out");
        }
        expect(contents(fake.repo)).toEqual(before);
      } finally {
        rmSync(fake.root, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "a normal run under a clean TMPDIR works and leaves only its results behind",
    async () => {
      const tmp = realpathSync(scratch());
      const out = join(tmp, "results");
      try {
        const result = await run(
          [...CLI, "--null", "--task", "D01", "--out", out, "--yes"],
          { TMPDIR: tmp },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(rows(join(out, "v1"))).toHaveLength(1);
        // The process sandbox, its templates and the trial folder are gone.
        expect(
          readdirSync(tmp).filter((name) => name.startsWith("akaun-eval")),
        ).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

describe("the safety preload", () => {
  it(
    "refuses a trial directory outside os.tmpdir()",
    async () => {
      for (const dir of ["/", "/usr/local", "relative/trial"]) {
        const result = await run(
          [
            "--no-env-file",
            "--preload",
            "./scripts/eval/preload.ts",
            "-e",
            "console.log('ran')",
          ],
          { AKAUN_EVAL_TRIAL_DIR: dir },
        );
        expect({ dir, code: result.code }).toEqual({ dir, code: 78 });
        expect(result.stdout).not.toContain("ran");
        expect(result.stderr).toContain("temp directory");
      }
    },
    SLOW,
  );

  it(
    "inside a trial directory: $env points into it, fetch reaches only the API, and the configured database and default store throw",
    async () => {
      const dir = scratch();
      try {
        const probe = join(dir, "probe.ts");
        writeFileSync(
          probe,
          `
const out: Record<string, unknown> = {};
const { env } = await import("$env/dynamic/private");
out.storage = env.STORAGE_PATH;
out.database = env.DATABASE_PATH;
out.logLevel = process.env.LOG_LEVEL;
try { await fetch("https://example.com/"); out.fetch = "allowed"; } catch (e) { out.fetch = String(e); }
try { await import(${JSON.stringify(join(REPO, "src/lib/server/db/client.ts"))}); out.db = "loaded"; } catch (e) { out.db = String(e); }
try { await import(${JSON.stringify(join(REPO, "src/lib/server/oauth/runtime.ts"))}); out.oauth = "loaded"; } catch (e) { out.oauth = String(e); }
const storage = await import(${JSON.stringify(join(REPO, "src/lib/server/file-storage.ts"))});
try { storage.fileStore(); out.store = "made"; } catch (e) { out.store = String(e); }
out.sandbox = (globalThis as Record<symbol, { dir: string; isTrial: boolean; checkRealData(): string[] }>)[Symbol.for("akaun.eval.sandbox")];
out.unchanged = (out.sandbox as { checkRealData(): string[] }).checkRealData();
console.log(JSON.stringify(out));
`,
        );
        const trialDir = join(dir, "trial");
        const result = await run(
          ["--no-env-file", "--preload", "./scripts/eval/preload.ts", probe],
          { AKAUN_EVAL_TRIAL_DIR: trialDir },
        );
        expect(result.code, result.stderr).toBe(0);
        const out = JSON.parse(
          result.stdout.trim().split("\n").at(-1)!,
        ) as Record<string, unknown> & {
          sandbox: { dir: string; isTrial: boolean };
        };
        expect(out.sandbox.isTrial).toBe(true);
        expect(String(out.storage).startsWith(out.sandbox.dir)).toBe(true);
        expect(String(out.database).startsWith(out.sandbox.dir)).toBe(true);
        expect(out.logLevel).toBe("warn");
        expect(out.fetch).toContain("only to https://api.anthropic.com");
        expect(out.db).toContain("must not load db/client.ts");
        expect(out.oauth).toContain("must not load oauth/runtime.ts");
        expect(out.store).toContain("must not use the default file store");
        expect(out.unchanged).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    "a trial will not start without it",
    async () => {
      // Without the preload, `$env/dynamic/private` cannot even be resolved.
      const result = await run([
        "--no-env-file",
        "scripts/eval/trial.ts",
        "/tmp/x",
        "D01",
        "null",
        "high",
        "0",
        "v2",
        "akaun_verb_noun",
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/preload\.ts|\$env\/dynamic\/private/);
    },
    SLOW,
  );
});

describe("the command line", () => {
  it("needs a priced model for a model run, and no model for --null or --oracle", () => {
    expect(() => parseArgs([])).toThrow(/--model/);
    expect(() => parseArgs(["--model", "claude-mystery-1"])).toThrow(
      /No price is known/,
    );
    expect(() => parseArgs(["--null", "--model", "claude-sonnet-5-5"])).toThrow(
      /runs no model/,
    );
    expect(() =>
      parseArgs([
        "--model",
        "claude-sonnet-5-5,claude-opus-5-5",
        "--round",
        "baseline",
      ]),
    ).toThrow(/one model/);
    expect(() =>
      parseArgs(["--model", "claude-sonnet-5-5", "--effort", "extreme"]),
    ).toThrow(/--effort/);
    expect(() =>
      parseArgs(["--model", "claude-sonnet-5-5", "--surprise"]),
    ).toThrow(/Unknown option/);
    // A paid run must name a folder that is kept; --null and --oracle need not.
    expect(() => parseArgs(["--model", "claude-sonnet-5-5"])).toThrow(/--out/);
    expect(() => parseArgs(["--null"])).not.toThrow();
    const options = parseArgs([
      "--",
      "--task",
      "D05,D08",
      "--out",
      "/tmp/akaun-eval-spec-out",
      "--model=claude-sonnet-5-5",
      "--reps",
      "3",
      "--surface",
      "v2",
      "--naming",
      "plain",
      "--max-usd",
      "20",
      "--yes",
    ]);
    expect(options).toMatchObject({
      ids: ["D05", "D08"],
      models: ["claude-sonnet-5-5"],
      reps: 3,
      surface: "v2",
      naming: "plain",
      maxUsd: 20,
      yes: true,
      effort: "high",
      concurrency: 4,
      mode: "model",
    });
    expect(parseArgs(["--null", "--split", "all"])).toMatchObject({
      mode: "null",
      split: "all",
      models: [],
      surface: "v2",
    });
    // v1 was deleted with its server; its baseline runs from the tag.
    expect(() =>
      parseArgs(["--model", "claude-sonnet-5-5", "--surface", "v1"]),
    ).toThrow("v1 was removed; check out the tag mcp-v1-baseline to run it");
    expect(() =>
      parseArgs(["--model", "claude-sonnet-5-5", "--surface", "v3"]),
    ).toThrow(/Unknown surface v3/);
    expect(parseArgs(["--serve", "--book", "B"])).toMatchObject({
      serve: true,
      book: "B",
    });
  });

  it("estimates per model and says where it will stop", () => {
    const estimates = estimateRun({
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      trials: 26,
      effort: "high",
      prefixTokens: 20_000,
    });
    expect(estimates[0].totalUsd).toBeCloseTo(estimates[0].perTrialUsd * 26, 9);
    expect(estimates[1].perTrialUsd).toBeLessThan(estimates[0].perTrialUsd);
    const text = formatEstimate(estimates, 20);
    expect(text).toContain("claude-opus-5-5");
    expect(text).toContain("--max-usd $20.00");
    expect(usd(0.0001)).toBe("$0.0001");
    expect(usd(12.5)).toBe("$12.50");
  });
});
