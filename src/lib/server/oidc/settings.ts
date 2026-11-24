import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import {
  authenticationSettings,
  groups,
  oidcAttempts,
  sessions,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import {
  keepsASuperuser,
  PROTECTED_GROUP,
  type SuperuserChange,
} from "../admin/access.js";
import { diffRecords, recordAudit } from "../audit.js";

const id = z.number().int().positive();
const name = z.string().trim().max(80);
const claim = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const reservedClaims = new Set(
  "sub iss aud exp iat nbf nonce sid auth_time email email_verified preferred_username name azp acr amr at_hash c_hash".split(
    " ",
  ),
);
const settingsSchema = z.object({
  oidcEnabled: z.boolean(),
  internalAuthenticationEnabled: z.boolean(),
  displayName: name,
  authority: z.string().trim().max(2048),
  clientId: z.string().trim().max(256),
  recoveryUserIds: z.array(id),
  additionalScopes: z.string().trim().max(1300),
  jitEnabled: z.boolean(),
  requireVerifiedEmail: z.boolean(),
  defaultGroupId: id.nullable(),
  groupsClaim: claim.refine(
    (value) => !reservedClaims.has(value.toLowerCase()),
    "Select a claim that does not contain identity or token metadata.",
  ),
  groupMappings: z
    .array(
      z.object({
        externalGroup: z
          .string()
          .max(256)
          .refine((value) => value.trim().length > 0),
        groupId: id,
      }),
    )
    .max(50),
});

export class AuthenticationSettingsError extends Error {}
export class AuthenticationSettingsConflict extends AuthenticationSettingsError {}

export type AuthenticationSettings = z.infer<typeof settingsSchema>;
const defaults: AuthenticationSettings = {
  oidcEnabled: false,
  internalAuthenticationEnabled: true,
  displayName: "",
  authority: "",
  clientId: "",
  recoveryUserIds: [],
  additionalScopes: "",
  jitEnabled: false,
  requireVerifiedEmail: true,
  defaultGroupId: null,
  groupsClaim: "groups",
  groupMappings: [],
};

type Deployment = Record<string, string | undefined>;
export type AuthenticationSnapshot = ReturnType<typeof readAuthentication>;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function readAuthentication(
  db: LedgerDb,
  env: Deployment = process.env,
) {
  const saved = db
    .select()
    .from(authenticationSettings)
    .where(eq(authenticationSettings.id, 1))
    .get();
  const recoveryMode = /^(true|1)$/i.test(
    env.OIDC_RECOVERY_MODE ?? env.Auth__RecoveryMode ?? "",
  );
  const stored = saved?.configuration ?? defaults;
  return {
    stored,
    revision: saved?.revision ?? "",
    encryptedSecret: saved?.encryptedSecret ?? null,
    recoveryMode,
    enabled: stored.oidcEnabled && !recoveryMode,
    internalEnabled: stored.internalAuthenticationEnabled || recoveryMode,
    displayName: stored.displayName || "SSO",
    identity: digest(JSON.stringify([stored.authority, stored.clientId])),
  };
}

export function allowsPassword(
  settings: AuthenticationSnapshot,
  userId: number,
) {
  return (
    settings.internalEnabled || settings.stored.recoveryUserIds.includes(userId)
  );
}

export function keepsRecoveryAdministrator(
  db: LedgerDb,
  change: SuperuserChange,
) {
  const { stored } = readAuthentication(db);
  return (
    stored.internalAuthenticationEnabled ||
    keepsASuperuser(db, change, stored.recoveryUserIds)
  );
}

export function allowedProviderUrl(value: string | URL): URL {
  const url = new URL(value);
  const loopback =
    ["localhost", "[::1]"].includes(url.hostname) ||
    (/^127\./.test(url.hostname) && /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AuthenticationSettingsError(
      "Use HTTPS. HTTP is allowed only on localhost.",
    );
  }
  return url;
}

export function publicOrigin(env: Deployment): URL {
  const value = env.PUBLIC_BASE_URL || env.ORIGIN;
  if (!value)
    throw new AuthenticationSettingsError(
      "Set PUBLIC_BASE_URL or ORIGIN to the public URL before enabling OIDC.",
    );
  const url = allowedProviderUrl(value);
  if (
    url.pathname !== "/" ||
    url.search ||
    (env.ORIGIN && new URL(env.ORIGIN).origin !== url.origin)
  ) {
    throw new AuthenticationSettingsError(
      "The public URL must be an origin and match ORIGIN when both are set.",
    );
  }
  return url;
}

export function scopes(value: string) {
  const extra = value.split(" ").filter(Boolean);
  if (
    extra.length > 10 ||
    extra.some(
      (scope) =>
        !/^[!#-\x5b\x5d-~]{1,128}$/.test(scope) || scope === "offline_access",
    )
  ) {
    throw new AuthenticationSettingsError(
      "Enter up to 10 space-separated scopes. Quotes, backslashes, and offline_access are disallowed.",
    );
  }
  return [...new Set(["openid", "profile", "email", ...extra])];
}

function protectionKey(env: Deployment, create = false): Buffer {
  const path = `${env.DATABASE_PATH || "./data/akaun.db"}.oidc-key`;
  try {
    const key = readFileSync(path);
    if (key.length !== 32)
      throw new AuthenticationSettingsError(
        "The saved OIDC key is invalid. Restore the original key file.",
      );
    return key;
  } catch (cause) {
    if (cause instanceof AuthenticationSettingsError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw new AuthenticationSettingsError(
        "Akaun could not read its OIDC key file.",
      );
    if (!create)
      throw new AuthenticationSettingsError(
        "Restore Akaun’s OIDC key file or re-enter the provider client secret.",
      );
  }

  // Publish the complete key atomically so concurrent processes share the same key.
  const key = randomBytes(32);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, key, { mode: 0o600, flag: "wx" });
    linkSync(temporary, path);
    return key;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      return protectionKey(env);
    throw new AuthenticationSettingsError(
      "Akaun could not save its OIDC key beside the database.",
    );
  } finally {
    rmSync(temporary, { force: true });
  }
}

function encryptSecret(secret: string, env: Deployment) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", protectionKey(env, true), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

export function clientSecret(
  settings: AuthenticationSnapshot,
  env: Deployment,
) {
  if (!settings.encryptedSecret)
    throw new AuthenticationSettingsError(
      "No OIDC client secret is configured.",
    );
  const payload = Buffer.from(settings.encryptedSecret, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    protectionKey(env),
    payload.subarray(0, 12),
  );
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([
    decipher.update(payload.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

export function saveAuthentication(
  db: LedgerDb,
  input: unknown,
  revision: string,
  secret: string,
  actor: number,
  actorSession: string,
  env: Deployment,
) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success)
    throw new AuthenticationSettingsError(parsed.error.issues[0].message);
  if ((secret && !secret.trim()) || secret.length > 4096)
    throw new AuthenticationSettingsError(
      "Enter a non-empty client secret of at most 4096 characters.",
    );
  const next = parsed.data;
  scopes(next.additionalScopes);
  if (!next.oidcEnabled) next.jitEnabled = false;
  if (next.oidcEnabled) {
    publicOrigin(env);
    const authority = allowedProviderUrl(next.authority);
    if (authority.search || !next.clientId)
      throw new AuthenticationSettingsError(
        "Enter an issuer URL without a query and a client ID.",
      );
  }

  db.transaction(
    (tx) => {
      const previous = readAuthentication(tx, env);
      if (previous.recoveryMode)
        throw new AuthenticationSettingsError(
          "Authentication settings are read-only in recovery mode.",
        );
      if (revision !== previous.revision)
        throw new AuthenticationSettingsConflict(
          "Authentication settings changed. Reload and try again.",
        );
      const selectableGroups = tx.select().from(groups).all();
      if (next.jitEnabled) {
        const group = selectableGroups.find(
          (candidate) => candidate.id === next.defaultGroupId,
        );
        if (!group || group.name === PROTECTED_GROUP || group.isSuperuser)
          throw new AuthenticationSettingsError(
            "Select an existing, unprotected default group.",
          );
        if (
          next.groupMappings.some(
            ({ groupId }) =>
              !selectableGroups.some((group) => group.id === groupId),
          )
        )
          throw new AuthenticationSettingsError(
            "Select an existing group for each mapping.",
          );
        if (
          new Set(
            next.groupMappings.map((mapping) =>
              JSON.stringify([mapping.externalGroup, mapping.groupId]),
            ),
          ).size !== next.groupMappings.length
        )
          throw new AuthenticationSettingsError(
            "Remove duplicate group mappings.",
          );
      }
      next.recoveryUserIds = [...new Set(next.recoveryUserIds)];
      const accounts = tx.select().from(users).all();
      const currentSession = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, actorSession))
        .get();
      if (
        !currentSession ||
        currentSession.userId !== actor ||
        currentSession.expiresAt <= new Date().toISOString() ||
        !keepsASuperuser(tx, undefined, [actor])
      )
        throw new AuthenticationSettingsError(
          "Sign in with an administrator account to change authentication settings.",
        );
      if (
        next.recoveryUserIds.some(
          (userId) =>
            !accounts.some(
              (user) => user.id === userId && !user.oidcManagedBy,
            ) || !keepsASuperuser(tx, undefined, [userId]),
        )
      )
        throw new AuthenticationSettingsError(
          "Recovery accounts must be enabled local administrators.",
        );
      if (!next.internalAuthenticationEnabled) {
        if (!next.oidcEnabled || !next.recoveryUserIds.length)
          throw new AuthenticationSettingsError(
            "Disabling internal authentication requires OIDC and a recovery administrator.",
          );
        if (
          currentSession.oidcConfiguration !==
            digest(JSON.stringify([next.authority, next.clientId])) &&
          !next.recoveryUserIds.includes(actor)
        )
          throw new AuthenticationSettingsError(
            "Select your account as a recovery administrator or sign in with OIDC first.",
          );
      }

      const changedProvider =
        next.authority !== previous.stored.authority ||
        next.clientId !== previous.stored.clientId;
      let sameSecret = false;
      if (secret && !changedProvider && previous.encryptedSecret) {
        try {
          sameSecret = clientSecret(previous, env) === secret;
        } catch {
          // A replacement credential can restore access after a key change.
        }
      }
      const changedSecret = !!secret && !sameSecret;
      const encryptedSecret = changedSecret
        ? encryptSecret(secret, env)
        : changedProvider
          ? null
          : previous.encryptedSecret;
      if (next.oidcEnabled) clientSecret({ ...previous, encryptedSecret }, env);
      const changes = diffRecords(previous.stored, next);
      if (!changes.length && !changedSecret) return;
      const record = {
        revision: randomUUID(),
        configuration: next,
        encryptedSecret,
      };
      tx.insert(authenticationSettings)
        .values({ id: 1, ...record })
        .onConflictDoUpdate({ target: authenticationSettings.id, set: record })
        .run();
      tx.delete(oidcAttempts).run();
      if (!next.oidcEnabled || changedProvider || changedSecret)
        tx.delete(sessions).where(isNotNull(sessions.oidcConfiguration)).run();
      if (!next.internalAuthenticationEnabled)
        tx.delete(sessions)
          .where(
            and(
              isNull(sessions.oidcConfiguration),
              notInArray(sessions.userId, next.recoveryUserIds),
            ),
          )
          .run();
      recordAudit(tx, {
        recordType: "settings",
        recordId: "authentication",
        action: "update",
        userId: actor,
        changes: [
          ...changes,
          ...(changedSecret
            ? [{ field: "clientSecret", before: null, after: "changed" }]
            : []),
        ],
      });
    },
    { behavior: "immediate" },
  );
}
