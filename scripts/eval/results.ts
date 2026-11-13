import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PRICES, type UsageTotals } from "./agent.ts";

/**
 * Where a run's results go, in the layout of the claude-api skill's
 * hill-climbing loop, so its report builder can read them:
 *
 *   <out>/_state.json            train_ids (dev) / test_ids (held-out), metrics
 *   <out>/vN/summary.json        one configuration: model, effort, surface, naming
 *   <out>/vN/results.jsonl       one row per trial, appended as each finishes
 *   <out>/vN/traces/<id>_rep<k>.json
 *   <out>/vN/errors.jsonl        infrastructure trouble: crashes, retries, stops
 *   <out>/vN/tools.json          the listing the model saw, for analysis and the leak check
 *
 * Each model of a run gets its own `vN`, so one directory is one
 * configuration. Every string written is scrubbed of access tokens and API
 * keys first.
 */

/** Under `/work/`, which git ignores. */
export const DEFAULT_OUT_DIR = "work/eval-mcp";

const SECRETS: [RegExp, string][] = [
  [/akp_[A-Za-z0-9]{6,}/g, "akp_[REDACTED]"],
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-[REDACTED]"],
];

/** `value` with every `akp_…` token and `sk-ant-…` key replaced, at any depth. */
export function scrubSecrets<T>(value: T): T {
  if (typeof value === "string") {
    let text: string = value;
    for (const [pattern, replacement] of SECRETS)
      text = text.replace(pattern, replacement);
    return text as T;
  }
  if (Array.isArray(value)) return value.map(scrubSecrets) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, scrubSecrets(inner)]),
    ) as T;
  return value;
}

export type Grade = {
  pass: 0 | 1;
  no_critical: 0 | 1;
  approval_ok: 0 | 1;
  collateral: number;
};

/** One trial, as `results.jsonl` holds it. */
export type ResultRow = {
  prompt_id: string;
  rep: number;
  prompt: string;
  tags: string[];
  grade: Grade;
  /** The model that answered, from the response; the mode for `null` and `oracle` runs. */
  model: string;
  latency_s: number;
  tool_calls: number;
  tool_errors: number;
  usage: UsageTotals;
  cost_usd: number;
  meta: Record<string, unknown>;
};

export type ErrorRow = {
  prompt_id: string;
  rep: number;
  at: string;
  kind: string;
  message: string;
  [key: string]: unknown;
};

export type RunConfig = {
  mode: "model" | "null" | "oracle";
  model: string;
  effort: string;
  surface: string;
  naming: string;
};

const VARIANT_DIR = /^(baseline|v\d+)$/;

export function listVariantDirs(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VARIANT_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => rank(a) - rank(b));
}

function rank(name: string): number {
  return name === "baseline" ? -1 : Number(name.slice(1));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function sameConfig(
  summary: Partial<RunConfig> | null,
  config: RunConfig,
): boolean {
  return (
    summary !== null &&
    summary.mode === config.mode &&
    summary.model === config.model &&
    summary.effort === config.effort &&
    summary.surface === config.surface &&
    summary.naming === config.naming
  );
}

/**
 * The variant directory for one configuration: `name` when given, the latest
 * directory with the same configuration when resuming, or the next `vN`.
 * `taken` holds names already handed out in this run.
 */
export function chooseVariantDir(options: {
  outDir: string;
  config: RunConfig;
  resume: boolean;
  name?: string;
  taken: Set<string>;
}): string {
  const existing = listVariantDirs(options.outDir);
  if (options.name) {
    if (!VARIANT_DIR.test(options.name))
      throw new Error(`--round must be "baseline" or vN, not ${options.name}.`);
    if (existing.includes(options.name) && !options.resume)
      throw new Error(
        `${options.name} already exists in ${options.outDir}; pass --resume to add to it.`,
      );
    return options.name;
  }
  if (options.resume) {
    const match = [...existing]
      .reverse()
      .find((name) =>
        sameConfig(
          readJson<RunConfig>(join(options.outDir, name, "summary.json")),
          options.config,
        ),
      );
    if (match) return match;
  }
  const numbers = [...existing, ...options.taken]
    .filter((name) => name !== "baseline")
    .map((name) => Number(name.slice(1)));
  return `v${Math.max(0, ...numbers) + 1}`;
}

/** Writes `_state.json`, keeping whatever else is already in it. */
export function writeState(
  outDir: string,
  state: {
    trainIds: string[];
    testIds: string[];
    reps: number;
    currentRound: string;
  },
): void {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "_state.json");
  const previous = readJson<Record<string, unknown>>(path) ?? {};
  const round =
    state.currentRound === "baseline" ? 0 : Number(state.currentRound.slice(1));
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...previous,
        train_ids: state.trainIds,
        test_ids: state.testIds,
        reps: state.reps,
        current_round: Math.max(Number(previous.current_round ?? 0), round),
        metrics: previous.metrics ?? [
          { id: "pass", kind: "binary", label: "Pass" },
          { id: "no_critical", kind: "binary", label: "No critical mistake" },
          { id: "approval_ok", kind: "binary", label: "Approval kept" },
          {
            id: "collateral",
            kind: "float",
            better: "lower",
            label: "Out-of-scope changes",
          },
        ],
        perf_fields: previous.perf_fields ?? [
          { id: "cost_usd", label: "Cost", unit: "$" },
          { id: "latency_s", label: "Latency", unit: "s" },
          { id: "tool_calls", label: "Tool calls" },
          { id: "tool_errors", label: "Tool errors" },
        ],
        prices: Object.fromEntries(
          Object.entries(PRICES).map(([model, price]) => [
            model,
            { in: price.in, out: price.out },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

export function writeSummary(
  variantDir: string,
  summary: Record<string, unknown>,
): void {
  mkdirSync(variantDir, { recursive: true });
  const path = join(variantDir, "summary.json");
  const previous = readJson<Record<string, unknown>>(path) ?? {};
  writeFileSync(
    path,
    JSON.stringify(scrubSecrets({ ...previous, ...summary }), null, 2),
  );
}

function appendJsonl(path: string, row: unknown): void {
  appendFileSync(path, `${JSON.stringify(scrubSecrets(row))}\n`);
}

export function appendResult(variantDir: string, row: ResultRow): void {
  mkdirSync(variantDir, { recursive: true });
  appendJsonl(join(variantDir, "results.jsonl"), row);
}

export function appendError(variantDir: string, row: ErrorRow): void {
  mkdirSync(variantDir, { recursive: true });
  appendJsonl(join(variantDir, "errors.jsonl"), row);
}

export function tracePath(variantDir: string, id: string, rep: number): string {
  return join(variantDir, "traces", `${id}_rep${rep}.json`);
}

export function writeTrace(
  variantDir: string,
  id: string,
  rep: number,
  trace: unknown,
): void {
  mkdirSync(join(variantDir, "traces"), { recursive: true });
  writeFileSync(
    tracePath(variantDir, id, rep),
    JSON.stringify(scrubSecrets(trace), null, 2),
  );
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(scrubSecrets(value), null, 2));
}

export function readResults(variantDir: string): ResultRow[] {
  const path = join(variantDir, "results.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ResultRow);
}

/** `(task, rep)` pairs already in a variant directory, for `--resume`. */
export function finishedTrials(variantDir: string): Set<string> {
  return new Set(
    readResults(variantDir).map((row) => `${row.prompt_id}#${row.rep}`),
  );
}

/** Pass rate and spend per task, then overall, recomputed from the rows. */
export function summarise(rows: readonly ResultRow[]) {
  const byTask = new Map<string, ResultRow[]>();
  for (const row of rows)
    byTask.set(row.prompt_id, [...(byTask.get(row.prompt_id) ?? []), row]);
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  const tasks = [...byTask]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, list]) => ({
      id,
      trials: list.length,
      pass: mean(list.map((row) => row.grade.pass)),
      critical: list.filter((row) => row.grade.no_critical === 0).length,
      approvalBroken: list.filter((row) => row.grade.approval_ok === 0).length,
      collateral: mean(list.map((row) => row.grade.collateral)),
      toolCalls: mean(list.map((row) => row.tool_calls)),
      toolErrors: mean(list.map((row) => row.tool_errors)),
      costUsd: list.reduce((sum, row) => sum + row.cost_usd, 0),
    }));
  return {
    tasks,
    trials: rows.length,
    pass: mean(rows.map((row) => row.grade.pass)),
    critical: rows.filter((row) => row.grade.no_critical === 0).length,
    costUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
  };
}

export function formatSummary(rows: readonly ResultRow[]): string {
  const summary = summarise(rows);
  const lines = [
    "task  trials  pass   critical  approval✗  collateral  calls  errors  cost",
    ...summary.tasks.map(
      (t) =>
        `${t.id.padEnd(5)} ${String(t.trials).padStart(6)}  ${(t.pass * 100).toFixed(0).padStart(3)}%  ${String(t.critical).padStart(8)}  ${String(t.approvalBroken).padStart(9)}  ${t.collateral.toFixed(1).padStart(10)}  ${t.toolCalls.toFixed(1).padStart(5)}  ${t.toolErrors.toFixed(1).padStart(6)}  $${t.costUsd.toFixed(2)}`,
    ),
    `all   ${String(summary.trials).padStart(6)}  ${(summary.pass * 100).toFixed(0).padStart(3)}%  ${String(summary.critical).padStart(8)}${" ".repeat(43)}$${summary.costUsd.toFixed(2)}`,
  ];
  return lines.join("\n");
}
