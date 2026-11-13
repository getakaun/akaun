import { z } from "zod";
import {
  EntityTypeLabels,
  LedgerRecordKind,
  LedgerRecordKindLabels,
  RoleLabels,
} from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import { preparePaymentCorrection } from "../../../application/payment-corrections.js";
import { resolvePaymentMovement } from "../../../application/refs.js";
import {
  contactVersion,
  recordVersions,
} from "../../../application/version.js";
import { toMinor } from "../../../ledger/money.js";
import type { RecordView } from "../../../ledger/types.js";
import { findDuplicateContacts } from "../../../queries/books-review.js";
import { categoryHistory } from "../../../queries/category-history.js";
import {
  countContacts,
  getContact,
  getContactUsageCounts,
  listContacts,
  normalizeName,
} from "../../../queries/contacts.js";
import { listRecords } from "../../../queries/ledger.js";
import {
  contactBalances,
  outstandingAgeing,
} from "../../../queries/settlements.js";
import { toolError } from "../../envelope.js";
import {
  enumCodec,
  enumInput,
  enumLabel,
  mainCurrency,
  money,
} from "../../format.js";
import { pageResult, pagingShape, startPage } from "../../paging.js";
import { defineReadTool, type ToolDefinition } from "../../registry.js";
import {
  actionRefusal,
  FIND_CONTACTS,
  GET_CONTACT,
  missingForActions,
} from "../../requirements/index.js";
import { Refs, recordNo, refInput } from "../writes/payments.js";

/**
 * `find_contacts` and `get_contact`.
 *
 * Balances are never totalled here: `contactBalances` (`queries/settlements.ts`)
 * is the one source, and the open items come from `listOutstanding`, the rows
 * it totals. Duplicates are the books review's own groups
 * (`findDuplicateContacts`), so this list and review_books' duplicate_contacts
 * check, whose next call is this one, always show the same groups.
 *
 * Movement and settlement ids never leave. A payment listed as a credit or an
 * open item carries `allocations_v`, the version `change_allocations` needs.
 */

const detailInput = z
  .enum(["concise", "full"])
  .optional()
  .describe("full adds registration number, email, phone, address and remark.");

const roleLabel = (code: number) => enumLabel(RoleLabels, code);

// --- find_contacts ------------------------------------------------------------

const FIND_DESCRIPTION = `Find the people and companies you deal with (customers, suppliers, employees, partners), or find contacts that look like duplicates.

Rows: id, name, roles, usage (how many records name the contact), v (version, for changes) and, when you may read balances, balance: the net owed to you from open items in the main currency (positive: they owe you; negative: you owe them; left out when nothing is open). Filters: query (name, registration number, email or phone), role, has_balance (needs records read too). detail: "full" adds registration number, email, phone and address.

duplicates: true returns groups instead, the ones the books review flags: {matched_on, contacts, keep_hint}. matched_on says why, strongest first: registration_no, email, phone or name (the same, ignoring case and punctuation); registration_no_in_documents (one contact's registration number in the files of another's records); name_without_suffix (the same once a company suffix such as Sdn Bhd is dropped); name_in_documents (one contact's full name in another's files). contacts starts with the one keep_hint names: one with a registration number, else a registered company name, else the most records, else the oldest. It is only a hint: read each with get_contact before changing anything. Names that only look alike are not grouped: search them with query. duplicates takes query to narrow, not role or has_balance.

Paging: limit (50, at most 200) and cursor; the last line says how to continue.`;

const findContactsInput = z.object({
  query: z.string().trim().max(200).optional(),
  role: enumInput(RoleLabels).optional(),
  has_balance: z
    .boolean()
    .optional()
    .describe(
      "true: only contacts with something open. false: only those with nothing open.",
    ),
  duplicates: z
    .boolean()
    .optional()
    .describe("true: groups of contacts that look like one party."),
  detail: detailInput,
  ...pagingShape,
});

/** Net owed to us by contact, and who has anything open at all. */
function balancesNow(db: Parameters<typeof contactBalances>[0]) {
  const net = new Map<number, number>();
  const open = new Set<number>();
  for (const [direction, sign] of [
    ["owed-to-us", 1],
    ["we-owe", -1],
  ] as const)
    for (const row of contactBalances(db, direction)) {
      net.set(
        row.contactId,
        (net.get(row.contactId) ?? 0) + sign * row.outstandingMinor,
      );
      if ((row.obligationsMinor ?? 0) + (row.creditsMinor ?? 0) > 0)
        open.add(row.contactId);
    }
  return { net, open };
}

const findContacts = defineReadTool({
  base: "find_contacts",
  title: "Find contacts",
  description: FIND_DESCRIPTION,
  input: findContactsInput,
  requirements: FIND_CONTACTS.requirements,
  handler: (ctx, args, meta) => {
    const { db } = ctx;
    const full = args.detail === "full";
    const mayBalance =
      missingForActions(ctx.locals, "find_contacts", ["balances"]).length === 0;
    if (args.has_balance !== undefined && !mayBalance)
      return toolError(
        actionRefusal(
          meta.name,
          missingForActions(ctx.locals, "find_contacts", ["balances"]),
        ),
      );
    if (args.duplicates && (args.role || args.has_balance !== undefined))
      return toolError({
        code: "INVALID_INPUT",
        message: "duplicates cannot be combined with role or has_balance.",
        fix: "Send duplicates with query only, or drop duplicates to filter by role or balance.",
      });
    const page = startPage(args, args);
    if (!page.ok) return toolError(page.error);
    const role = args.role ? enumCodec(RoleLabels).code(args.role) : undefined;

    const rowsFor = (
      contacts: ReturnType<typeof listContacts>,
      balances?: ReturnType<typeof balancesNow>,
    ) => {
      const ids = contacts.map((c) => c.id);
      const usage = getContactUsageCounts(db, ids);
      return contacts.map((c) => {
        const net = balances?.net.get(c.id) ?? 0;
        return {
          id: c.id,
          name: c.legalName,
          roles: c.roles.map(roleLabel),
          usage: usage[c.id]?.records ?? 0,
          v: contactVersion(db, c.id),
          balance: net !== 0 ? money(net) : undefined,
          ...(full
            ? {
                entity: enumLabel(EntityTypeLabels, c.entityType),
                registration_no: c.registrationNo,
                email: c.email,
                phone: c.phone,
                address: c.address,
              }
            : {}),
        };
      });
    };

    if (args.duplicates) {
      // The books review's finder, in its order: the contact to keep first in
      // each group, and the groups with the most records first.
      const groups = findDuplicateContacts(db);
      const wanted = args.query ? normalizeName(args.query) : "";
      const shown = groups.filter(
        (g) =>
          !wanted ||
          g.contacts.some(
            (c) =>
              normalizeName(c.name).includes(wanted) ||
              (c.registrationNo ?? "")
                .toLowerCase()
                .includes(args.query!.toLowerCase()),
          ),
      );
      const slice = shown.slice(
        page.value.offset,
        page.value.offset + page.value.limit + 1,
      );
      const everyone = new Map(
        listContacts(db, { limit: 1_000_000 }).map((c) => [c.id, c]),
      );
      const balances = mayBalance ? balancesNow(db) : undefined;
      const rows = slice.map((g) => {
        const [keep] = g.contacts;
        return {
          matched_on: g.signals,
          contacts: rowsFor(
            g.contacts.map((c) => everyone.get(c.id)!),
            balances,
          ),
          keep_hint: { id: keep.id, name: keep.name, why: g.keepReason },
        };
      });
      return pageResult({
        rows,
        page: page.value,
        total: shown.length,
        narrow: "query",
        key: "groups",
        head: { currency: mayBalance ? mainCurrency(db) : undefined },
      });
    }

    const filters = { role, search: args.query || undefined };
    const balances = mayBalance ? balancesNow(db) : undefined;
    if (args.has_balance !== undefined) {
      const all = listContacts(db, { ...filters, limit: 1_000_000 }).filter(
        (c) => balances!.open.has(c.id) === args.has_balance,
      );
      const slice = all.slice(
        page.value.offset,
        page.value.offset + page.value.limit + 1,
      );
      return pageResult({
        rows: rowsFor(slice, balances),
        page: page.value,
        total: all.length,
        narrow: "query or role",
        key: "contacts",
        head: { currency: mainCurrency(db) },
      });
    }
    const rows = listContacts(db, {
      ...filters,
      limit: page.value.limit + 1,
      offset: page.value.offset,
    });
    return pageResult({
      rows: rowsFor(rows, balances),
      page: page.value,
      total: countContacts(db, filters),
      narrow: "query or role",
      key: "contacts",
      head: { currency: mayBalance ? mainCurrency(db) : undefined },
    });
  },
});

// --- get_contact --------------------------------------------------------------

const GET_DESCRIPTION = `Read one contact in full: who they are, what is open with them, which categories their records use and their latest records. Use it after find_contacts, before changing a contact, or to see what to chase or pay.

contact is an id or the exact name. Amounts are decimal strings in the main currency. balances: receivable (what they owe you) and payable (what you owe them), each net of payments not yet applied, net (receivable less payable; positive: they owe you) and credit (the unapplied payments, listed in credits). open_items: the records still owed, with direction (owed_to_us or we_owe), outstanding, due and days_overdue. credits: payments received or made that are not fully applied. A payment in either list carries allocations_v, the version change_allocations needs to move it. category_usage: the five categories their records use most, with counts. recent: their last ten records. v is the contact's version for changes. detail: "full" adds address and remark.

Lists show at most 50 items; the drill call finds the rest.`;

const getContactInput = z.object({
  contact: refInput.describe("The contact: id or exact name."),
  detail: detailInput,
});

const OPEN_ITEM_CAP = 50;

function recordRow(record: RecordView, v: string, main: string) {
  const foreign = record.currency !== main;
  return {
    id: record.id,
    no: recordNo(record),
    date: record.date,
    kind: enumLabel(LedgerRecordKindLabels, record.kind),
    description: record.description,
    amount: foreign
      ? money(toMinor(record.amount, 1))
      : money(record.amountMinor),
    currency: foreign ? record.currency : undefined,
    amount_main: foreign ? money(record.amountMinor) : undefined,
    status: record.paid
      ? "paid"
      : record.outstandingMinor < record.amountMinor
        ? "part_paid"
        : "owed",
    v,
  };
}

const getContactTool = defineReadTool({
  base: "get_contact",
  title: "Get a contact",
  description: GET_DESCRIPTION,
  input: getContactInput,
  requirements: GET_CONTACT.requirements,
  handler: (ctx, args, meta) => {
    const { db } = ctx;
    const refs = new Refs(ctx, meta);
    const brief = refs.contact(args.contact, "contact");
    const missed = refs.failure();
    if (missed || !brief) return missed!;
    const contact = getContact(db, brief.id)!;
    const main = mainCurrency(db);
    const today = localToday();

    const receivable = contactBalances(db, "owed-to-us", contact.id)[0];
    const payable = contactBalances(db, "we-owe", contact.id)[0];
    const owedToUs = receivable?.outstandingMinor ?? 0;
    const weOwe = payable?.outstandingMinor ?? 0;
    const credit =
      (receivable?.creditsMinor ?? 0) + (payable?.creditsMinor ?? 0);

    const allocationsV = (recordId: number): string | undefined => {
      const line = resolvePaymentMovement(ctx, recordId);
      if (!line.ok) return undefined;
      const prepared = preparePaymentCorrection(ctx, line.value.movementId);
      return prepared.ok ? prepared.value.version : undefined;
    };
    const items = (["owed-to-us", "we-owe"] as const).flatMap((direction) =>
      outstandingAgeing(db, {
        direction,
        contactId: contact.id,
        openOnly: true,
        asOf: today,
      }).items.map((item) => ({ direction, item })),
    );
    const shape = (
      { direction, item }: (typeof items)[number],
      credit: boolean,
    ) => ({
      id: item.recordId,
      no: item.recordNumber ?? `#${item.recordId}`,
      kind: enumLabel(LedgerRecordKindLabels, item.kind),
      date: item.date,
      due: credit ? undefined : (item.dueDate ?? item.date),
      description: item.description,
      direction: direction === "owed-to-us" ? "owed_to_us" : "we_owe",
      amount: money(item.amountMinor),
      outstanding: money(item.outstandingMinor),
      days_overdue: credit ? undefined : item.daysOverdue,
      allocations_v:
        credit || item.kind === LedgerRecordKind.Payment
          ? allocationsV(item.recordId)
          : undefined,
    });
    const open = items
      .filter((x) => x.item.position !== "credit")
      .sort((a, b) => a.item.date.localeCompare(b.item.date));
    const credits = items.filter((x) => x.item.position === "credit");

    const history = categoryHistory(db, { contactId: contact.id, limit: 5 });
    const recent = listRecords(db, {
      contactId: contact.id,
      limit: 10,
      voided: "exclude",
    }).records;
    const versions = recordVersions(
      db,
      recent.map((r) => r.id),
    );
    const searchRecords = {
      tool: meta.nameOf("search_records"),
      args: { contact: contact.legalName },
    };

    return {
      id: contact.id,
      name: contact.legalName,
      roles: contact.roles.map(roleLabel),
      entity: enumLabel(EntityTypeLabels, contact.entityType),
      registration_no: contact.registrationNo,
      email: contact.email,
      phone: contact.phone,
      ...(args.detail === "full"
        ? { address: contact.address, remark: contact.remark }
        : {}),
      v: contactVersion(db, contact.id),
      currency: main,
      balances: {
        receivable: money(owedToUs),
        payable: money(weOwe),
        net: money(owedToUs - weOwe),
        credit: money(credit),
      },
      open_items: open.slice(0, OPEN_ITEM_CAP).map((x) => shape(x, false)),
      credits: credits.slice(0, OPEN_ITEM_CAP).map((x) => shape(x, true)),
      ...(open.length > OPEN_ITEM_CAP || credits.length > OPEN_ITEM_CAP
        ? {
            note: `Showing the first ${OPEN_ITEM_CAP} of ${open.length} open items and ${credits.length} credits; the drill call lists every record.`,
            drill: searchRecords,
          }
        : {}),
      category_usage: (history.entries[0]?.byContact ?? []).map((row) => ({
        category: row.name,
        count: row.count,
        last: row.lastDate,
        uncategorised_default: row.isUncategorisedDefault || undefined,
      })),
      recent: recent.map((r) => recordRow(r, versions[r.id], main)),
      recent_drill: searchRecords,
    };
  },
});

/** The contacts read tools, in listing order. */
export const contactsReadTools: readonly ToolDefinition[] = [
  findContacts,
  getContactTool,
];
