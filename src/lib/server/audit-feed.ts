import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { auditLog } from "./db/schema.js";
import {
  isRecordType,
  parseChanges,
  type AuditAction,
  type AuditVia,
  type FieldChange,
  type RecordType,
} from "./audit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

/**
 * The Audit Log page: every entry, across every kind of record, newest first.
 * Paged by id (keyset), never by offset, so a page stays put while new entries
 * arrive at the top.
 */

/** `agent` is any change that came through a token or a connected app. */
export type AuditViaFilter = AuditVia | "agent";

export type AuditFilters = {
  userId?: number;
  via?: AuditViaFilter;
  /** A token id or an OAuth grant id. */
  credentialId?: string;
  clientId?: string;
  recordTypes?: RecordType[];
  recordId?: string;
  action?: AuditAction;
  /** Instants (ISO 8601), so the viewer's time zone decides what a day is. */
  from?: string;
  to?: string;
  requestId?: string;
};

export type AuditFeedEntry = {
  id: number;
  recordType: RecordType;
  recordId: string;
  recordLabel: string | null;
  action: AuditAction;
  changes: FieldChange[] | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
  userId: number | null;
  actorName: string | null;
  via: AuditVia;
  credentialId: string | null;
  clientId: string | null;
  credentialLabel: string | null;
  requestId: string | null;
  operation: string | null;
  /** Where the record can be opened now, or null when it is gone. */
  href: string | null;
};

const VIAS: readonly AuditViaFilter[] = [
  "session",
  "pat",
  "oauth",
  "system",
  "agent",
];
const ACTIONS: readonly AuditAction[] = ["create", "update", "delete"];

/** `created_at` is stored as UTC `YYYY-MM-DD HH:MM:SS`. */
function storedInstant(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().replace("T", " ").slice(0, 19);
}

/** Reads the filters from a URL's query. Anything unrecognised is ignored. */
export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  const user = Number(params.get("user"));
  if (Number.isInteger(user) && user > 0) filters.userId = user;
  const via = params.get("via");
  if (via && (VIAS as readonly string[]).includes(via))
    filters.via = via as AuditViaFilter;
  const credential = params.get("credential")?.trim();
  if (credential) filters.credentialId = credential.slice(0, 200);
  const client = params.get("client")?.trim();
  if (client) filters.clientId = client.slice(0, 200);
  const types = params.getAll("type").filter(isRecordType);
  if (types.length) filters.recordTypes = types;
  const recordId = params.get("record")?.trim();
  if (recordId) filters.recordId = recordId.slice(0, 200);
  const action = params.get("action");
  if (action && (ACTIONS as readonly string[]).includes(action))
    filters.action = action as AuditAction;
  const from = params.get("from");
  if (from && storedInstant(from)) filters.from = from;
  const to = params.get("to");
  if (to && storedInstant(to)) filters.to = to;
  const request = params.get("request")?.trim();
  if (request) filters.requestId = request.slice(0, 200);
  return filters;
}

function conditions(filters: AuditFilters): SQL[] {
  const where: SQL[] = [];
  if (filters.userId !== undefined)
    where.push(eq(auditLog.userId, filters.userId));
  if (filters.via === "agent")
    where.push(inArray(auditLog.via, ["pat", "oauth"]));
  else if (filters.via) where.push(eq(auditLog.via, filters.via));
  if (filters.credentialId)
    where.push(eq(auditLog.credentialId, filters.credentialId));
  if (filters.clientId) where.push(eq(auditLog.clientId, filters.clientId));
  if (filters.recordTypes?.length)
    where.push(inArray(auditLog.recordType, filters.recordTypes));
  if (filters.recordId) where.push(eq(auditLog.recordId, filters.recordId));
  if (filters.action) where.push(eq(auditLog.action, filters.action));
  const from = filters.from && storedInstant(filters.from);
  if (from) where.push(gte(auditLog.createdAt, from));
  const to = filters.to && storedInstant(filters.to);
  if (to) where.push(lte(auditLog.createdAt, to));
  if (filters.requestId) where.push(eq(auditLog.requestId, filters.requestId));
  return where;
}

type Row = typeof auditLog.$inferSelect;

function entryOf(row: Row, href: string | null): AuditFeedEntry {
  return {
    id: row.id,
    recordType: row.recordType as RecordType,
    recordId: row.recordId,
    recordLabel: row.recordLabel,
    action: row.action as AuditAction,
    changes: parseChanges(row.changes),
    createdAt: row.createdAt,
    userId: row.userId,
    actorName: row.actorName,
    via: row.via as AuditVia,
    credentialId: row.credentialId,
    clientId: row.clientId,
    credentialLabel: row.credentialLabel,
    requestId: row.requestId,
    operation: row.operation,
    href,
  };
}

export const AUDIT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * One page of the log. `before` pages back through older entries; `after`
 * returns only entries newer than an id (what the live view asks for), oldest
 * of them last so they can be put on top in order.
 */
export function listAuditLog(
  db: Db,
  filters: AuditFilters,
  page: { before?: number; after?: number; limit?: number } = {},
): { entries: AuditFeedEntry[]; nextCursor: number | null } {
  const limit = Math.min(
    Math.max(1, Math.floor(page.limit ?? AUDIT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );
  const where = conditions(filters);
  if (page.before !== undefined) where.push(lt(auditLog.id, page.before));
  if (page.after !== undefined) where.push(gt(auditLog.id, page.after));

  // The newest first in both cases; `after` is capped at a page too, and a
  // page that falls that far behind reloads instead.
  const rows = db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1)
    .all();
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const links = resolveAuditLinks(db, shown);
  return {
    entries: shown.map((row) => entryOf(row, links.get(row.id) ?? null)),
    nextCursor: more ? shown[shown.length - 1].id : null,
  };
}

export function getAuditEntry(db: Db, id: number): AuditFeedEntry | null {
  const row = db.select().from(auditLog).where(eq(auditLog.id, id)).get();
  if (!row) return null;
  return entryOf(row, resolveAuditLinks(db, [row]).get(row.id) ?? null);
}

/** The other entries one request wrote — everything one tool call changed. */
export function sameRequestEntries(
  db: Db,
  entry: Pick<AuditFeedEntry, "id" | "requestId">,
  limit = 50,
): { entries: AuditFeedEntry[]; total: number } {
  if (!entry.requestId) return { entries: [], total: 0 };
  const where = and(
    eq(auditLog.requestId, entry.requestId),
    sql`${auditLog.id} <> ${entry.id}`,
  );
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(where)
      .get()?.n ?? 0;
  const rows = db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(asc(auditLog.id))
    .limit(limit)
    .all();
  const links = resolveAuditLinks(db, rows);
  return {
    entries: rows.map((row) => entryOf(row, links.get(row.id) ?? null)),
    total,
  };
}

export type AuditFilterOptions = {
  actors: { userId: number; name: string }[];
  tokens: { credentialId: string; label: string }[];
  apps: { clientId: string; label: string }[];
};

/**
 * Who and what appears in the log, for the filter menus — including deleted
 * users, tokens and apps, by the names they had when they last wrote.
 */
export function auditFilterOptions(db: Db): AuditFilterOptions {
  const actors = db
    .select({
      userId: auditLog.userId,
      name: sql<string>`max(${auditLog.actorName})`,
    })
    .from(auditLog)
    .where(isNotNull(auditLog.userId))
    .groupBy(auditLog.userId)
    .all()
    .filter(
      (row): row is { userId: number; name: string } => row.userId !== null,
    )
    .map((row) => ({
      userId: row.userId,
      name: row.name ?? `User ${row.userId}`,
    }));
  const tokens = db
    .select({
      credentialId: auditLog.credentialId,
      label: sql<string>`max(${auditLog.credentialLabel})`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.via, "pat"), isNotNull(auditLog.credentialId)))
    .groupBy(auditLog.credentialId)
    .all()
    .map((row) => ({
      credentialId: row.credentialId!,
      label: row.label ?? `Token ${row.credentialId}`,
    }));
  const apps = db
    .select({
      clientId: auditLog.clientId,
      label: sql<string>`max(${auditLog.credentialLabel})`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.via, "oauth"), isNotNull(auditLog.clientId)))
    .groupBy(auditLog.clientId)
    .all()
    .map((row) => ({
      clientId: row.clientId!,
      label: row.label ?? "Connected app",
    }));
  const byName =
    <T>(key: (t: T) => string) =>
    (a: T, b: T) =>
      key(a).localeCompare(key(b));
  return {
    actors: actors.sort(byName((a) => a.name)),
    tokens: tokens.sort(byName((t) => t.label)),
    apps: apps.sort(byName((a) => a.label)),
  };
}

// ── Links ───────────────────────────────────────────────────────────────────

/** Ids of one table that still exist, from a list of text ids. */
function existing(db: Db, table: string, ids: string[]): Set<string> {
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  if (!numeric.length) return new Set();
  return new Set(
    db
      .all<{ id: number }>(
        sql`SELECT id FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
          numeric.map((id) => sql`${Number(id)}`),
          sql`, `,
        )})`,
      )
      .map((row) => String(row.id)),
  );
}

/** id → `/feature/id` for the record pages that exist. */
const PAGE_OF: Partial<Record<RecordType, [table: string, path: string]>> = {
  record: ["ledger_records", "/records"],
  account: ["accounts", "/accounts"],
  contact: ["contacts", "/contacts"],
  invoice: ["invoices", "/invoices"],
  quotation: ["quotations", "/quotations"],
  import_profile: ["import_profiles", "/settings/import-profiles"],
};

/**
 * Where each entry's record can be opened now: one existence query per kind,
 * not per entry. A record that has since been deleted has no link; its entry
 * still reads by the label it was written with.
 */
export function resolveAuditLinks(
  db: Db,
  rows: Pick<Row, "id" | "recordType" | "recordId">[],
): Map<number, string> {
  const links = new Map<number, string>();
  const byType = new Map<string, Pick<Row, "id" | "recordId">[]>();
  for (const row of rows)
    byType.set(row.recordType, [...(byType.get(row.recordType) ?? []), row]);

  for (const [type, group] of byType) {
    const ids = [...new Set(group.map((row) => row.recordId))];
    const page = PAGE_OF[type as RecordType];
    if (page) {
      const live = existing(db, page[0], ids);
      for (const row of group)
        if (live.has(row.recordId))
          links.set(row.id, `${page[1]}/${row.recordId}`);
      continue;
    }
    switch (type as RecordType) {
      case "reconciliation": {
        const numeric = ids.filter((id) => /^\d+$/.test(id)).map(Number);
        if (!numeric.length) break;
        const statements = db.all<{ id: number; accountId: number | null }>(
          sql`SELECT id, account_id AS accountId FROM bank_statements WHERE id IN (${sql.join(
            numeric.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
        const accountOf = new Map(
          statements.map((s) => [String(s.id), s.accountId]),
        );
        for (const row of group) {
          const accountId = accountOf.get(row.recordId);
          if (accountId != null)
            links.set(
              row.id,
              `/accounts/${accountId}/reconcile/${row.recordId}`,
            );
        }
        break;
      }
      case "settlement": {
        // A settlement opens on the payment that made it.
        const numeric = ids.filter((id) => /^\d+$/.test(id)).map(Number);
        if (!numeric.length) break;
        const payments = db.all<{ id: number; recordId: number }>(
          sql`SELECT s.id AS id, m.record_id AS recordId FROM settlements s JOIN ledger_movements m ON m.id = s.payment_movement_id WHERE s.id IN (${sql.join(
            numeric.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
        const recordOf = new Map(
          payments.map((p) => [String(p.id), p.recordId]),
        );
        for (const row of group) {
          const recordId = recordOf.get(row.recordId);
          if (recordId != null) links.set(row.id, `/records/${recordId}`);
        }
        break;
      }
      case "import_job": {
        const jobs = new Set(
          db
            .all<{ id: string }>(
              sql`SELECT id FROM import_queue WHERE id IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
            .map((job) => job.id),
        );
        for (const row of group)
          if (jobs.has(row.recordId))
            links.set(row.id, `/import/${row.recordId}`);
        break;
      }
      case "user":
      case "group":
      case "access_token":
        for (const row of group) links.set(row.id, "/users-groups");
        break;
      case "settings":
      case "llm_provider":
        for (const row of group) links.set(row.id, "/settings");
        break;
      default:
        break;
    }
  }
  return links;
}
