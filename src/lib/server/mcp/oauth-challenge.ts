import type { OAuthScope } from "../oauth/config.js";
import { allowedScopes } from "../oauth/scopes.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../application/attachments.js";
import {
  DEFAULT_NAMING,
  requirementsMet,
  toolName,
  type NamingScheme,
  type ToolAccess,
} from "./registry.js";
import {
  actionsInArguments,
  requirementEntry,
  toolBaseOf,
} from "./requirements/index.js";

/** Every request but a file upload. Reads and ordinary writes are small. */
export const MAX_RPC_BYTES = 128 * 1024;
/** Largest file `attach_file` accepts, the same as the upload form's limit. */
export const MAX_ATTACH_FILE_BYTES = MAX_ATTACHMENT_FILE_BYTES;
/** The file as base64 (4/3 of its size), plus room for the rest of the call. */
export const MAX_ATTACH_RPC_BYTES =
  Math.ceil((MAX_ATTACH_FILE_BYTES * 4) / 3) + 64 * 1024;
/**
 * The base of the one tool allowed the larger body. Only its registered name
 * in the scheme served (`akaun_attach_file` by default) gets the allowance.
 */
export const ATTACH_TOOL = "attach_file";

const noStore = { "Cache-Control": "no-store" };
const tooLarge = () =>
  new Response("Request too large", { status: 413, headers: noStore });

export type RpcInspection =
  | { response: Response }
  | { response: null; maxRequestBodySize: number };

type Rpc = {
  method?: string;
  params?: { name?: string; uri?: string; arguments?: unknown };
};

/**
 * The scopes a tool call's challenge names, or null when no challenge is
 * due: the call is allowed, the name is not a tool of the scheme served, or
 * some part of it could never be granted (then the tool answers FORBIDDEN
 * itself).
 *
 * The name is looked up as an own key only (`toolBaseOf`, then
 * `Object.hasOwn` in `actionsInArguments`), so a name such as `constructor`
 * or `__proto__` is simply not a tool: never a 500.
 *
 * Each part of the call is one action found in its arguments
 * (`actionsInArguments`), or the tool's own requirement when it names none.
 * A part already allowed contributes the scopes of the route that allows
 * it, so a client that replaces its scopes with the challenge's keeps them.
 * Any other part picks the grantable route with the fewest
 * newly required scopes — counting those already chosen for earlier parts —
 * keeping declaration order on a tie. The challenge names their union.
 */
function challengeScopes(
  locals: App.Locals,
  name: string,
  args: unknown,
  naming: NamingScheme,
): OAuthScope[] | null {
  const base = toolBaseOf(name, naming);
  if (!base) return null;
  const entry = requirementEntry(base);
  const actions = actionsInArguments(base, args);
  const parts = actions.length
    ? actions.map((action) => entry.actions![action])
    : [entry.requirements];
  const held = locals.oauth!.scopes;
  const grantable = locals.role ? allowedScopes(locals.role) : [];
  const required: OAuthScope[] = [];
  let refused = false;
  for (const part of parts) {
    const allowed = part.find((option) => requirementsMet(locals, [option]));
    if (allowed) {
      required.push(...allowed.scopes);
      continue;
    }
    refused = true;
    const newlyRequired = (option: ToolAccess) =>
      option.scopes.filter((s) => !held.includes(s) && !required.includes(s))
        .length;
    const candidates = part
      .filter(
        (option) =>
          option.permissions.every((p) => locals.role?.delegable.has(p)) &&
          option.scopes.every((s) => grantable.includes(s)),
      )
      .sort((a, b) => newlyRequired(a) - newlyRequired(b));
    // A batch is saved whole or not at all, so a part no consent can allow
    // makes the call impossible: no consent loop for it.
    if (!candidates.length) return null;
    required.push(...candidates[0].scopes);
  }
  return refused ? [...new Set(required)] : null;
}

/**
 * Looks at a bounded clone of the request before the SDK does, for two things
 * the SDK cannot decide by itself.
 *
 * **Size.** Every call is held to 128 KiB except a single `akaun_attach_file`
 * (its name in the scheme served), which carries a whole file as base64. The
 * SDK takes one body limit per handler, and a handler is made per request
 * (`http.ts`), so this picks that limit — but only after reading which tool
 * is being called, so a large body can never reach any other tool. Runs for
 * OAuth and API-token requests alike.
 *
 * **Scope.** A tool called by an OAuth token that lacks scopes for what the
 * actions in its arguments need gets a 403 `insufficient_scope` challenge
 * naming them (`challengeScopes`, over the tables in `requirements/`), so the
 * client can ask the user for more access. An API token has no scopes; the
 * tool itself refuses what its user may not do.
 *
 * The SDK still parses and validates the original request.
 */
export async function inspectRpc(
  request: Request,
  locals: App.Locals,
  { naming = DEFAULT_NAMING }: { naming?: NamingScheme } = {},
): Promise<RpcInspection> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACH_RPC_BYTES)
    return { response: tooLarge() };

  const reader = request.clone().body?.getReader();
  if (!reader) return { response: null, maxRequestBodySize: MAX_RPC_BYTES };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rpc: Rpc | Rpc[];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACH_RPC_BYTES) {
        // Awaiting cancellation of one tee branch can wait for the other branch.
        void reader.cancel();
        return { response: tooLarge() };
      }
      chunks.push(value);
    }
    rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Not JSON: let the SDK refuse it, with the ordinary limit.
    return size > MAX_RPC_BYTES
      ? { response: tooLarge() }
      : { response: null, maxRequestBodySize: MAX_RPC_BYTES };
  } finally {
    reader.releaseLock();
  }

  const single = rpc && typeof rpc === "object" && !Array.isArray(rpc);
  const isAttach =
    single &&
    (rpc as Rpc).method === "tools/call" &&
    (rpc as Rpc).params?.name === toolName(ATTACH_TOOL, naming);
  if (size > MAX_RPC_BYTES && !isAttach) return { response: tooLarge() };
  const maxRequestBodySize = isAttach ? MAX_ATTACH_RPC_BYTES : MAX_RPC_BYTES;

  if (!locals.oauth || !single) return { response: null, maxRequestBodySize };
  const call = rpc as Rpc;
  if (call.method !== "tools/call" || typeof call.params?.name !== "string")
    return { response: null, maxRequestBodySize };
  const required = challengeScopes(
    locals,
    call.params.name,
    call.params.arguments,
    naming,
  );
  if (!required) return { response: null, maxRequestBodySize };
  const missing = required.filter((s) => !locals.oauth!.scopes.includes(s));
  if (missing.length === 0) return { response: null, maxRequestBodySize };
  // Step up only when the user could actually grant what is missing (their
  // role ∩ their groups' delegation ceiling). Otherwise a client would loop
  // through consent for a scope the page will never offer; the tool is not
  // listed for this caller anyway, and the call is refused as unknown.
  const grantable = locals.role ? allowedScopes(locals.role) : [];
  if (!missing.every((s) => grantable.includes(s)))
    return { response: null, maxRequestBodySize };
  return {
    response: new Response("Insufficient OAuth scope", {
      status: 403,
      headers: {
        ...noStore,
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${required.join(" ")}", resource_metadata="${new URL(locals.oauth.resource).origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    }),
  };
}
