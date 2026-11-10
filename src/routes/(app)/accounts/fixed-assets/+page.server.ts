import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
export const load: PageServerLoad = ({ url }) => {
  throw redirect(308, `/assets${url.search}`);
};
