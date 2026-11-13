import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../src/lib/server/db/schema.js";
import type { LedgerDb } from "../../src/lib/server/ledger/types.js";
import { LocalBlobStore } from "../../src/lib/server/storage/blob-store.js";
import { localsFor } from "../../src/lib/server/permissions/test-locals.js";
import { patLocals } from "../../src/lib/server/tokens/pat.js";
import type { AppContext } from "../../src/lib/server/application/context.js";
import type {
  NamingScheme,
  ToolSet,
} from "../../src/lib/server/mcp/registry.js";
import {
  buildEvalBook,
  EVAL_RULES_TEXT,
  type EvalManifest,
  type EvalVariant,
} from "../../src/lib/server/mcp/__fixtures__/eval-book.js";
import {
  anthropicModelClient,
  asksBeforeActing,
  EFFORTS,
  isFakeModel,
  runAgent,
  scriptedModelClient,
  type AgentRunResult,
  type Effort,
  type ModelClient,
  type RetryInfo,
  type TraceTurn,
} from "./agent.ts";
import {
  connectSurface,
  EVAL_ORIGIN,
  mcpToolExecutor,
  NAMINGS,
  parseSurface,
  type SurfaceKind,
} from "./surfaces.ts";
import { combineExecutors, harnessToolExecutor } from "./harness-tools.ts";
import {
  diffSnapshots,
  snapshotBook,
  taskById,
  type EvalOracle,
  type OracleModule,
  type RowChange,
  type SetupBook,
  type TaskVerdict,
  type TrialBook,
} from "./tasks.ts";
import { scrubSecrets } from "./results.ts";

/**
 * One trial: one task, one model, one repetition, in its own process.
 *
 *   bun --no-env-file --preload ./scripts/eval/preload.ts scripts/eval/trial.ts \
 *     <trialDir> <taskId> <model> <effort> <rep> <surface> <naming>
 *
 * `model` is a model id, `fake:<tool>,…` (a scripted model), `null` (no model:
 * the untouched book is verified) or `oracle` (the task's oracle from
 * `scripts/eval/oracles.ts`). The environment gives the template to copy
 * (`AKAUN_EVAL_TEMPLATE_DIR`) and the spending cap (`AKAUN_EVAL_BUDGET_USD`).
 *
 * The trial copies the template into its directory, runs the task's setup,
 * snapshots the book, runs the agent against the surface, verifies, and
 * writes `result.json` and `trace.json` there. The orchestrator files them.
 * Exit codes: 0 done (pass or fail), 2 bad arguments, 3 the real book
 * changed, 1 anything else.
 */

// -- The sandbox the preload set up ----------------------------------------------

export type RealDataStat = {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
};

/** What `preload.ts` leaves on `globalThis` for the runner. */
export type EvalSandbox = {
  dir: string;
  /** True in a trial (given `AKAUN_EVAL_TRIAL_DIR`), false in the orchestrator. */
  isTrial: boolean;
  envStoragePath: string;
  envDatabasePath: string;
  realDataBefore: RealDataStat[];
  /** What changed in the real book's files since the preload ran; empty when nothing did. */
  checkRealData(): string[];
};

/** The preload's sandbox, or null when this process was started without it. */
export function evalSandbox(): EvalSandbox | null {
  return (
    ((globalThis as Record<symbol, unknown>)[
      Symbol.for("akaun.eval.sandbox")
    ] as EvalSandbox | undefined) ?? null
  );
}

export const ENV = {
  trialDir: "AKAUN_EVAL_TRIAL_DIR",
  templateDir: "AKAUN_EVAL_TEMPLATE_DIR",
  budgetUsd: "AKAUN_EVAL_BUDGET_USD",
} as const;

/**
 * Whether `path` is strictly inside the OS temp directory, judged on real
 * paths: the nearest existing ancestor is resolved through any symlink, so a
 * link cannot carry a folder that does not exist yet somewhere else.
 */
export function insideTmp(path: string): boolean {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const real = join(realpathSync(existing), ...rest);
  const rel = relative(realpathSync(tmpdir()), real);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// -- Templates ----------------------------------------------------------------

export type TemplateInfo = {
  variant: EvalVariant;
  today: string;
  manifest: EvalManifest;
  agentToken: string;
  ownerId: number;
  agentUserId: number;
};

/** Builds one variant of the test book in `dir/book` (under the OS temp directory) and records it in `dir/template.json`. */
export async function buildTemplate(
  dir: string,
  variant: EvalVariant,
  today: string,
): Promise<TemplateInfo> {
  if (!insideTmp(dir))
    throw new Error(`Templates live under the OS temp directory, not ${dir}.`);
  mkdirSync(dir, { recursive: true });
  const book = await buildEvalBook({ dir: join(dir, "book"), variant, today });
  const info: TemplateInfo = {
    variant,
    today,
    manifest: book.manifest,
    agentToken: book.agentToken,
    ownerId: book.ownerId,
    agentUserId: book.agentUserId,
  };
  book.raw.close();
  writeFileSync(join(dir, "template.json"), JSON.stringify(info));
  return info;
}

export function readTemplate(dir: string): TemplateInfo {
  return JSON.parse(
    readFileSync(join(dir, "template.json"), "utf8"),
  ) as TemplateInfo;
}

/** A copy of the template's book in `target` (under the OS temp directory), opened. */
export function openBookCopy(
  templateDir: string,
  target: string,
  manifest: EvalManifest,
): SetupBook {
  if (!insideTmp(target))
    throw new Error(
      `A trial's book lives under the OS temp directory, not ${target}.`,
    );
  if (existsSync(join(target, "akaun-eval.db")))
    throw new Error(`${target} already holds a book.`);
  mkdirSync(target, { recursive: true });
  cpSync(join(templateDir, "book"), target, { recursive: true });
  const raw = new Database(join(target, "akaun-eval.db"));
  raw.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const db = drizzle(raw, { schema }) as unknown as LedgerDb;
  const storageRoot = join(target, "storage");
  return {
    raw,
    db,
    store: new LocalBlobStore(storageRoot),
    storageRoot,
    manifest,
  };
}

// -- The prompt -----------------------------------------------------------------

/** A short preamble, the server's instructions, and the owner's rules. */
export function systemPrompt(
  manifest: EvalManifest,
  instructions: string,
): string {
  return [
    `You are a bookkeeping assistant for ${manifest.business}. You work in its books in Akaun, a double-entry bookkeeping app, through the tools provided. Today's date is ${manifest.today}. The person messaging you is the business owner.`,
    instructions.trim()
      ? `Akaun's instructions for its tools:\n${instructions.trim()}`
      : "",
    EVAL_RULES_TEXT[manifest.variant],
  ]
    .filter(Boolean)
    .join("\n\n");
}

// -- Oracles --------------------------------------------------------------------

/**
 * The per-task oracles of `scripts/eval/oracles.ts` (task C5), or none while
 * that file does not exist. Loaded by path, so a missing file is not an error.
 */
export async function loadOracles(): Promise<
  Partial<Record<string, EvalOracle>>
> {
  const path = fileURLToPath(new URL("./oracles.ts", import.meta.url));
  if (!existsSync(path)) return {};
  const module = (await import(path)) as OracleModule;
  return module.ORACLES ?? {};
}

// -- One trial ------------------------------------------------------------------

export type TrialMode = "model" | "null" | "oracle";

export function modeOf(model: string): TrialMode {
  return model === "null" ? "null" : model === "oracle" ? "oracle" : "model";
}

export type TrialParams = {
  trialDir: string;
  templateDir: string;
  taskId: string;
  model: string;
  effort: Effort;
  rep: number;
  surface: SurfaceKind;
  naming: NamingScheme;
  budgetUsd?: number;
};

export type TrialDeps = {
  /** The model client; built from the model id when absent. */
  client?: ModelClient;
  /** v2's tools; the registry's lists when absent. */
  toolSet?: ToolSet;
  onRetry?: (info: RetryInfo) => void;
};

export type TrialOutcome = {
  taskId: string;
  rep: number;
  variant: EvalVariant;
  split: string;
  tags: string[];
  approval: string;
  prompt: string;
  mode: TrialMode;
  requestedModel: string;
  responseModel: string;
  effort: Effort;
  surface: SurfaceKind;
  naming: NamingScheme;
  toolSurfaceHash: string;
  toolCount: number;
  verdict: TaskVerdict;
  finalAnswer: string;
  writesBeforeApproval: number;
  agent: Omit<AgentRunResult, "trace" | "finalAnswer"> | null;
  /** Set when the trial did not run (no oracle for the task). */
  skipped?: string;
  retries: RetryInfo[];
  wallMs: number;
  trace: TraceTurn[];
};

function clientFor(
  model: string,
  onRetry: (info: RetryInfo) => void,
): ModelClient {
  if (isFakeModel(model)) return scriptedModelClient(model);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error(
      "ANTHROPIC_API_KEY is not set; a model trial cannot start without it.",
    );
  return anthropicModelClient({ apiKey, onRetry });
}

/** Runs one trial in this process. The caller owns `trialDir`. */
export async function runTrial(
  params: TrialParams,
  deps: TrialDeps = {},
): Promise<TrialOutcome> {
  const started = performance.now();
  const task = taskById(params.taskId);
  const template = readTemplate(params.templateDir);
  if (template.variant !== task.variant)
    throw new Error(
      `${task.id} runs on variant ${task.variant}; the template is ${template.variant}.`,
    );
  const mode = modeOf(params.model);
  const retries: RetryInfo[] = [];
  const onRetry = (info: RetryInfo) => {
    retries.push(info);
    deps.onRetry?.(info);
  };

  const book = openBookCopy(
    params.templateDir,
    join(params.trialDir, "book"),
    template.manifest,
  );
  try {
    const owner: AppContext = {
      db: book.db,
      locals: localsFor([], { superuser: true, userId: template.ownerId }),
      store: book.store,
      storageRoot: book.storageRoot,
    };
    const extra = task.setup ? await task.setup(book, owner) : {};
    const trialBook: TrialBook = {
      ...book,
      before: snapshotBook(book.raw),
      extra,
    };
    const locals = patLocals(book.db, `Bearer ${template.agentToken}`);
    if (!locals) throw new Error("The template's agent token was refused.");
    const agentCtx = {
      db: book.db,
      locals,
      store: book.store,
      storageRoot: book.storageRoot,
    };
    const connection = await connectSurface(
      { surface: params.surface, naming: params.naming },
      { ...agentCtx, requestOrigin: EVAL_ORIGIN },
      deps.toolSet,
    );
    try {
      let writesBeforeApproval: RowChange[] = [];
      let finalAnswer = "";
      let agent: AgentRunResult | null = null;
      let skipped: string | undefined;
      const trace: TraceTurn[] = [];

      if (mode === "oracle") {
        const oracle = (await loadOracles())[task.id];
        if (!oracle)
          skipped = `no oracle for ${task.id} in scripts/eval/oracles.ts`;
        else {
          const answer = await oracle({
            task,
            book: trialBook,
            agent: agentCtx,
            owner,
          });
          finalAnswer = typeof answer === "string" ? answer : "";
        }
      } else if (mode === "model") {
        const client = deps.client ?? clientFor(params.model, onRetry);
        const tools = combineExecutors(
          mcpToolExecutor(connection),
          harnessToolExecutor({
            variant: task.variant,
            db: book.db,
            store: book.store,
            origin: EVAL_ORIGIN,
          }),
        );
        const approvalTurn =
          task.approval === "confirm"
            ? (task.approvalTurn ?? task.turns.length - 1)
            : -1;
        const nothingSaved = () =>
          diffSnapshots(trialBook.before, snapshotBook(book.raw)).length === 0;
        agent = await runAgent({
          client,
          model: params.model,
          effort: params.effort,
          system: systemPrompt(template.manifest, connection.instructions),
          tools,
          turns: task.turns,
          budgetUsd: params.budgetUsd,
          beforeTurn(index) {
            if (index === approvalTurn)
              writesBeforeApproval = diffSnapshots(
                trialBook.before,
                snapshotBook(book.raw),
              );
          },
          shouldNudge:
            task.approval === "auto" && task.nudge !== false
              ? (lastText) => asksBeforeActing(lastText) && nothingSaved()
              : undefined,
        });
        finalAnswer = agent.finalAnswer;
        trace.push(...agent.trace);
      }

      const verdict = skipped
        ? {
            pass: false,
            critical: [],
            collateral: [],
            approvalOk: true,
            notes: [skipped],
          }
        : task.verify(trialBook, finalAnswer, writesBeforeApproval);
      const {
        trace: _trace,
        finalAnswer: _answer,
        ...agentSummary
      } = agent ?? {
        trace: [],
        finalAnswer: "",
      };
      void _trace;
      void _answer;
      return scrubSecrets({
        taskId: task.id,
        rep: params.rep,
        variant: task.variant,
        split: task.split,
        tags: task.tags,
        approval: task.approval,
        prompt: task.turns.join("\n\n---\n\n"),
        mode,
        requestedModel: params.model,
        responseModel:
          agent?.responseModels.at(-1) ??
          (mode === "model" ? params.model : mode),
        effort: params.effort,
        surface: params.surface,
        naming: params.naming,
        toolSurfaceHash: connection.hash,
        toolCount: connection.tools.length,
        verdict,
        finalAnswer,
        writesBeforeApproval: writesBeforeApproval.length,
        agent: agent ? (agentSummary as TrialOutcome["agent"]) : null,
        ...(skipped ? { skipped } : {}),
        retries,
        wallMs: Math.round(performance.now() - started),
        trace,
      });
    } finally {
      await connection.close();
    }
  } finally {
    book.raw.close();
  }
}

// -- The process ----------------------------------------------------------------

function fail(code: number, message: string): never {
  console.error(`[eval trial] ${message}`);
  process.exit(code);
}

async function main() {
  const sandbox = evalSandbox();
  if (!sandbox?.isTrial)
    fail(
      2,
      "trial.ts must run under scripts/eval/preload.ts with AKAUN_EVAL_TRIAL_DIR set.",
    );
  const [trialDir, taskId, model, effort, rep, surface, naming] =
    process.argv.slice(2);
  if (!naming)
    fail(
      2,
      "usage: trial.ts <trialDir> <taskId> <model> <effort> <rep> <surface> <naming>",
    );
  if (realpathSync(trialDir) !== sandbox.dir)
    fail(
      2,
      `The trial directory ${trialDir} is not the preload's sandbox ${sandbox.dir}.`,
    );
  if (!(EFFORTS as readonly string[]).includes(effort))
    fail(2, `Unknown effort ${effort}.`);
  try {
    parseSurface(surface);
  } catch (error) {
    fail(2, (error as Error).message);
  }
  if (!(NAMINGS as readonly string[]).includes(naming))
    fail(2, `Unknown naming ${naming}.`);
  const templateDir = process.env[ENV.templateDir];
  if (!templateDir || !insideTmp(templateDir))
    fail(
      2,
      `${ENV.templateDir} must name a template under the OS temp directory.`,
    );
  const budget = process.env[ENV.budgetUsd];

  let changed = sandbox.checkRealData();
  if (changed.length) fail(3, changed.join("\n"));
  const outcome = await runTrial({
    trialDir: sandbox.dir,
    templateDir,
    taskId,
    model,
    effort: effort as Effort,
    rep: Number(rep),
    surface: surface as SurfaceKind,
    naming: naming as NamingScheme,
    ...(budget ? { budgetUsd: Number(budget) } : {}),
  });
  changed = sandbox.checkRealData();
  const { trace, ...result } = outcome;
  writeFileSync(
    join(sandbox.dir, "trace.json"),
    JSON.stringify(scrubSecrets(trace)),
  );
  writeFileSync(
    join(sandbox.dir, "result.json"),
    JSON.stringify(
      scrubSecrets({
        ...result,
        safety: {
          realDataChanges: changed,
          defaultStorageUsed: existsSync(sandbox.envStoragePath),
          defaultDatabaseCreated: existsSync(sandbox.envDatabasePath),
        },
      }),
    ),
  );
  if (changed.length) fail(3, changed.join("\n"));
  process.exit(0);
}

if (import.meta.main) {
  main().catch((error: unknown) =>
    fail(
      1,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
  );
}
