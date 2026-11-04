import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { listContacts } from "$lib/server/queries/contacts.js";
import { z } from "zod";
import {
  createContact,
  createContactShape,
} from "$lib/server/application/contacts.js";
import { toResponse } from "$lib/server/application/http.js";
import { badRequest } from "$lib/server/api-response.js";
import { can } from "$lib/server/permissions.js";

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "contacts.read"))
    return new Response("Not Found", { status: 404 });
  const p = url.searchParams;
  const roleRaw = p.get("role");
  const entityRaw = p.get("entityType");

  const results = listContacts(db, {
    role: roleRaw ? parseInt(roleRaw) : undefined,
    entityType: entityRaw ? parseInt(entityRaw) : undefined,
    search: p.get("search") ?? undefined,
  });

  return Response.json(results);
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!can(locals, "contacts.create"))
    return new Response("Forbidden", { status: 403 });
  const parsed = z
    .object(createContactShape)
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(
    createContact({ db, locals }, parsed.data),
    201,
    (value) => value.contact,
  );
};
