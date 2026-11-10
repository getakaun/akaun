import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { fileStore } from "$lib/server/file-storage.js";
import { downloadMcpFile } from "$lib/server/mcp/file-links.js";

// downloadMcpFile verifies the capability and rechecks the token owner's
// record or reconciliation permissions, without cookies.
export const GET: RequestHandler = ({ params, request }) =>
  downloadMcpFile(db, fileStore(), params.token, request);

// Prevent SvelteKit's HEAD-to-GET fallback from consuming single-use tokens.
export const HEAD: RequestHandler = () =>
  new Response(null, { status: 405, headers: { Allow: "GET" } });
