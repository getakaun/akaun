import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How a change reached the books, for the audit log.
 *
 * The scope says how the request arrived; the `userId` a caller passes to
 * `recordAudit` says who the change is credited to. The two are kept apart on
 * purpose: an import confirm credits the person who confirmed it, while the
 * channel is still the request that confirmed it.
 *
 * A scope is opened by the request hook for every authenticated request and
 * again by `registerWrite` for each MCP write tool. Work with no scope —
 * the import worker, the auto-upgrade, a detached job wrapped in
 * `runAsSystem` — is recorded as `'system'`.
 *
 * This file imports nothing but `node:async_hooks`, so it is safe to load from
 * the MCP test preload.
 */
export type AuditVia = "session" | "pat" | "oauth" | "system";

export type AuditScope = {
  requestId: string;
  via: AuditVia;
  /** A personal access token id or OAuth grant id. */
  credentialId: string | null;
  /** The OAuth client id behind an 'oauth' write. */
  clientId: string | null;
  /** 'POST /api/records' or 'mcp:create_record'. */
  operation: string | null;
  /** Names looked up while writing this scope's entries, keyed by kind:id. */
  labelCache: Map<string, string | null>;
};

type ScopeLocals = {
  credential?:
    | { kind: "pat"; tokenId: number }
    | { kind: "oauth"; grantId: string; clientId: string };
};

const storage = new AsyncLocalStorage<AuditScope>();

function newScope(fields: Omit<AuditScope, "requestId" | "labelCache">) {
  return { ...fields, requestId: crypto.randomUUID(), labelCache: new Map() };
}

/** The scope of a request authenticated as `locals` describes. */
export function scopeFromLocals(
  locals: ScopeLocals,
  operation: string | null,
): AuditScope {
  const credential = locals.credential;
  if (credential?.kind === "pat")
    return newScope({
      via: "pat",
      credentialId: String(credential.tokenId),
      clientId: null,
      operation,
    });
  if (credential?.kind === "oauth")
    return newScope({
      via: "oauth",
      credentialId: credential.grantId,
      clientId: credential.clientId,
      operation,
    });
  return newScope({
    via: "session",
    credentialId: null,
    clientId: null,
    operation,
  });
}

export function runInAuditScope<T>(scope: AuditScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * Runs work that outlives its request — a statement extraction started with
 * `void` — as the system, so it is not credited to whatever channel happened
 * to start it.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(
    newScope({
      via: "system",
      credentialId: null,
      clientId: null,
      operation: null,
    }),
    fn,
  );
}

/**
 * The scope of the current async context. With none, a fresh system scope with
 * no request id — its cache would otherwise live, and go stale, forever.
 */
export function currentAuditScope(): AuditScope {
  return (
    storage.getStore() ?? {
      requestId: "",
      via: "system",
      credentialId: null,
      clientId: null,
      operation: null,
      labelCache: new Map(),
    }
  );
}
