import { recordRelations } from "../queries/reimbursements.js";
import { reimbursementAmountCorrectionAvailability } from "../application/reimbursement-amount-correction.js";
import { allocationHistoryDeletionReason } from "../queries/allocation-state.js";
import { fail, redirect, type Actions } from "@sveltejs/kit";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import { can, canAny } from "$lib/server/permissions.js";
import {
  defaultAccountId,
  listAccounts,
} from "$lib/server/queries/accounts.js";
import { defaultReimbursementPayeeId } from "$lib/server/settings.js";
import { getContact, listContacts } from "$lib/server/queries/contacts.js";
import {
  getRecord,
  listAttachments,
  listRecords,
} from "$lib/server/queries/ledger.js";
import {
  getInvoice,
  invoiceIdsForLedgerRecords,
} from "$lib/server/queries/invoices.js";
import { LedgerRecordKind } from "$lib/enums.js";
import { removeRecord } from "$lib/server/services/ledger.js";
import {
  getUserPreference,
  USER_PREF_KEYS,
} from "$lib/server/userPreferences.js";
import { mainCurrencyCode } from "$lib/server/currency/form.js";
import {
  isCategoryAccount,
  isMoneyPotAccount,
} from "$lib/server/ledger/account-type.js";

/**
 * The loads and actions behind `/records`, `/records/[id]`, `/records/new`
 * and `/records/new/payment`.
 *
 * This replaces `loaders/ledger.ts`, which served `/expenses` and `/income` and
 * differed between them in three things: which kind it listed, which accounts it
 * called a category, and which list a stale deep link fell back to. All three
 * differences are gone. There is one list of every kind, one set of accounts,
 * and one list to fall back to (FR-001, FR-004).
 *
 * The legacy lookup went with them. `/expenses/[id]` and `/income/[id]` are
 * retired outright rather than redirected, so there is nothing left to resolve a
 * pre-upgrade id against (FR-025a, D-04). The `legacy_kind` / `legacy_id`
 * columns stay on the record as provenance; only the lookup goes.
 */

const LIST_PATH = "/records";

/**
 * How many records the screen holds. The screen filters, searches and sorts in
 * the browser, so the page is loaded in one go rather than a round trip per
 * filter change; `total` says whether anything was left behind.
 */
const PAGE_LIMIT = 1000;

export function loadRecordsPage(locals: App.Locals) {
  if (!can(locals, "records.read")) throw redirect(302, "/dashboard");

  // No `kind` filter: one list of everything that happened, newest first
  // (FR-001).
  const { records, total } = listRecords(db, { limit: PAGE_LIMIT });

  return { records, total, ...recordFormOptions(locals) };
}

/**
 * One record, for `/records/[id]`.
 *
 * Split from the list load rather than sharing it. The list load fetched a
 * thousand records to show one, and then refused the ones it had not fetched:
 * `!records.some((r) => r.id === openId)` sent every link to a record older
 * than the newest thousand back to the list. A record has an address so it can
 * be sent to somebody, and that address has to work for the old ones too.
 *
 * `getRecord` already carries the derived answers — `paid`, `outstandingMinor`,
 * `locked`, `lockedReason`, `reconciled` — so nothing here recomputes them.
 */
export function loadRecordDetail(locals: App.Locals, id: number) {
  if (!can(locals, "records.read")) throw redirect(302, "/dashboard");

  const record = getRecord(db, id);
  // Deleted, never existed, or a mistyped id. The list, not a bare error page:
  // there is no `+error.svelte` in the app shell to land on.
  if (!record) throw redirect(302, LIST_PATH);

  return {
    record,
    reimbursementAmountCorrection: reimbursementAmountCorrectionAvailability(
      { db, locals },
      id,
    ),
    ...recordRelations(db, id),
    allocationHistoryDeleteReason: allocationHistoryDeletionReason(db, id),
    attachments: listAttachments(db, id),

    // The invoice an issue posting belongs to, for the link back to it. Kept
    // beside the record rather than on `RecordView`, which is frozen.
    invoiceId:
      record.kind === LedgerRecordKind.InvoiceIssue
        ? (invoiceIdsForLedgerRecords(db, [id])[0] ?? null)
        : null,
    ...recordFormOptions(locals, [record.contactId, record.supplierContactId]),
  };
}

/**
 * The blank form, for `/records/new`.
 *
 * Gated on `add`, not `view` — a create page's whole reason to exist fails
 * without it, so a user who lacks it is sent back rather than shown a form
 * that would 403 on submit.
 */
export function loadRecordNew(locals: App.Locals) {
  if (!can(locals, "records.create")) throw redirect(302, LIST_PATH);

  return recordFormOptions(locals);
}

/** A query-string id, or null for anything that is not a positive integer. */
function positiveIdParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The blank payment/receipt form, for `/records/new/payment`.
 *
 * Opens scoped to one contact, the way the drawer it replaces always did —
 * carried as a query param rather than a route segment, since it is prefilled
 * context for a create form and not a link to another feature's record.
 *
 * `?invoice=<id>` is the invoice page's "Record payment": a receipt from that
 * invoice's customer, with its owed side already ticked, and back to the
 * invoice once saved. Only for a user who may see invoices — anyone else gets
 * the ordinary blank form, as if the param were not there. The way back is
 * built here from the invoice's own id, never echoed from the address bar.
 */
export function loadPaymentNew(locals: App.Locals, url: URL) {
  if (!can(locals, "records.create")) throw redirect(302, LIST_PATH);

  let contactId = positiveIdParam(url, "contactId");
  const requestedDirection = url.searchParams.get("direction");
  let direction: import("../ledger/types.js").PaymentDirection | "reimburse" =
    requestedDirection === "reimburse" ||
    requestedDirection === "we-receive" ||
    requestedDirection === "refund-received" ||
    requestedDirection === "refund-paid"
      ? requestedDirection
      : requestedDirection === "we-pay" || contactId !== null
        ? "we-pay"
        : "reimburse";
  /** The owed movement to tick once the contact's items have loaded. */
  let preselectMovementId: number | null = null;
  let returnTo: { href: string; label: string } | null = null;

  const invoiceId = positiveIdParam(url, "invoice");
  const invoice =
    invoiceId !== null && can(locals, "invoices.read")
      ? getInvoice(db, invoiceId)
      : null;
  if (invoice) {
    contactId = invoice.contactId;
    direction = "we-receive";
    preselectMovementId = invoice.owedMovementId;
    returnTo = {
      href: `/invoices/${invoice.id}`,
      label: invoice.invoiceNumber,
    };
  }

  if (direction === "reimburse" && contactId === null) {
    contactId = defaultReimbursementPayeeId(db);
  }
  const options = recordFormOptions(locals);
  // Keep an explicitly selected/default contact available beyond the first page.
  if (contactId !== null && !options.contacts.some((c) => c.id === contactId)) {
    const contact = getContact(db, contactId);
    if (contact)
      options.contacts.push({ id: contact.id, legalName: contact.legalName });
  }

  return {
    contactId,
    direction,
    preselectMovementId,
    returnTo,
    settlementAccountId: positiveIdParam(url, "settlementAccountId"),
    ...options,
  };
}

/**
 * Everything the record *form* needs, whichever surface is showing it.
 *
 * Shared deliberately: if the list's create drawer and the detail page's editor
 * read their accounts from two places, they can offer two different charts and
 * nothing would say so.
 */
function recordFormOptions(
  locals: App.Locals,
  selectedContacts: (number | null | undefined)[] = [],
) {
  const allAccounts = listAccounts(db, {});
  const contacts = listContacts(db, { limit: 500 }).map((c) => ({
    id: c.id,
    legalName: c.legalName,
  }));
  const defaultPayee = defaultReimbursementPayeeId(db);
  for (const id of [...selectedContacts, defaultPayee]) {
    if (!id || contacts.some((contact) => contact.id === id)) continue;
    const contact = getContact(db, id);
    if (contact)
      contacts.push({ id: contact.id, legalName: contact.legalName });
  }
  return {
    // One read, split three ways. The split is `isMoneyPotAccount` /
    // `isCategoryAccount` rather than a type list, because equipment is an asset
    // that belongs with the categories (002 FR-006b).
    accounts: allAccounts.filter(isMoneyPotAccount),
    categories: allAccounts.filter(isCategoryAccount),
    // Every account, for the full list a user with `adjustments` can reach in
    // one step from either side of the form (FR-008a, FR-031).
    allAccounts,
    contacts,
    defaultAccountId: defaultAccountId(db),
    mainCurrency: mainCurrencyCode(db),
    // Both remembered currencies travel to one screen now. Which one the form
    // offers follows from the accounts the user names, not from which page they
    // are on — the kind is derived, so the currency memory is too.
    lastForeignCurrencyExpense:
      getUserPreference(
        db,
        locals.user!.id,
        USER_PREF_KEYS.lastForeignCurrencyExpense,
      ) ?? null,
    lastForeignCurrencyIncome:
      getUserPreference(
        db,
        locals.user!.id,
        USER_PREF_KEYS.lastForeignCurrencyIncome,
      ) ?? null,
    perms: {
      add: can(locals, "records.create"),
      change: can(locals, "records.update"),
      correctContact: can(locals, "records.correctContact"),
      correctDate:
        !locals.credential &&
        !locals.oauth &&
        can(locals, "records.correctDate"),
      delete: can(locals, "records.delete"),
      correctAllocations: canAny(locals, [
        ["records.correctAllocations"],
        ["records.delete"],
      ]),
      correctPaymentRecipient: canAny(locals, [
        ["records.correctPaymentRecipient"],
        ["records.delete"],
      ]),
      // Free choice of account and a third side. The server enforces this at
      // the point of derivation; the screen only stops offering what would be
      // refused (FR-031c).
      adjustments: can(locals, "records.adjust"),
    },
  };
}

/** A comma-separated list of record ids, as the selection bar submits it. */
const idsSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  )
  .pipe(z.array(z.number().int().positive()).min(1));

export const recordsActions: Actions = {
  /**
   * Removes the selected records.
   *
   * One at a time through the service, so each carries its own audit entry and
   * its own event, and so a record a settlement or a bank line still points at
   * refuses on its own rather than taking the whole selection down with it
   * (FR-017a). An invoice's issue posting refuses the same way — it goes when
   * the invoice is cancelled. The first refusal is handed back to be shown; the
   * rest still go.
   */
  delete: async ({ locals, request }) => {
    const data = await request.formData();
    const parsed = idsSchema.safeParse(String(data.get("ids") ?? ""));
    if (!parsed.success) return fail(400, { error: "Nothing was selected." });

    if (!can(locals, "records.delete")) {
      return fail(403, { error: "Forbidden" });
    }

    const userId = locals.user!.id;
    let deleted = 0;
    let refusedReason: string | null = null;

    for (const id of parsed.data) {
      const record = getRecord(db, id);
      if (!record) continue;

      const result = removeRecord(db, id, userId);
      if (result.ok) deleted++;
      else refusedReason ??= result.reason;
    }

    if (deleted === 0 && refusedReason)
      return fail(409, { error: refusedReason });
    return { success: true, deleted, refusedReason };
  },
};
