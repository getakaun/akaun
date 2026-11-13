import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createLogger } from "./logger.js";

/**
 * A unit of work: one synchronous run of several application operations that
 * either all take effect or none do.
 *
 * Each operation already commits its rows inside its own `ctx.db.transaction`,
 * which nests as a SAVEPOINT inside an outer transaction. What did NOT nest is
 * everything an operation does outside the database once its own savepoint is
 * released: it flushes its `DeferredEmits`, so live screens hear about rows the
 * outer transaction may still roll back, and it deletes or moves stored files.
 * Inside a unit of work those side effects wait for the outermost commit:
 *
 *   runUnitOfWork("write", () => ctx.db.transaction(() => { opA(); opB(); }))
 *
 * The unit must be OUTSIDE the transaction. Its after-commit work runs when
 * `fn` returns, which is only after the commit when `fn` is the transaction.
 *
 * Outside a unit of work nothing changes: every emitter and file helper behaves
 * exactly as before, so the REST routes are unaffected.
 */

export type UnitOfWorkMode = "dry_run" | "write";
export type UnitOfWorkState = "open" | "committed" | "rolled_back";

type Unit = {
  mode: UnitOfWorkMode;
  state: UnitOfWorkState;
  afterCommit: (() => void)[];
  onRollback: (() => void)[];
};

const log = createLogger("unit-of-work");
const units = new AsyncLocalStorage<Unit>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Runs one queued task outside every unit, logging (not throwing) a failure. */
function runOutside(task: () => void, phase: "after-commit" | "rollback") {
  units.exit(() => {
    try {
      task();
    } catch (err) {
      log.error({ err }, `A unit of work ${phase} task failed`);
    }
  });
}

function rollBack(unit: Unit): void {
  unit.state = "rolled_back";
  unit.afterCommit.length = 0;
  const undo = unit.onRollback.splice(0).reverse();
  for (const task of undo) runOutside(task, "rollback");
}

/**
 * Runs `fn` as one unit of work and returns what it returns.
 *
 * - `write`: events and after-commit work queue while `fn` runs, and run in
 *   order once it returns. When `fn` throws they are dropped, the `onRollback`
 *   tasks run newest first, and the error is rethrown.
 * - `dry_run`: events and after-commit work are dropped. `fn` is expected to
 *   roll its own transaction back by throwing; if it returns, the `onRollback`
 *   tasks still run.
 *
 * `fn` must be synchronous, because a bun:sqlite transaction is: a callback that
 * returns a promise is refused, and the unit is rolled back.
 *
 * A call inside an open unit joins it and just runs `fn`. A dry run cannot join
 * a unit that writes, so that combination throws; a write inside a dry run
 * stays a dry run.
 */
export function runUnitOfWork<T>(mode: UnitOfWorkMode, fn: () => T): T {
  const outer = units.getStore();
  if (outer?.state === "open") {
    if (outer.mode === "write" && mode === "dry_run") {
      throw new Error("a dry run cannot join a unit of work that writes");
    }
    const result = fn();
    if (isThenable(result)) {
      // Thrown into the outer unit, which then rolls back.
      Promise.resolve(result).catch(() => {});
      throw new Error("unit of work callbacks must be synchronous");
    }
    return result;
  }

  const unit: Unit = { mode, state: "open", afterCommit: [], onRollback: [] };
  let result: T;
  try {
    result = units.run(unit, fn);
  } catch (err) {
    rollBack(unit);
    throw err;
  }

  if (isThenable(result)) {
    rollBack(unit);
    // The work it started still settles later; keep its failure from becoming
    // an unhandled rejection. Its emits see a rolled-back unit and are dropped.
    Promise.resolve(result).catch(() => {});
    throw new Error("unit of work callbacks must be synchronous");
  }

  if (mode === "dry_run") {
    rollBack(unit);
    return result;
  }

  unit.state = "committed";
  unit.onRollback.length = 0;
  const tasks = unit.afterCommit.splice(0);
  for (const task of tasks) runOutside(task, "after-commit");
  return result;
}

/**
 * Runs `task` once the current unit of work commits.
 *
 * Outside a unit, or in one that has already committed, it runs now. In a dry
 * run, or a unit that rolls back, it never runs.
 */
export function afterCommit(task: () => void): void {
  const unit = units.getStore();
  if (!unit || unit.state === "committed") {
    task();
    return;
  }
  if (unit.state === "open") unit.afterCommit.push(task);
}

/**
 * Registers `task` to undo something just done, should the current unit of
 * work roll back. Register it after the change it undoes.
 *
 * Outside a unit, or in one that has committed, it does nothing. In a unit
 * that has already rolled back (a late microtask), the change cannot be kept,
 * so `task` runs now.
 */
export function onRollback(task: () => void): void {
  const unit = units.getStore();
  if (!unit || unit.state === "committed") return;
  if (unit.state === "open") unit.onRollback.push(task);
  else runOutside(task, "rollback");
}

/** The current unit of work's mode and state, or undefined outside one. */
export function currentUnitOfWork():
  | { mode: UnitOfWorkMode; state: UnitOfWorkState }
  | undefined {
  const unit = units.getStore();
  return unit ? { mode: unit.mode, state: unit.state } : undefined;
}

/**
 * An app event bus whose events wait for the unit of work they were emitted in.
 *
 * | Where `emit` is called      | What happens                               |
 * |-----------------------------|--------------------------------------------|
 * | outside a unit of work      | delivered now, as a plain EventEmitter     |
 * | open unit, `write`          | queued until the unit commits              |
 * | open unit, `dry_run`        | dropped                                    |
 * | unit already committed      | delivered now                              |
 * | unit already rolled back    | dropped                                    |
 *
 * The last two cover a microtask queued inside the unit (`recordAudit`'s
 * audit-feed emit), which inherits the unit and runs after it has finished.
 * A queued emit returns whether the event has listeners now.
 */
export class DeferrableEmitter extends EventEmitter {
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const unit = units.getStore();
    if (!unit || unit.state === "committed") {
      return super.emit(eventName, ...args);
    }
    if (unit.state === "rolled_back" || unit.mode === "dry_run") return false;
    unit.afterCommit.push(() => {
      super.emit(eventName, ...args);
    });
    return this.listenerCount(eventName) > 0;
  }
}
