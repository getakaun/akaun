import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { users } from "$lib/server/db/schema.js";
import { findIdentity } from "$lib/server/oidc/accounts.js";
import {
  allowsPassword,
  readAuthentication,
} from "$lib/server/oidc/settings.js";
import type { RequestHandler } from "./$types.js";

export const GET: RequestHandler = ({ locals, cookies, setHeaders }) => {
  if (!locals.user || !cookies.get("session"))
    return new Response(null, { status: 401 });
  const settings = readAuthentication(db);
  const account = db
    .select({ managed: users.oidcManagedBy })
    .from(users)
    .where(eq(users.id, locals.user.id))
    .get();
  setHeaders({ "cache-control": "no-store" });
  return json({
    enabled: settings.enabled,
    displayName: settings.displayName,
    linked:
      settings.enabled &&
      !!findIdentity(db, settings.stored.authority, locals.user.id),
    passwordAllowed:
      !!account && !account.managed && allowsPassword(settings, locals.user.id),
  });
};
