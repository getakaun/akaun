import type { PageServerLoad } from "./$types.js";
import { loadTaxWorksheet } from "$lib/server/loaders/tax-worksheets.js";
export const load: PageServerLoad = ({ locals, params, url }) =>
  loadTaxWorksheet(locals, Number(params.id), url);
