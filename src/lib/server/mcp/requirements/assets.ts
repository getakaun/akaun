import { write, writeTool } from "./define.js";

/**
 * Fixed assets: `manage_fixed_assets`. No v1 tool did this, so each action
 * asks exactly what its operation asks. There are no fixed-asset leaves in
 * the catalog: the operations ask for accounts and records leaves, which the
 * existing scopes already stand for, so no new scope is needed.
 */

/** `registerFixedAsset` / `updateFixedAsset` (`WRITE_PERMISSIONS` in `application/fixed-assets.ts`). */
const ASSET_WRITE = write(
  ["accounts:read", "records:read", "accounts:write"],
  ["accounts.read", "records.read", "accounts.update"],
);

/** `DEPRECIATION_WRITE` in `application/depreciation.ts`: depreciation posts journals. */
const DEPRECIATION_SCOPES = [
  "accounts:read",
  "records:read",
  "accounts:write",
  "records:write",
  "records:adjust",
] as const;
const DEPRECIATION_PERMISSIONS = [
  "accounts.read",
  "records.read",
  "accounts.update",
  "records.create",
  "records.adjust",
] as const;
const DEPRECIATION = write(
  [...DEPRECIATION_SCOPES],
  [...DEPRECIATION_PERMISSIONS],
);

export const MANAGE_FIXED_ASSETS = writeTool({
  // Moves an expensed line to a fixed-asset account (an update of the
  // record, records.update), then registers the asset.
  capitalise: write(
    ["accounts:read", "records:read", "accounts:write", "records:write"],
    ["accounts.read", "records.read", "accounts.update", "records.update"],
  ),
  register: ASSET_WRITE,
  update: ASSET_WRITE,
  // `approveDepreciationProfile`.
  approve: DEPRECIATION,
  // `postDepreciationMonth` for a month, `postAssetCatchUp` for an asset.
  post_depreciation: DEPRECIATION,
  // `stopDepreciation`.
  stop: DEPRECIATION,
  // `reverseDepreciationRun`: a reversal, so it needs records.void too.
  reverse_run: write(
    [...DEPRECIATION_SCOPES, "records:void"],
    [...DEPRECIATION_PERMISSIONS, "records.void"],
  ),
});
