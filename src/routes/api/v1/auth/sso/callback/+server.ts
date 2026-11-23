import { redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { completeBrowserFlow } from "$lib/server/oidc/browser.js";
import type { RequestHandler } from "./$types.js";

export const GET: RequestHandler = async ({ cookies, url }) => {
  redirect(302, await completeBrowserFlow(db, cookies, url));
};
