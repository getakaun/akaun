import type { PageServerLoad } from "./$types.js";
import { loadFixedAssetsPage } from "$lib/server/loaders/fixed-assets.js";
export const load: PageServerLoad = ({ locals, url }) =>
  loadFixedAssetsPage(locals, url);
