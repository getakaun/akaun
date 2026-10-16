import type { PageServerLoad } from "./$types.js";
import { loadDashboardPage } from "$lib/server/loaders/dashboard.js";

export const load: PageServerLoad = ({ locals, url }) =>
  loadDashboardPage(locals, url);
