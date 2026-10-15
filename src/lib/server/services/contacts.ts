import {
  createContact as _create,
  updateContact as _update,
  setContactRoles as _setRoles,
  getContactRoles,
  hardDeleteContact as _hardDelete,
  mergeContacts as _merge,
  cannotDeleteContactReason,
  getContact,
  type ContactCreate,
  type ContactPatch,
} from "$lib/server/queries/contacts.js";
import { contactEvents } from "$lib/server/finance/events.js";
import { recordAudit, diffRecords } from "$lib/server/audit.js";
import {
  ensurePartnerAccounts,
  retirePartnerAccounts,
} from "$lib/server/services/accounts.js";
import { Role } from "$lib/enums.js";
import { reindexInvoice } from "$lib/server/queries/invoices.js";
import { reindexQuotation } from "$lib/server/queries/quotations.js";
import { reindexRecord } from "$lib/server/queries/ledger.js";
import {
  contacts,
  invoices,
  ledgerRecords,
  quotations,
} from "$lib/server/db/schema.js";
import type { LedgerDb } from "$lib/server/ledger/types.js";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

/**
 * Marking a contact as a partner is the one contact change that touches
 * accounts (FR-008b, D-08): a partner has to appear by name on a balance sheet,
 * so they get their own pair of pots. Taking the role away never destroys
 * history — `retirePartnerAccounts` archives a pot that holds movements and
 * only deletes an empty one.
 */
function syncPartnerAccounts(
  db: Db,
  contactId: number,
  contactName: string,
  actingUserId: number,
  before: number[],
  after: number[],
) {
  const had = before.includes(Role.Partner);
  const has = after.includes(Role.Partner);
  if (had === has) return;
  if (has)
    ensurePartnerAccounts(db as LedgerDb, contactId, contactName, actingUserId);
  else retirePartnerAccounts(db as LedgerDb, contactId, actingUserId);
}

export function createContact(
  db: Db,
  actingUserId: number,
  data: ContactCreate,
) {
  const contact = _create(db, actingUserId, data);
  syncPartnerAccounts(
    db,
    contact.id,
    contact.legalName,
    actingUserId,
    [],
    contact.roles,
  );
  contactEvents.emit("contact-update", { item: contact });
  return contact;
}

/**
 * Rebuilds the search text of everything that names this contact: its
 * records, quotations and invoices. Each of those holds the contact's name in
 * its own search text, written when the document was, so without this a renamed
 * customer is found only under the old name until someone runs a full rebuild.
 */
function reindexContactDocuments(db: Db, contactId: number) {
  (db as LedgerDb).transaction((tx) => {
    for (const { id } of tx
      .select({ id: ledgerRecords.id })
      .from(ledgerRecords)
      .where(eq(ledgerRecords.contactId, contactId))
      .all())
      reindexRecord(tx, id);
    for (const { id } of tx
      .select({ id: quotations.id })
      .from(quotations)
      .where(eq(quotations.contactId, contactId))
      .all())
      reindexQuotation(tx, id);
    for (const { id } of tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.contactId, contactId))
      .all())
      reindexInvoice(tx, id);
  });
}

export function patchContact(
  db: Db,
  id: number,
  actingUserId: number,
  patch: ContactPatch,
) {
  const before = db
    .select({ legalName: contacts.legalName })
    .from(contacts)
    .where(eq(contacts.id, id))
    .get();
  const contact = _update(db, id, actingUserId, patch);
  // The name is the only part of a contact that other documents' search text
  // carries, so any other edit leaves them alone.
  if (contact && before && contact.legalName !== before.legalName)
    reindexContactDocuments(db, id);
  if (contact) contactEvents.emit("contact-update", { item: contact });
  return contact;
}

export function replaceContactRoles(
  db: Db,
  id: number,
  actingUserId: number,
  roles: number[],
) {
  const before = getContactRoles(db, id);
  const after = _setRoles(db, id, roles);
  const contact = getContact(db, id);
  if (contact)
    syncPartnerAccounts(db, id, contact.legalName, actingUserId, before, after);
  recordAudit(db, {
    recordType: "contact",
    recordId: id,
    userId: actingUserId,
    action: "update",
    changes: diffRecords({ roles: before }, { roles: after }),
  });
  if (contact) contactEvents.emit("contact-update", { item: contact });
  return contact;
}

/**
 * A contact nothing points at may be deleted; one a record names may not, and
 * the caller is told why in the words the screen shows (FR-009a).
 */
export function deleteContact(
  db: Db,
  id: number,
  actingUserId: number,
): { ok: true } | { ok: false; reason: string } {
  const blocked = cannotDeleteContactReason(db, id);
  if (blocked) return { ok: false, reason: blocked };
  if (!_hardDelete(db, id, actingUserId)) {
    return { ok: false, reason: "That contact no longer exists." };
  }
  contactEvents.emit("contact-delete", { id });
  return { ok: true };
}

export function mergeContacts(
  db: Db,
  survivorId: number,
  loserIds: number[],
  actingUserId: number,
) {
  const survivor = _merge(db, survivorId, loserIds, actingUserId);
  // The losers' documents now name the survivor, but their search text still
  // holds the name they were written with.
  if (survivor && loserIds.some((id) => id !== survivorId))
    reindexContactDocuments(db, survivorId);
  for (const id of loserIds) {
    if (id !== survivorId) contactEvents.emit("contact-delete", { id });
  }
  if (survivor) contactEvents.emit("contact-update", { item: survivor });
  return survivor;
}
