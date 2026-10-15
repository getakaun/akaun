import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getContact } from "$lib/server/queries/contacts.js";
import { patchContact, deleteContact } from "$lib/server/services/contacts.js";
import { can } from "$lib/server/permissions.js";
import { refused } from "$lib/server/api-response.js";

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "contacts.read"))
    return new Response("Not Found", { status: 404 });
  const id = parseInt(params.id!);
  const contact = getContact(db, id);
  if (!contact) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(contact);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "contacts.update"))
    return new Response("Forbidden", { status: 403 });
  const user = locals.user!;
  const id = parseInt(params.id!);
  if (!getContact(db, id))
    return Response.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const f of [
    "entityType",
    "legalName",
    "registrationNo",
    "email",
    "phone",
    "address",
    "remark",
  ]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }

  const updated = patchContact(db, id, user.id, patch);
  return Response.json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "contacts.delete"))
    return new Response("Forbidden", { status: 403 });
  const id = parseInt(params.id!);
  if (!getContact(db, id))
    return Response.json({ error: "Not found" }, { status: 404 });

  const result = deleteContact(db, id, locals.user!.id);
  if (!result.ok) return refused(result.reason);
  return new Response(null, { status: 204 });
};
