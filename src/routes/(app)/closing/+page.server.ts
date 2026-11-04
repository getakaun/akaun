import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";
import type { PageServerLoad } from "./$types.js";

/** Keep existing bookmarks while the book-wide workspace lives under Accounts. */
export const load: PageServerLoad = () =>
  redirect(302, resolve("/(app)/accounts/closing"));
