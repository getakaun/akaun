import { json } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { readAuthentication } from "$lib/server/oidc/settings.js";
import type { RequestHandler } from "./$types.js";

export const GET: RequestHandler = () => {
  const settings = readAuthentication(db);
  return json({
    oidcEnabled: settings.enabled,
    displayName: settings.displayName,
    internalAuthenticationEnabled: settings.internalEnabled,
  });
};
