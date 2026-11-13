import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TraceTurn } from "./agent.ts";
import { analyzeTraces, leakCheck, readTraces } from "./analyze.ts";
import {
  appendResult,
  chooseVariantDir,
  finishedTrials,
  scrubSecrets,
  summarise,
  writeState,
  writeSummary,
  type ResultRow,
  type RunConfig,
} from "./results.ts";

// Pure functions and files under os.tmpdir(); no book, no model.

const NOUNS = [
  "Shopee Malaysia",
  "Shopee",
  "Grab",
  "Maybank",
  "INV-A-1001",
  "J&T",
];

describe("the leak check", () => {
  it("catches a test-book noun planted in a description, a schema or the instructions", () => {
    const leaks = leakCheck(
      [
        {
          name: "akaun_search_records",
          description: "Find records, e.g. every Shopee order last month.",
        },
        {
          name: "akaun_get_record",
          description: "Read one record.",
          inputSchema: {
            properties: { id: { description: "Like INV-A-1001." } },
          },
        },
        {
          name: "akaun_list_accounts",
          title: "List accounts",
          description: "Lists the chart; grab the id you need.",
        },
      ],
      NOUNS,
      "Start with akaun_get_books_overview. Bank lines look like Maybank's.",
    );
    expect(leaks).toEqual([
      { tool: "akaun_search_records", field: "description", noun: "Shopee" },
      { tool: "akaun_get_record", field: "inputSchema", noun: "INV-A-1001" },
      { tool: "(server)", field: "instructions", noun: "Maybank" },
    ]);
  });

  it("passes descriptions that name nothing in the book", () => {
    expect(
      leakCheck(
        [
          {
            name: "akaun_change_contacts",
            description:
              "Merge duplicate suppliers; the result lists every record moved. Grabbing ids is not needed.",
          },
        ],
        NOUNS,
      ),
    ).toEqual([]);
  });
});

function turn(
  name: string,
  input: string,
  extra: Partial<TraceTurn> = {},
): TraceTurn[] {
  return [
    { role: "tool_call", name, content: input },
    {
      role: "tool_result",
      name,
      content: "{}",
      output_bytes: 100,
      latency_ms: 4,
      input_hash: `${name}:${input}`,
      ...extra,
    },
  ];
}

describe("per-tool statistics", () => {
  it("counts calls, errors, codes, rejected fields, repeats and sizes", () => {
    const analysis = analyzeTraces([
      {
        taskId: "D01",
        rep: 0,
        turns: [
          { role: "system", content: "…" },
          ...turn("akaun_search_records", '{"q":"x"}'),
          ...turn("akaun_search_records", '{"q":"x"}'),
          ...turn("akaun_change_records", '{"update":[]}', {
            is_error: true,
            error_code: "INVALID_INPUT",
            issue_paths: ["update.0.amount"],
          }),
          ...turn("made_up", "{}", {
            is_error: true,
            error_code: "UNKNOWN_TOOL",
          }),
        ],
      },
      {
        taskId: "D02",
        rep: 0,
        turns: turn("akaun_search_records", '{"q":"x"}', { output_bytes: 300 }),
      },
    ]);
    expect(analysis).toMatchObject({
      trials: 2,
      calls: 5,
      errors: 2,
      unknownToolCalls: 1,
    });
    const search = analysis.tools.find(
      (t) => t.tool === "akaun_search_records",
    )!;
    expect(search).toMatchObject({
      calls: 3,
      trials: 2,
      errors: 0,
      repeated: 1,
      maxOutputBytes: 300,
      meanOutputBytes: 167,
      meanLatencyMs: 4,
    });
    const change = analysis.tools.find(
      (t) => t.tool === "akaun_change_records",
    )!;
    expect(change).toMatchObject({
      errors: 1,
      errorCodes: { INVALID_INPUT: 1 },
      issuePaths: { "update.0.amount": 1 },
    });
  });

  it("reads only the development split's traces unless asked", () => {
    const out = mkdtempSync(join(tmpdir(), "akaun-eval-analyze-spec-"));
    try {
      writeFileSync(
        join(out, "_state.json"),
        JSON.stringify({ train_ids: ["D01"], test_ids: ["H1"] }),
      );
      mkdirSync(join(out, "v1", "traces"), { recursive: true });
      for (const id of ["D01", "H1"])
        writeFileSync(
          join(out, "v1", "traces", `${id}_rep0.json`),
          JSON.stringify(turn("akaun_get_record", "{}")),
        );
      expect(readTraces(join(out, "v1"), "dev").map((t) => t.taskId)).toEqual([
        "D01",
      ]);
      expect(
        readTraces(join(out, "v1"), "heldout").map((t) => t.taskId),
      ).toEqual(["H1"]);
      expect(readTraces(join(out, "v1"), "all")).toHaveLength(2);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("results", () => {
  it("scrubs access tokens and API keys at any depth", () => {
    const token = `akp_${"A1b2".repeat(9)}abcdef`;
    expect(
      scrubSecrets({
        a: `Bearer ${token}`,
        b: ["key sk-ant-api03-abcdefGHIJ_kl"],
        c: 5,
        d: null,
      }),
    ).toEqual({
      a: "Bearer akp_[REDACTED]",
      b: ["key sk-ant-[REDACTED]"],
      c: 5,
      d: null,
    });
  });

  it("gives each configuration its own vN, resumes the matching one, and keeps _state.json's other fields", () => {
    const out = mkdtempSync(join(tmpdir(), "akaun-eval-results-spec-"));
    try {
      const sonnet: RunConfig = {
        mode: "model",
        model: "claude-sonnet-5-5",
        effort: "high",
        surface: "v1",
        naming: "akaun_verb_noun",
      };
      const opus: RunConfig = { ...sonnet, model: "claude-opus-5-5" };
      const taken = new Set<string>();
      const first = chooseVariantDir({
        outDir: out,
        config: sonnet,
        resume: false,
        taken,
      });
      taken.add(first);
      const second = chooseVariantDir({
        outDir: out,
        config: opus,
        resume: false,
        taken,
      });
      expect([first, second]).toEqual(["v1", "v2"]);
      writeSummary(join(out, first), sonnet);
      writeSummary(join(out, second), opus);
      expect(
        chooseVariantDir({
          outDir: out,
          config: sonnet,
          resume: true,
          taken: new Set(),
        }),
      ).toBe("v1");
      expect(
        chooseVariantDir({
          outDir: out,
          config: { ...sonnet, effort: "low" },
          resume: true,
          taken: new Set(),
        }),
      ).toBe("v3");
      expect(
        chooseVariantDir({
          outDir: out,
          config: sonnet,
          resume: false,
          name: "baseline",
          taken: new Set(),
        }),
      ).toBe("baseline");
      expect(() =>
        chooseVariantDir({
          outDir: out,
          config: sonnet,
          resume: false,
          name: "v1",
          taken: new Set(),
        }),
      ).toThrow(/already exists/);

      writeFileSync(
        join(out, "_state.json"),
        JSON.stringify({ goal: { target: "pass" }, current_round: 5 }),
      );
      writeState(out, {
        trainIds: ["D01"],
        testIds: ["H1"],
        reps: 3,
        currentRound: "v2",
      });
      const state = JSON.parse(readFileSync(join(out, "_state.json"), "utf8"));
      expect(state).toMatchObject({
        goal: { target: "pass" },
        current_round: 5,
        train_ids: ["D01"],
        test_ids: ["H1"],
        reps: 3,
      });
      expect(state.metrics[0]).toEqual({
        id: "pass",
        kind: "binary",
        label: "Pass",
      });

      const row = (id: string, pass: 0 | 1, cost: number): ResultRow => ({
        prompt_id: id,
        rep: 0,
        prompt: "",
        tags: ["uc1"],
        grade: { pass, no_critical: 1, approval_ok: 1, collateral: 0 },
        model: "claude-sonnet-5-5",
        latency_s: 1,
        tool_calls: 4,
        tool_errors: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        cost_usd: cost,
        meta: {},
      });
      appendResult(join(out, first), row("D01", 1, 0.5));
      appendResult(join(out, first), { ...row("D02", 0, 0.25), rep: 1 });
      expect(finishedTrials(join(out, first))).toEqual(
        new Set(["D01#0", "D02#1"]),
      );
      const summary = summarise([
        row("D01", 1, 0.5),
        row("D01", 0, 0.5),
        row("D02", 0, 0.25),
      ]);
      expect(summary.pass).toBeCloseTo(1 / 3, 9);
      expect(summary.costUsd).toBeCloseTo(1.25, 9);
      expect(summary.tasks.map((t) => [t.id, t.trials, t.pass])).toEqual([
        ["D01", 2, 0.5],
        ["D02", 1, 0],
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
