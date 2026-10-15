import type { OAuthScope } from "../oauth/config.js";

const toolScopes: Record<string, OAuthScope[]> = {
  list_records: ["records:read"],
  get_record: ["records:read"],
  get_attachment: ["records:read"],
  list_outstanding: ["records:read"],
  get_account_statement: ["records:read"],
  list_accounts: ["accounts:read"],
  list_contacts: ["contacts:read"],
  get_contact_balance: ["contacts:read", "records:read"],
  get_financial_report: ["reports:read"],
  list_import_jobs: ["import:read"],
  get_import_job: ["import:read"],
};

/** Read only a bounded clone; the SDK still validates the original RPC request. */
export async function scopeChallenge(
  request: Request,
  locals: App.Locals,
): Promise<Response | null> {
  if (!locals.oauth) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rpc: { method?: string; params?: { name?: string; uri?: string } };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        // Awaiting cancellation of one tee branch can wait for the other branch.
        void reader.cancel();
        return new Response("Request too large", {
          status: 413,
          headers: { "Cache-Control": "no-store" },
        });
      }
      chunks.push(value);
    }
    rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) return null;
  let required: OAuthScope[] = [];
  if (rpc.method === "tools/call" && typeof rpc.params?.name === "string")
    required = toolScopes[rpc.params.name] ?? [];
  const descriptions =
    (rpc.method === "resources/read" &&
      rpc.params?.uri === "akaun://description-policy") ||
    (rpc.method === "prompts/get" &&
      rpc.params?.name === "review-record-descriptions");
  if (
    descriptions &&
    !locals.oauth.scopes.some(
      (s) => s === "records:read" || s === "import:read",
    )
  )
    required = ["records:read"];
  if (required.every((s) => locals.oauth!.scopes.includes(s))) return null;
  return new Response("Insufficient OAuth scope", {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${required.join(" ")}", resource_metadata="${new URL(locals.oauth.resource).origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}
