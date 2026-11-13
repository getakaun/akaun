import type { LeafPermission } from "$lib/permissions/catalog.js";
import { READ_SCOPES, type OAuthScope } from "$lib/permissions/oauth-scopes.js";
import type { ToolAccess, ToolRequirements } from "../registry.js";

/**
 * Builders for the v2 requirement tables. `read`, `write` and `either` have
 * the shape of v1's helpers in `tool-requirements.ts`, so each v2 entry can be
 * compared line by line with the v1 tool it replaces (the spec does).
 *
 * Every route is complete: its scopes (OAuth only) AND its permissions. The
 * scopes must stand for the permissions through `SCOPE_PERMISSIONS`; a read
 * scope a write route needs is listed too, as v1 does for `void_record`.
 */

/** A read route: each scope stands for its area's `read` leaf (v1's `read`). */
export function read(
  scopes: OAuthScope[],
  permissions: LeafPermission[] = scopes.map(
    (scope) => `${scope.split(":")[0]}.read` as LeafPermission,
  ),
): ToolRequirements {
  return [{ scopes, permissions }];
}

/** A write route: these scopes AND these permissions (v1's `write`). */
export function write(
  scopes: OAuthScope[],
  permissions: LeafPermission[],
): ToolRequirements {
  return [{ scopes, permissions }];
}

/**
 * Complete alternatives (v1's `either`). On a tie, a step-up prefers the
 * earlier one: narrow corrections first, grouped before legacy deletion.
 */
export function either(...routes: ToolRequirements[]): ToolRequirements {
  return routes.flat();
}

const within = (inner: readonly string[], outer: readonly string[]) =>
  inner.every((item) => outer.includes(item));

/** Meeting `option` meets `other`: `other` asks for nothing `option` does not. */
const implies = (option: ToolAccess, other: ToolAccess) =>
  within(other.scopes, option.scopes) &&
  within(other.permissions, option.permissions);

/**
 * The any-of of several requirements, without the options another one
 * already covers. An option that asks for everything another asks for is met
 * only when that one is, so dropping it changes no answer; of two equal
 * options the first is kept.
 */
export function anyOf(...requirements: ToolRequirements[]): ToolRequirements {
  const all = requirements.flat();
  return all.filter(
    (option, i) =>
      !all.some(
        (other, j) =>
          j !== i &&
          implies(option, other) &&
          (!implies(other, option) || j < i),
      ),
  );
}

/**
 * A write tool's own requirement, built from its actions: it is listed when
 * any one action is allowed. Each action is still checked when it is called.
 */
export function writeToolRequirements(
  actions: Readonly<Record<string, ToolRequirements>>,
): ToolRequirements {
  return anyOf(...Object.values(actions));
}

/**
 * Anyone who can read some area: one route per read scope. For the reads
 * that decide per area when they run (the overview, the books review, the
 * change history) — each shows only the areas the caller may read.
 */
export const ANY_READ: ToolRequirements = either(
  ...READ_SCOPES.map((scope) => read([scope])),
);

/** What one v2 tool needs, by part. */
export type RequirementEntry = {
  kind: "read" | "write";
  /** Who sees the tool listed, and may call it at all (any-of). */
  requirements: ToolRequirements;
  /**
   * What each part of a call needs. For a write tool these are its action
   * arrays (`void`, `merge`), found by the argument keys present. For a read
   * whose needs depend on one argument, the values of `selector`
   * (`get_report`'s report). `inspectRpc` steps up for them.
   */
  actions?: Readonly<Record<string, ToolRequirements>>;
  /** For a read with `actions`: the argument whose value names the action. */
  selector?: string;
  /**
   * Abilities that depend on what the input turns out to be — a derived
   * journal, a correction path, a release on a void. The tool or its
   * operation checks them once it knows; they are never read from the
   * arguments, so no step-up asks for them. Each is a complete route, so it
   * includes what its action needs.
   */
  checks?: Readonly<Record<string, ToolRequirements>>;
};

/** A read tool. */
export function readTool(
  requirements: ToolRequirements,
  checks?: Readonly<Record<string, ToolRequirements>>,
): RequirementEntry {
  return { kind: "read", requirements, ...(checks ? { checks } : {}) };
}

/**
 * A read whose needs depend on the value of one argument: listed when any
 * value is allowed, and checked for the value asked for.
 */
export function readToolBy(
  selector: string,
  actions: Readonly<Record<string, ToolRequirements>>,
): RequirementEntry {
  return {
    kind: "read",
    requirements: anyOf(...Object.values(actions)),
    actions,
    selector,
  };
}

/** A write tool with action arrays: listed when any one action is allowed. */
export function writeTool(
  actions: Readonly<Record<string, ToolRequirements>>,
  checks?: Readonly<Record<string, ToolRequirements>>,
): RequirementEntry {
  return {
    kind: "write",
    requirements: writeToolRequirements(actions),
    actions,
    ...(checks ? { checks } : {}),
  };
}

/** A write tool that takes no action arrays (`attach_file`). */
export function singleWriteTool(
  requirements: ToolRequirements,
): RequirementEntry {
  return { kind: "write", requirements };
}
