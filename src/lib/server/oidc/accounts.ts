import { and, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { JWTPayload } from "jose";
import {
  groups,
  oidcGroupMemberships,
  oidcIdentities,
  oidcLogoutReceipts,
  sessions,
  userGroups,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { createSession } from "../auth.js";
import {
  readAuthentication,
  digest,
  type AuthenticationSnapshot,
} from "./settings.js";
import {
  keepsASuperuser,
  PROTECTED_GROUP,
  userAuditSnapshot,
} from "../admin/access.js";
import { diffRecords, recordAudit } from "../audit.js";
import { createLogger } from "../logger.js";

const log = createLogger("oidc");

export class SignInRejected extends Error {}

export function findIdentity(db: LedgerDb, issuer: string, userId: number) {
  return db
    .select({ userId: oidcIdentities.userId })
    .from(oidcIdentities)
    .where(
      and(eq(oidcIdentities.issuer, issuer), eq(oidcIdentities.userId, userId)),
    )
    .get();
}

export function linkIdentity(
  db: LedgerDb,
  settings: AuthenticationSnapshot,
  sessionId: string,
  subject: string,
) {
  const session = db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date().toISOString()),
        eq(users.disabled, false),
        isNull(users.oidcManagedBy),
        isNull(sessions.oidcConfiguration),
      ),
    )
    .get();
  if (!session || !settings.internalEnabled)
    throw new SignInRejected("browser_proof");
  if (findIdentity(db, settings.stored.authority, session.userId))
    throw new SignInRejected("identity_conflict");
  const claimed = db
    .insert(oidcIdentities)
    .values({
      issuer: settings.stored.authority,
      subject,
      userId: session.userId,
    })
    .onConflictDoNothing()
    .returning({ id: oidcIdentities.userId })
    .get();
  if (!claimed) throw new SignInRejected("identity_conflict");
  recordAudit(db, {
    recordType: "user",
    recordId: session.userId,
    userId: session.userId,
    action: "update",
    changes: [{ field: "ssoIdentityLinked", before: false, after: true }],
  });
}

function provisionAccount(
  db: LedgerDb,
  settings: AuthenticationSnapshot,
  subject: string,
  claims: JWTPayload,
) {
  if (!settings.stored.jitEnabled)
    throw new SignInRejected("not_linked_and_jit_disabled");
  const username =
    typeof claims.preferred_username === "string"
      ? claims.preferred_username.trim()
      : "";
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const { name } = claims;
  if (!/^[a-z0-9._@+-]{1,256}$/i.test(username))
    throw new SignInRejected("username_claim_missing_or_invalid");
  if (email.length > 256 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new SignInRejected("email_claim_missing_or_invalid");
  const emailVerified =
    claims.email_verified === true ||
    (typeof claims.email_verified === "string" &&
      claims.email_verified.toLowerCase() === "true");
  if (settings.stored.requireVerifiedEmail && !emailVerified)
    throw new SignInRejected("email_unverified");
  if (name !== undefined && (typeof name !== "string" || name.length > 256))
    throw new SignInRejected("name_claim_invalid");
  const conflict = db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        sql`lower(${users.email}) = lower(${email})`,
        sql`lower(${users.username}) = lower(${username})`,
      ),
    )
    .get();
  if (conflict) throw new SignInRejected("account_conflict");
  const user = db
    .insert(users)
    .values({
      username,
      email,
      name: typeof name === "string" ? name : null,
      role: "user",
      passwordHash: "",
      oidcManagedBy: settings.stored.authority,
    })
    .returning()
    .get();
  db.insert(oidcIdentities)
    .values({ issuer: settings.stored.authority, subject, userId: user.id })
    .run();
  return user;
}

function syncGroups(
  db: LedgerDb,
  settings: AuthenticationSnapshot,
  userId: number,
  claims: JWTPayload,
  newUser: boolean,
) {
  const config = settings.stored;
  const owned = db
    .select()
    .from(oidcGroupMemberships)
    .where(eq(oidcGroupMemberships.userId, userId))
    .all();
  if (!newUser && config.groupMappings.length === 0 && owned.length === 0)
    return;
  const allGroups = db.select().from(groups).all();
  const fallback = allGroups.find(
    (group) => group.id === config.defaultGroupId,
  );
  if (!fallback || fallback.name === PROTECTED_GROUP || fallback.isSuperuser)
    throw new SignInRejected("invalid_default_group");
  if (
    config.groupMappings.some(
      ({ groupId }) => !allGroups.some((group) => group.id === groupId),
    )
  )
    throw new SignInRejected("invalid_group_mapping");
  const claim = claims[config.groupsClaim];
  const externalGroups = Array.isArray(claim)
    ? claim.filter((value) => typeof value === "string")
    : typeof claim === "string"
      ? [claim]
      : [];
  if (config.groupMappings.length && !externalGroups.length) {
    log.info(
      {
        claim: config.groupsClaim,
        claimsPresent: Object.keys(claims)
          .sort()
          .slice(0, 40)
          .map((name) => name.slice(0, 64)),
      },
      claim === undefined ? "OidcGroupsClaimMissing" : "OidcGroupsClaimEmpty",
    );
  }
  const desired = new Set(
    config.groupMappings
      .filter((mapping) => externalGroups.includes(mapping.externalGroup))
      .map((mapping) => mapping.groupId),
  );
  if (!desired.size) desired.add(fallback.id);
  const before = newUser ? null : userAuditSnapshot(db, userId);
  const previous = db
    .select()
    .from(userGroups)
    .where(eq(userGroups.userId, userId))
    .all();
  const remove = owned.filter(({ groupId }) => !desired.has(groupId));
  const add = [...desired].filter(
    (groupId) => !previous.some((row) => row.groupId === groupId),
  );
  if (
    remove.length &&
    !keepsASuperuser(db, {
      userId,
      groupIds: [
        ...previous
          .filter(
            (row) => !remove.some((removed) => removed.groupId === row.groupId),
          )
          .map((row) => row.groupId),
        ...add,
      ],
    })
  )
    throw new SignInRejected("last_administrator_would_be_removed");

  for (const { groupId } of remove) {
    db.delete(userGroups)
      .where(
        and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId)),
      )
      .run();
  }
  if (add.length) {
    const rows = add.map((groupId) => ({ userId, groupId }));
    db.insert(userGroups).values(rows).run();
    if (config.groupMappings.length)
      db.insert(oidcGroupMemberships).values(rows).run();
  }
  if (!config.groupMappings.length)
    db.delete(oidcGroupMemberships)
      .where(eq(oidcGroupMemberships.userId, userId))
      .run();
  recordAudit(db, {
    recordType: "user",
    recordId: userId,
    userId: null,
    action: newUser ? "create" : "update",
    changes: diffRecords(before, userAuditSnapshot(db, userId)),
  });
}

function matchesLogout(subject: string | null, sid: string | null) {
  return and(
    subject
      ? or(
          isNull(oidcLogoutReceipts.subject),
          eq(oidcLogoutReceipts.subject, subject),
        )
      : isNull(oidcLogoutReceipts.subject),
    sid
      ? or(isNull(oidcLogoutReceipts.sid), eq(oidcLogoutReceipts.sid, sid))
      : isNull(oidcLogoutReceipts.sid),
  );
}

export function signIn(
  db: LedgerDb,
  settings: AuthenticationSnapshot,
  subject: string,
  sid: string | null,
  claims: JWTPayload,
  startedAt: number,
) {
  const receipt = db
    .select({ id: oidcLogoutReceipts.id })
    .from(oidcLogoutReceipts)
    .where(
      and(
        eq(oidcLogoutReceipts.configuration, settings.identity),
        gte(oidcLogoutReceipts.receivedAt, startedAt),
        matchesLogout(subject, sid),
      ),
    )
    .get();
  if (receipt) throw new SignInRejected("provider_logout_receipt");

  const existing = db
    .select({ user: users })
    .from(oidcIdentities)
    .innerJoin(users, eq(users.id, oidcIdentities.userId))
    .where(
      and(
        eq(oidcIdentities.issuer, settings.stored.authority),
        eq(oidcIdentities.subject, subject),
      ),
    )
    .get();
  const user =
    existing?.user ?? provisionAccount(db, settings, subject, claims);
  if (user.disabled) throw new SignInRejected("account_disabled_or_removed");
  if (
    user.oidcManagedBy === settings.stored.authority &&
    settings.stored.jitEnabled
  )
    syncGroups(db, settings, user.id, claims, !existing);
  return createSession(db, user.id, {
    oidcConfiguration: settings.identity,
    oidcSubject: subject,
    oidcSid: sid,
  });
}

export function receiveLogout(
  db: LedgerDb,
  settings: AuthenticationSnapshot,
  logout: { subject: string | null; sid: string | null; jti: string },
) {
  db.transaction(
    (tx) => {
      const current = readAuthentication(tx);
      if (!current.enabled || current.revision !== settings.revision)
        throw new Error("OIDC settings changed.");
      const now = Date.now();
      tx.delete(oidcLogoutReceipts)
        .where(lt(oidcLogoutReceipts.expiresAt, now))
        .run();
      const id = digest(JSON.stringify([settings.identity, logout.jti]));
      const receipt = tx
        .insert(oidcLogoutReceipts)
        .values({
          id,
          configuration: settings.identity,
          subject: logout.subject,
          sid: logout.sid,
          receivedAt: now,
          expiresAt: now + 24 * 60 * 60_000,
        })
        .onConflictDoNothing()
        .returning({ id: oidcLogoutReceipts.id })
        .get();
      if (!receipt) return;
      const result = tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.oidcConfiguration, settings.identity),
            logout.subject
              ? eq(sessions.oidcSubject, logout.subject)
              : undefined,
            logout.sid ? eq(sessions.oidcSid, logout.sid) : undefined,
          ),
        )
        .returning({ id: sessions.id })
        .all();
      if (result.length)
        recordAudit(tx, {
          recordType: "settings",
          recordId: "authentication",
          userId: null,
          action: "update",
          changes: [
            {
              field: "oidcBackchannelLogout",
              before: null,
              after: result.length,
            },
          ],
        });
    },
    { behavior: "immediate" },
  );
}
