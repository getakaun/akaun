import type { PageServerLoad } from "./$types.js";
import { loadFixedAssetDetail } from "$lib/server/loaders/fixed-assets.js";
export const load: PageServerLoad = ({ locals, params }) =>
  loadFixedAssetDetail(locals, Number(params.id));
