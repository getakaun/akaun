import { error, redirect } from "@sveltejs/kit";
import { db } from "../db/client.js";
import { readFixedAssets } from "../application/fixed-assets.js";
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
  return { register: result.value, canChange: can(locals, "accounts.update") };
}
