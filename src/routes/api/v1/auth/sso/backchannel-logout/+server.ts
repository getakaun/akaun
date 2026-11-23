import { db } from "$lib/server/db/client.js";
import { receiveLogout } from "$lib/server/oidc/accounts.js";
import { verifyLogout } from "$lib/server/oidc/protocol.js";
import { readAuthentication } from "$lib/server/oidc/settings.js";
import { hit } from "$lib/server/rate-limit.js";
import type { RequestHandler } from "./$types.js";

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const settings = readAuthentication(db);
  if (!settings.enabled) return new Response(null, { status: 404 });
  if (hit(`oidc-logout:${getClientAddress()}`, 60, 60_000).limited)
    return new Response(null, { status: 429 });
  const maxBody = 16_384;
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  const stream = request.body;
  if (
    contentType !== "application/x-www-form-urlencoded" ||
    !stream ||
    Number(request.headers.get("content-length")) > maxBody
  )
    return new Response("Invalid logout request.", { status: 400 });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let count = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      count += chunk.value.length;
      if (count > maxBody) {
        await reader.cancel();
        throw new Error("Logout request is too large.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const tokens = new URLSearchParams(body).getAll("logout_token");
    if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 12_288)
      throw new Error("Invalid logout token.");
    const logout = await verifyLogout(settings, process.env, tokens[0]);
    receiveLogout(db, settings, logout);
    return new Response(null, { status: 200 });
  } catch {
    return new Response("Invalid logout request.", { status: 400 });
  } finally {
    reader.releaseLock();
  }
};
