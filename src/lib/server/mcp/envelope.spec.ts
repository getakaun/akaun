import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClosedPeriodError } from "../closing/policy.js";
import {
  compact,
  errorFromThrown,
  fitRows,
  fromAppFailure,
  HARD_CAP_BYTES,
  isToolEnvelope,
  payloadBytes,
  SOFT_BUDGET_BYTES,
  toolError,
  toolResult,
  ToolFailure,
  unwrap,
} from "./envelope.js";
import { resolveError } from "./resolve.js";
import { invalid, conflict, fail } from "../application/result.js";

const textOf = (result: { content: unknown[] }) =>
  JSON.parse((result.content[0] as { text: string }).text);

describe("toolResult", () => {
  it("drops null, undefined, empty strings, arrays and objects at every depth", () => {
    const result = toolResult({
      keep: 0,
      flag: false,
      name: "x",
      gone: null,
      missing: undefined,
      blank: "",
      none: [],
      empty: {},
      nested: { inner: { deeper: null }, list: [null, "", {}, [], 1] },
      rows: [{ a: null }, { b: 2 }],
    });
    expect(textOf(result)).toEqual({
      keep: 0,
      flag: false,
      name: "x",
      nested: { list: [1] },
      rows: [{ b: 2 }],
    });
  });

  it("sends one text block and never structuredContent", () => {
    const result = toolResult({ a: 1 });
    expect(result).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
    expect("structuredContent" in result).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(isToolEnvelope(result)).toBe(true);
    expect(isToolEnvelope({ content: [] })).toBe(false);
  });

  it("sends {} when everything compacts away", () => {
    expect(textOf(toolResult({ a: null }))).toEqual({});
    expect(compact({ a: [{}] })).toBeUndefined();
  });

  it("refuses a payload over the hard cap with OUTPUT_TOO_LARGE and a fix", () => {
    const result = toolResult({ blob: "x".repeat(HARD_CAP_BYTES) });
    expect(result.isError).toBe(true);
    const { error } = textOf(result);
    expect(error.code).toBe("OUTPUT_TOO_LARGE");
    expect(error.fix).toMatch(/Narrow/);
  });
});

describe("toolError", () => {
  it("is one shape: {error:{code,message,fix,...}} with isError", () => {
    const result = toolError({
      code: "NOT_FOUND",
      message: "No such record.",
      fix: "Search for it first.",
      candidates: [],
      issues: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "No such record.",
        fix: "Search for it first.",
      },
    });
  });
});

describe("fitRows", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    text: "y".repeat(200),
  }));

  it("keeps everything that fits", () => {
    const { payload, kept, trimmed } = fitRows(rows.slice(0, 10), (r) => ({
      rows: r,
    }));
    expect(kept).toBe(10);
    expect(trimmed).toBe(false);
    expect(payload.note).toBeUndefined();
  });

  it("trims to the soft budget and appends the steering note", () => {
    const { payload, kept, trimmed } = fitRows(
      rows,
      (r) => ({ rows: r, note: "Totals are for all rows." }),
      {
        steering: "Narrow the period.",
      },
    );
    expect(trimmed).toBe(true);
    expect(kept).toBeGreaterThan(100);
    expect(kept).toBeLessThan(400);
    expect(payloadBytes(payload)).toBeLessThanOrEqual(SOFT_BUDGET_BYTES);
    expect(
      payloadBytes({ ...payload, rows: rows.slice(0, kept + 1) }),
    ).toBeGreaterThan(SOFT_BUDGET_BYTES);
    expect(payload.note).toBe("Totals are for all rows. Narrow the period.");
  });

  it("keeps one row even when one row is over budget", () => {
    const { kept } = fitRows(rows, (r) => ({ rows: r }), { budget: 10 });
    expect(kept).toBe(1);
  });
});

describe("fromAppFailure", () => {
  it("keeps the operation's sentence, issues and current version", () => {
    expect(fromAppFailure(conflict("v9"))).toMatchObject({
      code: "CONFLICT",
      current_version: "v9",
      fix: expect.stringContaining("expected_version"),
    });
    const parsed = z
      .object({ lines: z.array(z.object({ amount: z.number() })) })
      .safeParse({
        lines: [{ amount: "x" }],
      });
    expect(fromAppFailure(invalid(parsed.error!))).toMatchObject({
      code: "INVALID_INPUT",
      issues: [{ path: "lines[0].amount" }],
    });
    expect(
      fromAppFailure(fail("REFUSED", "Settled records cannot be deleted.")),
    ).toEqual({
      code: "REFUSED",
      message: "Settled records cannot be deleted.",
    });
  });

  it("maps every AppErrorCode", () => {
    const map = (code: Parameters<typeof fail>[0]) =>
      fromAppFailure(fail(code, "r")).code;
    expect(map("FORBIDDEN")).toBe("FORBIDDEN");
    expect(map("NOT_FOUND")).toBe("NOT_FOUND");
    expect(map("INVALID_INPUT")).toBe("INVALID_INPUT");
    expect(map("REFUSED")).toBe("REFUSED");
    expect(map("CONFLICT")).toBe("CONFLICT");
    expect(map("PAYLOAD_TOO_LARGE")).toBe("INVALID_INPUT");
    expect(map("UNSUPPORTED_MEDIA_TYPE")).toBe("INVALID_INPUT");
    expect(map("RATE_UNAVAILABLE")).toBe("REFUSED");
  });

  it("recognises the closed-books refusal", () => {
    const reason = new ClosedPeriodError("2026-03-31").message;
    expect(fromAppFailure(fail("REFUSED", reason)).code).toBe("CLOSED_PERIOD");
  });
});

describe("errorFromThrown", () => {
  it("reports a ToolFailure as it is", () => {
    const body = { code: "AMBIGUOUS" as const, message: "Two match." };
    expect(errorFromThrown(new ToolFailure(body), { write: true })).toBe(body);
    expect(() => unwrap({ ok: false, error: body })).toThrow(ToolFailure);
  });

  it("maps closed books and a busy database, through a cause", () => {
    expect(
      errorFromThrown(
        new Error("wrapped", { cause: new ClosedPeriodError("2026-01-31") }),
        {
          write: true,
        },
      ).code,
    ).toBe("CLOSED_PERIOD");
    const busy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    expect(
      errorFromThrown(new Error("query failed", { cause: busy }), {
        write: true,
      }),
    ).toMatchObject({
      code: "BUSY",
      fix: expect.stringMatching(/Nothing was saved.*Retry/),
    });
  });

  it("never repeats an unexpected error's text", () => {
    const body = errorFromThrown(
      new Error("SQLITE_ERROR near SELECT * FROM users /private/x"),
      {
        write: true,
      },
    );
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("Nothing was saved");
    expect(JSON.stringify(body)).not.toMatch(/SELECT|private/);
    expect(errorFromThrown("x", { write: false }).message).not.toContain(
      "saved",
    );
  });
});

describe("resolveError", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    name: `Grab ${i}`,
    id: i + 1,
    code: 5100 + i,
  }));

  it("lists at most five candidates, id and name first", () => {
    const body = resolveError(
      { kind: "ambiguous", candidates },
      { what: "contact", ref: "Grab", path: "records[1].contact" },
    );
    expect(body.code).toBe("AMBIGUOUS");
    expect(body.path).toBe("records[1].contact");
    expect(body.message).toBe(
      'records[1].contact: "Grab" matches more than one contact.',
    );
    expect(body.candidates).toHaveLength(5);
    expect(Object.keys(body.candidates![0])).toEqual(["id", "name", "code"]);
  });

  it("gives NOT_FOUND a fix that names the lookup tool", () => {
    const body = resolveError(
      { kind: "not_found" },
      { what: "account", ref: "Advertsing", lookup: "akaun_list_accounts" },
    );
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: 'No account matches "Advertsing".',
      fix: "Check the account, or look it up with akaun_list_accounts, then send its id.",
    });
    const near = resolveError(
      { kind: "not_found", candidates },
      { what: "account", ref: 42 },
    );
    expect(near.fix).toMatch(/send its id/);
    expect(near.message).toBe("No account matches 42.");
  });

  it("keeps the resolver's own explanation as the message", () => {
    const body = resolveError(
      {
        kind: "not_found",
        message:
          '"5100 Travel": the code 5100 and the name Travel belong to different accounts.',
        candidates,
      },
      { what: "account", ref: "5100 Travel", path: "records[0].category" },
    );
    expect(body.message).toBe(
      'records[0].category: "5100 Travel": the code 5100 and the name Travel belong to different accounts.',
    );
    expect(body.candidates).toHaveLength(5);
    const ambiguous = resolveError(
      { kind: "ambiguous", message: "  ", candidates },
      { what: "contact", ref: "Grab" },
    );
    expect(ambiguous.message).toBe('"Grab" matches more than one contact.');
  });
});
