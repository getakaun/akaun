import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localToday } from "../../src/lib/local-date.js";
import {
  DEFAULT_NAMING,
  type NamingScheme,
} from "../../src/lib/server/mcp/registry.js";
import { patLocals } from "../../src/lib/server/tokens/pat.js";
import {
  EVAL_INBOX,
  EVAL_RULES_TEXT,
  type EvalVariant,
} from "../../src/lib/server/mcp/__fixtures__/eval-book.js";
import {
  EFFORTS,
  emptyUsage,
  estimateTrialCost,
  isFakeModel,
  PRICES,
  type Effort,
  type RetryInfo,
} from "./agent.ts";
import {
  connectSurface,
  createSurfaceHandler,
  EVAL_ORIGIN,
  NAMINGS,
  parseSurface,
  toAnthropicTool,
  type SurfaceKind,
} from "./surfaces.ts";
import { HARNESS_TOOLS } from "./harness-tools.ts";
import {
  DEV_TASK_IDS,
  HELDOUT_TASK_IDS,
  selectTasks,
  type EvalTask,
  type TaskSplit,
} from "./tasks.ts";
import {
  appendError,
  appendResult,
  chooseVariantDir,
  finishedTrials,
  formatSummary,
  readResults,
  writeJson,
  writeState,
  writeSummary,
  writeTrace,
  type ResultRow,
  type RunConfig,
} from "./results.ts";
import { leakCheck } from "./analyze.ts";
import { checkOutDir, EVAL_PATH_RULES } from "./safe-paths.ts";
import {
  buildTemplate,
  ENV,
  evalSandbox,
  loadOracles,
  openBookCopy,
  readTemplate,
  systemPrompt,
  type EvalSandbox,
  type TemplateInfo,
  type TrialOutcome,
} from "./trial.ts";

/**
 * The evaluation runner.
 *
 *   bun run eval:mcp -- --split dev --model claude-sonnet-5-5 --reps 3 --max-usd 20
 *
 * Builds each variant of the test book once into a template under the OS
 * temp directory, then runs every (task, model, repetition) as its own child
 * process (`trial.ts`) with an allow-listed environment and no `.env`, up to
 * `--concurrency` at a time. Results land in `--out` (default
 * `<os temp dir>/akaun-eval-mcp`), which is refused in any checkout or data
 * folder (`safe-paths.ts`). The runner refuses an `AKAUN_EVAL_TRIAL_DIR` in
 * its own environment, and deletes only folders it made with `mkdtemp`
 * (`sandbox.temp`). Before any paid call it prints an
 * estimate and asks to go on (unless `--yes`), and it stops starting trials
 * when `--max-usd` would be passed. `--serve` instead serves a temporary book
 * to real clients. Nothing here reads `.env` or touches the real `data/`.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The results folder's name in the OS temp directory when --out is not given. */
const DEFAULT_OUT_NAME = "akaun-eval-mcp";
/** A trial that runs this long is stopped. */
const TRIAL_TIMEOUT_MS = 45 * 60 * 1000;

export const USAGE = `Usage: bun run eval:mcp -- [options]

Choose tasks
  --task D05,D08            run exactly these tasks (overrides --split)
  --tag uc7[,uc9]           only tasks with one of these tags
  --split dev|heldout|all   default dev

Choose the agent
  --model <id>[,<id>…]      required for a model run, e.g. claude-sonnet-5-5
                            (fake:<tool>,… is a scripted model that costs nothing)
  --effort low|medium|high|xhigh|max      default high
  --null                    no model: verify the untouched book (every task must fail)
  --oracle                  run each task's oracle from scripts/eval/oracles.ts

Choose the tools
  --surface v2              default v2 (v1 was removed; its baseline runs from the tag mcp-v1-baseline)
  --naming akaun_verb_noun|akaun_noun_verb|plain   v2 only, default akaun_verb_noun

Run
  --reps N                  default 1
  --concurrency N           default 4
  --max-usd X               spending cap, default 10
  --yes                     do not ask before spending
  --out <dir>               results folder, never in a checkout or a data folder;
                            required for a model run (for example ~/akaun-eval);
                            --null and --oracle default to ${DEFAULT_OUT_NAME} in
                            the OS temp directory, which the OS clears
  --round baseline|vN       name the result directory (default: the next vN)
  --resume                  add to the latest directory with the same configuration
  --keep                    keep each trial's temporary book

Serve a temporary book to a real client instead
  --serve [--book A|B] [--port N] [--surface …] [--naming …]
`;

export type RunOptions = {
  ids: string[];
  tags: string[];
  split: TaskSplit | "all";
  models: string[];
  effort: Effort;
  mode: "model" | "null" | "oracle";
  surface: SurfaceKind;
  naming: NamingScheme;
  reps: number;
  concurrency: number;
  maxUsd: number;
  yes: boolean;
  outDir: string;
  round?: string;
  resume: boolean;
  keep: boolean;
  serve: boolean;
  book: EvalVariant;
  port: number;
};

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** Parses the CLI. Throws a message for anything it does not understand. */
export function parseArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = {
    ids: [],
    tags: [],
    split: "dev",
    models: [],
    effort: "high",
    mode: "model",
    surface: "v2",
    naming: DEFAULT_NAMING,
    reps: 1,
    concurrency: 4,
    maxUsd: 10,
    yes: false,
    outDir: "",
    resume: false,
    keep: false,
    serve: false,
    book: "A",
    port: 0,
  };
  const flags = new Set(["yes", "null", "oracle", "serve", "resume", "keep"]);
  const valued = new Set([
    "task",
    "tag",
    "split",
    "model",
    "effort",
    "surface",
    "naming",
    "reps",
    "concurrency",
    "max-usd",
    "out",
    "round",
    "book",
    "port",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}.`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!flags.has(name) && !valued.has(name))
      throw new Error(`Unknown option --${name}.`);
    if (flags.has(name)) {
      if (name === "yes") options.yes = true;
      else if (name === "null") options.mode = "null";
      else if (name === "oracle") options.mode = "oracle";
      else if (name === "serve") options.serve = true;
      else if (name === "resume") options.resume = true;
      else options.keep = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    const number = (min: number) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < min)
        throw new Error(`--${name} must be a number of at least ${min}.`);
      return n;
    };
    switch (name) {
      case "task":
        options.ids = list(value);
        break;
      case "tag":
        options.tags = list(value);
        break;
      case "split":
        if (!["dev", "heldout", "all"].includes(value))
          throw new Error("--split is dev, heldout or all.");
        options.split = value as RunOptions["split"];
        break;
      case "model":
        options.models = list(value);
        break;
      case "effort":
        if (!(EFFORTS as readonly string[]).includes(value))
          throw new Error(`--effort is one of ${EFFORTS.join(", ")}.`);
        options.effort = value as Effort;
        break;
      case "surface":
        options.surface = parseSurface(value);
        break;
      case "naming":
        if (!(NAMINGS as readonly string[]).includes(value))
          throw new Error(`--naming is one of ${NAMINGS.join(", ")}.`);
        options.naming = value as NamingScheme;
        break;
      case "reps":
        options.reps = Math.floor(number(1));
        break;
      case "concurrency":
        options.concurrency = Math.floor(number(1));
        break;
      case "max-usd":
        options.maxUsd = number(0);
        break;
      case "out":
        options.outDir = value;
        break;
      case "round":
        options.round = value;
        break;
      case "book":
        if (value !== "A" && value !== "B")
          throw new Error("--book is A or B.");
        options.book = value;
        break;
      case "port":
        options.port = Math.floor(number(0));
        break;
      default:
        throw new Error(`Unknown option --${name}.`);
    }
  }
  if (options.mode !== "model" && options.models.length)
    throw new Error(`--${options.mode} runs no model; leave out --model.`);
  if (!options.serve && options.mode === "model" && !options.models.length)
    throw new Error(
      "Name the model to evaluate with --model (for example --model claude-sonnet-5-5).",
    );
  for (const model of options.models)
    if (!isFakeModel(model) && !PRICES[model])
      throw new Error(
        `No price is known for ${model}, so its cost cannot be estimated or capped. Known: ${Object.keys(PRICES).join(", ")}.`,
      );
  if (options.round && options.models.length > 1)
    throw new Error(
      "--round names one directory; run one model at a time with it.",
    );
  // A paid run's results must outlive the OS temp directory, which the OS
  // clears: ask for a folder (checked by safe-paths: never a checkout or data).
  if (
    !options.serve &&
    options.mode === "model" &&
    !options.outDir &&
    options.models.some((model) => !isFakeModel(model))
  )
    throw new Error(
      "A model run costs money, so its results need a folder that is kept: pass --out <folder outside any checkout>, for example --out ~/akaun-eval.",
    );
  return options;
}

// -- Pieces --------------------------------------------------------------------------

function requireSandbox(): EvalSandbox {
  const sandbox = evalSandbox();
  if (!sandbox)
    throw new Error(
      "run.ts must be started through `bun run eval:mcp` (it needs scripts/eval/preload.ts).",
    );
  if (sandbox.isTrial || !sandbox.temp.owns(sandbox.dir))
    throw new Error(
      "run.ts is the orchestrator: its sandbox must be one the preload made, never a trial directory.",
    );
  return sandbox;
}

/**
 * The checked results folder: `--out`, or the default in the OS temp
 * directory. Refused in any checkout or data folder, and inside this
 * process's sandbox (deleted at the end).
 */
function resultsDir(options: RunOptions, sandbox: EvalSandbox): string {
  const out = checkOutDir(
    options.outDir || join(sandbox.temp.root, DEFAULT_OUT_NAME),
    EVAL_PATH_RULES,
  );
  if (out === sandbox.dir || out.startsWith(`${sandbox.dir}/`))
    throw new Error(
      `--out ${options.outDir} is refused: it is inside this run's temporary sandbox, which is deleted at the end.`,
    );
  return out;
}

function assertRealDataUnchanged(sandbox: EvalSandbox): void {
  const changed = sandbox.checkRealData();
  if (changed.length) {
    console.error(changed.join("\n"));
    process.exit(3);
  }
}

/** Builds the templates the tasks need, once each, in the sandbox. */
async function buildTemplates(
  sandbox: EvalSandbox,
  variants: Iterable<EvalVariant>,
): Promise<Map<EvalVariant, string>> {
  const today = localToday();
  const dirs = new Map<EvalVariant, string>();
  for (const variant of new Set(variants)) {
    const dir = join(sandbox.dir, "templates", variant);
    await buildTemplate(dir, variant, today);
    dirs.set(variant, dir);
  }
  return dirs;
}

type Listing = {
  hash: string;
  tools: Awaited<ReturnType<typeof connectSurface>>["tools"];
  instructions: string;
  /** Tools and system prompt, in approximate tokens. */
  prefixTokens: number;
};

/** The surface as the agent's token sees it, from a scratch copy of a template. */
async function listSurface(
  sandbox: EvalSandbox,
  templateDir: string,
  surface: SurfaceKind,
  naming: NamingScheme,
): Promise<Listing> {
  const template = readTemplate(templateDir);
  const scratch = sandbox.temp.make(sandbox.dir, "listing-");
  const book = openBookCopy(
    templateDir,
    join(scratch, "book"),
    template.manifest,
  );
  try {
    const locals = patLocals(book.db, `Bearer ${template.agentToken}`);
    if (!locals) throw new Error("The template's agent token was refused.");
    const connection = await connectSurface(
      { surface, naming },
      {
        db: book.db,
        locals,
        store: book.store,
        storageRoot: book.storageRoot,
        requestOrigin: EVAL_ORIGIN,
      },
    );
    try {
      const definitions = [
        ...connection.tools.map(toAnthropicTool),
        ...HARNESS_TOOLS,
      ];
      const chars =
        JSON.stringify(definitions).length +
        systemPrompt(template.manifest, connection.instructions).length;
      return {
        hash: connection.hash,
        tools: connection.tools,
        instructions: connection.instructions,
        prefixTokens: Math.round(chars / 3.5),
      };
    } finally {
      await connection.close();
    }
  } finally {
    book.raw.close();
    sandbox.temp.remove(scratch);
  }
}

/** The proper nouns of every variant: no tool description may contain one. */
function allNouns(templates: Iterable<TemplateInfo>): string[] {
  return [...new Set([...templates].flatMap((t) => t.manifest.nouns))].sort();
}

/** Dollars to the cent, or to a hundredth of a cent below one cent. */
export function usd(amount: number): string {
  return `$${amount !== 0 && Math.abs(amount) < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

export type Estimate = {
  model: string;
  trials: number;
  perTrialUsd: number;
  totalUsd: number;
};

export function estimateRun(options: {
  models: readonly string[];
  trials: number;
  effort: Effort;
  prefixTokens: number;
}): Estimate[] {
  return options.models.map((model) => {
    const perTrialUsd = estimateTrialCost({
      model,
      effort: options.effort,
      prefixTokens: options.prefixTokens,
    });
    return {
      model,
      trials: options.trials,
      perTrialUsd,
      totalUsd: perTrialUsd * options.trials,
    };
  });
}

export function formatEstimate(
  estimates: readonly Estimate[],
  maxUsd: number,
): string {
  const total = estimates.reduce((sum, e) => sum + e.totalUsd, 0);
  return [
    "Estimated cost (approximate token counts × published prices; cache writes 1.25× input):",
    ...estimates.map(
      (e) =>
        `  ${e.model.padEnd(20)} ${String(e.trials).padStart(4)} trials × ~$${e.perTrialUsd.toFixed(2)} = ~$${e.totalUsd.toFixed(2)}`,
    ),
    `  total ~$${total.toFixed(2)}; the run stops starting trials before --max-usd ${usd(maxUsd)} is passed.`,
  ].join("\n");
}

function ask(question: string): boolean {
  const answer = prompt(question);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

/** The environment a trial gets: nothing from `.env`, nothing it does not need. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "TMPDIR", "TZ", "LANG", "LC_ALL"])
    if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, NO_COLOR: "1", ...extra };
}

type TrialJob = {
  task: EvalTask;
  model: string;
  rep: number;
  variantDir: string;
};
type TrialReport = {
  outcome:
    | (Omit<TrialOutcome, "trace"> & { safety?: Record<string, unknown> })
    | null;
  trace: unknown;
  exitCode: number;
  stderr: string;
  trialDir: string;
};

async function spawnTrial(
  sandbox: EvalSandbox,
  job: TrialJob,
  options: RunOptions,
  templateDir: string,
  budgetUsd: number | undefined,
  running: Set<{ kill(): void }>,
): Promise<TrialReport> {
  const trialDir = sandbox.temp.make(
    sandbox.dir,
    `trial-${job.task.id}-${job.rep}-`,
  );
  const env = childEnv({
    [ENV.trialDir]: trialDir,
    [ENV.templateDir]: templateDir,
    ...(budgetUsd !== undefined ? { [ENV.budgetUsd]: String(budgetUsd) } : {}),
    ...(options.mode === "model" && !isFakeModel(job.model)
      ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" }
      : {}),
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./scripts/eval/preload.ts",
      "scripts/eval/trial.ts",
      trialDir,
      job.task.id,
      job.model,
      options.effort,
      String(job.rep),
      options.surface,
      options.naming,
    ],
    { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" },
  );
  running.add(child);
  const timer = setTimeout(() => child.kill(), TRIAL_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  running.delete(child);
  writeFileSync(join(trialDir, "stdout.log"), stdout);
  writeFileSync(join(trialDir, "stderr.log"), stderr);
  const read = (name: string) =>
    existsSync(join(trialDir, name))
      ? JSON.parse(readFileSync(join(trialDir, name), "utf8"))
      : null;
  return {
    outcome: read("result.json"),
    trace: read("trace.json") ?? [],
    exitCode,
    stderr,
    trialDir,
  };
}

export function toResultRow(
  outcome: NonNullable<TrialReport["outcome"]>,
): ResultRow {
  const v = outcome.verdict;
  const agent = outcome.agent;
  const safety = (outcome.safety ?? {}) as {
    realDataChanges?: string[];
    defaultStorageUsed?: boolean;
    defaultDatabaseCreated?: boolean;
  };
  return {
    prompt_id: outcome.taskId,
    rep: outcome.rep,
    prompt: outcome.prompt,
    tags: outcome.tags,
    grade: {
      pass: v.pass ? 1 : 0,
      no_critical: v.critical.length ? 0 : 1,
      approval_ok: v.approvalOk ? 1 : 0,
      collateral: v.collateral.length,
    },
    model: outcome.responseModel,
    latency_s: Math.round((agent?.wallMs ?? outcome.wallMs) / 100) / 10,
    tool_calls: agent?.calls.length ?? 0,
    tool_errors: agent?.calls.filter((call) => call.isError).length ?? 0,
    usage: agent?.usage ?? emptyUsage(),
    cost_usd: Math.round((agent?.costUsd ?? 0) * 1e6) / 1e6,
    meta: {
      variant: outcome.variant,
      split: outcome.split,
      approval: outcome.approval,
      mode: outcome.mode,
      requested_model: outcome.requestedModel,
      effort: outcome.effort,
      surface: outcome.surface,
      naming: outcome.naming,
      tool_surface_hash: outcome.toolSurfaceHash,
      tool_count: outcome.toolCount,
      stop: agent?.stop ?? null,
      iterations: agent?.iterations ?? 0,
      extra_turns: agent?.extraTurns ?? 0,
      unknown_tool_calls:
        agent?.calls.filter((call) => call.errorCode === "UNKNOWN_TOOL")
          .length ?? 0,
      writes_before_approval: outcome.writesBeforeApproval,
      critical: v.critical,
      collateral: v.collateral,
      notes: v.notes,
      final_answer: outcome.finalAnswer,
      calls: agent?.calls ?? [],
      wall_ms: outcome.wallMs,
      safety: {
        real_data_unchanged: (safety.realDataChanges ?? []).length === 0,
        default_storage_used: safety.defaultStorageUsed ?? false,
        default_database_created: safety.defaultDatabaseCreated ?? false,
      },
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
    },
  };
}

// -- Serving a book ---------------------------------------------------------------------

async function serve(options: RunOptions, sandbox: EvalSandbox): Promise<void> {
  const templates = await buildTemplates(sandbox, [options.book]);
  const templateDir = templates.get(options.book)!;
  const template = readTemplate(templateDir);
  const serveDir = sandbox.temp.make(sandbox.dir, "serve-");
  const book = openBookCopy(
    templateDir,
    join(serveDir, "book"),
    template.manifest,
  );
  const inbox = join(serveDir, "inbox");
  mkdirSync(inbox);
  for (const mail of EVAL_INBOX[options.book]) {
    writeFileSync(
      join(inbox, `${mail.id}.txt`),
      `From: ${mail.from}\nTo: ${mail.to}\nDate: ${mail.date}\nSubject: ${mail.subject}\n\n${mail.text}\n`,
    );
    for (const file of mail.attachments)
      writeFileSync(
        join(inbox, `${mail.id}-${file.filename}`),
        Buffer.from(file.contentBase64, "base64"),
      );
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: (request) => handle(request),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const handle = createSurfaceHandler(
    { surface: options.surface, naming: options.naming },
    {
      db: book.db,
      store: book.store,
      storageRoot: book.storageRoot,
      requestOrigin: origin,
    },
    origin,
  );
  console.log(`Serving a temporary copy of test book ${options.book} (${options.surface}${options.surface === "v2" ? `, ${options.naming}` : ""}).

  MCP endpoint   ${origin}/mcp
  Bearer token   ${template.agentToken}
  Book folder    ${serveDir}
  Inbox files    ${inbox}

Claude Code:
  claude mcp add --transport http akaun ${origin}/mcp --header "Authorization: Bearer ${template.agentToken}"

The owner's rules (give them to the agent):
${EVAL_RULES_TEXT[options.book]}

Nothing here touches the real data/. Press Ctrl-C to stop${options.keep ? "" : " (the temporary book is then deleted)"}.`);
  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  await server.stop(true);
  book.raw.close();
  assertRealDataUnchanged(sandbox);
  if (!options.keep) sandbox.temp.remove(sandbox.dir);
  else console.log(`Kept ${serveDir}.`);
}

// -- Running trials ------------------------------------------------------------------

export async function runEval(
  given: RunOptions,
  sandbox: EvalSandbox,
): Promise<number> {
  let options: RunOptions;
  try {
    options = { ...given, outDir: resultsDir(given, sandbox) };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const tasks = selectTasks({
    ids: options.ids,
    tags: options.tags,
    split: options.split,
  });
  if (!tasks.length) {
    console.error("No task matches that selection.");
    return 2;
  }
  let runnable = tasks;
  if (options.mode === "oracle") {
    const oracles = await loadOracles();
    const missing = tasks.filter((t) => !oracles[t.id]);
    if (missing.length)
      console.log(
        `No oracle yet for ${missing.map((t) => t.id).join(", ")} (scripts/eval/oracles.ts); skipping them.`,
      );
    runnable = tasks.filter((t) => oracles[t.id]);
    if (!runnable.length) {
      console.error("None of the selected tasks has an oracle.");
      return 2;
    }
  }

  // Both variants, always: the leak check needs every test-book noun, held-out ones included.
  console.log("Building the test books…");
  const templates = await buildTemplates(sandbox, ["A", "B"]);
  const templateInfos = [...templates.values()].map(readTemplate);
  const firstTemplate = templates.get(runnable[0].variant)!;
  const listing = await listSurface(
    sandbox,
    firstTemplate,
    options.surface,
    options.naming,
  );
  const nouns = allNouns(templateInfos);
  const leaks = leakCheck(listing.tools, nouns, listing.instructions);
  if (leaks.length) {
    console.error(
      `Leak check failed: tool descriptions name things in the test book, so scores would reward tuning to it:\n${leaks.map((l) => `  ${l.tool} ${l.field}: "${l.noun}"`).join("\n")}`,
    );
    return 1;
  }
  console.log(
    `Surface ${options.surface}${options.surface === "v2" ? ` (${options.naming})` : ""}: ${listing.tools.length} tools, hash ${listing.hash.slice(0, 12)}.`,
  );
  if (listing.tools.length === 0)
    console.log("Warning: the surface lists no tools.");

  const models = options.mode === "model" ? options.models : [options.mode];
  const paid = models.filter(
    (model) => options.mode === "model" && !isFakeModel(model),
  );
  const trialsPerModel = runnable.length * options.reps;
  const estimates = estimateRun({
    models: paid,
    trials: trialsPerModel,
    effort: options.effort,
    prefixTokens: listing.prefixTokens,
  });
  const perTrial = new Map(estimates.map((e) => [e.model, e.perTrialUsd]));
  if (paid.length) {
    console.log(formatEstimate(estimates, options.maxUsd));
    const cheapest = Math.min(...estimates.map((e) => e.perTrialUsd));
    if (cheapest * 0.5 > options.maxUsd) {
      console.error(
        `--max-usd ${usd(options.maxUsd)} does not cover even one trial (~${usd(cheapest)}); nothing was run.`,
      );
      return 1;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "ANTHROPIC_API_KEY is not set; a model run cannot start without it.",
      );
      return 2;
    }
    if (!options.yes && !ask("Run it? [y/N]")) {
      console.log("Nothing was run.");
      return 0;
    }
  } else
    console.log(
      options.mode === "model"
        ? "Scripted model: no API calls, no cost."
        : `--${options.mode}: no model calls, no cost.`,
    );

  // One result directory per configuration (model).
  const taken = new Set<string>();
  const variantDirs = new Map<string, string>();
  for (const model of models) {
    const config: RunConfig = {
      mode: options.mode,
      model,
      effort: options.effort,
      surface: options.surface,
      naming: options.naming,
    };
    const name = chooseVariantDir({
      outDir: options.outDir,
      config,
      resume: options.resume,
      name: options.round,
      taken,
    });
    taken.add(name);
    const dir = join(options.outDir, name);
    variantDirs.set(model, dir);
    writeSummary(dir, {
      description: `${options.surface}${options.surface === "v2" ? `/${options.naming}` : ""} · ${model} · effort ${options.effort}`,
      target: "tools",
      ...config,
      tool_surface_hash: listing.hash,
      started_at: new Date().toISOString(),
    });
    writeJson(join(dir, "tools.json"), {
      tools: listing.tools,
      instructions: listing.instructions,
      nouns,
      hash: listing.hash,
    });
    writeState(options.outDir, {
      trainIds: DEV_TASK_IDS,
      testIds: HELDOUT_TASK_IDS,
      reps: options.reps,
      currentRound: name,
    });
    console.log(`Results for ${model}: ${dir}`);
  }

  const jobs: TrialJob[] = [];
  for (const model of models) {
    const dir = variantDirs.get(model)!;
    const done = options.resume ? finishedTrials(dir) : new Set<string>();
    for (const task of runnable)
      for (let rep = 0; rep < options.reps; rep++)
        if (!done.has(`${task.id}#${rep}`))
          jobs.push({ task, model, rep, variantDir: dir });
  }
  console.log(
    `${jobs.length} trial${jobs.length === 1 ? "" : "s"} to run, ${options.concurrency} at a time.`,
  );

  let spent = 0;
  const reserved = new Map<number, number>();
  let stoppedForBudget = 0;
  let aborted = false;
  let crashed = 0;
  let next = 0;
  let finished = 0;
  const started = performance.now();
  const running = new Set<{ kill(): void }>();

  /** The real book changed: stop every trial, start no more, and say why. */
  const abort = (job: TrialJob, message: string) => {
    if (!aborted)
      console.error(
        `ABORTED during ${job.task.id} rep ${job.rep}:\n${message}`,
      );
    aborted = true;
    for (const child of running) child.kill();
    appendError(job.variantDir, {
      prompt_id: job.task.id,
      rep: job.rep,
      at: new Date().toISOString(),
      kind: "real_data_changed",
      message: message.slice(-2000),
    });
  };

  const reserve = (model: string): number | undefined | null => {
    const estimate = perTrial.get(model);
    if (estimate === undefined) return undefined; // costs nothing
    const available =
      options.maxUsd -
      spent -
      [...reserved.values()].reduce((a, b) => a + b, 0);
    if (available < estimate * 0.5) return null;
    return Math.min(available, Math.max(estimate * 4, 0.05));
  };

  async function worker(slot: number) {
    while (!aborted && next < jobs.length) {
      const job = jobs[next];
      const cap = reserve(job.model);
      if (cap === null) {
        if (reserved.size === 0) {
          stoppedForBudget = jobs.length - next;
          next = jobs.length;
          return;
        }
        await Bun.sleep(500);
        continue;
      }
      next++;
      if (cap !== undefined) reserved.set(slot, cap);
      const report = await spawnTrial(
        sandbox,
        job,
        options,
        templates.get(job.task.variant)!,
        cap,
        running,
      );
      reserved.delete(slot);
      finished++;
      if (aborted) return;
      const at = new Date().toISOString();
      if (report.exitCode === 3) {
        abort(job, report.stderr);
        return;
      }
      const outcome = report.outcome;
      if (!outcome) {
        crashed++;
        appendError(job.variantDir, {
          prompt_id: job.task.id,
          rep: job.rep,
          at,
          kind: "trial_crashed",
          message: `exit ${report.exitCode}: ${report.stderr.slice(-4000)}`,
        });
        console.log(
          `[${finished}/${jobs.length}] ${job.task.id} rep ${job.rep}: CRASHED (exit ${report.exitCode}); see errors.jsonl`,
        );
      } else {
        const row = toResultRow(outcome);
        spent += row.cost_usd;
        appendResult(job.variantDir, row);
        writeTrace(job.variantDir, job.task.id, job.rep, report.trace);
        for (const retry of (outcome.retries ?? []) as RetryInfo[])
          appendError(job.variantDir, {
            prompt_id: job.task.id,
            rep: job.rep,
            at,
            kind: "retry",
            message: retry.error,
            status: retry.status,
            attempt: retry.attempt,
            delay_ms: retry.delayMs,
          });
        const stop = outcome.agent?.stop;
        if (stop && stop !== "end_turn")
          appendError(job.variantDir, {
            prompt_id: job.task.id,
            rep: job.rep,
            at,
            kind: `stop_${stop}`,
            message: outcome.agent?.error ?? outcome.agent?.stopDetails ?? stop,
          });
        const safety = outcome.safety ?? {};
        if (safety.defaultStorageUsed || safety.defaultDatabaseCreated)
          appendError(job.variantDir, {
            prompt_id: job.task.id,
            rep: job.rep,
            at,
            kind: "default_path_used",
            message: JSON.stringify(safety),
          });
        const verdict = outcome.verdict;
        console.log(
          `[${finished}/${jobs.length}] ${job.task.id} rep ${job.rep} ${job.model}: ${outcome.skipped ? "SKIPPED" : verdict.pass ? "pass" : "FAIL"}${verdict.critical.length ? ` CRITICAL(${verdict.critical.length})` : ""}${!verdict.approvalOk ? " approval-broken" : ""}  calls ${row.tool_calls}  $${row.cost_usd.toFixed(3)}  spent $${spent.toFixed(2)}`,
        );
      }
      if (!options.keep) sandbox.temp.remove(report.trialDir);
      else console.log(`  kept ${report.trialDir}`);
      const changed = sandbox.checkRealData();
      if (changed.length) {
        abort(job, changed.join("\n"));
        return;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, Math.max(jobs.length, 1)) },
      (_, slot) => worker(slot),
    ),
  );

  for (const [model, dir] of variantDirs) {
    const rows = readResults(dir);
    writeSummary(dir, {
      finished_at: new Date().toISOString(),
      trials: rows.length,
    });
    console.log(`\n${model} (${dir}):\n${formatSummary(rows)}`);
  }
  console.log(
    `\nSpent $${spent.toFixed(2)} in ${Math.round((performance.now() - started) / 1000)}s.`,
  );
  if (stoppedForBudget)
    console.log(
      `Stopped at --max-usd ${usd(options.maxUsd)}: ${stoppedForBudget} trial(s) not run; --resume picks them up.`,
    );
  if (crashed)
    console.log(
      `${crashed} trial(s) crashed; see errors.jsonl. --resume reruns them.`,
    );
  if (aborted) return 3;
  if (options.mode === "null") {
    const passed = [...variantDirs.values()]
      .flatMap(readResults)
      .filter((row) => row.grade.pass === 1);
    if (passed.length) {
      console.error(
        `--null: ${passed.map((row) => row.prompt_id).join(", ")} passed on the untouched book; their verifiers accept doing nothing.`,
      );
      return 1;
    }
    console.log(
      "--null: every task failed on the untouched book, as it should.",
    );
  }
  return crashed ? 1 : 0;
}

async function main() {
  // A leftover trial directory in the environment would make the preload
  // treat this process as a trial; the preload refuses it too.
  if (process.env[ENV.trialDir] !== undefined) {
    console.error(
      `${ENV.trialDir} is set (${process.env[ENV.trialDir]}). The evaluation runner never takes a trial directory from its environment: unset it and run again.`,
    );
    process.exit(2);
  }
  let options: RunOptions;
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      console.log(USAGE);
      process.exit(0);
    }
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    process.exit(2);
  }
  let sandbox: EvalSandbox;
  try {
    sandbox = requireSandbox();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  assertRealDataUnchanged(sandbox);
  if (options.serve) {
    await serve(options, sandbox);
    process.exit(0);
  }
  const code = await runEval(options, sandbox);
  const changed = sandbox.checkRealData();
  if (changed.length) console.error(changed.join("\n"));
  sandbox.temp.remove(sandbox.dir);
  process.exit(changed.length ? 3 : code);
}

if (import.meta.main) await main();
