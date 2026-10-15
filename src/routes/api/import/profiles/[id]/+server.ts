import { json } from "@sveltejs/kit";
import { z } from "zod";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { db } from "$lib/server/db/client.js";
import {
  profileIdParam,
  profileNotFound,
  profileRefused,
} from "$lib/server/import/profile-reply.js";
import { can } from "$lib/server/permissions.js";
import {
  deleteImportProfile,
  getImportProfile,
  setImportProfileEnabled,
  updateImportProfile,
  type ImportProfileView,
} from "$lib/server/services/import-profiles.js";
import type { RequestHandler } from "./$types.js";

/**
 * One import profile (006 US6, FR-030, FR-038): read it for the editor, save
 * the editor's form, turn it on or off, or delete it.
 *
 * Reading a profile needs `import.view`, as the list and the editor page do:
 * seeing a profile is not changing it, and a user who may only view imports
 * sees the editor read-only. Every other verb here manages profiles, so it
 * needs `import.change` (FR-045).
 *
 * Every write is audited by the service in the same transaction as the write.
 * A document already read with the profile keeps its own copy of it, so no
 * change here alters a group already read (FR-038).
 */

/**
 * A PATCH is the editor's whole form, `enabled`, or both. `enabled` alone
 * turns the profile on or off and leaves the form as it is. Any other field
 * means the form is being saved, and the body is then the whole form, as the
 * editor stages it and sends it once (the Settings pattern): a field left out
 * is refused by the shared check, never kept from before. Fields the form does
 * not have, such as `id` or `createdAt` when the editor sends back what it
 * loaded, are dropped by that check.
 */
const patchBody = z
  .record(z.string(), z.unknown())
  .and(z.object({ enabled: z.boolean().optional() }));

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.read")) return forbidden();

  const id = profileIdParam(params.id);
  const profile = id === null ? null : getImportProfile(db, id);
  if (!profile) return profileNotFound();
  return json(profile);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.profiles")) return forbidden();

  const id = profileIdParam(params.id);
  if (id === null) return profileNotFound();

  const parsed = patchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const { enabled, ...form } = parsed.data;
  const savesForm = Object.keys(form).length > 0;
  if (!savesForm && enabled === undefined) {
    return Response.json(
      {
        error: "Nothing to change: send the profile's form, enabled, or both.",
      },
      { status: 400 },
    );
  }

  // The form first: when it is refused, nothing is written, the switch
  // included. Both writes run with no wait between them, so no other request
  // can come in between.
  let saved: ImportProfileView | null = null;
  if (savesForm) {
    const updated = updateImportProfile(db, locals.user.id, id, form);
    if (!updated.ok) return profileRefused(updated);
    saved = updated.value;
  }
  if (enabled !== undefined) {
    const switched = setImportProfileEnabled(db, locals.user.id, id, enabled);
    if (!switched.ok) return profileRefused(switched);
    saved = switched.value;
  }
  return json(saved);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.profiles")) return forbidden();

  const id = profileIdParam(params.id);
  if (id === null) return profileNotFound();

  const deleted = deleteImportProfile(db, locals.user.id, id);
  if (!deleted.ok) return profileRefused(deleted);
  return new Response(null, { status: 204 });
};
