import { readAssetDepreciation } from "../application/depreciation.js";
import { error, redirect } from "@sveltejs/kit";
import { db } from "../db/client.js";
import { readFixedAssets } from "../application/fixed-assets.js";
import { assetCapitalHistory } from "../queries/capital-allowances.js";
import { can } from "../permissions.js";

export function loadFixedAssetsPage(locals: App.Locals, url: URL) {
  const result = readFixedAssets(
    { db, locals },
    url.searchParams.get("asAt") ?? new Date().toISOString().slice(0, 10),
  );
  if (!result.ok) {
    if (result.code === "FORBIDDEN") throw redirect(302, "/accounts");
    throw error(400, result.reason);
  }
  const legacyId = Number(url.searchParams.get("asset"));
  if (Number.isSafeInteger(legacyId) && legacyId > 0)
    throw redirect(302, `/assets/${legacyId}`);
  return { register: result.value, canChange: can(locals, "accounts.update") };
}

export function loadFixedAssetDetail(locals: App.Locals, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw redirect(302, "/assets");
  const result = readFixedAssets({ db, locals }, "9999-12-31");
  if (!result.ok) throw redirect(302, "/assets");
  const asset = result.value.assets.find((row) => row.id === id);
  if (!asset) throw redirect(302, "/assets");
  const depreciation = readAssetDepreciation({ db, locals }, id);
  return {
    taxHistory: can(locals, "tax.read") ? assetCapitalHistory(db, id) : [],
    depreciation: depreciation.ok ? depreciation.value : null,
    asset,
    accounts: result.value.accounts,
    canChange: can(locals, "accounts.update"),
  };
}
