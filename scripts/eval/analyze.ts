import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TraceTurn } from "./agent.ts";

/**
 * What the transcripts say about the tools: per tool, how often it was
 * called, how often it failed and with which codes, which input fields the
 * schema rejected, how often an identical call was repeated, and how big its
 * results were. Plus the leak check: a tool description that names something
 * in the test book has been tuned to the test.
 *
 *   bun run eval:analyze -- work/eval-mcp/v3 [work/eval-mcp/v4 …] [--split dev|heldout|all] [--json]
 *
 * Only the development tasks' transcripts are read unless `--split` says
 * otherwise: the held-out transcripts exist for the final check, not for
 * tuning descriptions against.
 */

// -- The leak check ---------------------------------------------------------------

export type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type Leak = { tool: string; field: string; noun: string };

/**
 * Each place a proper noun of the test book appears in what the model is
 * shown of a surface: tool titles, descriptions and input schemas (field
 * descriptions included), and the server instructions. Whole words only,
 * case-sensitive, so ordinary English never trips it.
 */
export function leakCheck(
  tools: readonly ListedTool[],
  nouns: readonly string[],
  instructions = "",
): Leak[] {
  const patterns = [...new Set(nouns)]
    .filter((noun) => noun.trim().length > 1)
    .map((noun) => ({
      noun,
      pattern: new RegExp(
        `(?<![A-Za-z0-9])${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
      ),
    }));
  const leaks: Leak[] = [];
  const scan = (tool: string, field: string, text: string | undefined) => {
    if (!text) return;
    for (const { noun, pattern } of patterns)
      if (pattern.test(text)) leaks.push({ tool, field, noun });
  };
  for (const tool of tools) {
    scan(tool.name, "title", tool.title);
    scan(tool.name, "description", tool.description);
    scan(
      tool.name,
      "inputSchema",
      tool.inputSchema ? JSON.stringify(tool.inputSchema) : undefined,
    );
  }
  scan("(server)", "instructions", instructions);
  return leaks;
}

// -- Per-tool statistics ------------------------------------------------------------

export type TraceFile = { taskId: string; rep: number; turns: TraceTurn[] };

export type ToolStats = {
  tool: string;
  calls: number;
  errors: number;
  errorCodes: Record<string, number>;
  issuePaths: Record<string, number>;
  /** Calls identical (tool and input) to an earlier call in the same trial. */
  repeated: number;
  meanOutputBytes: number;
  maxOutputBytes: number;
  meanLatencyMs: number;
  /** Trials that called it at least once. */
  trials: number;
};

export type Analysis = {
  trials: number;
  calls: number;
  errors: number;
  unknownToolCalls: number;
  tools: ToolStats[];
};

export function analyzeTraces(traces: readonly TraceFile[]): Analysis {
  const stats = new Map<
    string,
    ToolStats & {
      outputTotal: number;
      latencyTotal: number;
      trialSet: Set<string>;
    }
  >();
  let calls = 0;
  let errors = 0;
  let unknown = 0;
  for (const trace of traces) {
    const seen = new Set<string>();
    const trialKey = `${trace.taskId}#${trace.rep}`;
    for (const turn of trace.turns) {
      if (turn.role !== "tool_result" || !turn.name) continue;
      calls++;
      const entry = stats.get(turn.name) ?? {
        tool: turn.name,
        calls: 0,
        errors: 0,
        errorCodes: {},
        issuePaths: {},
        repeated: 0,
        meanOutputBytes: 0,
        maxOutputBytes: 0,
        meanLatencyMs: 0,
        trials: 0,
        outputTotal: 0,
        latencyTotal: 0,
        trialSet: new Set<string>(),
      };
      entry.calls++;
      entry.trialSet.add(trialKey);
      const bytes = turn.output_bytes ?? Buffer.byteLength(turn.content ?? "");
      entry.outputTotal += bytes;
      entry.maxOutputBytes = Math.max(entry.maxOutputBytes, bytes);
      entry.latencyTotal += turn.latency_ms ?? 0;
      if (turn.is_error) {
        errors++;
        entry.errors++;
        const code = turn.error_code ?? "ERROR";
        entry.errorCodes[code] = (entry.errorCodes[code] ?? 0) + 1;
        if (code === "UNKNOWN_TOOL") unknown++;
        for (const path of turn.issue_paths ?? [])
          entry.issuePaths[path] = (entry.issuePaths[path] ?? 0) + 1;
      }
      const hash = turn.input_hash ?? `${turn.name}:${turn.content}`;
      if (seen.has(hash)) entry.repeated++;
      seen.add(hash);
      stats.set(turn.name, entry);
    }
  }
  const tools = [...stats.values()]
    .map(({ outputTotal, latencyTotal, trialSet, ...entry }) => ({
      ...entry,
      trials: trialSet.size,
      meanOutputBytes: entry.calls ? Math.round(outputTotal / entry.calls) : 0,
      meanLatencyMs: entry.calls ? Math.round(latencyTotal / entry.calls) : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  return {
    trials: traces.length,
    calls,
    errors,
    unknownToolCalls: unknown,
    tools,
  };
}

export function formatAnalysis(analysis: Analysis): string {
  const top = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([key, n]) => `${key}×${n}`)
      .join(" ");
  const lines = [
    `${analysis.trials} trials, ${analysis.calls} tool calls, ${analysis.errors} errors, ${analysis.unknownToolCalls} calls to tools that do not exist`,
    "",
    "tool                                  calls trials errors repeat  mean B   max B  ms  error codes / rejected fields",
    ...analysis.tools.map(
      (t) =>
        `${t.tool.padEnd(36)} ${String(t.calls).padStart(6)} ${String(t.trials).padStart(6)} ${String(t.errors).padStart(6)} ${String(t.repeated).padStart(6)} ${String(t.meanOutputBytes).padStart(7)} ${String(t.maxOutputBytes).padStart(7)} ${String(t.meanLatencyMs).padStart(3)}  ${top(t.errorCodes)}${Object.keys(t.issuePaths).length ? ` | ${top(t.issuePaths)}` : ""}`,
    ),
  ];
  return lines.join("\n");
}

// -- Reading a run --------------------------------------------------------------------

type State = { train_ids?: string[]; test_ids?: string[] };

/** The traces of one variant directory, limited to a split by the run's `_state.json`. */
export function readTraces(
  variantDir: string,
  split: "dev" | "heldout" | "all",
): TraceFile[] {
  const tracesDir = join(variantDir, "traces");
  if (!existsSync(tracesDir)) return [];
  const statePath = join(dirname(variantDir), "_state.json");
  const state: State = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
    : {};
  const allowed =
    split === "all"
      ? null
      : new Set(
          split === "dev" ? (state.train_ids ?? []) : (state.test_ids ?? []),
        );
  return readdirSync(tracesDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const match = basename(file, ".json").match(/^(.+)_rep(\d+)$/);
      if (!match) return [];
      const [, taskId, rep] = match;
      if (allowed && !allowed.has(taskId)) return [];
      return [
        {
          taskId,
          rep: Number(rep),
          turns: JSON.parse(
            readFileSync(join(tracesDir, file), "utf8"),
          ) as TraceTurn[],
        },
      ];
    });
}

async function main() {
  const args = process.argv.slice(2);
  const dirs = args.filter(
    (arg) => !arg.startsWith("--") && !["dev", "heldout", "all"].includes(arg),
  );
  const splitIndex = args.indexOf("--split");
  const split = (splitIndex >= 0 ? args[splitIndex + 1] : "dev") as
    | "dev"
    | "heldout"
    | "all";
  if (!dirs.length || !["dev", "heldout", "all"].includes(split)) {
    console.error(
      "usage: bun run eval:analyze -- <variantDir> [more…] [--split dev|heldout|all] [--json]",
    );
    process.exit(2);
  }
  if (split !== "dev")
    console.warn(
      "Note: held-out transcripts are kept for the final check; tune descriptions on the dev split only.",
    );
  let leaksFound = false;
  for (const dir of dirs) {
    const analysis = analyzeTraces(readTraces(dir, split));
    const toolsPath = join(dir, "tools.json");
    const listing = existsSync(toolsPath)
      ? (JSON.parse(readFileSync(toolsPath, "utf8")) as {
          tools: ListedTool[];
          instructions?: string;
          nouns?: string[];
        })
      : null;
    const leaks = listing
      ? leakCheck(listing.tools, listing.nouns ?? [], listing.instructions)
      : [];
    if (leaks.length) leaksFound = true;
    if (args.includes("--json"))
      console.log(JSON.stringify({ dir, analysis, leaks }, null, 2));
    else {
      console.log(`\n== ${dir} (${split})`);
      console.log(formatAnalysis(analysis));
      console.log(
        listing
          ? leaks.length
            ? `\nLEAK CHECK FAILED:\n${leaks.map((l) => `  ${l.tool} ${l.field}: "${l.noun}"`).join("\n")}`
            : "\nLeak check: no test-book noun in any tool description."
          : "\n(no tools.json; leak check skipped)",
      );
    }
  }
  process.exit(leaksFound ? 1 : 0);
}

if (import.meta.main) await main();
