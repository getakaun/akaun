import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema.js";
import {
  contacts,
  contactRoles,
  contactSearchText,
  accounts,
  importItems,
  importQueue,
  ledgerRecords,
  quotations,
  invoices,
} from "../db/schema.js";
import {
  EntityType,
  LedgerRecordKind,
  RoleLabels,
  EntityTypeLabels,
} from "$lib/enums.js";
import {
  upsertSearchText,
  searchTextExists,
  joinSearchText,
} from "../search-text.js";
import { recordAudit, diffRecords } from "../audit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<typeof schema> | BunSQLiteDatabase<any>;

export type ContactFilters = {
  role?: number;
  entityType?: number;
  search?: string;
  limit?: number;
  offset?: number;
};

export type ContactCreate = {
  entityType: number;
  legalName: string;
  registrationNo?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  remark?: string | null;
  roles?: number[];
};

export type ContactPatch = Partial<Omit<ContactCreate, "roles">>;

/** Lowercase, trim, collapse punctuation/whitespace — used for dedupe + matching. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchText(c: {
  legalName: string;
  registrationNo?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  return joinSearchText(c.legalName, c.registrationNo, c.email, c.phone);
}

/** Recomputes and upserts contact_search_text for one contact. Also used by the search-rebuild worker. */
export function reindexContact(
  db: Db,
  contactId: number,
  row: Parameters<typeof buildSearchText>[0],
) {
  const text = buildSearchText(row);
  upsertSearchText(
    db,
    contactSearchText,
    contactSearchText.contactId,
    contactSearchText.text,
    contactId,
    text,
  );
}

/** Resolve the role codes attached to a set of contacts → { [contactId]: number[] }. */
export function rolesForContacts(
  db: Db,
  ids: number[],
): Record<number, number[]> {
  if (ids.length === 0) return {};
  const rows = db
    .select()
    .from(contactRoles)
    .where(inArray(contactRoles.contactId, ids))
    .all();
  const map: Record<number, number[]> = {};
  for (const r of rows) {
    (map[r.contactId] ??= []).push(r.role);
  }
  return map;
}

function withLabels<T extends { entityType: number }>(c: T, roles: number[]) {
  return {
    ...c,
    roles,
    entityTypeLabel: EntityTypeLabels[c.entityType] ?? null,
    roleLabels: roles.map((r) => RoleLabels[r]).filter(Boolean),
  };
}

function contactConditions(filters: ContactFilters) {
  const { role, entityType, search } = filters;
  const conditions = [];
  if (entityType !== undefined)
    conditions.push(eq(contacts.entityType, entityType));
  if (role !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${contactRoles} WHERE ${contactRoles.contactId} = ${contacts.id} AND ${contactRoles.role} = ${role})`,
    );
  }
  if (search) {
    const term = `%${search}%`;
    conditions.push(
      searchTextExists(
        contactSearchText,
        contactSearchText.contactId,
        contactSearchText.text,
        contacts.id,
        term,
      ),
    );
  }

  return conditions;
}

export function countContacts(db: Db, filters: ContactFilters = {}): number {
  const conditions = contactConditions(filters);
  return (
    db
      .select({ total: sql<number>`count(*)` })
      .from(contacts)
      .where(conditions.length ? and(...conditions) : undefined)
      .get()?.total ?? 0
  );
}

export function listContacts(db: Db, filters: ContactFilters = {}) {
  const { limit = 200, offset = 0 } = filters;
  const conditions = contactConditions(filters);
  const rows = db
    .select()
    .from(contacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(contacts.legalName), asc(contacts.id))
    .limit(limit)
    .offset(offset)
    .all();

  const roleMap = rolesForContacts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => withLabels(r, roleMap[r.id] ?? []));
}

export function getContact(db: Db, id: number) {
  const contact = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!contact) return null;
  const roles = (rolesForContacts(db, [id])[id] ?? []).sort((a, b) => a - b);
  return withLabels(contact, roles);
}

export function getContactRoles(db: Db, id: number): number[] {
  return (rolesForContacts(db, [id])[id] ?? []).sort((a, b) => a - b);
}

/** Replace a contact's full role set with the given codes (may be empty). */
export function setContactRoles(db: Db, id: number, roles: number[]) {
  const unique = [...new Set(roles)];
  db.delete(contactRoles).where(eq(contactRoles.contactId, id)).run();
  if (unique.length > 0) {
    db.insert(contactRoles)
      .values(unique.map((role) => ({ contactId: id, role })))
      .run();
  }
  return unique.sort((a, b) => a - b);
}

export function createContact(
  db: Db,
  actingUserId: number,
  data: ContactCreate,
) {
  const row = db
    .insert(contacts)
    .values({
      entityType: data.entityType,
      legalName: data.legalName,
      registrationNo: data.registrationNo ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      remark: data.remark ?? null,
      createdBy: actingUserId,
      updatedBy: actingUserId,
    })
    .returning()
    .get()!;

  const roles = setContactRoles(db, row.id, data.roles ?? []);
  reindexContact(db, row.id, row);
  recordAudit(db, {
    recordType: "contact",
    recordId: row.id,
    userId: actingUserId,
    action: "create",
  });
  return withLabels(row, roles);
}

export function updateContact(
  db: Db,
  id: number,
  actingUserId: number,
  patch: ContactPatch,
) {
  const existing = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!existing) return null;

  const updated = db
    .update(contacts)
    .set({
      ...patch,
      updatedBy: actingUserId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(contacts.id, id))
    .returning()
    .get()!;

  reindexContact(db, id, updated);
  recordAudit(db, {
    recordType: "contact",
    recordId: id,
    userId: actingUserId,
    action: "update",
    changes: diffRecords(existing, updated),
  });
  const roles = getContactRoles(db, id);
  return withLabels(updated, roles);
}

/** Is this contact named by any record or document? Blocks hard delete (FR-009a). */
export function isContactReferenced(db: Db, id: number): boolean {
  const record = db
    .select({ id: ledgerRecords.id })
    .from(ledgerRecords)
    .where(eq(ledgerRecords.contactId, id))
    .get();
  if (record) return true;

  const quotationRef = db
    .select({ id: quotations.id })
    .from(quotations)
    .where(eq(quotations.contactId, id))
    .get();
  if (quotationRef) return true;

  const invoiceRef = db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.contactId, id))
    .get();
  if (invoiceRef) return true;

  return isPartnerAccountOwner(db, id);
}

/**
 * Does an account belong to this contact — a partner's capital or drawings
 * (002 FR-008b)? `accounts.contact_id` is ON DELETE SET NULL, so deleting the
 * contact would quietly leave the account owned by nobody, and the partner
 * statement would drop it.
 */
function isPartnerAccountOwner(db: Db, id: number): boolean {
  return !!db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.contactId, id))
    .get();
}

/** The sentence the disabled delete button shows, or null when deletion is free (FR-009a). */
export function cannotDeleteContactReason(db: Db, id: number): string | null {
  if (!isContactReferenced(db, id)) return null;
  return isPartnerAccountOwner(db, id)
    ? "An account belongs to this contact as a partner, so it cannot be deleted. Archive it instead."
    : "Transactions or documents refer to this contact, so you cannot delete it. Archive it instead. The existing records do not change.";
}

export type ContactUsage = {
  /** Every record naming the contact, whatever kind — this is what blocks deletion. */
  records: number;
  expenses: number;
  incomes: number;
  quotations: number;
  invoices: number;
};

/**
 * Per-contact record and document counts — what blocks a delete (FR-009a) and
 * what the merge-comparison UI shows is about to move.
 *
 * Records are counted off `ledger_records.contact_id`: since the ledger upgrade
 * every expense, income, payment and issued invoice lives there, so one query
 * over one indexed column answers for all of them.
 */
export function getContactUsageCounts(
  db: Db,
  ids: number[],
): Record<number, ContactUsage> {
  const out: Record<number, ContactUsage> = {};
  if (ids.length === 0) return out;
  for (const id of ids)
    out[id] = {
      records: 0,
      expenses: 0,
      incomes: 0,
      quotations: 0,
      invoices: 0,
    };

  const recordRows = db
    .select({
      contactId: ledgerRecords.contactId,
      kind: ledgerRecords.kind,
      n: sql<number>`count(*)`,
    })
    .from(ledgerRecords)
    .where(inArray(ledgerRecords.contactId, ids))
    .groupBy(ledgerRecords.contactId, ledgerRecords.kind)
    .all();
  for (const r of recordRows) {
    if (r.contactId == null) continue;
    const n = Number(r.n);
    out[r.contactId].records += n;
    if (r.kind === LedgerRecordKind.Expense) out[r.contactId].expenses += n;
    else if (r.kind === LedgerRecordKind.Income) out[r.contactId].incomes += n;
  }

  const quotationRows = db
    .select({ contactId: quotations.contactId, n: sql<number>`count(*)` })
    .from(quotations)
    .where(inArray(quotations.contactId, ids))
    .groupBy(quotations.contactId)
    .all();
  for (const r of quotationRows)
    if (r.contactId != null) out[r.contactId].quotations = Number(r.n);

  const invoiceRows = db
    .select({ contactId: invoices.contactId, n: sql<number>`count(*)` })
    .from(invoices)
    .where(inArray(invoices.contactId, ids))
    .groupBy(invoices.contactId)
    .all();
  for (const r of invoiceRows)
    if (r.contactId != null) out[r.contactId].invoices = Number(r.n);

  return out;
}

/** Hard delete — refuses if referenced. Returns false when blocked / missing. */
export function hardDeleteContact(
  db: Db,
  id: number,
  actingUserId: number,
): boolean {
  if (isContactReferenced(db, id)) return false;
  const result = db
    .delete(contacts)
    .where(eq(contacts.id, id))
    .returning()
    .get();
  if (!result) return false;
  recordAudit(db, {
    recordType: "contact",
    recordId: id,
    userId: actingUserId,
    action: "delete",
    changes: diffRecords(result, null),
  });
  return true;
}

type MatchSignal = "name" | "email" | "phone" | "registrationNo";

/** Digits-only phone key — ignores spacing/punctuation/country-code formatting differences. */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Cluster contacts that share ANY of: normalized legal name, email,
 * phone, or registration number. Deliberately does NOT consider entityType
 * or contactRoles — a Customer and Supplier sharing a name/email/phone/regNo
 * are surfaced together so the user can decide; type/role is shown in the
 * comparison UI instead of being used to filter candidates.
 */
export function findDuplicates(db: Db) {
  const rows = db.select().from(contacts).all();

  // Union-find over contact ids.
  const parent = new Map<number, number>();
  function find(id: number): number {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const r of rows) parent.set(r.id, r.id);

  const signalMatches = new Map<number, Set<MatchSignal>>();
  for (const r of rows) signalMatches.set(r.id, new Set());

  function applySignal(
    key: (r: (typeof rows)[number]) => string | null,
    signal: MatchSignal,
  ) {
    const groups = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const r of group) signalMatches.get(r.id)!.add(signal);
      for (let i = 1; i < group.length; i++) union(group[0].id, group[i].id);
    }
  }

  applySignal((r) => normalizeName(r.legalName) || null, "name");
  applySignal((r) => r.email?.trim().toLowerCase() || null, "email");
  applySignal((r) => normalizePhone(r.phone ?? "") || null, "phone");
  applySignal(
    (r) => r.registrationNo?.trim().toLowerCase() || null,
    "registrationNo",
  );

  const groupsByRoot = new Map<number, (typeof rows)[number][]>();
  for (const r of rows) {
    const root = find(r.id);
    (groupsByRoot.get(root) ?? groupsByRoot.set(root, []).get(root)!).push(r);
  }

  const roleMap = rolesForContacts(
    db,
    rows.map((r) => r.id),
  );
  const ids = rows.map((r) => r.id);
  const usageMap = getContactUsageCounts(db, ids);

  return [...groupsByRoot.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const matchedOn = [
        ...new Set(group.flatMap((r) => [...signalMatches.get(r.id)!])),
      ];
      const nameCounts = new Map<string, number>();
      for (const r of group) {
        const n = normalizeName(r.legalName);
        nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
      }
      const normalized =
        [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
        normalizeName(group[0].legalName);
      return {
        normalized,
        matchedOn,
        contacts: group.map((c) => ({
          ...withLabels(c, roleMap[c.id] ?? []),
          usage: usageMap[c.id] ?? {
            records: 0,
            expenses: 0,
            incomes: 0,
            quotations: 0,
            invoices: 0,
          },
        })),
      };
    });
}

/**
 * Transactional merge. Picks a survivor, repoints every contact-referencing table
 * onto it, unions roles, optionally backfills blank fields, then hard-deletes losers.
 *
 * EVERY future table that FKs contacts MUST be added to the "repoint references" block.
 */
export function mergeContacts(
  db: Db,
  survivorId: number,
  loserIds: number[],
  actingUserId: number,
) {
  const losers = loserIds.filter((id) => id !== survivorId);
  if (losers.length === 0) return getContact(db, survivorId);

  const before = getContact(db, survivorId);
  const loserSnapshots = losers
    .map((id) => db.select().from(contacts).where(eq(contacts.id, id)).get())
    .filter((r): r is typeof contacts.$inferSelect => !!r);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).transaction((tx: Db) => {
    // a/b. Repoint references — extend this block per new contact FK.
    tx.update(ledgerRecords)
      .set({ contactId: survivorId })
      .where(inArray(ledgerRecords.contactId, losers))
      .run();
    tx.update(importQueue)
      .set({ matchedContactId: survivorId })
      .where(inArray(importQueue.matchedContactId, losers))
      .run();
    tx.update(importItems)
      .set({ matchedContactId: survivorId })
      .where(inArray(importItems.matchedContactId, losers))
      .run();
    // A partner's capital and drawings accounts (002 FR-008b). Left alone, the
    // delete below would set them to nobody's.
    tx.update(accounts)
      .set({ contactId: survivorId })
      .where(inArray(accounts.contactId, losers))
      .run();
    tx.update(quotations)
      .set({ contactId: survivorId })
      .where(inArray(quotations.contactId, losers))
      .run();
    tx.update(invoices)
      .set({ contactId: survivorId })
      .where(inArray(invoices.contactId, losers))
      .run();

    // c. Union losers' roles into survivor BEFORE the delete (cascade would wipe them).
    tx.run(
      sql`INSERT OR IGNORE INTO ${contactRoles} (contact_id, role)
			    SELECT ${survivorId}, role FROM ${contactRoles} WHERE contact_id IN (${sql.join(
            losers.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );

    // d. Backfill survivor's blank descriptive fields from a loser (survivor's values win).
    const survivor = tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, survivorId))
      .get();
    if (survivor) {
      const fill: Record<string, unknown> = {};
      const fields = ["registrationNo", "email", "phone", "address"] as const;
      for (const id of losers) {
        const loser = tx
          .select()
          .from(contacts)
          .where(eq(contacts.id, id))
          .get();
        if (!loser) continue;
        for (const f of fields) {
          if (!survivor[f] && !fill[f] && loser[f]) fill[f] = loser[f];
        }
      }
      if (Object.keys(fill).length > 0) {
        tx.update(contacts)
          .set({
            ...fill,
            updatedBy: actingUserId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contacts.id, survivorId))
          .run();
      }
    }

    // e. Delete losers — their contact_roles + search_text cascade away.
    tx.delete(contacts).where(inArray(contacts.id, losers)).run();
  });

  // Re-index survivor name in case a backfill changed searchable fields.
  const survivor = db
    .select()
    .from(contacts)
    .where(eq(contacts.id, survivorId))
    .get();
  if (survivor) reindexContact(db, survivorId, survivor);

  const after = getContact(db, survivorId);
  recordAudit(db, {
    recordType: "contact",
    recordId: survivorId,
    userId: actingUserId,
    action: "update",
    changes: diffRecords(before, after),
  });
  for (const loser of loserSnapshots) {
    recordAudit(db, {
      recordType: "contact",
      recordId: loser.id,
      userId: actingUserId,
      action: "delete",
      changes: diffRecords(loser, null),
    });
  }

  return after;
}

// ---------------------------------------------------------------------------
// Name → contact resolution, shared by the programmatic create path and import.
// ---------------------------------------------------------------------------

/**
 * Programmatic create helper: resolve a name string to a contact id among the
 * role-appropriate set (exact-then-normalized), else auto-create a Business
 * contact with that role. Used by POST /api/records and Auto Import.
 */
export function resolveOrCreateContact(
  db: Db,
  name: string,
  role: number,
  actingUserId: number,
): number {
  const trimmed = name.trim();
  if (!trimmed) {
    // Never silently fail — create a placeholder business contact with the role.
    return createContact(db, actingUserId, {
      entityType: EntityType.Business,
      legalName: name,
      roles: [role],
    }).id;
  }
  const match = findContactByName(db, trimmed, role);
  if (match) return match.id;
  return createContact(db, actingUserId, {
    entityType: EntityType.Business,
    legalName: trimmed,
    roles: [role],
  }).id;
}

/** Exact-then-normalized lookup within a role. Returns the contact row or null. */
export function findContactByName(db: Db, name: string, role: number) {
  const roleContacts = db
    .select({
      id: contacts.id,
      legalName: contacts.legalName,
      entityType: contacts.entityType,
    })
    .from(contacts)
    .innerJoin(contactRoles, eq(contactRoles.contactId, contacts.id))
    .where(eq(contactRoles.role, role))
    .all();

  // Exact match first.
  const exact = roleContacts.find((c) => c.legalName === name);
  if (exact) return exact;
  // Normalized match next.
  const norm = normalizeName(name);
  return roleContacts.find((c) => normalizeName(c.legalName) === norm) ?? null;
}

export type ContactCandidate = { id: number; legalName: string; score: number };

/**
 * Import worker helper. Returns a confident exact-normalized match (matchedId)
 * and/or a ranked fuzzy candidate list. NEVER auto-links on a fuzzy guess.
 */
export function resolveContactCandidates(
  db: Db,
  name: string,
  role: number,
): { matchedId: number | null; candidates: ContactCandidate[] } {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { matchedId: null, candidates: [] };

  const roleContacts = db
    .select({ id: contacts.id, legalName: contacts.legalName })
    .from(contacts)
    .innerJoin(contactRoles, eq(contactRoles.contactId, contacts.id))
    .where(eq(contactRoles.role, role))
    .all();

  const norm = normalizeName(trimmed);

  // Confident exact-normalized hit.
  const exact = roleContacts.find((c) => normalizeName(c.legalName) === norm);
  if (exact) return { matchedId: exact.id, candidates: [] };

  // Fuzzy candidates above threshold (top 5).
  const THRESHOLD = 0.55;
  const candidates = roleContacts
    .map((c) => ({
      id: c.id,
      legalName: c.legalName,
      score: similarity(norm, normalizeName(c.legalName)),
    }))
    .filter((c) => c.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { matchedId: null, candidates };
}

/** Token-overlap (Dice) similarity on normalized names, 0..1. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(" "));
  const tb = new Set(b.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}
