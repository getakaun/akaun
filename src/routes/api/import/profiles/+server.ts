import { json } from "@sveltejs/kit";
import { z } from "zod";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { db } from "$lib/server/db/client.js";
import { profileRefused } from "$lib/server/import/profile-reply.js";
import { can } from "$lib/server/permissions.js";
import {
  createImportProfile,
  listImportProfiles,
} from "$lib/server/services/import-profiles.js";
import type { RequestHandler } from "./$types.js";

/**
 * Import profiles (006 US6, FR-030): list them, and add one.
 *
 * Listing needs `import.view`, the permission the upload screen already needs,
 * since "Read as" names the enabled profiles. Adding one is managing profiles,
 * which needs `import.change` (FR-045). The Settings loader has no permission
 * check of its own, so this route is where the rule is kept.
 *
 * The body of a POST is the profile's form, as the editor stages it. Zod only
 * checks that it is an object; what a profile may hold is checked by the one
 * shared check the editor also runs (`$lib/import-profile-schema.ts`), inside
 * the service, so the client and the server can never disagree about it. A
 * profile that breaks a rule is refused with every problem and its path, and
 * nothing is saved (FR-035 AS8).
 */

/** The body must at least be an object; the shared check reads the rest. */
const profileBody = z.record(z.string(), z.unknown());

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.read")) return forbidden();

  // `?enabled=1` gives only the ones "Read as" offers (US6 AS5, AS12).
  const enabledOnly = url.searchParams.get("enabled") === "1";
  return json(listImportProfiles(db, { enabledOnly }));
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.profiles")) return forbidden();

  const parsed = profileBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const created = createImportProfile(db, locals.user.id, parsed.data);
  if (!created.ok) return profileRefused(created);
  return json(created.value, { status: 201 });
};
