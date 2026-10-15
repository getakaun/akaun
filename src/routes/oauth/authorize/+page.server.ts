import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types.js";
import { oauth, config } from "$lib/server/oauth/runtime.js";
import { BROWSER_COOKIE, OAuthFailure } from "$lib/server/oauth/service.js";
import { isSameOriginRequest } from "$lib/server/browser-origin.js";
import { scopeAvailability } from "$lib/server/oauth/scopes.js";
import { SCOPE_PERMISSIONS } from "$lib/permissions/oauth-scopes.js";
import { leafMeta } from "$lib/permissions/catalog.js";

export const load: PageServerLoad = ({ url, cookies, locals, setHeaders }) => {
  setHeaders({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin" });
  if (!oauth || !config) error(404, "OAuth is disabled");
  const role = locals.role;
  if (!role || locals.credential) error(403, "Sign in to connect an app.");
  try {
    const p = oauth.pending(
      url.searchParams.get("transaction") ?? "",
      cookies.get(BROWSER_COOKIE) ?? "",
    );
    const availability = new Map(
      scopeAvailability(role).map((entry) => [entry.scope, entry]),
    );
    return {
      clientName: p.client.name as string,
      clientId: p.client.id,
      instance: config.issuer,
      username: locals.user!.username,
      scopes: p.scopes.map((scope) => {
        const entry = availability.get(scope);
        const allowed = entry?.allowed ?? false;
        return {
          scope,
          allowed,
          // "ceiling": the user could, but their administrator does not let
          // them hand it on to apps. "role": they cannot do it at all.
          reason: entry?.reason ?? "role",
          // What the scope stands for, so the user sees what they are allowing.
          includes: SCOPE_PERMISSIONS[scope].map((leaf) => {
            const meta = leafMeta(leaf);
            return `${meta.rootLabel}: ${meta.label}`;
          }),
          // Reads start ticked. A change or delete grant is never pre-selected:
          // the user ticks it on purpose or the app does not get it.
          preselected: allowed && scope.endsWith(":read"),
        };
      }),
    };
  } catch {
    error(
      400,
      "This connection request is invalid or has expired. Start again from your MCP client.",
    );
  }
};

export const actions: Actions = {
  default: async ({ url, cookies, locals, request }) => {
    if (!oauth || !config) error(404, "OAuth is disabled");
    // Defense in addition to the browser-action CSRF check in request-hook.ts.
    if (!isSameOriginRequest(request, config.issuer))
      error(403, "Invalid form origin");
    const form = await request.formData();
    let location: string;
    try {
      location = await oauth.finish(
        url.searchParams.get("transaction") ?? "",
        cookies.get(BROWSER_COOKIE) ?? "",
        locals,
        form.getAll("scope").map(String),
        form.get("decision") === "approve",
      );
    } catch (e) {
      if (e instanceof OAuthFailure)
        return fail(e.status, {
          error:
            e.code === "invalid_scope"
              ? "Select at least one available permission."
              : "This request is invalid or has expired. Please reconnect.",
        });
      error(500, "Unable to connect the app. Please reconnect.");
    }
    redirect(303, location);
  },
};
