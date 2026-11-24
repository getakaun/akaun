import {
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";
import { and, eq, gt, lt } from "drizzle-orm";
import { verify } from "argon2";
import type { Cookies } from "@sveltejs/kit";
import { oidcAttempts, sessions, users } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { RECENT_PASSWORD_AGE, setSessionCookie } from "../auth.js";
import {
  authorizationUrl,
  exchangeCode,
  identifier,
  localReturnTo,
  SSO_PATH,
  AUTH_COMPLETE_PATH,
  SSO_ERROR,
} from "./protocol.js";
import { digest, publicOrigin, readAuthentication } from "./settings.js";
import {
  findIdentity,
  linkIdentity,
  signIn,
  SignInRejected,
} from "./accounts.js";
import { createLogger } from "../logger.js";
import { hit, reset } from "../rate-limit.js";

const log = createLogger("oidc");
const ATTEMPT_AGE = 5 * 60_000;
const LINK_RETURN = "/profile?tab=security";
const LINK_COOKIE = "akaun_oidc_link";
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

export async function beginBrowserFlow(
  db: LedgerDb,
  cookies: Cookies,
  returnTo: string | null,
  proof?: {
    sessionId: string;
    userId: number;
    password: string;
  },
) {
  const settings = readAuthentication(db);
  if (!settings.enabled || (proof && !settings.internalEnabled))
    throw new SignInRejected("disabled");
  const rateKey = proof ? `oidc-link-password:${proof.userId}` : "";
  let passwordHash: string | undefined;
  if (proof) {
    const account = db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, proof.sessionId))
      .get();
    if (
      !account ||
      account.user.id !== proof.userId ||
      account.user.disabled ||
      account.user.oidcManagedBy ||
      account.session.oidcConfiguration ||
      account.session.expiresAt <= new Date().toISOString()
    ) {
      throw new SignInRejected("browser_proof");
    }
    if (findIdentity(db, settings.stored.authority, proof.userId))
      throw new SignInRejected("identity_conflict");
    passwordHash = account.user.passwordHash;
    const created = Date.parse(
      account.session.createdAt.includes("T")
        ? account.session.createdAt
        : account.session.createdAt.replace(" ", "T") + "Z",
    );
    if (
      !Number.isFinite(created) ||
      created > Date.now() ||
      Date.now() - created >= RECENT_PASSWORD_AGE
    ) {
      if (!proof.password) return null;
      if (
        proof.password.length > 1024 ||
        hit(rateKey, 5, 15 * 60_000).limited ||
        !(await verify(passwordHash, proof.password))
      )
        throw new SignInRejected("password_proof");
      reset(rateKey);
    }
  }

  const startedAt = Date.now();
  const browser = randomState();
  const attempt = {
    startedAt,
    expiresAt: startedAt + ATTEMPT_AGE,
    state: randomState(),
    nonce: randomNonce(),
    verifier: randomPKCECodeVerifier(),
    browserHash: digest(browser),
    revision: settings.revision,
    linkSessionId: proof?.sessionId ?? null,
    returnTo: proof ? LINK_RETURN : localReturnTo(returnTo),
  };
  const secure = publicOrigin(process.env).protocol === "https:";
  const url = proof
    ? null
    : await authorizationUrl(settings, process.env, attempt);
  db.transaction(
    (tx) => {
      if (readAuthentication(tx).revision !== settings.revision)
        throw new SignInRejected("settings_changed");
      tx.delete(oidcAttempts)
        .where(lt(oidcAttempts.expiresAt, startedAt))
        .run();
      if (proof) {
        const current = tx
          .select({ hash: users.passwordHash })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(
            and(
              eq(sessions.id, proof.sessionId),
              eq(users.id, proof.userId),
              eq(users.disabled, false),
              gt(sessions.expiresAt, new Date().toISOString()),
            ),
          )
          .get();
        if (!current || current.hash !== passwordHash)
          throw new SignInRejected("browser_proof");
        tx.delete(oidcAttempts)
          .where(eq(oidcAttempts.linkSessionId, proof.sessionId))
          .run();
      }
      tx.insert(oidcAttempts).values(attempt).run();
    },
    { behavior: "immediate" },
  );
  const options = {
    path: SSO_PATH,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: ATTEMPT_AGE / 1000,
  };
  cookies.set(`oidc_${attempt.state}`, browser, options);
  if (proof) cookies.set(LINK_COOKIE, attempt.state, options);
  return url?.href ?? SSO_PATH + "/link";
}

function readAttempt(db: LedgerDb, cookies: Cookies, state: string) {
  if (!TOKEN_PATTERN.test(state)) return undefined;
  const browser = cookies.get(`oidc_${state}`);
  if (!browser || !TOKEN_PATTERN.test(browser)) return undefined;
  return db
    .select()
    .from(oidcAttempts)
    .where(
      and(
        eq(oidcAttempts.state, state),
        eq(oidcAttempts.browserHash, digest(browser)),
        gt(oidcAttempts.expiresAt, Date.now()),
      ),
    )
    .get();
}

export async function continueLink(db: LedgerDb, cookies: Cookies) {
  const state = cookies.get(LINK_COOKIE);
  const attempt = state ? readAttempt(db, cookies, state) : undefined;
  const settings = readAuthentication(db);
  if (
    !attempt?.linkSessionId ||
    attempt.linkSessionId !== cookies.get("session") ||
    !settings.enabled ||
    !settings.internalEnabled ||
    settings.revision !== attempt.revision
  )
    return null;
  const startedAt = Date.now();
  const authorization = await authorizationUrl(settings, process.env, attempt);
  const active = db
    .update(oidcAttempts)
    .set({ startedAt })
    .where(
      and(
        eq(oidcAttempts.state, attempt.state),
        gt(oidcAttempts.expiresAt, Date.now()),
      ),
    )
    .returning({ state: oidcAttempts.state })
    .get();
  cookies.delete(LINK_COOKIE, { path: SSO_PATH });
  return active ? authorization.href : null;
}

export async function completeBrowserFlow(
  db: LedgerDb,
  cookies: Cookies,
  url: URL,
) {
  const state = url.searchParams.get("state");
  const target = `/login?${new URLSearchParams(SSO_ERROR)}`;
  if (!state || url.searchParams.getAll("state").length !== 1) return target;
  const attempt = readAttempt(db, cookies, state);
  if (!attempt) return target;
  cookies.delete(`oidc_${state}`, { path: SSO_PATH });
  const retry = new URLSearchParams(SSO_ERROR);
  const pending = new URL(attempt.returnTo, "https://akaun.invalid");
  if (
    pending.pathname === "/oauth/authorize" &&
    pending.searchParams.has("transaction")
  )
    retry.set("oauth", pending.searchParams.get("transaction")!);
  else if (attempt.returnTo !== "/") retry.set("returnTo", attempt.returnTo);
  const signInFailure = `/login?${retry}`;
  const settings = readAuthentication(db);

  try {
    if (!settings.enabled || attempt.revision !== settings.revision)
      throw new SignInRejected("settings_changed");
    if (
      attempt.linkSessionId &&
      cookies.get("session") !== attempt.linkSessionId
    )
      throw new SignInRejected("browser_proof");
    const claims = await exchangeCode(
      settings,
      process.env,
      url.search,
      attempt,
    );
    const subject = identifier(claims, "sub", true)!;
    const sid = identifier(claims, "sid");
    const sessionId = db.transaction(
      (tx) => {
        const current = readAuthentication(tx);
        if (!current.enabled || current.revision !== attempt.revision)
          throw new SignInRejected("settings_changed");
        const consumed = tx
          .delete(oidcAttempts)
          .where(
            and(
              eq(oidcAttempts.state, state),
              gt(oidcAttempts.expiresAt, Date.now()),
            ),
          )
          .returning({ state: oidcAttempts.state })
          .get();
        if (!consumed) throw new SignInRejected("link_expired_or_replaced");
        if (attempt.linkSessionId) {
          linkIdentity(tx, current, attempt.linkSessionId, subject);
          return null;
        }
        return signIn(tx, current, subject, sid, claims, attempt.startedAt);
      },
      { behavior: "immediate" },
    );
    if (sessionId)
      setSessionCookie(
        cookies,
        sessionId,
        publicOrigin(process.env).protocol === "https:",
      );
    return attempt.linkSessionId
      ? LINK_RETURN + "&sso=linked"
      : `${AUTH_COMPLETE_PATH}?${new URLSearchParams({ returnTo: attempt.returnTo })}`;
  } catch (error) {
    db.delete(oidcAttempts).where(eq(oidcAttempts.state, state)).run();
    const reason =
      error instanceof SignInRejected ? error.message : "provider_response";
    log.warn(
      { reason, linking: !!attempt.linkSessionId },
      "OidcSignInRejected",
    );
    return attempt.linkSessionId
      ? LINK_RETURN +
          "&sso=" +
          (reason === "identity_conflict" ? reason : "failed")
      : signInFailure;
  }
}
