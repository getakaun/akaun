import { error, redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { beginBrowserFlow } from "$lib/server/oidc/browser.js";
import { localReturnTo } from "$lib/server/oidc/protocol.js";
import { readAuthentication } from "$lib/server/oidc/settings.js";
import { hit } from "$lib/server/rate-limit.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types.js";

const log = createLogger("oidc");

export const GET: RequestHandler = async ({
  cookies,
  url,
  getClientAddress,
}) => {
  if (!readAuthentication(db).enabled) error(404);
  if (hit(`oidc-login:${getClientAddress()}`, 20, 60_000).limited) error(429);
  let target: string | null;
  try {
    target = await beginBrowserFlow(
      db,
      cookies,
      url.searchParams.get("returnTo"),
    );
  } catch {
    log.warn(
      { reason: "provider_discovery_or_challenge" },
      "OidcSignInRejected",
    );
    target = null;
  }
  const retry = new URLSearchParams({ ssoError: "provider_configuration" });
  const pending = url.searchParams.get("oauth");
  if (pending) retry.set("oauth", pending);
  else {
    const returnTo = localReturnTo(url.searchParams.get("returnTo"));
    if (returnTo !== "/") retry.set("returnTo", returnTo);
  }
  redirect(302, target ?? `/login?${retry}`);
};
