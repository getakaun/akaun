import { json, redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { beginBrowserFlow, continueLink } from "$lib/server/oidc/browser.js";
import { readAuthentication } from "$lib/server/oidc/settings.js";
import { hit } from "$lib/server/rate-limit.js";
import type { RequestHandler } from "./$types.js";

export const POST: RequestHandler = async ({
  request,
  locals,
  cookies,
  getClientAddress,
}) => {
  const sessionId = cookies.get("session");
  if (!locals.user || !sessionId) return new Response(null, { status: 401 });
  if (!readAuthentication(db).enabled)
    return new Response(null, { status: 404 });
  if (hit(`oidc-link:${getClientAddress()}`, 5, 60_000).limited)
    return new Response(null, { status: 429 });
  try {
    const body = await request.json();
    if (
      body.password != null &&
      (typeof body.password !== "string" || body.password.length > 1024)
    )
      return json(
        { error: "Enter your current local password." },
        { status: 400 },
      );
    const redirectUri = await beginBrowserFlow(db, cookies, null, {
      sessionId,
      userId: locals.user.id,
      password: body.password ?? "",
    });
    return json(
      { redirectUri, passwordRequired: !redirectUri },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json(
      {
        error:
          "Could not confirm this account. Sign in with your password and try again.",
      },
      { status: 400 },
    );
  }
};

export const GET: RequestHandler = async ({ cookies, getClientAddress }) => {
  if (!readAuthentication(db).enabled)
    return new Response(null, { status: 404 });
  if (hit(`oidc-link-start:${getClientAddress()}`, 10, 60_000).limited)
    return new Response(null, { status: 429 });
  let target: string | null;
  try {
    target = await continueLink(db, cookies);
  } catch {
    redirect(302, "/profile?tab=security&sso=failed");
  }
  if (!target) return new Response(null, { status: 401 });
  redirect(302, target);
};
