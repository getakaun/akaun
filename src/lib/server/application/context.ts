import type { LedgerDb } from "../ledger/types.js";
import type { BlobStore } from "../storage/blob-store.js";
import {
  hasPermission,
  type ActionName,
  type ResourceName,
} from "../permissions.js";
import { denied, type AppFailure } from "./result.js";

/**
 * What one authorized operation runs against.
 *
 * Everything it needs comes in here: the database, who is asking, and — for
 * the operations that touch files — where files live. **Nothing under
 * `application/` imports `db/client.ts`, `env.js` or `file-storage.ts`.** That
 * is what lets the MCP specs run every operation against an in-memory database
 * and a folder under `os.tmpdir()`, and is what keeps a test from ever reaching
 * the real `data/` (CLAUDE.md, Verification Policy).
 */
export type AppContext = {
  db: LedgerDb;
  locals: App.Locals;
  /** The file store's root on disk, for the helpers that still take a path. */
  storageRoot?: string;
  store?: BlobStore;
  /**
   * Reads text out of newly stored files, for search. Passed in rather than
   * imported because it runs OCR and reads configuration. Absent means the
   * attachment is saved without its text, which a later re-index fills in.
   */
  indexAttachments?: (
    storedKeys: string[],
    storageRoot: string,
  ) => Promise<string | null>;
};

/** The acting user's id. Every operation is reached only once one is signed in. */
export function actor(ctx: AppContext): number {
  const user = ctx.locals.user;
  if (!user) throw new Error("An operation was reached with nobody signed in.");
  return user.id;
}

/**
 * Every pair must be granted. Returns the refusal to hand back, or null.
 *
 * Route code and MCP tools never call `hasPermission` for a write themselves:
 * the operation asks, so the two can never ask different questions.
 */
export function requirePermissions(
  ctx: AppContext,
  pairs: [ResourceName, ActionName][],
): AppFailure | null {
  if (!ctx.locals.user) return denied();
  return pairs.every(([resource, action]) =>
    hasPermission(ctx.locals, resource, action),
  )
    ? null
    : denied();
}
