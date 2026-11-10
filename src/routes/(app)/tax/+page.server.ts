import type { PageServerLoad } from "./$types.js";
import { loadTaxWorksheets } from "$lib/server/loaders/tax-worksheets.js";
export const load: PageServerLoad = ({ locals }) => loadTaxWorksheets(locals);
