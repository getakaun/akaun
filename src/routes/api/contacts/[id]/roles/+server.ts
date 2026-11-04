import { z } from "zod";
import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getContact, getContactRoles } from "$lib/server/queries/contacts.js";
import { updateContact, rolesShape } from "$lib/server/application/contacts.js";
import { toResponse } from "$lib/server/application/http.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, notFound } from "$lib/server/api-response.js";

/** Replace roles through the same authorized, atomic contact operation. */
const rolesSchema = z.object({ roles: rolesShape.default([]) });

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

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return notFound("That contact no longer exists.");
  return toResponse(
    updateContact({ db, locals }, id, parsed.data),
    200,
    (value) => value.contact,
  );
};
