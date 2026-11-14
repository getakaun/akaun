import type { CallToolResult } from "@modelcontextprotocol/server";
import { closedPeriodReason } from "../closing/policy.js";
import type { AppFailure } from "../application/result.js";

/**
 * The one response shape of every v2 MCP tool.
 *
 * - **Success** is `{ content: [{ type: "text", text: <JSON> }] }`. There is
 *   no `structuredContent` (v1 sent every payload twice), and the JSON has
 *   every `null`, `undefined`, `""`, `[]` and `{}` removed, recursively, so a
 *   reader never pays for an absent field. `0` and `false` are kept.
 * - **Failure** is the same, with `isError: true` and the text
 *   `{"error":{"code","message","fix"?,"candidates"?,"issues"?,...}}`. One
 *   shape for every refusal, so an agent learns it once.
 * - **Size.** A response should stay under `SOFT_BUDGET_BYTES` (48 KiB):
 *   `fitRows` trims a list to fit and says so. Over `HARD_CAP_BYTES`
 *   (512 KiB) `toolResult` refuses with `OUTPUT_TOO_LARGE` instead.
 *
 * Handlers return a plain payload object (the registry wraps it with
 * `toolResult`) or a `toolError(...)`. They never throw on purpose; the
 * registry turns anything thrown into an error result via `errorFromThrown`,
 * which never repeats an exception's own text (it could quote SQL or a path).
 */

export const SOFT_BUDGET_BYTES = 48 * 1024;
export const HARD_CAP_BYTES = 512 * 1024;

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "CONFLICT"
  | "REFUSED"
  | "FORBIDDEN"
  | "CLOSED_PERIOD"
  | "BUSY"
  | "IDEMPOTENCY_MISMATCH"
  | "OUTPUT_TOO_LARGE"
  | "INTERNAL_ERROR";

/** One input problem, located: `path` is `records[2].amount`, or `""` for the whole input. */
export type ToolIssue = { path: string; message: string };

/** A near match offered when a reference did not resolve (see `resolve.ts`). */
export type ToolCandidate = {
  id: number | string;
  name: string;
  [detail: string]: unknown;
};

/** A follow-up call that would make progress, named in the active scheme. */
export type NextCall = { tool: string; args?: Record<string, unknown> };

/** The body of `{"error": ...}`. Fields beyond `code` and `message` are optional. */
export type ToolErrorBody = {
  code: ToolErrorCode;
  /** What went wrong, as one or two plain sentences. */
  message: string;
  /** What to send instead. Present on every error an agent can act on. */
  fix?: string;
  /** Where in the input (a batch item, a field), for errors about one part. */
  path?: string;
  candidates?: readonly ToolCandidate[];
  issues?: readonly ToolIssue[];
  /** On CONFLICT: the version to re-read against. */
  current_version?: string;
  /** On a create whose accounts derive a different kind than was asked for. */
  derived_kind?: string;
  next?: NextCall;
};

/**
 * A value or the error to report instead. What every parser and resolver in
 * the response layer returns, so a handler writes
 * `if (!r.ok) return toolError(r.error);`.
 */
export type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolErrorBody };

export const checked = <T>(value: T): Checked<T> => ({ ok: true, value });
export const rejected = <T = never>(error: ToolErrorBody): Checked<T> => ({
  ok: false,
  error,
});

/**
 * Thrown by `unwrap`, and caught by the registry, which reports `body` as it
 * is. For a helper several calls deep where threading `Checked` through every
 * level would be noise. Prefer returning `toolError` from a handler.
 */
export class ToolFailure extends Error {
  constructor(public readonly body: ToolErrorBody) {
    super(body.message);
    this.name = "ToolFailure";
  }
}

/** The value, or a thrown `ToolFailure` carrying the error. */
export function unwrap<T>(result: Checked<T>): T {
  if (!result.ok) throw new ToolFailure(result.error);
  return result.value;
}

/**
 * Every result built here, mapped to the compacted payload it carries (null
 * for an error). The registry uses it to tell a ready result from a payload
 * object, and to add `request_id` to a write's payload without re-parsing.
 */
const BUILT = new WeakMap<CallToolResult, Record<string, unknown> | null>();

/** True when `value` is a result made by `toolResult` or `toolError`. */
export function isToolEnvelope(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    BUILT.has(value as CallToolResult)
  );
}

/** Payloads `toolResult` refused for size, keyed by the OUTPUT_TOO_LARGE result. */
const OVERSIZED = new WeakMap<CallToolResult, Record<string, unknown>>();

/**
 * The payload an `OUTPUT_TOO_LARGE` result from `toolResult` refused to send,
 * so the registry can still see that a write reported `saved: true`.
 */
export function oversizedPayload(
  result: CallToolResult,
): Record<string, unknown> | undefined {
  return OVERSIZED.get(result);
}

/** The compacted payload of a successful `toolResult`, or undefined. */
export function envelopePayload(
  result: CallToolResult,
): Record<string, unknown> | undefined {
  return BUILT.get(result) ?? undefined;
}

type Compacted = unknown;

/**
 * `value` with every `null`, `undefined`, `""`, `[]` and `{}` removed, at
 * every depth; a container emptied by that is removed too. Returns
 * `undefined` when nothing is left. `toJSON` (a Date) is honoured first, the
 * way `JSON.stringify` would.
 */
export function compact(value: unknown): Compacted {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    return undefined;
  if (typeof value !== "object") return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return compact(withJson.toJSON());
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = compact(child);
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/** UTF-8 size of the JSON a payload compacts to. */
export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(compact(payload) ?? {}), "utf8");
}

function textResult(text: string, isError: boolean): CallToolResult {
  return isError
    ? { isError: true, content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }] };
}

/**
 * A successful result: `payload`, compacted, as one JSON text block.
 *
 * Over `HARD_CAP_BYTES` it returns `OUTPUT_TOO_LARGE` instead, with a fix.
 * (A write that has already saved must not report that — the registry swaps
 * in a short "saved" note for a payload with `saved: true`.)
 */
export function toolResult(payload: Record<string, unknown>): CallToolResult {
  const body = (compact(payload) ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, "utf8") > HARD_CAP_BYTES) {
    const refused = toolError({
      code: "OUTPUT_TOO_LARGE",
      message: `The result is larger than ${HARD_CAP_BYTES / 1024} KiB and was not sent.`,
      fix: "Narrow the request: a shorter period, more filters, a lower limit, or concise detail instead of full.",
    });
    OVERSIZED.set(refused, body);
    return refused;
  }
  const result = textResult(text, false);
  BUILT.set(result, body);
  return result;
}

/** An error result: `{"error": body}`, compacted, with `isError: true`. */
export function toolError(body: ToolErrorBody): CallToolResult {
  const result = textResult(
    JSON.stringify({ error: compact(body) ?? { code: body.code } }),
    true,
  );
  BUILT.set(result, null);
  return result;
}

/**
 * A list trimmed to fit `budget`. `build(kept, trimmed)` makes the whole
 * payload from the first `kept` rows; this finds the most rows whose payload
 * stays within budget (at least one, when there are any — the hard cap still
 * applies to that one) and returns that payload. When it had to trim, it
 * appends `steering` to the payload's `note` so the agent knows the list is
 * cut and how to get the rest.
 *
 * `paging.ts`'s `pageResult` calls this with a steering note that names the
 * filters and the cursor; call it directly for a list that is not paged.
 */
export function fitRows<R, P extends Record<string, unknown>>(
  rows: readonly R[],
  build: (kept: readonly R[], trimmed: boolean) => P,
  options: { budget?: number; steering?: string } = {},
): { payload: P & { note?: string }; kept: number; trimmed: boolean } {
  const budget = options.budget ?? SOFT_BUDGET_BYTES;
  const steering =
    options.steering ??
    "The list was cut to fit the response size; narrow the request to see the rest.";
  const make = (n: number): P & { note?: string } => {
    const trimmed = n < rows.length;
    const payload = build(rows.slice(0, n), trimmed);
    if (!trimmed || !steering) return payload;
    const note =
      typeof payload.note === "string" && payload.note
        ? `${payload.note} `
        : "";
    return { ...payload, note: `${note}${steering}` };
  };
  const whole = make(rows.length);
  if (payloadBytes(whole) <= budget)
    return { payload: whole, kept: rows.length, trimmed: false };
  // The largest n in [1, rows.length - 1] that fits; 1 when none does.
  let lo = 1;
  let hi = rows.length - 1;
  let best = Math.min(1, rows.length);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (payloadBytes(make(mid)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return { payload: make(best), kept: best, trimmed: best < rows.length };
}

/** A sentence that tells the agent what to do next for each code, when the caller gave none. */
const DEFAULT_FIX: Partial<Record<ToolErrorCode, string>> = {
  CONFLICT:
    "Read the item again, check the change still makes sense, then retry with expected_version set to current_version.",
  CLOSED_PERIOD:
    "Nothing was saved. A person must reopen the month in Akaun before this change can be made.",
  BUSY: "Nothing was saved. Retry the same call in a few seconds.",
  FORBIDDEN:
    "This connection may not do that. Ask the person who runs Akaun to grant the access, then reconnect.",
};

const CLOSED_PERIOD_TEXT = /^Accounting is closed through \d{4}-\d{2}-\d{2}\./;

/** Zod-style issues as `{ path, message }`, with `records[2].amount` paths. */
export function issuePaths(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ToolIssue[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/** `["records", 2, "amount"]` → `records[2].amount`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * Today's `AppResult` failure (from `application/result.ts`) as a v2 error.
 * Keeps the operation's own sentence, its `issues` (re-pathed), its
 * `currentVersion` (as `current_version`) and `derivedKind`.
 *
 * | AppErrorCode | v2 code |
 * |---|---|
 * | FORBIDDEN, NOT_FOUND, INVALID_INPUT, CONFLICT | same |
 * | REFUSED | REFUSED, or CLOSED_PERIOD when the reason is the closed-books sentence |
 * | PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE | INVALID_INPUT |
 * | RATE_UNAVAILABLE | REFUSED, with a fix to pass the rate |
 */
export function fromAppFailure(failure: AppFailure): ToolErrorBody {
  const base = {
    message: failure.reason,
    issues: failure.issues ? issuePaths(failure.issues) : undefined,
    current_version: failure.currentVersion,
    derived_kind: failure.derivedKind,
  };
  switch (failure.code) {
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "INVALID_INPUT":
      return { code: failure.code, ...base, fix: DEFAULT_FIX[failure.code] };
    case "CONFLICT":
      return { code: "CONFLICT", ...base, fix: DEFAULT_FIX.CONFLICT };
    case "REFUSED":
      return CLOSED_PERIOD_TEXT.test(failure.reason)
        ? { code: "CLOSED_PERIOD", ...base, fix: DEFAULT_FIX.CLOSED_PERIOD }
        : { code: "REFUSED", ...base };
    case "PAYLOAD_TOO_LARGE":
      return { code: "INVALID_INPUT", ...base, fix: "Send a smaller file." };
    case "UNSUPPORTED_MEDIA_TYPE":
      return {
        code: "INVALID_INPUT",
        ...base,
        fix: "Send a PDF, JPEG or PNG file.",
      };
    case "RATE_UNAVAILABLE":
      return {
        code: "REFUSED",
        ...base,
        fix: "Pass exchange_rate yourself, or retry later when the rate service answers.",
      };
  }
}

function isBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /database is locked/i.test(message))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Anything a handler threw, as an error body that is safe to show.
 *
 * - `ToolFailure` → its own body.
 * - The closed-books error (`closing/policy.ts`) → `CLOSED_PERIOD`.
 * - SQLite busy / locked → `BUSY` ("nothing was saved, retry").
 * - Anything else → `INTERNAL_ERROR`, with none of the exception's text. For
 *   a write it says nothing was saved: every v2 write runs in one
 *   transaction, and a throw rolls it back.
 */
export function errorFromThrown(
  error: unknown,
  options: { write: boolean },
): ToolErrorBody {
  if (error instanceof ToolFailure) return error.body;
  const closed = closedPeriodReason(error);
  if (closed)
    return {
      code: "CLOSED_PERIOD",
      message: closed,
      fix: DEFAULT_FIX.CLOSED_PERIOD,
    };
  if (isBusy(error))
    return {
      code: "BUSY",
      message: "The books are busy with another change.",
      fix: DEFAULT_FIX.BUSY,
    };
  return options.write
    ? {
        code: "INTERNAL_ERROR",
        message: "The change failed unexpectedly. Nothing was saved.",
        fix: "Read the current state, then retry once. If it fails again, report it to the person who runs Akaun.",
      }
    : {
        code: "INTERNAL_ERROR",
        message: "The read failed unexpectedly.",
        fix: "Retry once, or narrow the request. If it fails again, report it to the person who runs Akaun.",
      };
}
