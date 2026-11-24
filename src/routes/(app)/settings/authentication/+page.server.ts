import { error, fail } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import {
  AuthenticationSettingsError,
  AuthenticationSettingsConflict,
  readAuthentication,
  saveAuthentication,
} from "$lib/server/oidc/settings.js";
import { authenticationAdminView } from "$lib/server/oidc/admin.js";
import { hit } from "$lib/server/rate-limit.js";
import type { Actions, PageServerLoad } from "./$types.js";

export const load: PageServerLoad = ({ locals }) => {
  if (!can(locals, "users.manage")) error(403);
  return {
    ...authenticationAdminView(db, process.env),
    canReadTax: can(locals, "tax.read"),
    canSeeBooks: can(locals, "reports.read"),
  };
};

export const actions: Actions = {
  default: async ({ request, locals, cookies, getClientAddress }) => {
    const session = cookies.get("session");
    if (!session || !locals.user || !can(locals, "users.manage")) error(403);
    if (hit(`oidc-settings:${getClientAddress()}`, 10, 60_000).limited)
      return fail(429, {
        error: "Too many settings changes. Try again in a minute.",
      });
    const form = await request.formData();
    const string = (key: string) => String(form.get(key) ?? "");
    const oidcEnabled = form.has("oidcEnabled");
    const jitEnabled = oidcEnabled && form.has("jitEnabled");
    const current = readAuthentication(db);
    const external = form.getAll("externalGroup");
    const groupIds = form.getAll("groupId");
    try {
      saveAuthentication(
        db,
        {
          oidcEnabled,
          internalAuthenticationEnabled: form.has(
            "internalAuthenticationEnabled",
          ),
          displayName: oidcEnabled
            ? string("displayName")
            : current.stored.displayName,
          authority: oidcEnabled
            ? string("authority")
            : current.stored.authority,
          clientId: oidcEnabled ? string("clientId") : current.stored.clientId,
          recoveryUserIds: form.getAll("recoveryUserId").map(Number),
          additionalScopes: oidcEnabled
            ? string("additionalScopes")
            : current.stored.additionalScopes,
          jitEnabled,
          requireVerifiedEmail: jitEnabled
            ? form.has("requireVerifiedEmail")
            : current.stored.requireVerifiedEmail,
          defaultGroupId: jitEnabled
            ? Number(string("defaultGroupId")) || null
            : current.stored.defaultGroupId,
          groupsClaim: jitEnabled
            ? string("groupsClaim")
            : current.stored.groupsClaim,
          groupMappings: jitEnabled
            ? external.map((externalGroup, index) => ({
                externalGroup,
                groupId: Number(groupIds[index]),
              }))
            : current.stored.groupMappings,
        },
        string("revision"),
        string("clientSecret"),
        locals.user.id,
        session,
        process.env,
      );
      return { saved: true };
    } catch (cause) {
      return fail(cause instanceof AuthenticationSettingsConflict ? 409 : 400, {
        error:
          cause instanceof AuthenticationSettingsError
            ? cause.message
            : "Could not save authentication settings.",
      });
    }
  },
};
