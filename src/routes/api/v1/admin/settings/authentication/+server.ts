import { json } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { authenticationAdminView } from "$lib/server/oidc/admin.js";
import {
  AuthenticationSettingsError,
  AuthenticationSettingsConflict,
  saveAuthentication,
} from "$lib/server/oidc/settings.js";
import { hit } from "$lib/server/rate-limit.js";
import type { RequestHandler } from "./$types.js";

const headers = { "Cache-Control": "no-store" };

function settingsResponse() {
  const page = authenticationAdminView(db, process.env);
  const groupName = (id: number | null) =>
    page.groups.find((group) => group.id === id)?.name ?? "";
  return json(
    {
      ...page.settings,
      revision: page.revision,
      clientCredentialConfigured: page.hasSecret,
      defaultGroup: groupName(page.settings.defaultGroupId),
      groupMappings: page.settings.groupMappings.map((mapping) => ({
        ...mapping,
        group: groupName(mapping.groupId),
      })),
      groups: page.groups,
      recoveryAccounts: page.recoveryAccounts,
      callbackUrl: page.callback || null,
      logoutUrl: page.logout || null,
      recoveryMode: page.recoveryMode,
    },
    { headers },
  );
}

export const GET: RequestHandler = ({ locals }) => {
  if (!can(locals, "users.manage")) return new Response(null, { status: 403 });
  return settingsResponse();
};

export const PUT: RequestHandler = async ({
  locals,
  cookies,
  request,
  getClientAddress,
}) => {
  const sessionId = cookies.get("session");
  if (!sessionId || !locals.user || !can(locals, "users.manage"))
    return new Response(null, { status: 403 });
  if (hit(`oidc-settings:${getClientAddress()}`, 10, 60_000).limited)
    return new Response(null, { status: 429 });
  try {
    const { revision, settings } = await request.json();
    if (
      typeof revision !== "string" ||
      !settings ||
      typeof settings !== "object"
    )
      throw new AuthenticationSettingsError(
        "Enter authentication settings and their revision.",
      );
    if (
      settings.clientSecret != null &&
      typeof settings.clientSecret !== "string"
    )
      throw new AuthenticationSettingsError("Enter a client secret.");
    const page = authenticationAdminView(db, process.env);
    const resolveGroup = (name: unknown) =>
      typeof name === "string"
        ? page.groups.find(
            (group) => group.name.toLowerCase() === name.toLowerCase(),
          )?.id
        : undefined;
    saveAuthentication(
      db,
      {
        ...settings,
        authority: settings.authority ?? "",
        clientId: settings.clientId ?? "",
        defaultGroupId:
          settings.defaultGroupId ??
          resolveGroup(settings.defaultGroup) ??
          null,
        groupMappings: Array.isArray(settings.groupMappings)
          ? settings.groupMappings.map(
              (mapping: Record<string, unknown> | null) =>
                mapping && {
                  externalGroup: mapping.externalGroup,
                  groupId: mapping.groupId ?? resolveGroup(mapping.group),
                },
            )
          : settings.groupMappings,
      },
      revision,
      settings.clientSecret ?? "",
      locals.user.id,
      sessionId,
      process.env,
    );
    return settingsResponse();
  } catch (cause) {
    const error =
      cause instanceof AuthenticationSettingsError
        ? cause.message
        : "Could not save authentication settings.";
    return json(
      { error },
      {
        status: cause instanceof AuthenticationSettingsConflict ? 409 : 400,
        headers,
      },
    );
  }
};
