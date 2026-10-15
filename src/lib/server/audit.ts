import { and, desc, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { auditLog, users } from "./db/schema.js";
import type { ResourceName } from "./permissions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

export type RecordType =
  // Kept: pre-upgrade entries carry these, and the audit trail of a migrated
  // expense or income must keep resolving after the ledger upgrade. New ledger
  // writes use 'record'.
  | "expense"
  | "income"
  | "contact"
  | "quotation"
  | "invoice"
  | "reconciliation"
  // A ledger record of any kind — expense, income, transfer, payment, opening
  // balance, invoice issue or journal entry.
  | "record"
  | "account"
  // Settling is the one action that changes a record nobody edited, so it is
  // audited in its own right (FR-041).
  | "settlement"
  // A saved way of reading a document (006 FR-038).
  | "import_profile";
export type AuditAction = "create" | "update" | "delete";

/**
 * Which ability's `view` gates reading each kind of audit trail. The trail is
 * read from a page the user already had to be allowed to open.
 *
 * 'expense' and 'income' survive for entries written before the ledger
 * upgrade; every ledger write since is a 'record'. All three are gated on
 * `records`: there is one ability for every kind of record.
 */
export const AUDIT_RESOURCE: Record<RecordType, ResourceName> = {
  expense: "records",
  income: "records",
  record: "records",
  account: "accounts",
  settlement: "records",
  contact: "contacts",
  quotation: "quotations",
  invoice: "invoices",
  reconciliation: "reconciliation",
  // Anyone who may see the import screen may read how a profile changed;
  // changing one needs import.change (006 FR-045).
  import_profile: "import",
};
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

export function recordAudit(
  db: Db,
  opts: {
    recordType: RecordType;
    recordId: number;
    userId: number | null;
    action: AuditAction;
    changes?: FieldChange[];
  },
): void {
  // Don't log a save that changed nothing.
  if (opts.action === "update" && (!opts.changes || opts.changes.length === 0))
    return;

  db.insert(auditLog)
    .values({
      recordType: opts.recordType,
      recordId: opts.recordId,
      userId: opts.userId,
      action: opts.action,
      changes:
        opts.changes && opts.changes.length > 0
          ? JSON.stringify(opts.changes)
          : null,
    })
    .run();
}

export type AuditEntry = {
  id: number;
  action: AuditAction;
  changes: FieldChange[] | null;
  createdAt: string;
  userId: number | null;
  userName: string | null;
};

export function getAuditTrail(
  db: Db,
  recordType: RecordType,
  recordId: number,
): AuditEntry[] {
  const rows = db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      changes: auditLog.changes,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
      userName: users.name,
      username: users.username,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(
      and(eq(auditLog.recordType, recordType), eq(auditLog.recordId, recordId)),
    )
    .orderBy(desc(auditLog.id))
    .all();

  return rows.map((r) => ({
    id: r.id,
    action: r.action as AuditAction,
    changes: r.changes ? (JSON.parse(r.changes) as FieldChange[]) : null,
    createdAt: r.createdAt,
    userId: r.userId,
    userName: r.userName ?? r.username ?? null,
  }));
}
