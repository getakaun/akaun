import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { config } from "$lib/server/oauth/runtime.js";
import { handleMcpRequest } from "$lib/server/mcp/http.js";
import { fileStore } from "$lib/server/file-storage.js";

const handle: RequestHandler = ({ request, locals, url }) =>
  handleMcpRequest(
    request,
    { db, locals, store: fileStore() },
    config?.issuer ?? url.origin,
  );

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const PUT = handle;
export const PATCH = handle;
export const OPTIONS = handle;
