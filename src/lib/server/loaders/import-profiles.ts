import { redirect } from "@sveltejs/kit";
import { profileKind } from "$lib/import-profile-schema.js";
import { db } from "$lib/server/db/client.js";
import { isImportTransactionAsset } from "$lib/server/import/account-policy.js";
import { categoryChoices } from "$lib/server/import/category-accounts.js";
import { profileIdParam } from "$lib/server/import/profile-reply.js";
import type { LedgerDb } from "$lib/server/ledger/types.js";
import { can } from "$lib/server/permissions.js";
import { listAccounts } from "$lib/server/queries/accounts.js";
import {
  getImportProfile,
  listImportProfiles,
  setImportProfileEnabled,
} from "$lib/server/services/import-profiles.js";

/**
 * The loads behind the import profile screens (006 US6, FR-030, FR-045): the
 * list on Settings › Intelligence, the editor for a new profile
 * (`/settings/import-profiles/new`) and the editor for a saved one
 * (`/settings/import-profiles/[id]`).
 *
 * The Settings loader and its actions check no permission of their own, so
 * every function here checks its own: seeing profiles needs `import.view`,
 * changing them `import.change`. What a screen hides it hides because the
 * server would refuse it anyway.
 *
 * Each takes the database as an argument with the real one as the default, so
 * a spec can run it against a temporary database.
 */

/** Where the editor goes back to, and where a refused load lands. */
export const PROFILES_HOME = "/settings?tab=intelligence";

/**
 * The categories a section or a line type can be pinned to, by kind: the same
 * lists the server checks a saved profile against (`categoryChoices`).
 */
function categoryOptions(database: LedgerDb) {
  const pick = ({
    id,
    code,
    name,
  }: {
    id: number;
    code: string | number;
    name: string;
  }) => ({
    id,
    code: String(code),
    name,
  });
  return {
    expenseCategories: categoryChoices(database, "expense").map(pick),
    incomeCategories: categoryChoices(database, "income").map(pick),
  };
}

/**
 * What else the editor offers to choose from: the accounts that hold money,
 * for the account the document is about and each transfer's other account
 * (FR-058), checked again on save; and the other profiles, which a section
 * can name as describing the same money (FR-066). `selfId` is the profile
 * being edited, left out of its own list.
 */
function editorChoices(database: LedgerDb, selfId: number | null) {
  return {
    moneyAccounts: listAccounts(database, {})
      .filter(isImportTransactionAsset)
      .map((account) => ({
        id: account.id,
        code: String(account.code),
        name: account.name,
      })),
    otherProfiles: listImportProfiles(database)
      .filter((profile) => profile.id !== selfId)
      .map((profile) => ({ id: profile.id, name: profile.name })),
  };
}

/**
 * The profiles as the Settings list shows them: name, whether it is on, and
 * how many sections it has. Empty for a user who may not see imports, and
 * `canChange` false for one who may not change them.
 */
export function importProfileList(locals: App.Locals, database: LedgerDb = db) {
  if (!can(locals, "import.read")) {
    return { canView: false, canChange: false, profiles: [] };
  }
  return {
    canView: true,
    canChange: can(locals, "import.profiles"),
    profiles: listImportProfiles(database).map((profile) => ({
      id: profile.id,
      name: profile.name,
      enabled: profile.enabled,
      sectionCount: profile.sections.length,
      // What it imports, which says who reads it (FR-055, FR-057).
      kind: profileKind(profile),
    })),
  };
}

/**
 * The editor for a new profile. Adding one is managing profiles, so it needs
 * `import.change` (FR-045); without it the editor is never shown, rather than
 * shown and then refused on save.
 */
export function loadImportProfileNew(
  locals: App.Locals,
  database: LedgerDb = db,
) {
  if (!can(locals, "import.profiles")) {
    throw redirect(302, PROFILES_HOME);
  }
  return {
    ...categoryOptions(database),
    ...editorChoices(database, null),
  };
}

/**
 * The editor for a saved profile. Anyone who may see imports may read it, as
 * the list route already gives them every profile whole; its fields are read
 * only without `import.change`. An id that names no profile goes back to the
 * list: there is no error page in the app shell to land on.
 */
export function loadImportProfileDetail(
  locals: App.Locals,
  rawId: string,
  database: LedgerDb = db,
) {
  if (!can(locals, "import.read")) {
    throw redirect(302, PROFILES_HOME);
  }
  const id = profileIdParam(rawId);
  const profile = id === null ? null : getImportProfile(database, id);
  if (!profile) throw redirect(302, PROFILES_HOME);
  return {
    profile,
    ...categoryOptions(database),
    ...editorChoices(database, profile.id),
    perms: { change: can(locals, "import.profiles") },
  };
}

// ── Turning profiles on and off from the Settings list ──────────────────────

/** One switch the Settings list staged: this profile on or off. */
type ProfileSwitch = { id: number; enabled: boolean };

/**
 * Reads the switches the Intelligence tab staged (its `importProfiles` field)
 * and keeps the ones that change something. The list stages switches like the
 * provider switches beside it and sends them with the tab's one Save.
 *
 * Refused, before anything on the tab is saved, when the field is not a list
 * of switches, or when it changes a profile and the user may not change
 * imports (FR-045): the Settings action checks no permission of its own. A
 * profile that was deleted since the page loaded has nothing to switch, and is
 * passed over.
 */
export function planProfileSwitches(
  locals: App.Locals,
  raw: FormDataEntryValue | null,
  database: LedgerDb = db,
):
  | { ok: true; switches: ProfileSwitch[] }
  | { ok: false; status: 400 | 403; error: string } {
  // A user who may not see profiles is sent no list, so sends none back.
  if (raw === null || raw === "") return { ok: true, switches: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    parsed = null;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Number.isSafeInteger((entry as ProfileSwitch).id) &&
        typeof (entry as ProfileSwitch).enabled === "boolean",
    );
  if (!valid)
    return {
      ok: false,
      status: 400,
      error: "Invalid import profile list data",
    };

  const switches = (parsed as ProfileSwitch[]).filter((entry) => {
    const current = getImportProfile(database, entry.id);
    return current !== null && current.enabled !== entry.enabled;
  });
  if (switches.length > 0 && !can(locals, "import.profiles")) {
    return {
      ok: false,
      status: 403,
      error: "You do not have permission to turn import profiles on or off.",
    };
  }
  return { ok: true, switches };
}

/** Turns each planned profile on or off, each one audited by the service. */
export function applyProfileSwitches(
  actingUserId: number,
  switches: readonly ProfileSwitch[],
  database: LedgerDb = db,
): void {
  for (const entry of switches) {
    setImportProfileEnabled(database, actingUserId, entry.id, entry.enabled);
  }
}
