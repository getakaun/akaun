import type { OAuthScope } from "../oauth/config.js";
import { TOOL_REQUIREMENTS } from "./tool-requirements.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../application/attachments.js";

/** Every request but a file upload. Reads and ordinary writes are small. */
export const MAX_RPC_BYTES = 128 * 1024;
/** Largest file `attach_file` accepts, the same as the upload form's limit. */
export const MAX_ATTACH_FILE_BYTES = MAX_ATTACHMENT_FILE_BYTES;
/** The file as base64 (4/3 of its size), plus room for the rest of the call. */
export const MAX_ATTACH_RPC_BYTES =
  Math.ceil((MAX_ATTACH_FILE_BYTES * 4) / 3) + 64 * 1024;
/** The one tool allowed the larger body. */
export const ATTACH_TOOL = "attach_file";

const noStore = { "Cache-Control": "no-store" };
const tooLarge = () =>
  new Response("Request too large", { status: 413, headers: noStore });

export type RpcInspection =
  | { response: Response }
  | { response: null; maxRequestBodySize: number };

type Rpc = { method?: string; params?: { name?: string; uri?: string } };

/**
 * Looks at a bounded clone of the request before the SDK does, for two things
 * the SDK cannot decide by itself.
 *
 * **Size.** Every call is held to 128 KiB except a single `attach_file`, which
 * carries a whole file as base64. The SDK takes one body limit per handler, and
 * a handler is made per request (`http.ts`), so this picks that limit — but
 * only after reading which tool is being called, so a large body can never
 * reach any other tool. Runs for OAuth and API-token requests alike.
 *
 * **Scope.** A tool called by an OAuth token that lacks one of the tool's
 * scopes gets a 403 `insufficient_scope` challenge naming them, so the client
 * can ask the user for more access (`TOOL_REQUIREMENTS`). An API token has no
 * scopes; the tool itself refuses what its user may not do.
 *
 * The SDK still parses and validates the original request.
 */
export async function inspectRpc(
  request: Request,
  locals: App.Locals,
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
    (rpc as Rpc).params?.name === ATTACH_TOOL;
  if (size > MAX_RPC_BYTES && !isAttach) return { response: tooLarge() };
  const maxRequestBodySize = isAttach ? MAX_ATTACH_RPC_BYTES : MAX_RPC_BYTES;

  if (!locals.oauth || !single) return { response: null, maxRequestBodySize };
  const call = rpc as Rpc;
  let required: OAuthScope[] = [];
  if (call.method === "tools/call" && typeof call.params?.name === "string")
    required = TOOL_REQUIREMENTS[call.params.name]?.scopes ?? [];
  const descriptions =
    (call.method === "resources/read" &&
      call.params?.uri === "akaun://description-policy") ||
    (call.method === "prompts/get" &&
      call.params?.name === "review-record-descriptions");
  if (
    descriptions &&
    !locals.oauth.scopes.some(
      (s) => s === "records:read" || s === "import:read",
    )
  )
    required = ["records:read"];
  if (required.every((s) => locals.oauth!.scopes.includes(s)))
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
