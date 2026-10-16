import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  expandAll,
  isPermission,
  sortLeaves,
  type LeafPermission,
} from "$lib/permissions/catalog.js";
import { personalAccessTokens } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import type { RoleAccess } from "../permissions.js";
import { fail, missing, ok, type AppResult } from "../application/result.js";
import { hashToken, mintPat, storedPermissions } from "./pat.js";
import { diffRecords, recordAudit } from "../audit.js";

/** Most live tokens one user may hold, as GitHub's fine-grained limit. */
export const MAX_TOKENS_PER_USER = 50;
/** What the New token page fills in: six months from today. */
export const DEFAULT_EXPIRY_MONTHS = 6;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type TokenRow = typeof personalAccessTokens.$inferSelect;

/** What the audit log keeps of a token: never its hash. */
function auditFields(row: TokenRow) {
  return {
    name: row.name,
    ownerId: row.userId,
    permissions: storedPermissions(row.permissions),
    expiresOn:
      row.expiresAt === null
        ? null
        : new Date(row.expiresAt).toISOString().slice(0, 10),
    lastFour: row.lastFour,
  };
}

function auditToken(
  db: LedgerDb,
  actorId: number,
  action: "create" | "update" | "delete",
  before: TokenRow | null,
  after: TokenRow | null,
) {
  const row = (after ?? before)!;
  recordAudit(db, {
    recordType: "access_token",
    recordId: row.id,
    userId: actorId,
    action,
    changes: diffRecords(
      before && auditFields(before),
      after && auditFields(after),
    ),
    label: row.name,
  });
}

export type TokenView = {
  id: number;
  name: string;
  lastFour: string;
  permissions: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  createdBy: number | null;
};

function view(row: typeof personalAccessTokens.$inferSelect): TokenView {
  const permissions = storedPermissions(row.permissions);
  return {
    id: row.id,
    name: row.name,
    lastFour: row.lastFour,
    permissions,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

export function listTokens(db: LedgerDb, userId: number): TokenView[] {
  return db
    .select()
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .orderBy(desc(personalAccessTokens.createdAt))
    .all()
    .map(view);
}

export const tokenInputSchema = z.object({
  name: z.string().trim().min(1, "Give the token a name.").max(100),
  permissions: z
    .array(z.string())
    .min(1, "Choose at least one permission.")
    .max(200),
  /** The last day it works (YYYY-MM-DD, UTC); null for no expiry. */
  expiresOn: z
    .string()
    .regex(ISO_DATE, "Choose a date for the token to expire.")
    .nullable(),
});
export type TokenInput = z.infer<typeof tokenInputSchema>;

/**
 * A token's permissions, checked against what its owner may delegate. Stored
 * as given (a root stays a root, so "all of invoices" keeps its meaning as
 * that area grows — bounded by the owner's ceiling on every request anyway).
 */
function validPermissions(
  permissions: string[],
  owner: RoleAccess,
): AppResult<string[]> {
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length)
    return fail("INVALID_INPUT", `Unknown permission: ${unknown.join(", ")}.`);
  const outside = sortLeaves(
    [...expandAll(permissions)].filter(
      (leaf: LeafPermission) => !owner.delegable.has(leaf),
    ),
  );
  if (outside.length)
    return fail(
      "FORBIDDEN",
      `The token cannot have ${outside.join(", ")}: its owner may not hand that on. An administrator sets this on the owner's groups.`,
    );
  return ok([...new Set(permissions)]);
}

/**
 * When a token stops working: the end of the chosen day, UTC, which is also
 * the day the screens show. It must still be ahead, so a token is never
 * created already expired. The page offers tomorrow onwards in the user's own
 * time zone; this only refuses a day that is over everywhere it is shown.
 */
function validExpiry(
  expiresOn: string | null,
  now: number,
): AppResult<number | null> {
  if (expiresOn === null) return ok(null);
  // Every caller, not only the form schema: an unreadable date would be
  // stored as NULL, which reads as "never expires".
  const end = ISO_DATE.test(expiresOn)
    ? Date.parse(`${expiresOn}T23:59:59.999Z`)
    : Number.NaN;
  if (
    !Number.isFinite(end) ||
    new Date(end).toISOString().slice(0, 10) !== expiresOn
  )
    return fail("INVALID_INPUT", "Choose a date for the token to expire.");
  if (end <= now)
    return fail("INVALID_INPUT", "Choose an expiry date in the future.");
  return ok(end);
}

export function createToken(
  db: LedgerDb,
  args: {
    ownerId: number;
    createdBy: number;
    owner: RoleAccess;
    input: TokenInput;
  },
  now = Date.now(),
): AppResult<{ token: string; view: TokenView }> {
  const permissions = validPermissions(args.input.permissions, args.owner);
  if (!permissions.ok) return permissions;
  const expiresAt = validExpiry(args.input.expiresOn, now);
  if (!expiresAt.ok) return expiresAt;
  if (listTokens(db, args.ownerId).length >= MAX_TOKENS_PER_USER)
    return fail(
      "REFUSED",
      `A user can hold at most ${MAX_TOKENS_PER_USER} tokens. Revoke one first.`,
    );
  if (listTokens(db, args.ownerId).some((t) => t.name === args.input.name))
    return fail("REFUSED", "There is already a token with that name.");
  const token = mintPat();
  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(personalAccessTokens)
      .values({
        userId: args.ownerId,
        name: args.input.name,
        tokenHash: hashToken(token),
        lastFour: token.slice(-4),
        permissions: JSON.stringify(permissions.value),
        expiresAt: expiresAt.value,
        createdAt: now,
        createdBy: args.createdBy,
      })
      .returning()
      .get();
    auditToken(tx, args.createdBy, "create", null, inserted);
    return inserted;
  });
  return ok({ token, view: view(row) });
}

function liveToken(db: LedgerDb, ownerId: number, tokenId: number) {
  return db
    .select()
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, tokenId),
        eq(personalAccessTokens.userId, ownerId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .get();
}

/** Changes a token's name and permissions. Its secret and expiry stay. */
export function updateToken(
  db: LedgerDb,
  args: {
    ownerId: number;
    tokenId: number;
    owner: RoleAccess;
    name: string;
    permissions: string[];
    /** Who made the change, for the audit log. Default: the owner. */
    actorId?: number;
  },
): AppResult<TokenView> {
  const existing = liveToken(db, args.ownerId, args.tokenId);
  if (!existing) return missing("That token no longer exists.");
  const permissions = validPermissions(args.permissions, args.owner);
  if (!permissions.ok) return permissions;
  if (
    listTokens(db, args.ownerId).some(
      (t) => t.name === args.name && t.id !== args.tokenId,
    )
  )
    return fail("REFUSED", "There is already a token with that name.");
  const row = db.transaction((tx) => {
    const updated = tx
      .update(personalAccessTokens)
      .set({
        name: args.name,
        permissions: JSON.stringify(permissions.value),
      })
      .where(eq(personalAccessTokens.id, args.tokenId))
      .returning()
      .get();
    auditToken(tx, args.actorId ?? args.ownerId, "update", existing, updated);
    return updated;
  });
  return ok(view(row));
}

/**
 * Replaces a token's secret. The old secret stops working at once; the name,
 * permissions and expiry stay. An expired token is not brought back: a new
 * one is made instead, with its expiry chosen again.
 */
export function regenerateToken(
  db: LedgerDb,
  args: {
    ownerId: number;
    tokenId: number;
    owner: RoleAccess;
    /** Who made the change, for the audit log. Default: the owner. */
    actorId?: number;
  },
  now = Date.now(),
): AppResult<{ token: string; view: TokenView }> {
  const existing = liveToken(db, args.ownerId, args.tokenId);
  if (!existing) return missing("That token no longer exists.");
  // The owner's ceiling may have narrowed since: a regenerated token must
  // still fit it, as a new one would.
  const permissions = validPermissions(view(existing).permissions, args.owner);
  if (!permissions.ok) return permissions;
  if (existing.expiresAt !== null && existing.expiresAt <= now)
    return fail("REFUSED", "This token has expired. Create a new one.");
  const token = mintPat();
  const row = db.transaction((tx) => {
    const updated = tx
      .update(personalAccessTokens)
      .set({
        tokenHash: hashToken(token),
        lastFour: token.slice(-4),
        lastUsedAt: null,
      })
      .where(eq(personalAccessTokens.id, args.tokenId))
      .returning()
      .get();
    // Shows as a new `lastFour`: the only visible trace of a new secret.
    auditToken(tx, args.actorId ?? args.ownerId, "update", existing, updated);
    return updated;
  });
  return ok({ token, view: view(row) });
}

/** Audited as a delete: a revoked token can never be used again. */
export function revokeToken(
  db: LedgerDb,
  ownerId: number,
  tokenId: number,
  /** Who revoked it, for the audit log: the owner, or an administrator. */
  actorId = ownerId,
  now = Date.now(),
): boolean {
  return db.transaction((tx) => {
    const row = tx
      .update(personalAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(personalAccessTokens.id, tokenId),
          eq(personalAccessTokens.userId, ownerId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning()
      .get();
    if (row) auditToken(tx, actorId, "delete", row, null);
    return row !== undefined;
  });
}

/** Every live token of one user. On a password change, and by an administrator. */
export function revokeAllTokens(
  db: LedgerDb,
  ownerId: number,
  /** Who revoked them, for the audit log: the owner, or an administrator. */
  actorId = ownerId,
  now = Date.now(),
): number {
  return db.transaction((tx) => {
    const rows = tx
      .update(personalAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(personalAccessTokens.userId, ownerId),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .returning()
      .all();
    // One entry per token, so each can be found by its own name.
    for (const row of rows) auditToken(tx, actorId, "delete", row, null);
    return rows.length;
  });
}
