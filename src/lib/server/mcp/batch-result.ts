import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  BatchFailure,
  BatchItemResult,
  BatchResult,
} from "../application/batch.js";
import type { AppFailure } from "../application/result.js";
import {
  fromAppFailure,
  toolError,
  toolResult,
  type ToolCandidate,
  type ToolErrorBody,
  type ToolErrorCode,
} from "./envelope.js";
import { topCandidates } from "./resolve.js";

/**
 * A batch's outcome (`application/batch.ts`) as the v2 tool result.
 *
 * | Outcome | Payload |
 * |---|---|
 * | saved | `{ saved: true, request_id, items: [{ n, action, label?, ...formatValue(value) }] }` |
 * | replay of a saved call | the same, with the first call's `request_id` and `replayed: true` |
 * | dry run, nothing failed | `{ saved: false, dry_run: true, items: [...] }`, the same item shape |
 * | any item failed | `isError`: `{ error: { code, message: "Nothing was saved: N of M items failed.", fix, items } }` |
 * | the call itself failed | `isError`: one error (`BUSY`, `IDEMPOTENCY_MISMATCH`, `INTERNAL_ERROR`, `INVALID_INPUT`, ...) |
 *
 * `n` is the item's 1-based position in the batch. In a failed call each item
 * says how it went: `ok: true` (it would have been saved, but was rolled back
 * with the rest), `error: {code, message, fix?, path?, candidates?, blocked?,
 * current_version?, issues?, derived_kind?, ...}`, or `skipped: true` (never
 * attempted, because another item failed to prepare).
 *
 * The call's own `code` is the items' code when they all agree, and
 * `REFUSED` when they differ.
 */

/** A field a change could not make, why, and what to undo or send first. */
export type BlockedField = { field: string; why: string; fix: string };

/**
 * What an item's failure may carry beyond `AppFailure`, all optional, so its
 * error in the tool result can say how to recover. A `run` returns it as its
 * failure (it is still an `AppFailure`), the batch hands the same object back,
 * and `batchFailureBody` keeps every field here in the item's error.
 *
 * `current_version`, `issues` and `derived_kind` need nothing here: they come
 * from the failure's own `currentVersion`, `issues` and `derivedKind`, through
 * `fromAppFailure`.
 */
export type ItemFailureDetails = {
  /**
   * The v2 code to report instead of the one `code` maps to, e.g. `AMBIGUOUS`
   * or `NOT_FOUND` from a resolver (`resolveError`'s code).
   */
  toolCode?: ToolErrorCode;
  /** Where in the input, e.g. `records[2].category`. */
  path?: string;
  /** What to send instead. Replaces the code's default fix. */
  fix?: string;
  /** Near matches for a reference that did not resolve; at most five are kept. */
  candidates?: readonly ToolCandidate[];
  /** The fields a change could not make (a routing block), each with why and what to undo first. */
  blocked?: readonly BlockedField[];
  /**
   * Anything else the agent needs to act on, added to the error as it is,
   * e.g. what a void with a release would undo. Never replaces a field the
   * error already has.
   */
  details?: Readonly<Record<string, unknown>>;
};

/** An item's failure with the details its error keeps. */
export type ItemFailure = AppFailure & ItemFailureDetails;

/** One failed item's error: a v2 error body, plus what the item carried. */
export type ItemErrorBody = ToolErrorBody & {
  blocked?: readonly BlockedField[];
  [detail: string]: unknown;
};

export type BatchItemMeta = { index: number; action: string; label?: string };

/**
 * One saved item's fields, e.g. `{ id, number, v }`. On a replay `value` is
 * the stored JSON copy of what the first call returned.
 */
export type FormatBatchValue<T> = (
  value: T,
  item: BatchItemMeta,
) => Record<string, unknown>;

const RETRY_FIX = "Nothing was saved. Retry the same call in a few seconds.";
const FIX_ITEMS =
  "Fix or remove the failing items and send the whole call again. The other items were rolled back too, so resend them as well.";

/** A failure's own v2 error body: the batch's codes, else `fromAppFailure`. */
function mappedBody(failure: BatchFailure): ToolErrorBody {
  switch (failure.batchCode) {
    case "BUSY":
      return { code: "BUSY", message: failure.reason, fix: RETRY_FIX };
    case "IDEMPOTENCY_MISMATCH":
      return {
        code: "IDEMPOTENCY_MISMATCH",
        message: failure.reason,
        fix: "To get the first call's result, resend exactly its input with this key. For a different change, use a new idempotency_key.",
      };
    case "INTERNAL_ERROR":
      return {
        code: "INTERNAL_ERROR",
        message: failure.reason,
        fix: "Read the current state, then retry once. If it fails again, report it to the person who runs Akaun.",
      };
    default:
      return fromAppFailure(failure);
  }
}

/**
 * A batch failure as a v2 error body, keeping the batch's own codes and every
 * detail an item's failure carried (`ItemFailureDetails`): its `toolCode`
 * replaces the mapped code, and its `path`, `fix`, `candidates`, `blocked`
 * and `details` are kept.
 */
export function batchFailureBody(
  failure: BatchFailure & ItemFailureDetails,
): ItemErrorBody {
  const body: ItemErrorBody = {
    ...mappedBody(failure),
    ...(failure.toolCode ? { code: failure.toolCode } : {}),
    ...(failure.path ? { path: failure.path } : {}),
    ...(failure.fix ? { fix: failure.fix } : {}),
    ...(failure.candidates?.length
      ? { candidates: topCandidates(failure.candidates) }
      : {}),
    ...(failure.blocked?.length ? { blocked: failure.blocked } : {}),
  };
  for (const [key, value] of Object.entries(failure.details ?? {}))
    if (!(key in body)) body[key] = value;
  return body;
}

function meta(item: BatchItemResult<unknown>) {
  return { n: item.index + 1, action: item.action, label: item.label };
}

/** The item without its 1-based `n`, as `formatValue` is given it. */
function itemMeta(item: BatchItemResult<unknown>): BatchItemMeta {
  return item.label === undefined
    ? { index: item.index, action: item.action }
    : { index: item.index, action: item.action, label: item.label };
}

/**
 * The result a batch write tool returns. `requestId` is the call's own
 * (`meta.requestId`); a replay reports the first call's instead.
 */
export function batchToolResult<T>(
  result: BatchResult<T>,
  opts: { requestId?: string; formatValue: FormatBatchValue<T> },
): CallToolResult {
  if (!result.ok) return toolError(batchFailureBody(result));
  const outcome = result.value;
  const failed = outcome.items.filter(
    (item): item is Extract<BatchItemResult<T>, { ok: false }> =>
      !item.ok && !item.skipped,
  );
  const skipped = outcome.items.some((item) => !item.ok && item.skipped);

  if (failed.length === 0 && !skipped) {
    const items = outcome.items.map((item) =>
      item.ok
        ? { ...meta(item), ...opts.formatValue(item.value, itemMeta(item)) }
        : meta(item),
    );
    if (outcome.saved)
      return toolResult({
        saved: true,
        ...(outcome.replayed ? { replayed: true } : {}),
        request_id: outcome.requestId ?? opts.requestId,
        items,
      });
    if (outcome.dryRun)
      return toolResult({ saved: false, dry_run: true, items });
  }

  const bodies = failed.map((item) => batchFailureBody(item.failure));
  const codes = new Set<ToolErrorCode>(bodies.map((body) => body.code));
  const code: ToolErrorCode =
    codes.size === 1
      ? bodies[0].code
      : codes.size === 0
        ? "INTERNAL_ERROR"
        : "REFUSED";
  const total = outcome.items.length;
  const message = outcome.dryRun
    ? `Dry run: ${failed.length} of ${total} items would fail. Nothing was saved.`
    : `Nothing was saved: ${failed.length} of ${total} items failed.`;
  let next = 0;
  const items = outcome.items.map((item) => {
    if (item.ok) return { ...meta(item), ok: true };
    if (item.skipped) return { ...meta(item), skipped: true };
    const { code: itemCode, ...rest } = bodies[next++];
    return { ...meta(item), error: { code: itemCode, ...rest } };
  });
  const body: ToolErrorBody & { dry_run?: true; items: typeof items } = {
    code,
    message,
    // A closed month or a busy book is not fixed by editing the items.
    fix:
      code === "BUSY"
        ? RETRY_FIX
        : code === "CLOSED_PERIOD"
          ? (bodies[0].fix ?? FIX_ITEMS)
          : FIX_ITEMS,
    ...(outcome.dryRun ? { dry_run: true as const } : {}),
    items,
  };
  return toolError(body);
}
