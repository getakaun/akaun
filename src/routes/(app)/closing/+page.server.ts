import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { closingPage } from "$lib/server/application/closing.js";

export const load: PageServerLoad = ({ locals, depends }) => {
  depends("app:closing");
  const result = closingPage({ db, locals });
  if (!result.ok) throw redirect(302, "/dashboard");
  return result.value;
};
