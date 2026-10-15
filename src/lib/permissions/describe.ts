import {
  PERMISSION_CATALOG,
  PERMISSION_ROOTS,
  expandAll,
  leafMeta,
  leafTier,
  leavesOf,
  type LeafPermission,
  type PermissionRoot,
} from "./catalog.js";

/**
 * Access levels and plain-language summaries over the permission catalog.
 *
 * A level is a name for a set of one area's abilities, worked out from each
 * ability's tier: nothing is stored as a level. A group, a user or a token
 * still holds leaves; a screen shows "Invoices: Edit" when the leaves it
 * holds are exactly what Edit stands for, and "Custom" otherwise.
 *
 * Explicit abilities (Adjustments) belong to no level: picking a level never
 * grants or removes one, and they are left out when deciding the level.
 */

export type AccessLevel = "none" | "view" | "edit" | "full";
export type AreaLevel = AccessLevel | "custom";

export const LEVEL_LABELS: Record<AreaLevel, string> = {
  none: "None",
  view: "View",
  edit: "Edit",
  full: "Full",
  custom: "Custom",
};

const TIERS_OF: Record<AccessLevel, readonly string[]> = {
  none: [],
  view: ["read"],
  edit: ["read", "write"],
  full: ["read", "write", "full"],
};

/** The abilities a level can grant: every leaf that is not explicit. */
export function levelledLeaves(root: PermissionRoot): LeafPermission[] {
  return leavesOf(root).filter((leaf) => !leafMeta(leaf).explicit);
}

export function explicitLeaves(root: PermissionRoot): LeafPermission[] {
  return leavesOf(root).filter((leaf) => leafMeta(leaf).explicit);
}

export function levelLeaves(
  root: PermissionRoot,
  level: AccessLevel,
): LeafPermission[] {
  return levelledLeaves(root).filter((leaf) =>
    TIERS_OF[level].includes(leafTier(leaf)),
  );
}

/**
 * The levels worth offering for an area, cheapest first. A level that
 * stands for the same abilities as a cheaper one is left out, so Reports
 * offers only None and View.
 */
export function levelsFor(root: PermissionRoot): AccessLevel[] {
  const seen = new Set<string>();
  return (["none", "view", "edit", "full"] as const).filter((level) => {
    const key = levelLeaves(root, level).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The level a set of leaves stands for in one area, or "custom". */
export function levelOf(
  root: PermissionRoot,
  leaves: Iterable<LeafPermission>,
): AreaLevel {
  const held = new Set(leaves);
  const own = levelledLeaves(root).filter((leaf) => held.has(leaf));
  for (const level of levelsFor(root)) {
    const want = levelLeaves(root, level);
    if (want.length === own.length && want.every((leaf) => held.has(leaf)))
      return level;
  }
  return "custom";
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

function wording(leaf: LeafPermission): string {
  const meta = leafMeta(leaf);
  return meta.verb ?? meta.phrase ?? meta.label.toLowerCase();
}

/**
 * One area's abilities as a sentence: "Can see, add and send invoices.
 * Cannot void or delete." An explicit ability is named when held and never
 * listed as missing, since no level would have given it.
 */
export function describeArea(
  root: PermissionRoot,
  leaves: Iterable<LeafPermission>,
): string {
  const held = new Set(leaves);
  const all = leavesOf(root);
  const on = all.filter((leaf) => held.has(leaf));
  if (on.length === 0) return "No access.";

  const verbs = on.filter((leaf) => leafMeta(leaf).verb).map(wording);
  const phrases = on.filter((leaf) => !leafMeta(leaf).verb).map(wording);
  const clauses = [
    ...(verbs.length
      ? [`${listOf(verbs, "and")} ${PERMISSION_CATALOG[root].noun}`]
      : []),
    ...phrases,
  ];
  const can = `Can ${listOf(clauses, "and")}.`;

  const missing = all
    .filter((leaf) => !held.has(leaf) && !leafMeta(leaf).explicit)
    .map(wording);
  return missing.length ? `${can} Cannot ${listOf(missing, "or")}.` : can;
}

export type AreaSummary = {
  root: PermissionRoot;
  label: string;
  /** "custom" too when only explicit abilities are held. */
  level: AreaLevel;
  /** Labels of explicit abilities held, which no level includes. */
  extras: string[];
  sentence: string;
};

/**
 * Every area a set of permissions touches, in catalog order. Accepts stored
 * strings — a root stands for its leaves, an unknown string for nothing.
 */
export function summarizeAccess(permissions: Iterable<string>): AreaSummary[] {
  const leaves = expandAll(permissions);
  return PERMISSION_ROOTS.flatMap((root) => {
    const own = leavesOf(root).filter((leaf) => leaves.has(leaf));
    if (own.length === 0) return [];
    const level = levelOf(root, own);
    const extras = own.filter((leaf) => leafMeta(leaf).explicit);
    return [
      {
        root,
        label: PERMISSION_CATALOG[root].label,
        level: level === "none" ? "custom" : level,
        extras: extras.map((leaf) => leafMeta(leaf).label),
        sentence: describeArea(root, own),
      },
    ];
  });
}
