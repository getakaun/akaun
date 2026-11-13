import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { mcpIdempotency } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { closedPeriodReason } from "../closing/policy.js";
import { ExpenseTaxError } from "../queries/expense-tax.js";
import { currentAuditScope } from "../audit-context.js";
import { createLogger } from "../logger.js";
import { runUnitOfWork } from "../unit-of-work.js";
import type { AppContext } from "./context.js";
import {
  denied,
  fail,
  ok,
  Rollback,
  type AppFailure,
  type AppResult,
} from "./result.js";

/**
 * The batch write executor: how every MCP write runs.
 *
 * One call is one batch of up to `MAX_BATCH_ITEMS` items, and it is atomic:
 * every item is saved, or none is. Each item still runs on its own, so a call
 * with three bad items reports all three at once rather than the first.
 *
 *   runUnitOfWork(mode, () =>          ← events and file effects wait for commit
 *     db.transaction(() => {           ← BEGIN IMMEDIATE: the one write lock
 *       for (item of items)
 *         db.transaction(() => run())  ← SAVEPOINT per item
 *       throw rollback | insert idempotency row
 *     }, { behavior: "immediate" }))
 *
 * - An item that refuses (`ok:false`) or throws has its savepoint rolled back,
 *   so whatever it wrote before refusing is gone even when the operation wrote
 *   it outside its own transaction; then the next item runs.
 * - After the loop, a failure or a dry run rolls the whole transaction back.
 *   A dry run therefore runs every rule and every write exactly as a save
 *   would, and reports what a save would have stored.
 * - Otherwise the transaction commits, and only then are the items' events
 *   delivered (the unit of work holds them).
 *
 * `run` is synchronous on purpose: a bun:sqlite transaction is, and the
 * connection is shared, so an `await` inside it would let another request's
 * statements into this transaction. Async work (an exchange rate) belongs in
 * `prepare`, which runs before the transaction opens and must not write.
 *
 * Idempotency: with a key, a saved outcome is stored in `mcp_idempotency`
 * inside the same transaction, for 24 hours. The same key and input returns
 * it again with `replayed: true` and writes nothing; the same key with other
 * input is refused. Dry runs are never stored or looked up. `storedReplay` is
 * the lookup `runBatch` makes first, exported so a write tool can make it
 * before resolving any reference.
 */

const log = createLogger("batch");

export const MAX_BATCH_ITEMS = 50;
/** How often expired idempotency rows are swept, at most, per database. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const TTL = sql`datetime('now', '-24 hours')`;

export type BatchItem<T> = {
  /** The action this item performs, e.g. `"update"` or `"void"`. */
  action: string;
  /** Shown in results so an agent can tell items apart, e.g. `"record 812"`. */
  label?: string;
  /**
   * Async work done BEFORE the transaction opens (an exchange-rate lookup,
   * an import's extraction). Must not write. Its value is handed to `run`.
   */
  prepare?: (ctx: AppContext) => Promise<AppResult<unknown>>;
  /**
   * The write, calling `application/` operations. SYNCHRONOUS: a returned
   * promise is refused. Its value must survive `JSON.stringify` when the
   * call carries an idempotency key, because a replay returns the stored copy.
   */
  run: (ctx: AppContext, prepared: unknown) => AppResult<T>;
};

/**
 * What only the batch can say, beyond `AppErrorCode`. The MCP layer reports
 * it as the v2 code of the same name (`mcp/batch-result.ts`); `code` keeps a
 * plain `AppErrorCode` for any other caller.
 */
export type BatchFailureCode =
  | "BUSY"
  | "IDEMPOTENCY_MISMATCH"
  | "INTERNAL_ERROR";

export type BatchFailure = AppFailure & { batchCode?: BatchFailureCode };

export type BatchItemResult<T> =
  | { index: number; action: string; label?: string; ok: true; value: T }
  | {
      index: number;
      action: string;
      label?: string;
      ok: false;
      failure: BatchFailure;
      /**
       * Not attempted: another item's `prepare` failed, so no transaction was
       * opened. `failure` says so. Not counted as one of the failures.
       */
      skipped?: true;
    };

export type BatchOutcome<T> = {
  /** True only when every item was committed (or this is a replay of that). */
  saved: boolean;
  dryRun: boolean;
  /** The stored outcome of an earlier call with the same idempotency key. */
  replayed?: boolean;
  /**
   * The audit `request_id` of the call that saved this, when it ran inside
   * an audit scope. On a replay, the ORIGINAL call's, so the change history
   * it points at is the one that was written.
   */
  requestId?: string;
  items: BatchItemResult<T>[];
};

/** `AppResult<BatchOutcome<T>>`, with the batch's own failure codes. */
export type BatchResult<T> =
  | { ok: true; value: BatchOutcome<T> }
  | BatchFailure;

/**
 * Which stored outcome a call would replay: `runBatch`'s options without the
 * items. A write tool builds it once and passes the same object to
 * `storedReplay` and `runBatch`, so the two use one key, input hash and tool.
 */
export type ReplayLookup = {
  /** The tool's name, stored with an idempotency key and used in logs. */
  tool: string;
  /** A dry run neither looks a key up nor stores it. Default false. */
  dryRun?: boolean;
  /**
   * `inputHash` is `hashInput` of the parsed arguments without the key
   * itself. The binding (which credential) comes from `ctx.locals`.
   */
  idempotency?: { key: string; inputHash: string };
};

export type BatchOptions<T> = ReplayLookup & {
  dryRun: boolean;
  items: BatchItem<T>[];
  /** Default `MAX_BATCH_ITEMS`. */
  maxItems?: number;
};

// --- failures ---------------------------------------------------------------

const NOTHING_SAVED = "Nothing was saved.";

function busy(): BatchFailure {
  return {
    ...fail(
      "CONFLICT",
      `The books are busy with another change. ${NOTHING_SAVED}`,
    ),
    batchCode: "BUSY",
  };
}

function internal(reason: string): BatchFailure {
  return { ...fail("REFUSED", reason), batchCode: "INTERNAL_ERROR" };
}

function mismatch(): BatchFailure {
  return {
    ...fail(
      "CONFLICT",
      `This idempotency_key was already used in the last 24 hours for a different call. ${NOTHING_SAVED}`,
    ),
    batchCode: "IDEMPOTENCY_MISMATCH",
  };
}

function isBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code))
      return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /database is locked/i.test(message))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isIdempotencyCollision(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      /UNIQUE constraint failed: mcp_idempotency\./.test(message)
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAppResult(value: unknown): value is AppResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

/** Thrown inside an item's savepoint to roll back what the item wrote. */
class ItemRefused extends Error {
  constructor(public readonly failure: AppFailure) {
    super(failure.reason);
  }
}

/** Thrown inside an item's savepoint when `run` broke its contract. */
class ItemMisbehaved extends Error {}

/** Thrown out of the outer transaction to roll the whole batch back. */
class BatchRollback<T> extends Error {
  constructor(public readonly items: BatchItemResult<T>[]) {
    super("batch rolled back");
  }
}

/** The connection left its transaction mid-batch; nothing more may run. */
class BatchAborted extends Error {}

type Where = { tool: string; action: string; index: number };

/** What an item that threw is reported as. Never the exception's own text. */
function thrownItemFailure(error: unknown, where: Where): BatchFailure {
  if (error instanceof ItemRefused) return error.failure;
  if (error instanceof Rollback) return error.failure;
  const closed = closedPeriodReason(error);
  if (closed) return fail("REFUSED", closed);
  if (error instanceof ExpenseTaxError) return fail("REFUSED", error.message);
  if (isBusy(error)) return busy();
  if (error instanceof ItemMisbehaved)
    log.error({ ...where, problem: error.message }, "Batch item misbehaved");
  else log.error({ ...where, err: error }, "Batch item threw");
  return internal(
    `The "${where.action}" step failed unexpectedly. ${NOTHING_SAVED}`,
  );
}

// --- idempotency ------------------------------------------------------------

/**
 * Which credential an idempotency key belongs to. A key is only ever looked
 * up for the same user and the same token, app or browser session.
 */
export function bindingOf(locals: App.Locals): string {
  const credential = locals.credential;
  if (credential?.kind === "pat") return `pat:${credential.tokenId}`;
  if (credential?.kind === "oauth") return `oauth:${credential.clientId}`;
  if (locals.oauth) return `oauth:${locals.oauth.clientId}`;
  return `session:${locals.user?.id ?? 0}`;
}

/** `value` with every object's keys sorted, ready for `JSON.stringify`. */
function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function")
    return canonical(withJson.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

/**
 * A stable fingerprint of a call's input: JSON with sorted keys, hashed with
 * sha256 (hex). Key order never matters; an `undefined` field counts as
 * absent, the way JSON drops it.
 */
export function hashInput(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "undefined")
    .digest("hex");
}

type Slot = {
  userId: number;
  binding: string;
  key: string;
  tool: string;
  inputHash: string;
};

/**
 * The row a call's key claims: this user and credential, the key, the tool and
 * the input. None for a dry run, a call without a key, or nobody signed in.
 */
function slotOf(ctx: AppContext, call: ReplayLookup): Slot | undefined {
  const user = ctx.locals.user;
  if (!call.idempotency || call.dryRun || !user) return undefined;
  return {
    userId: user.id,
    binding: bindingOf(ctx.locals),
    key: call.idempotency.key,
    tool: call.tool,
    inputHash: call.idempotency.inputHash,
  };
}

type Stored<T> = { requestId?: string; items: BatchItemResult<T>[] };

const lastSweep = new WeakMap<object, number>();

/** Deletes expired rows, at most every 10 minutes per database. Best effort. */
function sweepExpired(db: LedgerDb): void {
  const now = Date.now();
  const last = lastSweep.get(db);
  if (last !== undefined && now - last < SWEEP_EVERY_MS) return;
  lastSweep.set(db, now);
  try {
    db.delete(mcpIdempotency)
      .where(sql`${mcpIdempotency.createdAt} < ${TTL}`)
      .run();
  } catch (err) {
    log.warn({ err }, "Could not sweep expired idempotency keys");
  }
}

const sameSlot = (slot: Slot) =>
  and(
    eq(mcpIdempotency.userId, slot.userId),
    eq(mcpIdempotency.binding, slot.binding),
    eq(mcpIdempotency.key, slot.key),
  );

/** The live (unexpired) row for this key, if any. */
function findStored(db: LedgerDb, slot: Slot) {
  return db
    .select()
    .from(mcpIdempotency)
    .where(and(sameSlot(slot), sql`${mcpIdempotency.createdAt} >= ${TTL}`))
    .get();
}

/** The stored outcome again, or the refusal when the input differs. */
function replayOf<T>(
  row: { tool: string; inputHash: string; result: string },
  slot: Slot,
): BatchResult<T> {
  if (row.tool !== slot.tool || row.inputHash !== slot.inputHash)
    return mismatch();
  let stored: Stored<T>;
  try {
    stored = JSON.parse(row.result) as Stored<T>;
  } catch (err) {
    log.error(
      { err, tool: slot.tool },
      "Stored idempotent outcome is unreadable",
    );
    return internal(`The stored result could not be read. ${NOTHING_SAVED}`);
  }
  return ok({
    saved: true,
    dryRun: false,
    replayed: true,
    ...(stored.requestId ? { requestId: stored.requestId } : {}),
    items: stored.items,
  });
}

/**
 * What an earlier call with this idempotency key stored, looked up before any
 * work is done. `runBatch` makes exactly this lookup first; a write tool makes
 * it too, before it resolves a single reference, so a retry whose target is
 * gone (a delete or merge by name) replays instead of answering NOT_FOUND.
 *
 * - The same key, tool and input hash: the stored outcome, with
 *   `replayed: true` and the first call's `requestId`.
 * - The same key with another input or tool: the `IDEMPOTENCY_MISMATCH`
 *   failure.
 * - Nothing stored (or expired), no key, a dry run, nobody signed in, or an
 *   empty key: `null`, and the call goes on to `runBatch`.
 * - The books busy, or the lookup failing: that failure, as `runBatch` would
 *   answer.
 *
 * It only reads (and sweeps expired keys). It never stores, and `runBatch`
 * looks again inside its write transaction, so a call is never saved twice.
 */
export function storedReplay<T = unknown>(
  ctx: AppContext,
  call: ReplayLookup,
): BatchResult<T> | null {
  const slot = slotOf(ctx, call);
  if (!slot || !slot.key.trim()) return null;
  try {
    sweepExpired(ctx.db);
    const row = findStored(ctx.db, slot);
    return row ? replayOf<T>(row, slot) : null;
  } catch (error) {
    if (isBusy(error)) return busy();
    log.error({ err: error, tool: slot.tool }, "Idempotency lookup failed");
    return internal(`The change failed unexpectedly. ${NOTHING_SAVED}`);
  }
}

// --- the executor -----------------------------------------------------------

/** False only when the connection is known to have left its transaction. */
function stillInTransaction(db: LedgerDb): boolean {
  const client = (db as unknown as { $client?: { inTransaction?: unknown } })
    .$client;
  return client?.inTransaction !== false;
}

function head(
  index: number,
  item: BatchItem<unknown>,
): { index: number; action: string; label?: string } {
  return item.label === undefined
    ? { index, action: item.action }
    : { index, action: item.action, label: item.label };
}

/** Runs every item in its own savepoint, inside the open transaction. */
function runItems<T>(
  ctx: AppContext,
  tool: string,
  items: BatchItem<T>[],
  prepared: unknown[],
): BatchItemResult<T>[] {
  const results: BatchItemResult<T>[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const value = ctx.db.transaction(() => {
        const result: unknown = item.run(ctx, prepared[index]);
        if (isThenable(result)) {
          // The work it started settles later, after this savepoint is gone;
          // its emits find a rolled-back unit and are dropped.
          Promise.resolve(result).catch(() => {});
          throw new ItemMisbehaved(
            `run for action "${item.action}" returned a promise; batch items must be synchronous`,
          );
        }
        if (!isAppResult(result))
          throw new ItemMisbehaved(
            `run for action "${item.action}" returned no AppResult`,
          );
        if (!result.ok) throw new ItemRefused(result);
        return result.value as T;
      });
      results.push({ ...head(index, item), ok: true, value });
    } catch (error) {
      results.push({
        ...head(index, item),
        ok: false,
        failure: thrownItemFailure(error, {
          tool,
          action: item.action,
          index,
        }),
      });
      // A few SQLite errors end the whole transaction, not just the
      // savepoint. Running on would put later items in autocommit mode.
      if (!stillInTransaction(ctx.db)) throw new BatchAborted();
    }
  }
  return results;
}

type Finished<T> =
  | { kind: "saved"; items: BatchItemResult<T>[]; requestId?: string }
  | {
      kind: "replay";
      row: { tool: string; inputHash: string; result: string };
    };

/**
 * Runs one batch. See the comment at the top of this file.
 *
 * Returns a failure only for the call as a whole: too many items, a reused
 * key, the books being busy, or something unexpected. Item refusals come back
 * as an outcome with `saved: false` and a result for every item. A call whose
 * key already stored an outcome answers as `storedReplay` does.
 */
export async function runBatch<T>(
  ctx: AppContext,
  opts: BatchOptions<T>,
): Promise<BatchResult<T>> {
  const { tool, dryRun, items } = opts;
  const maxItems = opts.maxItems ?? MAX_BATCH_ITEMS;
  if (!ctx.locals.user) return denied();
  if (items.length === 0)
    return fail("INVALID_INPUT", "Send at least one item.");
  if (items.length > maxItems)
    return fail(
      "INVALID_INPUT",
      `One call takes at most ${maxItems} items; this one has ${items.length}. Split it into several calls of ${maxItems} or fewer. ${NOTHING_SAVED}`,
    );

  // A dry run accepts a key but neither looks it up nor stores it.
  const slot = slotOf(ctx, opts);
  if (slot && !slot.key.trim())
    return fail("INVALID_INPUT", "The idempotency_key is empty.");
  // The same lookup a write tool makes before resolving its references.
  const replay = storedReplay<T>(ctx, opts);
  if (replay) return replay;

  // Prepare, in order. One failure means no transaction at all.
  const prepared: unknown[] = [];
  const prepareFailures = new Map<number, BatchFailure>();
  for (const [index, item] of items.entries()) {
    if (!item.prepare) continue;
    try {
      const result = await item.prepare(ctx);
      if (result.ok) prepared[index] = result.value;
      else prepareFailures.set(index, result);
    } catch (error) {
      prepareFailures.set(
        index,
        thrownItemFailure(error, { tool, action: item.action, index }),
      );
    }
  }
  if (prepareFailures.size > 0)
    return ok({
      saved: false,
      dryRun,
      items: items.map((item, index): BatchItemResult<T> => {
        const failure = prepareFailures.get(index);
        return failure
          ? { ...head(index, item), ok: false, failure }
          : {
              ...head(index, item),
              ok: false,
              skipped: true,
              failure: fail(
                "REFUSED",
                `Not attempted, because another item failed first. ${NOTHING_SAVED}`,
              ),
            };
      }),
    });

  let finished: Finished<T>;
  try {
    finished = runUnitOfWork(dryRun ? "dry_run" : "write", () =>
      ctx.db.transaction(
        (): Finished<T> => {
          if (slot) {
            // Authoritative now that this transaction holds the write lock:
            // a concurrent call with the same key that committed after the
            // lookup above is seen here, and nothing runs twice.
            ctx.db
              .delete(mcpIdempotency)
              .where(
                and(sameSlot(slot), sql`${mcpIdempotency.createdAt} < ${TTL}`),
              )
              .run();
            const row = findStored(ctx.db, slot);
            if (row) return { kind: "replay", row };
          }
          const results = runItems(ctx, tool, items, prepared);
          if (dryRun || results.some((r) => !r.ok))
            throw new BatchRollback(results);
          const requestId = currentAuditScope().requestId || undefined;
          if (slot) {
            const stored: Stored<T> = { requestId, items: results };
            ctx.db
              .insert(mcpIdempotency)
              .values({ ...slot, result: JSON.stringify(stored) })
              .run();
          }
          return { kind: "saved", items: results, requestId };
        },
        { behavior: "immediate" },
      ),
    );
  } catch (error) {
    if (error instanceof BatchRollback)
      return ok({
        saved: false,
        dryRun,
        items: error.items as BatchItemResult<T>[],
      });
    if (slot && isIdempotencyCollision(error)) {
      // Another connection committed the same key first. This call is rolled
      // back; answer with what that one stored.
      const row = findStored(ctx.db, slot);
      return row ? replayOf<T>(row, slot) : busy();
    }
    if (isBusy(error)) return busy();
    if (error instanceof BatchAborted)
      log.error({ tool }, "Batch aborted: the connection left its transaction");
    else log.error({ err: error, tool }, "Batch failed");
    return internal(`The change failed unexpectedly. ${NOTHING_SAVED}`);
  }

  if (finished.kind === "replay") return replayOf<T>(finished.row, slot!);
  return ok({
    saved: true,
    dryRun: false,
    ...(finished.requestId ? { requestId: finished.requestId } : {}),
    items: finished.items,
  });
}
