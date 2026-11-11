import { asc } from "drizzle-orm";
import { assetTaxSchemes } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import type { AppliedAssetTaxScheme } from "$lib/asset-tax-scheme.js";
export function assetTaxSchemeVersions(db: LedgerDb) {
  return db
    .select()
    .from(assetTaxSchemes)
    .orderBy(asc(assetTaxSchemes.id))
    .all();
}
export function schemeSnapshot(
  row: typeof assetTaxSchemes.$inferSelect,
): AppliedAssetTaxScheme {
  return {
    id: row.id,
    familyKey: row.familyKey,
    version: row.version,
    definition: row.definition,
    verification: "custom_unverified",
  };
}

export type AssetTaxSchemeVersion = ReturnType<
  typeof assetTaxSchemeVersions
>[number];
