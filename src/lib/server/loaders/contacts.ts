import type { Actions } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import {
  getContact,
  listContacts,
  getContactUsageCounts,
} from "$lib/server/queries/contacts.js";
import { contactBalances } from "$lib/server/queries/settlements.js";
import {
  createContact,
  patchContact,
  replaceContactRoles,
  deleteContact,
  mergeContacts,
} from "$lib/server/services/contacts.js";
import { fail, redirect } from "@sveltejs/kit";
import { can } from "$lib/server/permissions.js";

export function loadContactsPage(locals: App.Locals) {
  if (!can(locals, "contacts.read"))
    throw redirect(302, "/dashboard");

  const contacts = listContacts(db, {});
  const usage = getContactUsageCounts(
    db,
    contacts.map((c) => c.id),
  );

  /**
   * What each contact owes, or is owed — the purchase and sales ledger.
   *
   * Real bookkeeping keeps this as a subsidiary ledger behind the two shared
   * owed accounts: one account per supplier and customer, reconciling to the
   * control account. Here it is derived from the movements instead, which is
   * why adding a contact never touches the chart of accounts (FR-008a) and why
   * these figures can never disagree with the ledger they come from.
   *
   * `contactBalances()` has computed this correctly since the double-entry
   * release and nothing has ever displayed it.
   *
   * Gated on `records.view`, not on `contacts.view`: it is derived from records,
   * so seeing it means being allowed to see them.
   */
  const canSeeRecords = can(locals, "records.read");
  const owedToUs = canSeeRecords ? contactBalances(db, "owed-to-us") : [];
  const weOwe = canSeeRecords ? contactBalances(db, "we-owe") : [];

  // One figure per contact, signed the way the screen reads it: positive when
  // they owe us, negative when we owe them. A contact on both sides nets out,
  // which is the answer a person wants when they buy from a customer.
  const balances: Record<number, number> = {};
  for (const row of owedToUs) {
    balances[row.contactId] =
      (balances[row.contactId] ?? 0) + row.outstandingMinor;
  }
  for (const row of weOwe) {
    balances[row.contactId] =
      (balances[row.contactId] ?? 0) - row.outstandingMinor;
  }

  return {
    contacts,
    usage,
    balances,
    totals: {
      owedToUsMinor: owedToUs.reduce((sum, r) => sum + r.outstandingMinor, 0),
      weOweMinor: weOwe.reduce((sum, r) => sum + r.outstandingMinor, 0),
    },
    perms: {
      add: can(locals, "contacts.create"),
      change: can(locals, "contacts.update"),
      delete: can(locals, "contacts.delete"),
      merge:
        can(locals, "contacts.merge") &&
        can(locals, "contacts.update") &&
        can(locals, "contacts.delete"),
      /** Whether to offer the statement link at all. */
      records: canSeeRecords,
    },
  };
}

/**
 * One contact, for `/contacts/[id]`.
 *
 * Contacts had no read view at all: the edit form *was* the detail, so a
 * contact's balance — the purchase and sales ledger `contactBalances()` has
 * computed correctly since the double-entry release — had nowhere to appear.
 */
export function loadContactDetail(locals: App.Locals, id: number) {
  if (!can(locals, "contacts.read"))
    throw redirect(302, "/dashboard");

  const contact = getContact(db, id);
  if (!contact) throw redirect(302, "/contacts");

  const usage = getContactUsageCounts(db, [id]);

  // Gated on `records.view`, not on `contacts.view`: it is derived from
  // records, so seeing it means being allowed to see them.
  const canSeeRecords = can(locals, "records.read");
  const owedToUs = canSeeRecords
    ? (contactBalances(db, "owed-to-us").find((r) => r.contactId === id)
        ?.outstandingMinor ?? 0)
    : 0;
  const weOwe = canSeeRecords
    ? (contactBalances(db, "we-owe").find((r) => r.contactId === id)
        ?.outstandingMinor ?? 0)
    : 0;

  return {
    contact,
    usage: usage[id] ?? { records: 0, quotations: 0, invoices: 0 },
    // Positive when they owe us, negative when we owe them. A contact on both
    // sides nets out, which is the answer a person wants when they buy from a
    // customer.
    balanceMinor: owedToUs - weOwe,
    perms: {
      change: can(locals, "contacts.update"),
      delete: can(locals, "contacts.delete"),
      /** Whether to offer the statement link at all. */
      records: canSeeRecords,
    },
  };
}

function parseRoles(data: FormData): number[] {
  return data
    .getAll("roles")
    .map((r) => parseInt(String(r)))
    .filter((n) => !Number.isNaN(n));
}

export const contactsActions: Actions = {
  create: async ({ locals, request }) => {
    if (!can(locals, "contacts.create"))
      return fail(403, { error: "Forbidden" });
    const userId = locals.user!.id;
    const data = await request.formData();

    const entityType = parseInt(String(data.get("entityType") ?? "0"));
    const legalName = String(data.get("legalName") ?? "").trim();
    if (!entityType) return fail(400, { error: "Entity type is required" });
    if (!legalName) return fail(400, { error: "Legal name is required" });

    const contact = createContact(db, userId, {
      entityType,
      legalName,
      registrationNo: String(data.get("registrationNo") ?? "").trim() || null,
      email: String(data.get("email") ?? "").trim() || null,
      phone: String(data.get("phone") ?? "").trim() || null,
      address: String(data.get("address") ?? "").trim() || null,
      remark: String(data.get("remark") ?? "").trim() || null,
      roles: parseRoles(data),
    });

    return { success: true, id: contact.id };
  },

  update: async ({ locals, request }) => {
    if (!can(locals, "contacts.update"))
      return fail(403, { error: "Forbidden" });
    const userId = locals.user!.id;
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "Invalid contact" });

    const legalName = String(data.get("legalName") ?? "").trim();
    if (!legalName) return fail(400, { error: "Legal name is required" });

    patchContact(db, id, userId, {
      entityType: parseInt(String(data.get("entityType") ?? "0")) || undefined,
      legalName,
      registrationNo: String(data.get("registrationNo") ?? "").trim() || null,
      email: String(data.get("email") ?? "").trim() || null,
      phone: String(data.get("phone") ?? "").trim() || null,
      address: String(data.get("address") ?? "").trim() || null,
      remark: String(data.get("remark") ?? "").trim() || null,
    });
    replaceContactRoles(db, id, userId, parseRoles(data));

    return { success: true, id };
  },

  delete: async ({ locals, request }) => {
    if (!can(locals, "contacts.delete"))
      return fail(403, { error: "Forbidden" });
    const userId = locals.user!.id;
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "Invalid contact" });
    const result = deleteContact(db, id, userId);
    if (!result.ok) return fail(409, { error: result.reason });
    return { success: true };
  },

  merge: async ({ locals, request }) => {
    if (
      !can(locals, "contacts.merge") ||
      !can(locals, "contacts.update") ||
      !can(locals, "contacts.delete")
    ) {
      return fail(403, { error: "Forbidden" });
    }
    const userId = locals.user!.id;
    const data = await request.formData();
    const survivorId = parseInt(String(data.get("survivorId") ?? "0"));
    const loserIds = String(data.get("loserIds") ?? "")
      .split(",")
      .map(Number)
      .filter(Boolean);
    if (!survivorId || loserIds.length === 0 || loserIds.includes(survivorId)) {
      return fail(400, { error: "Invalid survivor/loser selection" });
    }
    mergeContacts(db, survivorId, loserIds, userId);
    return { success: true };
  },
};
