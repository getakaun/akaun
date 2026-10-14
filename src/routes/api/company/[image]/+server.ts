import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { getSetting, SETTING_KEYS } from "$lib/server/settings.js";
import { fileStore } from "$lib/server/file-storage.js";
import { storedFileResponse } from "$lib/server/stored-file-response.js";

const SETTING_FOR_IMAGE: Record<string, string> = {
  logo: SETTING_KEYS.companyLogoPath,
  letterhead: SETTING_KEYS.companyLetterheadPath,
};

/**
 * The company logo or letterhead. Any signed-in user may see them: they are
 * printed on every invoice and quotation. The path comes from a settings key
 * that only the upload can write (see `api/settings/+server.ts`), never from
 * the request.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });

  const key = Object.hasOwn(SETTING_FOR_IMAGE, params.image)
    ? SETTING_FOR_IMAGE[params.image]
    : undefined;
  const path = key ? getSetting(db, key) : null;
  if (!path) return new Response("Not found", { status: 404 });

  return storedFileResponse(fileStore(), request, path, params.image);
};
