import { z } from "zod";
import {
  EntityTypeLabels,
  LedgerRecordKind,
  LedgerRecordKindLabels,
  RoleLabels,
} from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import { preparePaymentCorrection } from "../../../application/payment-corrections.js";
import {
  resolvePaymentMovement,
  similarity,
} from "../../../application/refs.js";
import {
  contactVersion,
  recordVersions,
} from "../../../application/version.js";
import { toMinor } from "../../../ledger/money.js";
import type { RecordView } from "../../../ledger/types.js";
import { categoryHistory } from "../../../queries/category-history.js";
import {
  countContacts,
  findDuplicates,
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
 * it totals. A contact's duplicates are `findDuplicates` plus a name
 * similarity pass over legal names with company suffixes dropped.
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

/** Words that make a name legal, not distinctive: "Acme Sdn Bhd" is "Acme". */
const LEGAL_FORM = new Set([
  "sdn",
  "bhd",
  "berhad",
  "pte",
  "ltd",
  "limited",
  "inc",
  "llc",
  "pty",
  "plt",
  "co",
  "corp",
  "the",
]);
const coreOf = (name: string) =>
  normalizeName(name)
    .split(" ")
    .filter((word) => word && !LEGAL_FORM.has(word))
    .join(" ");

/** How alike two cores must be to be offered as one party. High: lookalikes are common. */
const SIMILAR_NAME = 0.85;
/** Past this many contacts the pairwise pass is skipped; exact cores still group. */
const FUZZY_LIMIT = 1500;

type DuplicateGroup = { ids: number[]; matchedOn: string[] };

const SIGNAL_NAMES: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  registrationNo: "registration_no",
};

/** Contacts that look like one party: findDuplicates' clusters plus alike names. */
function duplicateGroups(db: Parameters<typeof findDuplicates>[0]): {
  groups: DuplicateGroup[];
  fuzzySkipped: boolean;
} {
  const everyone = listContacts(db, { limit: 1_000_000 });
  const parent = new Map<number, number>(everyone.map((c) => [c.id, c.id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  const exact = findDuplicates(db);
  for (const cluster of exact) {
    const ids = cluster.contacts.map((c) => c.id);
    for (const id of ids.slice(1)) union(ids[0], id);
  }
  // Signals follow the final root, so collect them once the groups are known.
  const exactSignals = exact.map((cluster) => ({
    ids: cluster.contacts.map((c) => c.id),
    on: cluster.matchedOn.map((s) => SIGNAL_NAMES[s] ?? s),
  }));

  const cores = everyone.map((c) => ({ id: c.id, core: coreOf(c.legalName) }));
  const similarPairs: [number, number][] = [];
  // Blocks: contacts sharing a word, or the first three letters of the core.
  const blocks = new Map<string, number[]>();
  const put = (key: string, id: number) =>
    (blocks.get(key) ?? blocks.set(key, []).get(key)!).push(id);
  for (const { id, core } of cores) {
    if (core.length < 3) continue;
    put(`c:${core}`, id);
    if (cores.length <= FUZZY_LIMIT) {
      put(`p:${core.slice(0, 3)}`, id);
      for (const word of core.split(" "))
        if (word.length >= 3) put(`w:${word}`, id);
    }
  }
  const coreById = new Map(cores.map((c) => [c.id, c.core]));
  const seen = new Set<string>();
  for (const [key, ids] of blocks) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        const pair = `${a}:${b}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const same = key.startsWith("c:");
        if (
          same ||
          similarity(coreById.get(a)!, coreById.get(b)!) >= SIMILAR_NAME
        )
          similarPairs.push([a, b]);
      }
  }
  for (const [a, b] of similarPairs) union(a, b);

  const members = new Map<number, number[]>();
  for (const { id } of everyone)
    (members.get(find(id)) ?? members.set(find(id), []).get(find(id))!).push(
      id,
    );
  const groups: DuplicateGroup[] = [];
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const idSet = new Set(ids);
    const on = new Set<string>();
    for (const entry of exactSignals)
      if (entry.ids.some((id) => idSet.has(id)))
        entry.on.forEach((s) => on.add(s));
    if (
      similarPairs.some(([a, b]) => idSet.has(a) && idSet.has(b)) &&
      !on.has("name")
    )
      on.add("similar_name");
    groups.push({ ids: ids.sort((a, b) => a - b), matchedOn: [...on] });
  }
  groups.sort((a, b) => b.ids.length - a.ids.length || a.ids[0] - b.ids[0]);
  return { groups, fuzzySkipped: cores.length > FUZZY_LIMIT };
}

const REGISTERED =
  /\b(sdn\.?\s*bhd|berhad|bhd|pte|ltd|limited|plt|llc|inc|pty)\b/i;

const FIND_DESCRIPTION = `Find the people and companies you deal with (customers, suppliers, employees, partners), or find contacts that look like duplicates.

Rows: id, name, roles, usage (how many records name the contact), v (version, for changes) and, when you may read balances, balance: the net owed to you from open items in the main currency (positive: they owe you; negative: you owe them; left out when nothing is open). Filters: query (name, registration number, email or phone), role, has_balance (needs records read too). detail: "full" adds registration number, email, phone and address.

duplicates: true returns groups instead: {matched_on, contacts, keep_hint}. Contacts group when they share a name (ignoring case and punctuation), an email, a phone number or a registration number, or when their names are alike once company suffixes such as Sdn Bhd are dropped (similar_name). keep_hint names the contact with the most records, or failing that the one whose legal name looks registered. Acronyms and brand names with an extra word are not grouped: search them with query. keep_hint is only a hint: read each with get_contact before changing anything. duplicates takes query to narrow, not role or has_balance.

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
      const { groups, fuzzySkipped } = duplicateGroups(db);
      const wanted = args.query ? normalizeName(args.query) : "";
      const everyone = new Map(
        listContacts(db, { limit: 1_000_000 }).map((c) => [c.id, c]),
      );
      const shown = groups.filter(
        (g) =>
          !wanted ||
          g.ids.some((id) => {
            const c = everyone.get(id)!;
            return (
              normalizeName(c.legalName).includes(wanted) ||
              (c.registrationNo ?? "")
                .toLowerCase()
                .includes(args.query!.toLowerCase())
            );
          }),
      );
      const slice = shown.slice(
        page.value.offset,
        page.value.offset + page.value.limit + 1,
      );
      const balances = mayBalance ? balancesNow(db) : undefined;
      const rows = slice.map((g) => {
        const contacts = rowsFor(
          g.ids.map((id) => everyone.get(id)!),
          balances,
        );
        const byRecords = [...contacts].sort(
          (a, b) => b.usage - a.usage || a.id - b.id,
        );
        const top = byRecords[0];
        const tied = byRecords.filter((c) => c.usage === top.usage);
        const registered = tied.find((c) => REGISTERED.test(c.name));
        const keep = tied.length > 1 ? (registered ?? top) : top;
        return {
          matched_on: g.matchedOn,
          contacts,
          keep_hint: {
            id: keep.id,
            name: keep.name,
            why:
              tied.length === 1
                ? `most records (${top.usage})`
                : registered
                  ? "its legal name looks registered"
                  : "lowest id",
          },
        };
      });
      return pageResult({
        rows,
        page: page.value,
        total: shown.length,
        narrow: "query",
        key: "groups",
        head: {
          currency: mayBalance ? mainCurrency(db) : undefined,
          ...(fuzzySkipped
            ? {
                note: "The book has many contacts, so similar names were only compared when they match exactly once company suffixes are dropped.",
              }
            : {}),
        },
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
