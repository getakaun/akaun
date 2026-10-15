import { z } from "zod";
import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getContact, getContactRoles } from "$lib/server/queries/contacts.js";
import { replaceContactRoles } from "$lib/server/services/contacts.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, notFound } from "$lib/server/api-response.js";
import { Role } from "$lib/enums.js";

/**
 * A contact's roles, replaced as a whole set.
 *
 * Partner is the one role with a side effect: granting it creates that
 * partner's two accounts, removing it retires them. That happens in
 * `services/contacts.ts`, which every write path shares (FR-008b, D-08).
 */

const ROLE_CODES: number[] = Object.values(Role);

const rolesSchema = z.object({
  roles: z
    .array(
      z
        .number()
        .int()
        .refine((r) => ROLE_CODES.includes(r), {
          message: "That is not a role a contact can have.",
        }),
    )
    .default([]),
});

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "contacts.read"))
    return new Response("Not Found", { status: 404 });
  const id = parseInt(params.id!);
  if (!getContact(db, id)) return notFound("That contact no longer exists.");
  return Response.json({ roles: getContactRoles(db, id) });
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "contacts.update")) return forbidden();

  const parsed = rolesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const id = parseInt(params.id!);
  if (!getContact(db, id)) return notFound("That contact no longer exists.");

  return Response.json(
    replaceContactRoles(db, id, locals.user!.id, parsed.data.roles),
  );
};
