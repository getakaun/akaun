import { json } from "@sveltejs/kit";
import { z } from "zod";
import { Role } from "$lib/enums.js";
import { db } from "$lib/server/db/client.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { can } from "$lib/server/permissions.js";
import { findContactByName } from "$lib/server/queries/contacts.js";
import type { RequestHandler } from "./$types.js";

const schema = z.object({
  name: z.string().trim().min(1),
  role: z.union([z.literal(Role.Supplier), z.literal(Role.Customer)]),
});

// Read-only preview; confirming the import still resolves against the current DB.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.read")) return forbidden();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  return json({
    existing: findContactByName(db, parsed.data.name, parsed.data.role) != null,
  });
};
