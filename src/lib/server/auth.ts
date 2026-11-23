import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Cookies } from "@sveltejs/kit";
import { sessions, users } from "./db/schema.js";
import type { LedgerDb } from "./ledger/types.js";
import { allowsPassword, readAuthentication } from "./oidc/settings.js";

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE = 14 * DAY;
const OIDC_IDLE_AGE = 3 * DAY;
export const RECENT_PASSWORD_AGE = 10 * 60 * 1000;

export function getSessionUser(db: LedgerDb, sessionId: string) {
  const now = Date.now();
  const row = db
    .select({
      user: {
        id: users.id,
        email: users.email,
        username: users.username,
        name: users.name,
        role: users.role,
      },
      session: sessions,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), eq(users.disabled, false)))
    .get();
  if (!row || row.session.expiresAt <= new Date(now).toISOString()) return null;

  const policy = readAuthentication(db);
  if (row.session.oidcConfiguration) {
    if (!policy.enabled || row.session.oidcConfiguration !== policy.identity)
      return null;
    const deadline = Date.parse(row.session.createdAt) + SESSION_MAX_AGE;
    if (deadline <= now) return null;
    const expiresAt = new Date(
      Math.min(now + OIDC_IDLE_AGE, deadline),
    ).toISOString();
    db.update(sessions)
      .set({ expiresAt })
      .where(and(eq(sessions.id, sessionId), lt(sessions.expiresAt, expiresAt)))
      .run();
  } else if (!allowsPassword(policy, row.user.id)) {
    return null;
  }
  return row.user;
}

export function createSession(
  db: LedgerDb,
  userId: number,
  oidc?: {
    oidcConfiguration: string;
    oidcSubject: string;
    oidcSid: string | null;
  },
): string {
  const id = randomBytes(32).toString("hex");
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(
    now + (oidc ? OIDC_IDLE_AGE : SESSION_MAX_AGE),
  ).toISOString();
  db.delete(sessions).where(lt(sessions.expiresAt, createdAt)).run();
  db.insert(sessions)
    .values({ id, userId, createdAt, expiresAt, ...oidc })
    .run();
  return id;
}

export function setSessionCookie(
  cookies: Cookies,
  sessionId: string,
  secure = process.env.NODE_ENV === "production",
) {
  cookies.set("session", sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_MAX_AGE / 1000,
  });
}

export function deleteSession(db: LedgerDb, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}
