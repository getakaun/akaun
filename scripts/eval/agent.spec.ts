import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { localToday } from "../../src/lib/local-date.js";
import { patLocals } from "../../src/lib/server/tokens/pat.js";
import { defineReadTool } from "../../src/lib/server/mcp/registry.js";
import {
  asksBeforeActing,
  costOf,
  estimateTrialCost,
  NUDGE_TEXT,
  runAgent,
  scriptedModelClient,
  type ModelClient,
  type ToolExecutor,
} from "./agent.ts";
import {
  connectSurface,
  EVAL_ORIGIN,
  mcpToolExecutor,
  toolSurfaceHash,
} from "./surfaces.ts";
import { fetchUrl, readInbox } from "./harness-tools.ts";
import {
  buildTemplate,
  openBookCopy,
  readTemplate,
  runTrial,
} from "./trial.ts";

// No network and no API key: every model here is a scripted fake. Books are
// file databases under os.tmpdir(); nothing imports db/client.ts. Run with
//   bun test --preload ./scripts/mcp-test-preload.ts scripts/eval/agent.spec.ts

const SLOW = 120_000;
const MODEL = "claude-sonnet-5-5";

type Params = Anthropic.MessageCreateParamsNonStreaming;

function message(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.StopReason,
  options: { model?: string; usage?: Partial<Anthropic.Usage> } = {},
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: options.model ?? MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...options.usage,
    },
  } as unknown as Anthropic.Message;
}

const text = (value: string) =>
  ({ type: "text", text: value, citations: null }) as Anthropic.TextBlock;
const use = (id: string, name: string, input: unknown) =>
  ({
    type: "tool_use",
    id,
    name,
    input,
    caller: { type: "direct" },
  }) as Anthropic.ToolUseBlock;

/** Answers with the scripted responses in order, recording every request. */
function fakeClient(
  script: ((params: Params) => Anthropic.Message)[],
  seen: Params[] = [],
): ModelClient {
  let call = 0;
  return {
    async create(params) {
      seen.push(structuredClone(params));
      const step = script[Math.min(call++, script.length - 1)];
      return step(params);
    },
  };
}

/** Two tools: `echo` answers, `fail` returns an INVALID_INPUT error result. */
const tools: ToolExecutor = {
  definitions: [
    { name: "echo", description: "Echo", input_schema: { type: "object" } },
    { name: "fail", description: "Fail", input_schema: { type: "object" } },
  ],
  async call(name, input) {
    if (name === "echo") {
      const body = JSON.stringify({ echoed: input });
      return {
        content: body,
        isError: false,
        traceText: body,
        outputBytes: body.length,
      };
    }
    const body = JSON.stringify({
      error: {
        code: "INVALID_INPUT",
        message: "bad",
        issues: [{ path: ["amount"] }],
      },
    });
    return {
      content: body,
      isError: true,
      errorCode: "INVALID_INPUT",
      issuePaths: ["amount"],
      traceText: body,
      outputBytes: body.length,
    };
  },
};

describe("the model loop", () => {
  it("calls the tools it is asked to, records each call, and returns the last turn's text", async () => {
    const seen: Params[] = [];
    const result = await runAgent({
      client: fakeClient(
        [
          () =>
            message(
              [
                text("Looking."),
                use("t1", "echo", { a: 1 }),
                use("t2", "fail", {}),
              ],
              "tool_use",
            ),
          () => message([use("t3", "echo", { a: 1 })], "tool_use"),
          () => message([text("All done: 2 echoes.")], "end_turn"),
        ],
        seen,
      ),
      model: MODEL,
      effort: "high",
      system: "SYSTEM",
      tools,
      turns: ["Do it."],
    });
    expect(result.stop).toBe("end_turn");
    expect(result.iterations).toBe(3);
    expect(result.finalAnswer).toBe("Looking.\n\nAll done: 2 echoes.");
    expect(
      result.calls.map((c) => [c.tool, c.isError, c.errorCode ?? null]),
    ).toEqual([
      ["echo", false, null],
      ["fail", true, "INVALID_INPUT"],
      ["echo", false, null],
    ]);
    expect(result.calls[1].issuePaths).toEqual(["amount"]);
    expect(result.calls[0].inputHash).toBe(result.calls[2].inputHash);
    expect(
      result.calls.every(
        (c) => c.inputBytes > 0 && c.outputBytes > 0 && c.latencyMs >= 0,
      ),
    ).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 300,
      output_tokens: 60,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(result.trace.map((t) => t.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
    ]);

    // Every request: same tools and system, adaptive thinking, the effort, caching, no fallbacks.
    for (const params of seen) {
      expect(params.model).toBe(MODEL);
      expect(params.system).toBe("SYSTEM");
      expect(params.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual([
        "echo",
        "fail",
      ]);
      expect(params.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
      expect(params.output_config).toEqual({ effort: "high" });
      expect(params.cache_control).toEqual({ type: "ephemeral" });
      expect("fallbacks" in params).toBe(false);
    }
    // Both results of one response go back in one user message, after the assistant's content.
    const second = seen[1].messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(
      (second[2].content as Anthropic.ToolResultBlockParam[]).map((b) => [
        b.tool_use_id,
        b.is_error ?? false,
      ]),
    ).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
  });

  it("stops at the iteration cap", async () => {
    const result = await runAgent({
      client: fakeClient([() => message([use("x", "echo", {})], "tool_use")]),
      model: MODEL,
      effort: "low",
      system: "",
      tools,
      turns: ["Loop."],
      maxIterations: 5,
    });
    expect(result.stop).toBe("iteration_cap");
    expect(result.iterations).toBe(5);
    expect(result.calls).toHaveLength(5);
  });

  it("stops when the budget is spent", async () => {
    const result = await runAgent({
      client: fakeClient([
        () =>
          message([use("x", "echo", {})], "tool_use", {
            usage: { input_tokens: 100_000 },
          }),
      ]),
      model: MODEL,
      effort: "low",
      system: "",
      tools,
      turns: ["Spend."],
      budgetUsd: 0.5,
    });
    // $2 per million input tokens: each call costs $0.20, so the third reaches $0.60.
    expect(result.stop).toBe("budget");
    expect(result.iterations).toBe(3);
    expect(result.costUsd).toBeCloseTo(0.6 + (3 * 20 * 10) / 1_000_000, 6);
  });

  it("refuses an answer from a model it did not ask for", async () => {
    const result = await runAgent({
      client: fakeClient([
        () => message([text("hi")], "end_turn", { model: "claude-opus-4-8" }),
      ]),
      model: MODEL,
      effort: "high",
      system: "",
      tools,
      turns: ["Hello."],
    });
    expect(result.stop).toBe("model_mismatch");
    expect(result.error).toContain("claude-opus-4-8");
  });

  it("ends on a refusal without running its tools", async () => {
    const result = await runAgent({
      client: fakeClient([() => message([use("x", "echo", {})], "refusal")]),
      model: MODEL,
      effort: "high",
      system: "",
      tools,
      turns: ["Hello."],
    });
    expect(result.stop).toBe("refusal");
    expect(result.calls).toHaveLength(0);
  });

  it("sends each scripted turn, and says 'Go ahead.' once when the agent stops to ask", async () => {
    const seen: Params[] = [];
    const turns: number[] = [];
    const result = await runAgent({
      client: fakeClient(
        [
          () => message([text("Plan: merge two contacts.")], "end_turn"),
          () => message([text("Shall I go ahead?")], "end_turn"),
          () => message([text("Merged.")], "end_turn"),
        ],
        seen,
      ),
      model: MODEL,
      effort: "high",
      system: "",
      tools,
      turns: ["First.", "Second."],
      beforeTurn: (index) => {
        turns.push(index);
      },
      shouldNudge: asksBeforeActing,
    });
    expect(turns).toEqual([0, 1]);
    expect(result.extraTurns).toBe(1);
    expect(seen.at(-1)!.messages.at(-1)).toEqual({
      role: "user",
      content: NUDGE_TEXT,
    });
    expect(result.finalAnswer).toBe("Merged.");
  });

  it("tells a question to the owner from a report", () => {
    expect(asksBeforeActing("Shall I merge them?")).toBe(true);
    expect(
      asksBeforeActing(
        "Here is the plan. Would you like me to proceed with it.",
      ),
    ).toBe(true);
    expect(asksBeforeActing("Merged the three contacts into one.")).toBe(false);
    expect(asksBeforeActing("")).toBe(false);
  });
});

describe("prices", () => {
  it("prices input, output, cache writes (1.25×) and cache reads", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    expect(costOf("claude-opus-5-5", usage)).toBeCloseTo(4 + 20 + 5 + 0.2, 9);
    expect(costOf("claude-sonnet-5-5", usage)).toBeCloseTo(
      2 + 10 + 2.5 + 0.1,
      9,
    );
    expect(costOf("fake:list_accounts", usage)).toBe(0);
    expect(() => costOf("claude-unknown", usage)).toThrow(/No price/);
    // Haiku 5.5: prompts over 100K tokens take the higher rate.
    expect(
      costOf("claude-haiku-5-5", {
        input_tokens: 10_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(0.001 + 0.5, 9);
    expect(
      costOf("claude-haiku-5-5", {
        input_tokens: 200_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(0.1 + 2.5, 9);
  });

  it("estimates a trial at about a dollar on Opus at high effort, less on Sonnet and at lower effort", () => {
    const opus = estimateTrialCost({
      model: "claude-opus-5-5",
      effort: "high",
      prefixTokens: 20_000,
    });
    expect(opus).toBeGreaterThan(0.5);
    expect(opus).toBeLessThan(2.5);
    expect(
      estimateTrialCost({
        model: "claude-sonnet-5-5",
        effort: "high",
        prefixTokens: 20_000,
      }),
    ).toBeCloseTo(opus / 2, 6);
    expect(
      estimateTrialCost({
        model: "claude-opus-5-5",
        effort: "low",
        prefixTokens: 20_000,
      }),
    ).toBeLessThan(opus);
    expect(
      estimateTrialCost({
        model: "fake:",
        effort: "max",
        prefixTokens: 20_000,
      }),
    ).toBe(0);
  });
});

/** One template of variant A, for the tests below. */
function withTemplate(
  name: string,
  check: (dir: string, root: string) => Promise<void>,
) {
  it(
    name,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "akaun-eval-agent-spec-"));
      try {
        await buildTemplate(join(root, "A"), "A", localToday());
        await check(join(root, "A"), root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SLOW,
  );
}

describe("a trial against the v2 surface", () => {
  withTemplate(
    "runs a scripted model that lists accounts, verifies, and records metrics and a trace",
    async (template, root) => {
      const trialDir = join(root, "trial");
      const outcome = await runTrial({
        trialDir,
        templateDir: template,
        taskId: "D13",
        model: "fake:list_accounts",
        effort: "high",
        rep: 0,
        surface: "v2",
        naming: "akaun_verb_noun",
      });
      expect(outcome.mode).toBe("model");
      expect(outcome.responseModel).toBe("fake:list_accounts");
      expect(outcome.toolCount).toBe(28);
      expect(outcome.toolSurfaceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(outcome.agent?.stop).toBe("end_turn");
      expect(outcome.agent?.calls.map((c) => [c.tool, c.isError])).toEqual([
        ["akaun_list_accounts", false],
      ]);
      expect(outcome.agent?.calls[0].outputBytes).toBeGreaterThan(100);
      // The verifier ran: the scripted answer gives no August figures, so it fails.
      expect(outcome.verdict.pass).toBe(false);
      expect(
        outcome.verdict.notes.some((note) =>
          note.startsWith("FAIL: the answer should give August"),
        ),
      ).toBe(true);
      expect(outcome.verdict.collateral).toEqual([]);
      expect(outcome.trace.map((t) => t.role)).toEqual([
        "system",
        "user",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      expect(outcome.trace[0].content).toContain(
        "Bookkeeping rules for this business",
      );
      expect(outcome.trace[0].content).toContain(
        "Akaun's instructions for its tools",
      );
      expect(JSON.stringify(outcome)).not.toMatch(/akp_[A-Za-z0-9]{6}/);
    },
  );

  withTemplate(
    "hands out working file links, and reads the inbox",
    async (template, root) => {
      const info = readTemplate(template);
      const book = openBookCopy(template, join(root, "copy"), info.manifest);
      try {
        const locals = patLocals(book.db, `Bearer ${info.agentToken}`)!;
        const connection = await connectSurface(
          { surface: "v2", naming: "akaun_verb_noun" },
          {
            db: book.db,
            locals,
            store: book.store,
            storageRoot: book.storageRoot,
            requestOrigin: EVAL_ORIGIN,
          },
        );
        try {
          const executor = mcpToolExecutor(connection);
          const attachment = info.manifest.attachments.canvaPro!;
          const linked = await executor.call("akaun_get_attachment", {
            recordId: info.manifest.records.canvaPro,
            attachmentId: attachment.id,
          });
          expect(linked.isError).toBe(false);
          const url = (JSON.parse(linked.traceText) as { downloadUrl: string })
            .downloadUrl;
          expect(url.startsWith(`${EVAL_ORIGIN}/api/mcp-files/`)).toBe(true);
          const options = {
            db: book.db,
            store: book.store,
            origin: EVAL_ORIGIN,
          };
          const file = await fetchUrl(options, { url });
          expect(file.isError).toBe(false);
          expect((file.content as Anthropic.DocumentBlockParam[])[0].type).toBe(
            "document",
          );
          // Single use, as in the app.
          expect((await fetchUrl(options, { url })).errorCode).toBe("HTTP_410");
          expect(
            (await fetchUrl(options, { url: "https://example.com/x.pdf" }))
              .isError,
          ).toBe(true);

          const missing = await executor.call("akaun_get_record", {
            record: 999_999,
          });
          expect(missing.isError).toBe(true);
          expect(missing.errorCode).toBe("NOT_FOUND");
          const invalid = await executor.call("akaun_get_record", {
            record: { id: "seven" },
          });
          expect(invalid.isError).toBe(true);
          expect(invalid.errorCode).toBe("INVALID_INPUT");
          expect((await executor.call("no_such_tool", {})).errorCode).toBe(
            "UNKNOWN_TOOL",
          );
        } finally {
          await connection.close();
        }
      } finally {
        book.raw.close();
      }
      const inbox = readInbox("A", {});
      const blocks = inbox.content as Anthropic.ContentBlockParam[];
      const listing = JSON.parse(
        (blocks[0] as Anthropic.TextBlockParam).text,
      ) as { emails: { attachments: unknown[] }[] };
      expect(listing.emails).toHaveLength(3);
      expect(blocks.filter((b) => b.type === "document")).toHaveLength(1);
      expect(
        JSON.parse(
          (
            readInbox("A", { query: "payroll" })
              .content as Anthropic.TextBlockParam[]
          )[0].text,
        ).emails,
      ).toHaveLength(1);
    },
  );
});

describe("the v2 surface", () => {
  withTemplate(
    "lists the registry's tools under each naming scheme and calls them",
    async (template, root) => {
      const info = readTemplate(template);
      const book = openBookCopy(template, join(root, "copy"), info.manifest);
      const widget = defineReadTool({
        base: "get_widget",
        title: "Get a widget",
        description: "Reads one widget by id.",
        input: z.object({ id: z.number().int().positive() }),
        requirements: [
          { scopes: ["records:read"], permissions: ["records.read"] },
        ],
        handler: (_ctx, args) => ({ id: args.id }),
      });
      try {
        const locals = patLocals(book.db, `Bearer ${info.agentToken}`)!;
        const ctx = {
          db: book.db,
          locals,
          store: book.store,
          storageRoot: book.storageRoot,
          requestOrigin: EVAL_ORIGIN,
        };
        const hashes = new Set<string>();
        for (const [naming, name] of [
          ["akaun_verb_noun", "akaun_get_widget"],
          ["akaun_noun_verb", "akaun_widget_get"],
          ["plain", "get_widget"],
        ] as const) {
          const connection = await connectSurface(
            { surface: "v2", naming },
            ctx,
            { reads: [widget], writes: [] },
          );
          try {
            expect(connection.tools.map((t) => t.name)).toEqual([name]);
            expect(connection.hash).toBe(
              toolSurfaceHash(connection.tools, connection.instructions),
            );
            hashes.add(connection.hash);
            const executor = mcpToolExecutor(connection);
            expect(executor.definitions[0].input_schema.type).toBe("object");
            const ok = await executor.call(name, { id: 7 });
            expect([ok.isError, JSON.parse(ok.traceText)]).toEqual([
              false,
              { id: 7 },
            ]);
            const bad = await executor.call(name, { id: -1 });
            expect([bad.isError, bad.errorCode, bad.issuePaths]).toEqual([
              true,
              "INVALID_INPUT",
              ["id"],
            ]);
          } finally {
            await connection.close();
          }
        }
        expect(hashes.size).toBe(3);
      } finally {
        book.raw.close();
      }
    },
  );

  it("scripts a model that names its tools by suffix, under any naming scheme", async () => {
    const client = scriptedModelClient("fake:list_accounts");
    const result = await runAgent({
      client,
      model: "fake:list_accounts",
      effort: "high",
      system: "",
      tools: {
        definitions: [
          { name: "akaun_list_accounts", input_schema: { type: "object" } },
        ],
        call: async () => ({
          content: "[]",
          isError: false,
          traceText: "[]",
          outputBytes: 2,
        }),
      },
      turns: ["List them.", "Thanks."],
    });
    expect(result.calls.map((c) => c.tool)).toEqual(["akaun_list_accounts"]);
    expect(result.finalAnswer).toBe("Done.");
    expect(result.costUsd).toBe(0);
  });
});
