import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getContact } from "$lib/server/queries/contacts.js";
import { z } from "zod";
import {
  updateContact,
  updateContactShape,
  deleteContact,
} from "$lib/server/application/contacts.js";
import { toResponse } from "$lib/server/application/http.js";
import { can } from "$lib/server/permissions.js";
import { badRequest } from "$lib/server/api-response.js";

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
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = z
    .object(updateContactShape)
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(
    updateContact({ db, locals }, id, parsed.data),
    200,
    (value) => value.contact,
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "contacts.delete"))
    return new Response("Forbidden", { status: 403 });
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return Response.json({ error: "Not found" }, { status: 404 });
  return toResponse(deleteContact({ db, locals }, id), 204);
};
