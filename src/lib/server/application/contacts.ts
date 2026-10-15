import { z } from "zod";
import { EntityType, Role } from "$lib/enums.js";
import { getContact } from "../queries/contacts.js";
import {
  createContact as createContactService,
  deleteContact as deleteContactService,
  patchContact,
  replaceContactRoles,
} from "../services/contacts.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, missing, ok, type AppResult } from "./result.js";
import { checkVersion, contactVersion } from "./version.js";

/**
 * Contacts — the purchase and sales ledger's "who" (CLAUDE.md, The three
 * ledgers) — as authorized operations.
 *
 * Nothing validated a contact's fields before these: the routes copied what
 * the body held. The shapes here are the first schema, and they describe only
 * what the forms already send.
 */

const ROLE_CODES: number[] = Object.values(Role);
const ENTITY_TYPES: number[] = Object.values(EntityType);

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

export const contactFieldsShape = {
  entityType: z
    .number()
    .int()
    .refine((value) => ENTITY_TYPES.includes(value), {
      message: "Choose individual (1) or business (2).",
    })
    .describe("1 individual, 2 business."),
  legalName: z.string().trim().min(1).max(200),
  registrationNo: optionalText(100),
  email: optionalText(200),
  phone: optionalText(100),
  address: optionalText(1000),
  remark: optionalText(2000),
};

export const rolesShape = z
  .array(
    z
      .number()
      .int()
      .refine((role) => ROLE_CODES.includes(role), {
        message: "That is not a role a contact can have.",
      }),
  )
  .describe("Role codes: 1 customer, 2 supplier, 3 employee, 4 partner.");

export const createContactShape = {
  ...contactFieldsShape,
  roles: rolesShape.default([]),
};

export const updateContactShape = {
  entityType: contactFieldsShape.entityType.optional(),
  legalName: contactFieldsShape.legalName.optional(),
  registrationNo: optionalText(100),
  email: optionalText(200),
  phone: optionalText(100),
  address: optionalText(1000),
  remark: optionalText(2000),
  /** Replaces every role the contact has. Omit to leave them as they are. */
  roles: rolesShape.optional(),
};

type Contact = NonNullable<ReturnType<typeof getContact>>;
export type ContactWritten = { contact: Contact; version: string };

const NOT_FOUND = "That contact no longer exists.";

export function createContact(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof createContactShape>>,
): AppResult<ContactWritten> {
  const refused = requirePermissions(ctx, ["contacts.create"]);
  if (refused) return refused;
  const contact = createContactService(ctx.db, actor(ctx), input);
  return ok({ contact, version: contactVersion(ctx.db, contact.id) });
}

export function updateContact(
  ctx: AppContext,
  id: number,
  input: z.output<z.ZodObject<typeof updateContactShape>>,
  expectedVersion?: string,
): AppResult<ContactWritten> {
  const refused = requirePermissions(ctx, ["contacts.update"]);
  if (refused) return refused;
  if (!getContact(ctx.db, id)) return missing(NOT_FOUND);
  const stale = checkVersion(contactVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;

  const { roles, ...fields } = input;
  const patch = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(patch).length > 0)
    patchContact(ctx.db, id, actor(ctx), patch);
  if (roles !== undefined) replaceContactRoles(ctx.db, id, actor(ctx), roles);
  const contact = getContact(ctx.db, id);
  if (!contact) return missing(NOT_FOUND);
  return ok({ contact, version: contactVersion(ctx.db, id) });
}

export function deleteContact(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, ["contacts.delete"]);
  if (refused) return refused;
  if (!getContact(ctx.db, id)) return missing(NOT_FOUND);
  const stale = checkVersion(contactVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  // A contact a record, quotation or invoice names is refused, with the
  // sentence the screen shows (FR-009a).
  const result = deleteContactService(ctx.db, id, actor(ctx));
  return result.ok ? ok({ id }) : fail("REFUSED", result.reason);
}
