import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { auditLog } from "./db/schema.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { currentAuditScope, type AuditVia } from "./audit-context.js";
import { auditEvents } from "./audit-events.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

export type RecordType =
  | "contact"
  | "quotation"
  | "invoice"
  // A bank statement. Its lines and matches are filed here; an allocation that
  // belongs to a ledger record is filed under that 'record'.
  | "reconciliation"
  // A ledger record of any kind — expense, income, transfer, payment, opening
  // balance, invoice issue or journal entry.
  | "record"
  | "account"
  // Settling is the one action that changes a record nobody edited, so it is
  // audited in its own right (FR-041).
  | "settlement"
  // A saved way of reading a document (006 FR-038).
  | "import_profile"
  // Administration. Only the Audit Log shows these — see AUDIT_PERMISSION.
  | "user"
  | "group"
  | "access_token"
  | "oauth_grant"
  // One row per Settings section saved; the id is the section's name.
  | "settings"
  | "llm_provider"
  | "import_job";
export type AuditAction = "create" | "update" | "delete";
export type { AuditVia };

/**
 * Which permission gates reading each kind of audit trail on its own record's
 * page. The trail is read from a page the user already had to be allowed to
 * open. The administrative kinds have no such page, so they need `audit.read`,
 * which is never delegable: a token or an app cannot ask for them.
 *
 * The Audit Log page itself shows every kind, and needs `audit.read`.
 */
export const AUDIT_PERMISSION: Record<RecordType, LeafPermission> = {
  record: "records.read",
  account: "accounts.read",
  settlement: "records.read",
  contact: "contacts.read",
  quotation: "quotations.read",
  invoice: "invoices.read",
  reconciliation: "reconciliation.read",
  // Anyone who may see the import screen may read how a profile changed;
  // changing one needs import.change (006 FR-045).
  import_profile: "import.read",
  user: "audit.read",
  group: "audit.read",
  access_token: "audit.read",
  oauth_grant: "audit.read",
  settings: "audit.read",
  llm_provider: "audit.read",
  import_job: "audit.read",
};

export const RECORD_TYPES = Object.keys(AUDIT_PERMISSION) as RecordType[];

export function isRecordType(value: string): value is RecordType {
  return Object.hasOwn(AUDIT_PERMISSION, value);
}

export type FieldChange = { field: string; before: unknown; after: unknown };

// Bookkeeping columns, not user-visible edits — never worth showing in a diff.
const IGNORED_FIELDS = new Set([
  "id",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
]);

/**
 * Shallow-compares two flat row objects and returns the fields whose value changed.
 * Arrays/nested values (e.g. a contact's `roles`, a record's movements) are
 * compared as opaque JSON — the entry shows the old array vs. the new one, not an
 * itemized diff.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const b = before?.[key] ?? null;
    const a = after?.[key] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a))
      changes.push({ field: key, before: b, after: a });
  }
  return changes;
}

/**
 * Secrets never reach the log, whatever the caller passed. A field is matched
 * by its last segment (`autoImport.apiKey`), and a nested object is searched
 * too, so a whole-row snapshot of a user or a provider is safe to pass.
 */
const SECRET_FIELDS = new Set([
  "password",
  "passwordHash",
  "tokenHash",
  "secretHash",
  "apiKey",
  "oauthCredentials",
  "bearerToken",
  "token",
]);
export const REDACTED = "[redacted]";

function isSecretField(field: string): boolean {
  return SECRET_FIELDS.has(field.split(/[.:]/).at(-1) ?? field);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value))
      out[key] =
        isSecretField(key) && inner != null && inner !== ""
          ? REDACTED
          : redactValue(inner);
    return out;
  }
  return value;
}

export function redactChanges(changes: FieldChange[]): FieldChange[] {
  return changes.map((change) =>
    isSecretField(change.field)
      ? {
          field: change.field,
          before:
            change.before == null || change.before === ""
              ? change.before
              : REDACTED,
          after:
            change.after == null || change.after === ""
              ? change.after
              : REDACTED,
        }
      : {
          field: change.field,
          before: redactValue(change.before),
          after: redactValue(change.after),
        },
  );
}

const SETTINGS_SECTION_LABELS: Record<string, string> = {
  general: "General settings",
  ledger: "Ledger settings",
  company: "Company details",
  pdf: "Document layout",
  numbering: "Numbering",
  intelligence: "AI & auto import",
  accounts: "Default accounts",
};

/** The `label` column of a one-row query, or null. */
function labelOf(db: Db, query: SQL): string | null {
  return db.all<{ label: string | null }>(query)[0]?.label ?? null;
}

/** What a record of this kind is called right now, or null when it is gone. */
function currentLabel(db: Db, type: RecordType, id: string): string | null {
  const one = (query: SQL) => labelOf(db, query);
  switch (type) {
    case "record":
      return one(
        sql`SELECT trim(coalesce(record_number, '') || ' ' || description) AS label FROM ledger_records WHERE id = ${id}`,
      );
    case "account":
      return one(sql`SELECT name AS label FROM accounts WHERE id = ${id}`);
    case "contact":
      return one(
        sql`SELECT legal_name AS label FROM contacts WHERE id = ${id}`,
      );
    case "invoice":
      return one(
        sql`SELECT invoice_number AS label FROM invoices WHERE id = ${id}`,
      );
    case "quotation":
      return one(
        sql`SELECT quotation_number AS label FROM quotations WHERE id = ${id}`,
      );
    case "reconciliation":
      return one(
        sql`SELECT original_filename AS label FROM bank_statements WHERE id = ${id}`,
      );
    case "import_profile":
      return one(
        sql`SELECT name AS label FROM import_profiles WHERE id = ${id}`,
      );
    case "user":
      return one(
        sql`SELECT coalesce(name, username) AS label FROM users WHERE id = ${id}`,
      );
    case "group":
      return one(sql`SELECT name AS label FROM groups WHERE id = ${id}`);
    case "access_token":
      return one(
        sql`SELECT name AS label FROM personal_access_tokens WHERE id = ${id}`,
      );
    case "oauth_grant":
      return one(
        sql`SELECT c.name AS label FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id WHERE g.id = ${id}`,
      );
    case "llm_provider":
      return one(sql`SELECT name AS label FROM llm_providers WHERE id = ${id}`);
    case "import_job":
      return one(
        sql`SELECT original_filename AS label FROM import_queue WHERE id = ${id}`,
      );
    case "settings":
      return SETTINGS_SECTION_LABELS[id] ?? id;
    case "settlement":
      return null;
  }
}

// Fields a deleted row's snapshot is named by, in order of preference.
const LABEL_FIELDS = [
  "name",
  "legalName",
  "invoiceNumber",
  "quotationNumber",
  "recordNumber",
  "description",
  "originalFilename",
  "username",
];

/** A deleted record's name, read back from the snapshot its delete carries. */
function labelFromChanges(changes: FieldChange[] | undefined): string | null {
  for (const field of LABEL_FIELDS) {
    const change = changes?.find((c) => c.field === field);
    const value = change?.before ?? change?.after;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** A lookup cached on the scope: one request often writes many entries. */
function cached(key: string, look: () => string | null): string | null {
  const cache = currentAuditScope().labelCache;
  if (!cache.has(key)) cache.set(key, look());
  return cache.get(key) ?? null;
}

function actorName(db: Db, userId: number | null): string | null {
  if (userId == null) return null;
  return cached(`user:${userId}`, () =>
    labelOf(
      db,
      sql`SELECT coalesce(name, username) AS label FROM users WHERE id = ${userId}`,
    ),
  );
}

function credentialLabel(
  db: Db,
  via: AuditVia,
  credentialId: string | null,
  clientId: string | null,
): string | null {
  if (via === "pat" && credentialId)
    return cached(`pat:${credentialId}`, () =>
      labelOf(
        db,
        sql`SELECT name AS label FROM personal_access_tokens WHERE id = ${credentialId}`,
      ),
    );
  if (via === "oauth" && clientId)
    return cached(`client:${clientId}`, () =>
      labelOf(
        db,
        sql`SELECT name AS label FROM oauth_clients WHERE id = ${clientId}`,
      ),
    );
  return null;
}

/**
 * Writes one audit entry, in the caller's transaction when given one.
 *
 * `userId` is who the change is credited to; how it arrived — the browser, a
 * personal access token or a connected app, and which one — comes from the
 * current audit scope (`audit-context.ts`), so no caller passes it. Names are
 * copied in as they are now (the actor, the token or app, the record), so the
 * log still reads after any of them is renamed or deleted.
 *
 * The log is append-only: nothing in the app deletes an entry.
 */
export function recordAudit(
  db: Db,
  opts: {
    recordType: RecordType;
    recordId: number | string;
    userId: number | null;
    action: AuditAction;
    changes?: FieldChange[];
    /** What to call the record, when its row does not say (or is gone). */
    label?: string | null;
  },
): void {
  // Don't log a save that changed nothing.
  if (opts.action === "update" && (!opts.changes || opts.changes.length === 0))
    return;

  const scope = currentAuditScope();
  const recordId = String(opts.recordId);
  const changes = opts.changes?.length ? redactChanges(opts.changes) : null;
  const label =
    opts.label ??
    currentLabel(db, opts.recordType, recordId) ??
    labelFromChanges(opts.changes);

  db.insert(auditLog)
    .values({
      recordType: opts.recordType,
      recordId,
      recordLabel: label || null,
      userId: opts.userId,
      actorName: actorName(db, opts.userId),
      via: scope.via,
      credentialId: scope.credentialId,
      clientId: scope.clientId,
      credentialLabel: credentialLabel(
        db,
        scope.via,
        scope.credentialId,
        scope.clientId,
      ),
      requestId: scope.requestId || null,
      operation: scope.operation,
      action: opts.action,
      changes: changes ? JSON.stringify(changes) : null,
    })
    .run();

  // bun:sqlite transactions are synchronous, so this runs after the caller's
  // transaction has committed (or rolled back — the page then finds nothing).
  queueMicrotask(() => auditEvents.emit("entry-added"));
}

export type AuditEntry = {
  id: number;
  action: AuditAction;
  changes: FieldChange[] | null;
  createdAt: string;
  userId: number | null;
  /** The actor's name when the entry was written. */
  userName: string | null;
  via: AuditVia;
  /** The token's or the app's name when the entry was written. */
  credentialLabel: string | null;
  operation: string | null;
};

export function parseChanges(json: string | null): FieldChange[] | null {
  return json ? (JSON.parse(json) as FieldChange[]) : null;
}

export function getAuditTrail(
  db: Db,
  recordType: RecordType,
  recordId: number | string,
): AuditEntry[] {
  const rows = db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      changes: auditLog.changes,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
      actorName: auditLog.actorName,
      via: auditLog.via,
      credentialLabel: auditLog.credentialLabel,
      operation: auditLog.operation,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.recordType, recordType),
        eq(auditLog.recordId, String(recordId)),
      ),
    )
    .orderBy(desc(auditLog.id))
    .all();

  return rows.map((r) => ({
    id: r.id,
    action: r.action as AuditAction,
    changes: parseChanges(r.changes),
    createdAt: r.createdAt,
    userId: r.userId,
    userName: r.actorName,
    via: r.via as AuditVia,
    credentialLabel: r.credentialLabel,
    operation: r.operation,
  }));
}
