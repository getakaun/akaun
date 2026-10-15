import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { personalAccessTokens, users } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { resolveAccess } from "../permissions.js";

/**
 * Personal access tokens.
 *
 * `akp_` + 36 random base62 characters + a 6-character checksum of them. The
 * prefix makes a leaked token recognisable to secret scanners; the checksum
 * lets a malformed or made-up token be refused without a database lookup
 * (the same reasoning as GitHub's token formats). Only a SHA-256 of the whole
 * token is stored — the secret is high-entropy, so a fast hash is enough and
 * a lookup by hash needs no constant-time comparison.
 *
 * A token's permissions are checked against its owner's role and their
 * groups' delegation ceiling on every request (`effectivePermissions`): a
 * token never does more than its owner may currently delegate, whatever it
 * was created with.
 */
export const PAT_PREFIX = "akp_";
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BODY_LENGTH = 36;
const CHECKSUM_LENGTH = 6;
/** How often `last_used_at` is written for one token, at most. */
export const LAST_USED_WRITE_MS = 60_000;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8"))
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function base62(value: number, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    out = ALPHABET[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

/** Anything but a list of strings stands for no permissions: fail closed. */
export function storedPermissions(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintPat(): string {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[randomInt(62)];
  return `${PAT_PREFIX}${body}${base62(crc32(body), CHECKSUM_LENGTH)}`;
}

/** True only for a well-formed token whose checksum matches. */
export function isWellFormedPat(token: string): boolean {
  if (!token.startsWith(PAT_PREFIX)) return false;
  const rest = token.slice(PAT_PREFIX.length);
  if (rest.length !== BODY_LENGTH + CHECKSUM_LENGTH) return false;
  if (![...rest].every((ch) => ALPHABET.includes(ch))) return false;
  const body = rest.slice(0, BODY_LENGTH);
  return rest.slice(BODY_LENGTH) === base62(crc32(body), CHECKSUM_LENGTH);
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(authorization: string | null): string | null {
  return authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null;
}

/**
 * The request's locals for a personal access token, or null when the token is
 * not one, is unknown, revoked or expired. Never accepts a caller-supplied
 * user id.
 */
export function patLocals(
  db: LedgerDb,
  authorization: string | null,
  now = Date.now(),
): App.Locals | null {
  const token = bearerToken(authorization);
  if (!token || !isWellFormedPat(token)) return null;
  const row = db
    .select({
      id: personalAccessTokens.id,
      permissions: personalAccessTokens.permissions,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      userId: users.id,
      email: users.email,
      username: users.username,
      name: users.name,
      role: users.role,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.tokenHash, hashToken(token)),
        isNull(personalAccessTokens.revokedAt),
        or(
          isNull(personalAccessTokens.expiresAt),
          gt(personalAccessTokens.expiresAt, now),
        ),
      ),
    )
    .get();
  if (!row) return null;

  // Throttled: a busy integration must not turn every read into a write.
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_WRITE_MS) {
    db.update(personalAccessTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(personalAccessTokens.id, row.id),
          or(
            isNull(personalAccessTokens.lastUsedAt),
            lt(personalAccessTokens.lastUsedAt, now - LAST_USED_WRITE_MS + 1),
          ),
        ),
      )
      .run();
  }

  // Never null: a credential with no readable permissions has none, rather
  // than falling back to the owner's whole role.
  const granted = storedPermissions(row.permissions);
  const { role, permissions } = resolveAccess(db, row.userId, granted);
  return {
    user: {
      id: row.userId,
      email: row.email,
      username: row.username,
      name: row.name,
      role: row.role,
    },
    role,
    permissions,
    credential: { kind: "pat", tokenId: row.id },
  };
}

/** What a 401 says to someone still using a token from before tokens were replaced. */
export const LEGACY_TOKEN_MESSAGE =
  "API tokens were replaced by personal access tokens. Create one under Profile → Access tokens.";

export function isLegacyToken(authorization: string | null): boolean {
  const token = bearerToken(authorization);
  return token !== null && /^akn_[0-9a-f]{48}$/.test(token);
}
