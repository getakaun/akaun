import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

/**
 * The model loop of one evaluation trial: a plain manual tool loop over the
 * Messages API, chosen over the SDK's Tool Runner so that every tool call can
 * be timed and classified, turns can be scripted (a two-turn approval, one
 * "Go ahead" nudge), the iteration cap and the per-trial budget are exact, and
 * the model client can be a scripted fake in specs.
 *
 * Each request sends the same tools (MCP tools sorted by name, then the
 * harness tools) and system prompt, so the cached prefix holds across
 * iterations and trials; `cache_control` on the request caches the growing
 * conversation. History is append-only (assistant content is passed back
 * unchanged, thinking blocks included). Adaptive thinking and the effort are
 * set explicitly; no `fallbacks` are sent, and every response must come from
 * the requested model — a score always belongs to the model asked for.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Model calls per trial, across every turn. */
export const MAX_ITERATIONS = 60;
/** Output cap per request; streaming keeps a long turn clear of HTTP timeouts. */
export const MAX_OUTPUT_TOKENS = 32_000;
/** What the simulated owner says, once, when an `auto` task's agent stops to ask. */
export const NUDGE_TEXT = "Go ahead.";

// -- Prices ---------------------------------------------------------------------

/** USD per million tokens. Cache writes cost 1.25× input (5-minute cache). */
export type Price = {
  in: number;
  out: number;
  cacheRead: number;
  /** A higher rate for a request whose prompt is over `threshold` tokens. */
  longPrompt?: {
    threshold: number;
    in: number;
    out: number;
    cacheRead: number;
  };
};

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    in: 0.1,
    out: 0.5,
    cacheRead: 0.01,
    longPrompt: { threshold: 100_000, in: 0.5, out: 2.5, cacheRead: 0.05 },
  },
};
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** A scripted model id (`fake:<tool>,…`): no API call, no cost. */
export function isFakeModel(model: string): boolean {
  return model.startsWith("fake:");
}

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export function emptyUsage(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addUsage(total: UsageTotals, usage: Anthropic.Usage): void {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

/** The cost of one response's usage, in USD. Scripted models cost nothing. */
export function costOf(
  model: string,
  usage: UsageTotals | Anthropic.Usage,
): number {
  if (isFakeModel(model)) return 0;
  const price = PRICES[model];
  if (!price)
    throw new Error(
      `No price is known for model ${model}; add it to PRICES in scripts/eval/agent.ts.`,
    );
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + cacheWrite + cacheRead;
  const rate =
    price.longPrompt && prompt > price.longPrompt.threshold
      ? price.longPrompt
      : price;
  return (
    (usage.input_tokens * rate.in +
      cacheWrite * rate.in * CACHE_WRITE_MULTIPLIER +
      cacheRead * rate.cacheRead +
      usage.output_tokens * rate.out) /
    1_000_000
  );
}

/** How much a trial's output grows with effort, against `high`. */
const EFFORT_OUTPUT: Record<Effort, number> = {
  low: 0.4,
  medium: 0.7,
  high: 1,
  xhigh: 1.5,
  max: 2,
};

/**
 * A rough cost of one trial, for the estimate printed before a run: the
 * prefix (tools and system prompt) read from cache on every iteration, the
 * conversation growing by `growthTokens` per iteration, and `outputTokens` of
 * output (thinking included) per iteration at `high` effort.
 */
export function estimateTrialCost(options: {
  model: string;
  effort: Effort;
  prefixTokens: number;
  iterations?: number;
  growthTokens?: number;
  outputTokens?: number;
}): number {
  if (isFakeModel(options.model)) return 0;
  const n = options.iterations ?? 18;
  const growth = options.growthTokens ?? 2_500;
  const output = Math.round(
    (options.outputTokens ?? 1_500) * EFFORT_OUTPUT[options.effort],
  );
  return costOf(options.model, {
    input_tokens: n * 50,
    cache_creation_input_tokens: options.prefixTokens + n * growth,
    cache_read_input_tokens:
      n * options.prefixTokens + (growth * n * (n - 1)) / 2,
    output_tokens: n * output,
  });
}

// -- The model client -------------------------------------------------------------

/** One Messages API call, returning the complete message. Injected, so specs can script it. */
export interface ModelClient {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message>;
}

export type RetryInfo = {
  attempt: number;
  delayMs: number;
  status: number | null;
  error: string;
};

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 6;

/**
 * The real client. The key is passed in (it comes only from
 * `ANTHROPIC_API_KEY`), so no other credential source is read; the base URL
 * is fixed. The SDK's own retries are off and done here instead, with backoff
 * and jitter, so each one is reported to `onRetry` for `errors.jsonl`.
 */
export function anthropicModelClient(options: {
  apiKey: string;
  onRetry?: (info: RetryInfo) => void;
}): ModelClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: "https://api.anthropic.com",
    maxRetries: 0,
    timeout: 15 * 60 * 1000,
  });
  return {
    async create(params) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.messages.stream(params).finalMessage();
        } catch (error) {
          const status =
            error instanceof Anthropic.APIError &&
            typeof error.status === "number"
              ? error.status
              : null;
          const retryable =
            error instanceof Anthropic.APIConnectionError ||
            (status !== null && RETRYABLE_STATUS.has(status));
          if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
          const header =
            error instanceof Anthropic.APIError
              ? Number(error.headers?.get?.("retry-after"))
              : NaN;
          const backoff = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
          const delayMs =
            Number.isFinite(header) && header > 0
              ? Math.min(120_000, header * 1000)
              : backoff + Math.round(Math.random() * backoff * 0.3);
          options.onRetry?.({
            attempt,
            delayMs,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          await Bun.sleep(delayMs);
        }
      }
    },
  };
}

/**
 * A scripted model for the CLI and specs: `fake:` calls nothing and answers;
 * `fake:list_accounts,get_record` calls each named tool in turn (the first
 * tool whose name ends with it, with `{}` as input), then answers. Every later
 * user turn gets a short answer. It reports small, fixed usage and the model
 * id it was asked for.
 */
export function scriptedModelClient(model: string): ModelClient {
  const script = model
    .slice("fake:".length)
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean);
  let step = 0;
  let call = 0;
  return {
    async create(params) {
      call++;
      const last = params.messages.at(-1);
      const afterTool =
        Array.isArray(last?.content) &&
        last.content.some((block) => block.type === "tool_result");
      const startOfTurn = !afterTool;
      const names = (params.tools ?? []).flatMap((tool) =>
        "name" in tool && typeof tool.name === "string" ? [tool.name] : [],
      );
      if (step < script.length && (afterTool || call === 1)) {
        const wanted = script[step++];
        const name = names.find(
          (n) => n === wanted || n.endsWith(`_${wanted}`),
        );
        if (name)
          return fakeMessage(
            model,
            [
              {
                type: "tool_use",
                id: `toolu_fake_${call}`,
                name,
                input: {},
                caller: { type: "direct" },
              } as Anthropic.ToolUseBlock,
            ],
            "tool_use",
          );
      }
      const text = startOfTurn && call > 1 ? "Done." : "Here is what I found.";
      return fakeMessage(
        model,
        [{ type: "text", text, citations: null } as Anthropic.TextBlock],
        "end_turn",
      );
    },
  };
}

function fakeMessage(
  model: string,
  content: Anthropic.ContentBlock[],
  stop: Anthropic.StopReason,
): Anthropic.Message {
  return {
    id: `msg_fake_${createHash("sha1").update(JSON.stringify(content)).digest("hex").slice(0, 12)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 1_200,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

// -- Tools ------------------------------------------------------------------------

/** What a tool call gave back, for the model and for the metrics. */
export type ToolOutcome = {
  content: Anthropic.ToolResultBlockParam["content"];
  isError: boolean;
  /** The error code in the result (`INVALID_INPUT`, `NOT_FOUND`, …), when there is one. */
  errorCode?: string;
  /** Input fields an `INVALID_INPUT` named, as dotted paths. */
  issuePaths?: string[];
  /** The result as the trace shows it: its text, with binary blocks summarised. */
  traceText: string;
  outputBytes: number;
};

export type ToolExecutor = {
  /** Every tool the model is offered, in the order it is offered. */
  definitions: Anthropic.Tool[];
  call(name: string, input: unknown): Promise<ToolOutcome>;
};

/** One tool call, as the metrics record it. */
export type CallRecord = {
  iteration: number;
  turn: number;
  tool: string;
  latencyMs: number;
  isError: boolean;
  errorCode?: string;
  issuePaths?: string[];
  inputBytes: number;
  outputBytes: number;
  /** A hash of tool and input, to find repeated calls. */
  inputHash: string;
};

/** A trace turn, in the hill-climbing report's format plus per-call fields. */
export type TraceTurn = {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  thinking?: string;
  name?: string;
  is_error?: boolean;
  error_code?: string;
  issue_paths?: string[];
  latency_ms?: number;
  input_bytes?: number;
  output_bytes?: number;
  input_hash?: string;
};

// -- The loop ---------------------------------------------------------------------

export type AgentStop =
  | "end_turn"
  | "iteration_cap"
  | "budget"
  | "refusal"
  | "max_tokens"
  | "context_window"
  | "model_mismatch"
  | "api_error";

export type AgentRunOptions = {
  client: ModelClient;
  model: string;
  effort: Effort;
  system: string;
  tools: ToolExecutor;
  /** The owner's messages, in order. */
  turns: readonly string[];
  maxIterations?: number;
  maxOutputTokens?: number;
  /** Stop once this much has been spent (USD). */
  budgetUsd?: number;
  /** Runs before each scripted turn is sent; the trial snapshots the book before an approval turn. */
  beforeTurn?: (index: number) => void | Promise<void>;
  /**
   * After the last turn: whether to answer `NUDGE_TEXT` once, given the
   * agent's last text. `auto` tasks use it when the agent stopped to ask.
   */
  shouldNudge?: (lastText: string) => boolean | Promise<boolean>;
};

export type AgentRunResult = {
  /** Everything the agent wrote to the owner in the last turn it answered. */
  finalAnswer: string;
  stop: AgentStop;
  iterations: number;
  extraTurns: number;
  usage: UsageTotals;
  costUsd: number;
  calls: CallRecord[];
  trace: TraceTurn[];
  /** The model each response came from. */
  responseModels: string[];
  stopDetails?: string;
  error?: string;
  wallMs: number;
};

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function thinkingOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter(
      (block): block is Anthropic.ThinkingBlock => block.type === "thinking",
    )
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function hashCall(name: string, input: unknown): string {
  return createHash("sha256")
    .update(`${name}\u0000${JSON.stringify(input ?? null)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Runs the scripted conversation to its end. Never throws: an API failure ends the run with `stop: "api_error"`. */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const started = performance.now();
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const messages: Anthropic.MessageParam[] = [];
  const trace: TraceTurn[] = [{ role: "system", content: options.system }];
  const calls: CallRecord[] = [];
  const usage = emptyUsage();
  const responseModels: string[] = [];
  let costUsd = 0;
  let iterations = 0;
  let extraTurns = 0;
  /** The agent's text in the current turn, message by message. */
  let turnTexts: string[] = [];
  let lastAnswered: string[] = [];
  let stop: AgentStop = "end_turn";
  let stopDetails: string | undefined;
  let error: string | undefined;

  /** One user message, then model calls until the turn ends. False when the run must stop. */
  async function turn(index: number, text: string): Promise<boolean> {
    messages.push({ role: "user", content: text });
    trace.push({ role: "user", content: text });
    turnTexts = [];
    for (;;) {
      if (iterations >= maxIterations) {
        stop = "iteration_cap";
        return false;
      }
      if (options.budgetUsd !== undefined && costUsd >= options.budgetUsd) {
        stop = "budget";
        return false;
      }
      iterations++;
      let response: Anthropic.Message;
      try {
        response = await options.client.create({
          model: options.model,
          max_tokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          system: options.system,
          tools: options.tools.definitions,
          messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: options.effort },
          cache_control: { type: "ephemeral" },
        });
      } catch (caught) {
        stop = "api_error";
        error = caught instanceof Error ? caught.message : String(caught);
        return false;
      }
      responseModels.push(response.model);
      addUsage(usage, response.usage);
      costUsd += costOf(options.model, response.usage);
      if (response.model !== options.model) {
        stop = "model_mismatch";
        error = `Asked for ${options.model}, answered by ${response.model}.`;
        return false;
      }
      messages.push({ role: "assistant", content: response.content });
      const text = textOf(response.content);
      const thinking = thinkingOf(response.content);
      if (text || thinking)
        trace.push({
          role: "assistant",
          content: text,
          ...(thinking ? { thinking } : {}),
        });
      if (text) {
        turnTexts.push(text);
        lastAnswered = turnTexts;
      }

      if (response.stop_reason === "refusal") {
        stop = "refusal";
        stopDetails = JSON.stringify(
          (response as { stop_details?: unknown }).stop_details ?? null,
        );
        return false;
      }
      if (response.stop_reason === "model_context_window_exceeded") {
        stop = "context_window";
        return false;
      }
      if (response.stop_reason === "pause_turn") continue;
      const uses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      if (response.stop_reason === "max_tokens") {
        // A tool input cut off at the cap may still parse; never run it.
        stop = "max_tokens";
        return false;
      }
      if (uses.length === 0) return true;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const inputJson = JSON.stringify(use.input ?? {});
        trace.push({ role: "tool_call", name: use.name, content: inputJson });
        const begun = performance.now();
        let outcome: ToolOutcome;
        try {
          outcome = await options.tools.call(use.name, use.input);
        } catch (caught) {
          const message =
            caught instanceof Error ? caught.message : String(caught);
          outcome = {
            content: message,
            isError: true,
            errorCode: "HARNESS_ERROR",
            traceText: message,
            outputBytes: Buffer.byteLength(message),
          };
        }
        const record: CallRecord = {
          iteration: iterations,
          turn: index,
          tool: use.name,
          latencyMs: Math.round(performance.now() - begun),
          isError: outcome.isError,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          ...(outcome.issuePaths?.length
            ? { issuePaths: outcome.issuePaths }
            : {}),
          inputBytes: Buffer.byteLength(inputJson),
          outputBytes: outcome.outputBytes,
          inputHash: hashCall(use.name, use.input),
        };
        calls.push(record);
        trace.push({
          role: "tool_result",
          name: use.name,
          content: outcome.traceText,
          is_error: outcome.isError,
          ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
          ...(outcome.issuePaths?.length
            ? { issue_paths: outcome.issuePaths }
            : {}),
          latency_ms: record.latencyMs,
          input_bytes: record.inputBytes,
          output_bytes: record.outputBytes,
          input_hash: record.inputHash,
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      // Every result of one response goes back in one user message.
      messages.push({ role: "user", content: results });
    }
  }

  let going = true;
  for (let index = 0; going && index < options.turns.length; index++) {
    await options.beforeTurn?.(index);
    going = await turn(index, options.turns[index]);
  }
  if (
    going &&
    options.shouldNudge &&
    (await options.shouldNudge(lastAnswered.at(-1) ?? ""))
  ) {
    extraTurns = 1;
    await turn(options.turns.length, NUDGE_TEXT);
  }

  return {
    finalAnswer: lastAnswered.join("\n\n"),
    stop,
    iterations,
    extraTurns,
    usage,
    costUsd,
    calls,
    trace,
    responseModels,
    ...(stopDetails ? { stopDetails } : {}),
    ...(error ? { error } : {}),
    wallMs: Math.round(performance.now() - started),
  };
}

/** Whether an agent's last message is a question to the owner rather than a report. */
export function asksBeforeActing(lastText: string): boolean {
  const text = lastText.trim();
  if (!text) return false;
  return (
    /\?\s*$/.test(text) ||
    /\b(shall i|should i|would you like|do you want|want me to|let me know if you(?:'d| would) like|please confirm|confirm (?:that|if|whether)|before i (?:proceed|make|change|save))\b/i.test(
      text,
    )
  );
}
