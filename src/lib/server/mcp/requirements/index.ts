import type { LeafPermission } from "$lib/permissions/catalog.js";
import type { OAuthScope } from "$lib/permissions/oauth-scopes.js";
import { can } from "../../permissions.js";
import { allowedScopes } from "../../oauth/scopes.js";
import type { ToolErrorBody } from "../envelope.js";
import {
  DEFAULT_NAMING,
  requirementsMet,
  toolName,
  type NamingScheme,
  type ToolAccess,
  type ToolRequirements,
} from "../registry.js";
import type { RequirementEntry } from "./define.js";
import { GET_BOOKS_OVERVIEW } from "./overview.js";
import {
  ATTACH_FILE,
  CHANGE_RECORDS,
  CREATE_RECORDS,
  GET_CATEGORY_HISTORY,
  GET_RECORD,
  SEARCH_RECORDS,
} from "./records.js";
import { GET_ATTACHMENT, GET_BANK_STATEMENT_FILE } from "./files.js";
import { CHANGE_ACCOUNTS, LIST_ACCOUNTS } from "./accounts.js";
import { CHANGE_CONTACTS, FIND_CONTACTS, GET_CONTACT } from "./contacts.js";
import { GET_REPORT } from "./reports.js";
import {
  GET_BANK_RECONCILIATION,
  MATCH_BANK_LINES,
  UNMATCH_BANK_LINES,
} from "./bank.js";
import { REVIEW_BOOKS } from "./review.js";
import {
  CHANGE_SALES_DOCUMENTS,
  CREATE_SALES_DOCUMENTS,
  GET_SALES_DOCUMENTS,
} from "./sales.js";
import { GET_IMPORT_QUEUE, REVIEW_IMPORTS } from "./imports.js";
import { GET_CHANGE_HISTORY } from "./history.js";
import { CHANGE_ALLOCATIONS, RECORD_PAYMENTS } from "./payments.js";
import { MANAGE_FIXED_ASSETS } from "./assets.js";

/**
 * What every v2 tool needs, by base name: the v2 counterpart of v1's
 * `TOOL_REQUIREMENTS`, read by the same three things — listing, the check
 * when a tool runs, and the `insufficient_scope` step-up in `inspectRpc` — so
 * they cannot disagree.
 *
 * A tool file passes its entry's `requirements` (and a write tool its
 * `actions`) to `defineReadTool` / `defineWriteTool`, and at call time asks
 * `missingForActions` about the actions in the call and any check it meets
 * on the way; `actionRefusal` words the FORBIDDEN answer.
 *
 * The operation in `application/` still asks for every permission itself, so
 * these tables can only hide or refuse more, never allow anything the
 * operation would not.
 */

export {
  ANY_READ,
  anyOf,
  writeToolRequirements,
  type RequirementEntry,
} from "./define.js";
export * from "./overview.js";
export * from "./records.js";
export * from "./files.js";
export * from "./accounts.js";
export * from "./contacts.js";
export * from "./reports.js";
export * from "./bank.js";
export * from "./review.js";
export * from "./sales.js";
export * from "./imports.js";
export * from "./history.js";
export * from "./payments.js";
export * from "./assets.js";

/** Every v2 tool's requirements, by base name, in the catalogue's order. */
export const TOOL_REQUIREMENTS_V2: Readonly<Record<string, RequirementEntry>> =
  {
    // Reads (15)
    get_books_overview: GET_BOOKS_OVERVIEW,
    search_records: SEARCH_RECORDS,
    get_record: GET_RECORD,
    get_attachment: GET_ATTACHMENT,
    get_bank_statement_file: GET_BANK_STATEMENT_FILE,
    list_accounts: LIST_ACCOUNTS,
    find_contacts: FIND_CONTACTS,
    get_contact: GET_CONTACT,
    get_category_history: GET_CATEGORY_HISTORY,
    get_report: GET_REPORT,
    get_bank_reconciliation: GET_BANK_RECONCILIATION,
    review_books: REVIEW_BOOKS,
    get_sales_documents: GET_SALES_DOCUMENTS,
    get_import_queue: GET_IMPORT_QUEUE,
    get_change_history: GET_CHANGE_HISTORY,
    // Writes (13)
    attach_file: ATTACH_FILE,
    create_records: CREATE_RECORDS,
    change_records: CHANGE_RECORDS,
    record_payments: RECORD_PAYMENTS,
    change_allocations: CHANGE_ALLOCATIONS,
    match_bank_lines: MATCH_BANK_LINES,
    unmatch_bank_lines: UNMATCH_BANK_LINES,
    change_contacts: CHANGE_CONTACTS,
    change_accounts: CHANGE_ACCOUNTS,
    manage_fixed_assets: MANAGE_FIXED_ASSETS,
    create_sales_documents: CREATE_SALES_DOCUMENTS,
    change_sales_documents: CHANGE_SALES_DOCUMENTS,
    review_imports: REVIEW_IMPORTS,
  };

/** Each write tool's action arrays and what each needs (the plan's `ACTION_REQUIREMENTS`). */
export const ACTION_REQUIREMENTS: Readonly<
  Record<string, Readonly<Record<string, ToolRequirements>>>
> = Object.fromEntries(
  Object.entries(TOOL_REQUIREMENTS_V2).flatMap(([base, entry]) =>
    entry.kind === "write" && entry.actions ? [[base, entry.actions]] : [],
  ),
);

/** One tool's entry. Throws for a base name the catalogue does not have. */
export function requirementEntry(toolBase: string): RequirementEntry {
  if (!Object.hasOwn(TOOL_REQUIREMENTS_V2, toolBase))
    throw new Error(`MCP tool "${toolBase}" has no requirements entry.`);
  return TOOL_REQUIREMENTS_V2[toolBase];
}

const basesByScheme = new Map<NamingScheme, ReadonlyMap<string, string>>();

/**
 * The base name behind a registered v2 name in a naming scheme
 * (`akaun_change_records` → `change_records`), or null for anything else,
 * v1's names included.
 */
export function toolBaseOf(
  name: string,
  naming: NamingScheme = DEFAULT_NAMING,
): string | null {
  let bases = basesByScheme.get(naming);
  if (!bases) {
    const built = new Map<string, string>();
    for (const base of Object.keys(TOOL_REQUIREMENTS_V2))
      built.set(toolName(base, naming), base);
    basesByScheme.set(naming, (bases = built));
  }
  return bases.get(name) ?? null;
}

/** An action argument counts when it holds something: not absent, null, false or `[]`. */
const holdsSomething = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  !(Array.isArray(value) && value.length === 0);

/**
 * The actions a call's arguments ask for, in the tool's declared order. A
 * write tool's are the action arrays present (`{void: [...], update: [...]}`
 * → `["update", "void"]`); a read with a selector's is the selector's value
 * when it names one. Checks are never read from the arguments. Shared by
 * `inspectRpc` and the tools, so a step-up and a refusal see the same call.
 */
export function actionsInArguments(toolBase: string, args: unknown): string[] {
  const entry = requirementEntry(toolBase);
  if (
    !entry.actions ||
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args)
  )
    return [];
  const values = args as Record<string, unknown>;
  if (entry.selector) {
    const value = Object.hasOwn(values, entry.selector)
      ? values[entry.selector]
      : undefined;
    return typeof value === "string" && Object.hasOwn(entry.actions, value)
      ? [value]
      : [];
  }
  return Object.keys(entry.actions).filter(
    (action) => Object.hasOwn(values, action) && holdsSomething(values[action]),
  );
}

/** One action or check the caller may not use, and what it lacks for it. */
export type ActionShortfall = {
  action: string;
  /** OAuth only: the scopes the token lacks. Empty for a token or a session. */
  missingScopes: OAuthScope[];
  /** The permissions this request lacks. */
  missingPermissions: LeafPermission[];
};

function partOf(
  entry: RequirementEntry,
  toolBase: string,
  name: string,
): ToolRequirements {
  if (entry.actions && Object.hasOwn(entry.actions, name))
    return entry.actions[name];
  if (entry.checks && Object.hasOwn(entry.checks, name))
    return entry.checks[name];
  throw new Error(`MCP tool "${toolBase}" has no action or check "${name}".`);
}

function gapOf(locals: App.Locals, option: ToolAccess) {
  const held = locals.oauth?.scopes;
  return {
    missingScopes: held ? option.scopes.filter((s) => !held.includes(s)) : [],
    missingPermissions: option.permissions.filter((p) => !can(locals, p)),
  };
}

/**
 * The route to name in a refusal: one the caller could come to hold without
 * an administrator (an app by allowing more scopes, a token by being
 * replaced), then the fewest missing scopes, then the fewest missing
 * permissions, then declaration order — the order a step-up prefers.
 */
function closestRoute(
  locals: App.Locals,
  requirements: ToolRequirements,
): ToolAccess {
  const role = locals.user ? locals.role : null;
  const grantable = role && locals.oauth ? allowedScopes(role) : [];
  const reachable = (option: ToolAccess) =>
    !!role &&
    (locals.oauth
      ? option.permissions.every((p) => role.delegable.has(p)) &&
        option.scopes.every((s) => grantable.includes(s))
      : option.permissions.every((p) =>
          (locals.credential ? role.delegable : role.leaves).has(p),
        ));
  return requirements
    .map((option, index) => ({
      option,
      index,
      reachable: reachable(option),
      ...gapOf(locals, option),
    }))
    .sort(
      (a, b) =>
        Number(b.reachable) - Number(a.reachable) ||
        a.missingScopes.length - b.missingScopes.length ||
        a.missingPermissions.length - b.missingPermissions.length ||
        a.index - b.index,
    )[0].option;
}

/**
 * What the caller lacks for each of `actionsPresent` — a tool's actions or
 * checks — that it may not use; empty when it may use them all. A write tool
 * asks before it saves anything and refuses the whole call with
 * `actionRefusal` when this is not empty. Throws for a name the tool does
 * not have.
 */
export function missingForActions(
  locals: App.Locals,
  toolBase: string,
  actionsPresent: readonly string[],
): ActionShortfall[] {
  const entry = requirementEntry(toolBase);
  const shortfalls: ActionShortfall[] = [];
  for (const action of new Set(actionsPresent)) {
    const requirements = partOf(entry, toolBase, action);
    if (requirementsMet(locals, requirements)) continue;
    shortfalls.push({
      action,
      ...gapOf(locals, closestRoute(locals, requirements)),
    });
  }
  return shortfalls;
}

const named = (noun: string, items: readonly string[]) =>
  `the ${noun}${items.length > 1 ? "s" : ""} ${items.join(", ")}`;

/**
 * The FORBIDDEN answer for `missingForActions`' shortfalls: it names each
 * action and the scope or permission to grant. `tool` is the registered
 * name (`meta.name`).
 */
export function actionRefusal(
  tool: string,
  shortfalls: readonly ActionShortfall[],
): ToolErrorBody {
  const needs = shortfalls.map(
    ({ action, missingScopes, missingPermissions }) =>
      `${action} needs ${[
        missingScopes.length ? named("OAuth scope", missingScopes) : null,
        missingPermissions.length
          ? named("permission", missingPermissions)
          : null,
      ]
        .filter(Boolean)
        .join(" and ")}`,
  );
  const actions = shortfalls.map((s) => s.action).join(", ");
  return {
    code: "FORBIDDEN",
    message: `This connection may not use ${actions} in ${tool}: ${needs.join("; ")}.`,
    fix: `Send the call without the ${actions} items, or ask the person who runs Akaun to grant what is named (an app is reconnected to allow a scope; a token is replaced by one with the permission), then call again.`,
  };
}
