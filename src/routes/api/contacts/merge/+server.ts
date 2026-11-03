import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { mergeContacts } from "$lib/server/application/contacts.js";
import { toResponse } from "$lib/server/application/http.js";
import { can } from "$lib/server/permissions.js";

export const POST: RequestHandler = async ({ locals, request }) => {
  if (
    !can(locals, "contacts.merge") ||
    !can(locals, "contacts.update") ||
    !can(locals, "contacts.delete")
  )
    return new Response("Forbidden", { status: 403 });
  return toResponse(
    mergeContacts({ db, locals }, await request.json().catch(() => null)),
    200,
    (value) => value.contact,
  );
};
