import type { PageServerLoad } from "./$types.js";
import { error } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { readAssetTaxSchemes } from "$lib/server/application/asset-tax-schemes.js";
import { can } from "$lib/server/permissions.js";

/** Focused configuration page: tax access never grants access to general/admin settings. */
export const load: PageServerLoad = ({ locals }) => {
  const result = readAssetTaxSchemes({ db, locals });
  if (!result.ok) throw error(403, result.reason);
  return {
    schemes: result.value,
    canManage: can(locals, "tax.update"),
    canSeeSettings: can(locals, "settings.read"),
  };
};
