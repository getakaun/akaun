import { z } from "zod";
import { asc, inArray, or } from "drizzle-orm";
import { EntityType, EntityTypeLabels, RoleLabels } from "$lib/enums.js";
import { can } from "../../../permissions.js";
import { contacts, ledgerRecords } from "../../../db/schema.js";
import { runBatch } from "../../../application/batch.js";
import type { AppContext } from "../../../application/context.js";
import {
  createContact,
  deleteContact,
  mergeContacts,
  updateContact,
} from "../../../application/contacts.js";
import type { ContactBrief } from "../../../application/refs.js";
import { fail, ok, type AppResult } from "../../../application/result.js";
import { contactVersion } from "../../../application/version.js";
import type { LedgerDb } from "../../../ledger/types.js";
import {
  getContact,
  getContactUsageCounts,
  normalizeName,
  rolesForContacts,
} from "../../../queries/contacts.js";
import { currentUnitOfWork } from "../../../unit-of-work.js";
import { batchToolResult } from "../../batch-result.js";
import { enumCodec } from "../../format.js";
import { defineWriteTool, type ToolDefinition } from "../../registry.js";
import { CHANGE_CONTACTS } from "../../requirements/index.js";
import {
  batchControls,
  idempotencyOf,
  nothingToDo,
  refInput,
  refuseActions,
  Refs,
  SPLIT_CALL,
} from "./payments.js";

/**
 * The contacts write tool: `change_contacts`.
 *
 * It only parses, resolves references and formats. Every rule lives in
 * `application/contacts.ts`: who may do what, a contact a record names cannot
 * be deleted, a merge moves everything and deletes the merged contacts. Each
 * item calls exactly one of those operations, and the batch rolls the whole
 * call back when any item fails or the call is a dry run.
 *
 * References are resolved before the batch opens, so every miss in a call is
 * reported together as `NOT_FOUND` / `AMBIGUOUS` with candidates, and nothing
 * runs.
 */

const roleCodec = enumCodec(RoleLabels);
const entityCodec = enumCodec(EntityTypeLabels);

/** `business` and `individual`, as the reads say them; `company` is accepted for `business`. */
const ENTITY_WORDS = [...entityCodec.labels, "company"] as [
  string,
  ...string[],
];
const entityInput = z
  .enum(ENTITY_WORDS)
  .describe(
    "business (a company or other organisation) or individual (a person).",
  );
const entityCodeOf = (word: string): number =>
  word === "company" ? EntityType.Business : entityCodec.code(word)!;

const roleInput = z.enum(roleCodec.labels);

const NAME = z.string().trim().min(1).max(200);
/** A text detail on create. */
const detail = (max: number) => z.string().trim().max(max);
/** A text detail on update: an empty string or null clears it. */
const clearable = (max: number) => z.string().trim().max(max).nullable();

const MERGE_LIMIT = 20;

const createItem = z
  .object({
    name: NAME.describe("The contact's legal name."),
    entity: entityInput,
    roles: z
      .array(roleInput)
      .min(1)
      .max(4)
      .describe("customer, supplier, employee and/or partner."),
    registration_no: detail(100).optional(),
    email: detail(200).optional(),
    phone: detail(100).optional(),
    address: detail(1000).optional(),
    remark: detail(2000).optional(),
    force_new: z
      .boolean()
      .optional()
      .describe(
        "true: create it even though a contact with this name exists. Only when it really is another contact.",
      ),
  })
  .strict();
type CreateItem = z.output<typeof createItem>;

const setInput = z
  .object({
    name: NAME.optional(),
    entity: entityInput.optional(),
    roles: z
      .array(roleInput)
      .max(4)
      .optional()
      .describe(
        "REPLACES the whole role list: send every role the contact should have.",
      ),
    registration_no: clearable(100).optional(),
    email: clearable(200).optional(),
    phone: clearable(100).optional(),
    address: clearable(1000).optional(),
    remark: clearable(2000).optional(),
  })
  .strict();

const versionInput = z
  .string()
  .min(1)
  .describe("The contact's v from when it was read. A stale one is CONFLICT.");

const updateItem = z
  .object({
    contact: refInput.describe("The contact: id or exact name."),
    expected_version: versionInput,
    set: setInput,
  })
  .strict();
type UpdateItem = z.output<typeof updateItem>;

const mergeItem = z
  .object({
    keep: refInput.describe("The contact that stays: id or exact name."),
    merge: z
      .array(refInput)
      .min(1)
      .max(MERGE_LIMIT)
      .describe(
        "The duplicates folded into keep, then deleted. Each is an id or exact name.",
      ),
    expected_versions: z
      .record(z.string(), z.string().min(1))
      .describe(
        'Each contact\'s v, keyed by id, for keep and every merged contact: {"12": "ab12...", "15": "cd34..."}.',
      ),
  })
  .strict();
type MergeItem = z.output<typeof mergeItem>;

const deleteItem = z
  .object({
    contact: refInput.describe("The contact: id or exact name."),
    expected_version: versionInput,
  })
  .strict();

const changeContactsInput = z.object({
  create: z.array(createItem).max(50, SPLIT_CALL).optional(),
  update: z.array(updateItem).max(50, SPLIT_CALL).optional(),
  merge: z.array(mergeItem).max(50, SPLIT_CALL).optional(),
  delete: z.array(deleteItem).max(50, SPLIT_CALL).optional(),
  ...batchControls,
});
type ChangeContactsArgs = z.output<typeof changeContactsInput>;

const DESCRIPTION = `Create, edit, merge or delete contacts (suppliers, customers, employees, partners). Look contacts up first with the contact reads: they give each id and v, and flag duplicates.

- create[]: name, entity (business or individual), roles (customer, supplier, employee, partner), optional registration_no, email, phone, address, remark. A name that already exists is refused with the existing contacts listed; send force_new: true only when it really is another contact.
- update[]: contact (id or exact name), expected_version (its v), set {name, entity, roles, registration_no, email, phone, address, remark}. roles REPLACES the whole list, so send every role the contact should have. An empty string or null clears a text field.
- merge[]: keep, merge (the duplicates), expected_versions ({"<id>": v} for keep and each merged contact). Every record, quotation and invoice of the merged contacts moves to keep, their roles are added, blank details are filled in, and they are deleted. A MERGE CANNOT BE UNDONE: always run it with dry_run: true first, show the user which records move, and merge only after they agree. One item per kept contact. Needs the merge permission (the contacts:merge scope).
- delete[]: contact, expected_version. Refused while a record, quotation or invoice names the contact; merge it instead.

Up to 50 items per call, saved together or not at all. dry_run: true saves nothing and shows the result; idempotency_key makes a retried call return the first result.`;

type Value = Record<string, unknown>;
type Contact = NonNullable<ReturnType<typeof getContact>>;

/** The details of a contact as an agent reads them, for the before/after of an update. */
function facts(contact: Contact): Record<string, unknown> {
  return {
    name: contact.legalName,
    entity: entityCodec.label(contact.entityType),
    roles: contact.roles.map((role) => roleCodec.label(role)),
    registration_no: contact.registrationNo,
    email: contact.email,
    phone: contact.phone,
    address: contact.address,
    remark: contact.remark,
  };
}

/** The fields whose value differs, as `{ from, to }`. An empty value is left out of its side. */
function changesBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      out[key] = { from: before[key], to: after[key] };
  return out;
}

const blankToNull = (value: string | null) =>
  value === null || value.trim() === "" ? null : value;

const uniqueRoles = (labels: readonly string[]) => [
  ...new Set(labels.map((label) => roleCodec.code(label)!)),
];

const isDryRun = () => currentUnitOfWork()?.mode === "dry_run";

// --- create -------------------------------------------------------------------

type CreatePlan = { path: string; item: CreateItem; mayRead: boolean };

/** The contacts that already carry this name, best first. */
function sameName(db: LedgerDb, name: string) {
  const wanted = normalizeName(name);
  const same = db
    .select({ id: contacts.id, legalName: contacts.legalName })
    .from(contacts)
    .all()
    .filter((row) => normalizeName(row.legalName) === wanted);
  const roles = rolesForContacts(
    db,
    same.map((row) => row.id),
  );
  return same.slice(0, 5).map((row) => ({
    id: row.id,
    name: row.legalName,
    roles: (roles[row.id] ?? [])
      .map((role) => roleCodec.label(role))
      .filter(Boolean)
      .join(", "),
  }));
}

function planCreates(refs: Refs, items: CreateItem[]): CreatePlan[] {
  // Only a caller who may read contacts is told which ones exist.
  const mayRead = can(refs.ctx.locals, "contacts.read");
  const named = new Map<string, number>();
  return items.map((item, i) => {
    const path = `create[${i}]`;
    if (!item.force_new) {
      const key = normalizeName(item.name);
      const earlier = named.get(key);
      if (earlier !== undefined)
        refs.invalid(
          `${path}.name`,
          `"${item.name}" is also created in create[${earlier}].`,
          "Create it once, or send force_new: true if they really are two contacts.",
        );
      else named.set(key, i);
    }
    return { path, item, mayRead };
  });
}

function runCreate(ctx: AppContext, plan: CreatePlan): AppResult<Value> {
  const { item } = plan;
  // Looked for here, inside the batch, so that a retry with the same
  // idempotency_key replays the first result instead of meeting the contact
  // it just made.
  if (!item.force_new && plan.mayRead) {
    const same = sameName(ctx.db, item.name);
    if (same.length)
      return fail(
        "REFUSED",
        `${plan.path}.name: a contact named "${item.name}" already exists: ${same
          .map((c) => `${c.name} (id ${c.id}${c.roles ? `, ${c.roles}` : ""})`)
          .join(
            "; ",
          )}. To change it, use update with its id. If it really is another contact, send this create item again with force_new: true.`,
      );
  }
  const created = createContact(ctx, {
    entityType: entityCodeOf(item.entity),
    legalName: item.name,
    registrationNo: item.registration_no || null,
    email: item.email || null,
    phone: item.phone || null,
    address: item.address || null,
    remark: item.remark || null,
    roles: uniqueRoles(item.roles),
  });
  if (!created.ok) return created;
  const { contact, version } = created.value;
  return ok({
    id: contact.id,
    name: contact.legalName,
    entity: entityCodec.label(contact.entityType),
    roles: contact.roles.map((role) => roleCodec.label(role)),
    v: version,
  });
}

// --- update -------------------------------------------------------------------

type UpdatePlan = { path: string; contact: ContactBrief; item: UpdateItem };

function planUpdates(refs: Refs, items: UpdateItem[]): UpdatePlan[] {
  return items.flatMap((item, i) => {
    const path = `update[${i}]`;
    const contact = refs.contact(item.contact, `${path}.contact`);
    if (Object.values(item.set).every((value) => value === undefined))
      refs.invalid(
        `${path}.set`,
        "Nothing to change.",
        "Send at least one of name, entity, roles, registration_no, email, phone, address, remark in set.",
      );
    return contact ? [{ path, contact, item }] : [];
  });
}

function runUpdate(ctx: AppContext, plan: UpdatePlan): AppResult<Value> {
  const { set } = plan.item;
  const before = getContact(ctx.db, plan.contact.id);
  const updated = updateContact(
    ctx,
    plan.contact.id,
    {
      ...(set.name !== undefined ? { legalName: set.name } : {}),
      ...(set.entity !== undefined
        ? { entityType: entityCodeOf(set.entity) }
        : {}),
      ...(set.registration_no !== undefined
        ? { registrationNo: blankToNull(set.registration_no) }
        : {}),
      ...(set.email !== undefined ? { email: blankToNull(set.email) } : {}),
      ...(set.phone !== undefined ? { phone: blankToNull(set.phone) } : {}),
      ...(set.address !== undefined
        ? { address: blankToNull(set.address) }
        : {}),
      ...(set.remark !== undefined ? { remark: blankToNull(set.remark) } : {}),
      ...(set.roles !== undefined ? { roles: uniqueRoles(set.roles) } : {}),
    },
    plan.item.expected_version,
  );
  if (!updated.ok) return updated;
  const { contact, version } = updated.value;
  const changes = before
    ? changesBetween(facts(before), facts(contact))
    : undefined;
  return ok({
    id: contact.id,
    name: contact.legalName,
    changes,
    note:
      changes && Object.keys(changes).length === 0
        ? "Nothing changed: the contact already had these values."
        : undefined,
    v: version,
  });
}

// --- merge --------------------------------------------------------------------

type MergePlan = {
  path: string;
  keep: ContactBrief;
  merge: ContactBrief[];
  versions: Map<number, string>;
};

/** The id a key of `expected_versions` names: `"12"` or `"#12"`. */
const keyId = (key: string): number | null => {
  const match = /^#?(\d+)$/.exec(key.trim());
  return match ? Number(match[1]) : null;
};

function planMerges(refs: Refs, items: MergeItem[]): MergePlan[] {
  const claimed = new Map<number, string>();
  return items.flatMap((item, i) => {
    const path = `merge[${i}]`;
    const keep = refs.contact(item.keep, `${path}.keep`);
    const merge = item.merge.flatMap((ref, j) => {
      const found = refs.contact(ref, `${path}.merge[${j}]`);
      return found ? [found] : [];
    });
    if (!keep || merge.length !== item.merge.length) return [];

    // One item per kept contact: an item's merge changes the kept contact's
    // version, so a second item naming it could never carry the right one.
    const named = [keep, ...merge];
    let clash = false;
    const inThisItem = new Set<number>();
    for (const [index, contact] of named.entries()) {
      const where = index === 0 ? `${path}.keep` : `${path}.merge`;
      if (inThisItem.has(contact.id)) {
        clash = true;
        refs.invalid(
          where,
          `${contact.legalName} (#${contact.id}) is named more than once in this item.`,
          "Name each contact once: keep is not also in merge, and merge lists each contact once.",
        );
      } else if (claimed.has(contact.id)) {
        clash = true;
        refs.invalid(
          where,
          `${contact.legalName} (#${contact.id}) is also named in ${claimed.get(contact.id)}.`,
          "Use one merge item per kept contact: put every duplicate of it in that item's merge list, and name no contact in two items.",
        );
      }
      inThisItem.add(contact.id);
      claimed.set(contact.id, claimed.get(contact.id) ?? path);
    }
    if (clash) return [];

    const versions = new Map<number, string>();
    for (const [key, version] of Object.entries(item.expected_versions)) {
      const id = keyId(key);
      if (id === null || !named.some((c) => c.id === id)) {
        refs.invalid(
          `${path}.expected_versions`,
          `"${key}" is not the id of a contact in this merge.`,
          "Key expected_versions by the ids of keep and the merged contacts only.",
        );
        continue;
      }
      versions.set(id, version);
    }
    for (const contact of named)
      if (!versions.has(contact.id))
        refs.invalid(
          `${path}.expected_versions`,
          `The version of ${contact.legalName} (#${contact.id}) is missing.`,
          `Add "${contact.id}": its v, from ${refs.meta.nameOf("find_contacts")} or ${refs.meta.nameOf("get_contact")}.`,
        );
    return versions.size === named.length
      ? [{ path, keep, merge, versions }]
      : [];
  });
}

const MOVED_LISTED = 25;

/** The records each contact is named on (as contact or supplier), oldest first. */
function recordsOf(db: LedgerDb, ids: number[]) {
  const rows = db
    .select({
      id: ledgerRecords.id,
      no: ledgerRecords.recordNumber,
      contactId: ledgerRecords.contactId,
      supplierContactId: ledgerRecords.supplierContactId,
    })
    .from(ledgerRecords)
    .where(
      or(
        inArray(ledgerRecords.contactId, ids),
        inArray(ledgerRecords.supplierContactId, ids),
      ),
    )
    .orderBy(asc(ledgerRecords.date), asc(ledgerRecords.id))
    .all();
  const byContact = new Map<number, { id: number; no: string }[]>();
  for (const row of rows)
    for (const id of new Set([row.contactId, row.supplierContactId]))
      if (id !== null && ids.includes(id)) {
        const list = byContact.get(id) ?? [];
        list.push({ id: row.id, no: row.no ?? `#${row.id}` });
        byContact.set(id, list);
      }
  return byContact;
}

function runMerge(
  ctx: AppContext,
  plan: MergePlan,
  findTool: string,
): AppResult<Value> {
  const everyone = [plan.keep, ...plan.merge];
  const stale = everyone.flatMap((contact) => {
    const current = contactVersion(ctx.db, contact.id);
    return current === plan.versions.get(contact.id)
      ? []
      : [{ contact, current }];
  });
  if (stale.length)
    return {
      ...fail(
        "CONFLICT",
        `${stale
          .map(
            ({ contact, current }) =>
              `${contact.legalName} (#${contact.id}) is now at v ${current}`,
          )
          .join(
            "; ",
          )}. Read ${stale.length === 1 ? "it" : "them"} again with ${findTool}, check the merge still makes sense, then retry with the current versions.`,
      ),
      currentVersion: stale[0].current,
    };

  // What will move, read before it does.
  const ids = plan.merge.map((contact) => contact.id);
  const records = recordsOf(ctx.db, ids);
  const usage = getContactUsageCounts(ctx.db, ids);
  const merged = mergeContacts(ctx, {
    survivorId: plan.keep.id,
    loserIds: ids,
  });
  if (!merged.ok) return merged;
  const { contact, version } = merged.value;
  return ok({
    kept: {
      id: contact.id,
      name: contact.legalName,
      roles: contact.roles.map((role) => roleCodec.label(role)),
      v: version,
    },
    merged: plan.merge.map((loser) => {
      const moved = records.get(loser.id) ?? [];
      return {
        id: loser.id,
        name: loser.legalName,
        records: moved.slice(0, MOVED_LISTED),
        records_total: moved.length,
        more:
          moved.length > MOVED_LISTED
            ? `${moved.length - MOVED_LISTED} more records moved`
            : undefined,
        quotations: usage[loser.id]?.quotations || undefined,
        invoices: usage[loser.id]?.invoices || undefined,
      };
    }),
    note: isDryRun()
      ? "Dry run: nothing was merged. A merge cannot be undone, so show the user what moves and merge only after they agree."
      : "Merged. The merged contacts no longer exist, and this cannot be undone.",
  });
}

// --- delete -------------------------------------------------------------------

type DeletePlan = { path: string; contact: ContactBrief; version: string };

function runDelete(ctx: AppContext, plan: DeletePlan): AppResult<Value> {
  const deleted = deleteContact(ctx, plan.contact.id, plan.version);
  if (!deleted.ok) return deleted;
  return ok({ id: plan.contact.id, name: plan.contact.legalName });
}

// --- the tool -----------------------------------------------------------------

const changeContacts = defineWriteTool({
  base: "change_contacts",
  title: "Change contacts",
  description: DESCRIPTION,
  input: changeContactsInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: CHANGE_CONTACTS.requirements,
  actions: CHANGE_CONTACTS.actions,
  handler: async (ctx, args: ChangeContactsArgs, meta) => {
    const refused = refuseActions(ctx, meta, "change_contacts", args);
    if (refused) return refused;
    if (
      !args.create?.length &&
      !args.update?.length &&
      !args.merge?.length &&
      !args.delete?.length
    )
      return nothingToDo("create, update, merge or delete");

    const refs = new Refs(ctx, meta);
    const creates = planCreates(refs, args.create ?? []);
    const updates = planUpdates(refs, args.update ?? []);
    const merges = planMerges(refs, args.merge ?? []);
    const deletes = (args.delete ?? []).flatMap((item, i): DeletePlan[] => {
      const path = `delete[${i}]`;
      const contact = refs.contact(item.contact, `${path}.contact`);
      return contact ? [{ path, contact, version: item.expected_version }] : [];
    });
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<Value>(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items: [
        ...creates.map((plan) => ({
          action: "create",
          label: `${plan.path} ${plan.item.name}`,
          run: (c: AppContext) => runCreate(c, plan),
        })),
        ...updates.map((plan) => ({
          action: "update",
          label: `${plan.path} ${plan.contact.legalName}`,
          run: (c: AppContext) => runUpdate(c, plan),
        })),
        ...merges.map((plan) => ({
          action: "merge",
          label: `${plan.path} into ${plan.keep.legalName}`,
          run: (c: AppContext) =>
            runMerge(c, plan, meta.nameOf("find_contacts")),
        })),
        ...deletes.map((plan) => ({
          action: "delete",
          label: `${plan.path} ${plan.contact.legalName}`,
          run: (c: AppContext) => runDelete(c, plan),
        })),
      ],
      idempotency: idempotencyOf(args, {
        create: args.create,
        update: args.update,
        merge: args.merge,
        delete: args.delete,
      }),
    });
    return batchToolResult(result, {
      requestId: meta.requestId,
      formatValue: (value) => value,
    });
  },
});

/** The contacts write tools, in listing order. */
export const contactsWriteTools: readonly ToolDefinition[] = [changeContacts];
