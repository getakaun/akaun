/**
 * An import profile as a file, to move it from one installation to another:
 * built and tried on a test copy, then brought into the real books.
 *
 * A profile names accounts and other profiles by id, and an id means nothing
 * in another installation, or worse, means a different account there. So the
 * file names each account by its code and name instead, and each profile by
 * its name, and an import looks them up again: by code first, then by name.
 * One that is not found is left empty, and named, for the user to choose in
 * the editor before saving.
 *
 * A file holds one profile. Bringing it in fills the editor and saves
 * nothing: Save is the same create or replace as typing the profile by hand,
 * with the same checks and the same history.
 *
 * Client-safe: no zod, nothing from `$lib/server`.
 */
import {
  checkProfile,
  formatProfileErrors,
  type ImportProfileDraft,
  type ProfileSectionKind,
} from "./import-profile-schema.js";
import { slugifyKey } from "./import-profile-form.js";

/** One account or category the user can choose, as the editor lists them. */
export type PortableChoice = { id: number; code: string; name: string };

/** What a file's references are looked up in, here. */
export interface PortableChoices {
  /** Accounts that hold money: the profile's account and each transfer's other one. */
  moneyAccounts: PortableChoice[];
  expenseCategories: PortableChoice[];
  incomeCategories: PortableChoice[];
  /** The other saved profiles, which a section can name as the same money. */
  otherProfiles: { id: number; name: string }[];
}

/** An account or category, named so another installation can find its own. */
export type AccountReference = { code: string; name: string };

export const PROFILE_FILE_FORMAT = "akaun.import-profile";
// Version 3 adds table-section filters.
// Older readers must refuse it rather than silently discard these settings.
export const PROFILE_FILE_VERSION = 3;

/**
 * The file. `profile` is an `ImportProfileDraft` with each account id an
 * `AccountReference` and each same-money id a profile name.
 */
export interface ProfileFile {
  format: typeof PROFILE_FILE_FORMAT;
  version: number;
  exportedAt: string;
  profile: Record<string, unknown>;
}

/** The categories a section of this kind can name, as the editor and the server allow them. */
function categoryPool(
  kind: ProfileSectionKind,
  choices: PortableChoices,
): PortableChoice[] {
  if (kind === "income") return choices.incomeCategories;
  if (kind === "expense") return choices.expenseCategories;
  if (kind === "transfer") return [];
  return [...choices.expenseCategories, ...choices.incomeCategories];
}

function describe(ref: AccountReference): string {
  return [ref.code, ref.name].filter((part) => part !== "").join(" ");
}

function sectionLabel(section: { name?: unknown }, index: number): string {
  const name = typeof section.name === "string" ? section.name.trim() : "";
  return name ? `Section “${name}”` : `Section ${index + 1}`;
}

// ── Out: a saved profile to a file ──────────────────────────────────────────

/**
 * The file for one profile. An id with no choice here, such as an account
 * archived since the profile was saved, cannot be named, so it is written
 * empty and listed in `lost`.
 */
export function profileFile(
  draft: ImportProfileDraft,
  choices: PortableChoices,
  now: Date = new Date(),
): { file: ProfileFile; lost: string[] } {
  const lost: string[] = [];

  const toRef = (
    id: number | null | undefined,
    pool: PortableChoice[],
    label: string,
  ): AccountReference | null => {
    if (id === null || id === undefined) return null;
    const found = pool.find((choice) => choice.id === id);
    if (!found) {
      lost.push(label);
      return null;
    }
    return { code: found.code, name: found.name };
  };

  const profileNames = new Map(
    choices.otherProfiles.map((other) => [other.id, other.name]),
  );

  const profile: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    phrases: draft.phrases,
    instructions: draft.instructions,
    ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
    mode: draft.mode,
    statedTotalLabels: draft.statedTotalLabels,
    accountId: toRef(draft.accountId, choices.moneyAccounts, "Account"),
    // Absent means both, as an older installation reads a file without it.
    ...(draft.fileTypes ? { fileTypes: draft.fileTypes } : {}),
    sheet: draft.sheet ?? null,
    layout: draft.layout ?? null,
    sections: draft.sections.map((section, index) => {
      const at = sectionLabel(section, index);
      const pool = categoryPool(section.kind, choices);
      const sameMoneyAs: string[] = [];
      for (const id of section.sameMoneyAs ?? []) {
        const name = profileNames.get(id);
        if (name === undefined)
          lost.push(`${at}: a profile with the same money`);
        else sameMoneyAs.push(name);
      }
      return {
        ...section,
        fixedCategoryAccountId: toRef(
          section.fixedCategoryAccountId,
          pool,
          `${at}: category`,
        ),
        feeTypes: section.feeTypes.map((fee) => ({
          ...fee,
          categoryAccountId: toRef(
            fee.categoryAccountId,
            pool,
            `${at}, line type “${fee.name || fee.key}”: category`,
          ),
        })),
        ...(section.counterAccountId !== undefined
          ? {
              counterAccountId: toRef(
                section.counterAccountId,
                choices.moneyAccounts,
                `${at}: other account`,
              ),
            }
          : {}),
        ...(section.sameMoneyAs !== undefined ? { sameMoneyAs } : {}),
      };
    }),
  };

  return {
    file: {
      format: PROFILE_FILE_FORMAT,
      version: PROFILE_FILE_VERSION,
      exportedAt: now.toISOString(),
      profile,
    },
    lost,
  };
}

/** The file name for a profile: its name as a key, so it reads in a folder. */
export function profileFileName(name: string): string {
  return `${slugifyKey(name) || "import_profile"}.profile.json`;
}

// ── In: a file to a profile the editor can show ─────────────────────────────

/** Reads a file's text. Says plainly what is wrong with one that is not a profile file. */
export function parseProfileFile(
  text: string,
): { ok: true; file: ProfileFile } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        "This file is not JSON. Choose a profile file that Akaun exported.",
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { format?: unknown }).format !== PROFILE_FILE_FORMAT
  ) {
    return {
      ok: false,
      error:
        "This file is not an Akaun import profile. Choose a file that Akaun exported.",
    };
  }
  const file = value as Partial<ProfileFile>;
  if (typeof file.version !== "number" || !Number.isInteger(file.version)) {
    return {
      ok: false,
      error: "This profile file has no version. Export the profile again.",
    };
  }
  if (file.version > PROFILE_FILE_VERSION) {
    return {
      ok: false,
      error:
        "A newer version of Akaun made this file. Update this installation, then import it.",
    };
  }
  if (
    typeof file.profile !== "object" ||
    file.profile === null ||
    Array.isArray(file.profile)
  ) {
    return {
      ok: false,
      error:
        "This profile file has no profile in it. Export the profile again.",
    };
  }
  return { ok: true, file: file as ProfileFile };
}

// Stand-ins for an account that was not found, only while the profile is
// checked: the check needs a transfer's two accounts to be set and different.
// They are replaced with nothing before the profile reaches the editor.
const MISSING_ACCOUNT = Number.MAX_SAFE_INTEGER;
const MISSING_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function isReference(value: unknown): value is AccountReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AccountReference).code === "string" &&
    typeof (value as AccountReference).name === "string"
  );
}

function plainName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Finds a reference's account here: the same code, then the same name. A
 * bare number is never taken as an id: one from another installation would
 * point at whatever account has that id here.
 */
function lookUp(value: unknown, pool: PortableChoice[]): number | null {
  if (!isReference(value)) return null;
  const code = value.code.trim();
  if (code !== "") {
    const byCode = pool.find((choice) => choice.code === code);
    if (byCode) return byCode.id;
  }
  const name = plainName(value.name);
  if (name === "") return null;
  return pool.find((choice) => plainName(choice.name) === name)?.id ?? null;
}

/**
 * The profile in a file, with its references found here. What is not found
 * is left empty and listed in `unmatched`, for the user to choose. Refused
 * when the profile is not one the editor can show; then `error` says why.
 * `selfId` is the saved profile the file replaces, if any: a profile cannot
 * name itself as the same money.
 */
export function draftFromFile(
  file: ProfileFile,
  choices: PortableChoices,
  selfId: number | null,
):
  | { ok: true; draft: ImportProfileDraft; unmatched: string[] }
  | { ok: false; error: string } {
  const unmatched: string[] = [];
  const source = file.profile;

  const resolve = (
    value: unknown,
    pool: PortableChoice[],
    label: string,
    standIn: number | null,
  ): number | null => {
    if (value === null || value === undefined) return null;
    const id = lookUp(value, pool);
    if (id !== null) return id;
    unmatched.push(
      isReference(value) && describe(value)
        ? `${label}: ${describe(value)}`
        : label,
    );
    return standIn;
  };

  const others = choices.otherProfiles.filter((other) => other.id !== selfId);
  const kindOf = (section: Record<string, unknown>): ProfileSectionKind =>
    (typeof section.kind === "string"
      ? section.kind
      : "by_sign") as ProfileSectionKind;

  const sections = Array.isArray(source.sections) ? source.sections : [];
  const candidate: Record<string, unknown> = {
    ...source,
    accountId: resolve(
      source.accountId,
      choices.moneyAccounts,
      "Account",
      MISSING_ACCOUNT,
    ),
    sections: sections.map((raw: unknown, index: number) => {
      if (typeof raw !== "object" || raw === null) return raw;
      const section = raw as Record<string, unknown>;
      const at = sectionLabel(section, index);
      const pool = categoryPool(kindOf(section), choices);
      const fees = section.feeTypes;
      const next: Record<string, unknown> = {
        ...section,
        fixedCategoryAccountId: resolve(
          section.fixedCategoryAccountId,
          pool,
          `${at}: category`,
          null,
        ),
        feeTypes: Array.isArray(fees)
          ? fees.map((fee: unknown) => {
              if (typeof fee !== "object" || fee === null) return fee;
              const typed = fee as Record<string, unknown>;
              const key = typeof typed.key === "string" ? typed.key : "";
              const label =
                typeof typed.name === "string" && typed.name.trim()
                  ? typed.name.trim()
                  : key;
              return {
                ...typed,
                categoryAccountId: resolve(
                  typed.categoryAccountId,
                  pool,
                  `${at}, line type “${label}”: category`,
                  null,
                ),
              };
            })
          : fees,
      };
      if ("counterAccountId" in section) {
        next.counterAccountId = resolve(
          section.counterAccountId,
          choices.moneyAccounts,
          `${at}: other account`,
          MISSING_COUNTER,
        );
      }
      if (Array.isArray(section.sameMoneyAs)) {
        const ids: number[] = [];
        for (const name of section.sameMoneyAs) {
          const found =
            typeof name === "string"
              ? others.find(
                  (other) => plainName(other.name) === plainName(name),
                )
              : undefined;
          if (found) ids.push(found.id);
          else unmatched.push(`${at}: same money as “${String(name)}”`);
        }
        next.sameMoneyAs = ids;
      }
      return next;
    }),
  };

  const checked = checkProfile(candidate);
  if (!checked.ok) {
    return {
      ok: false,
      error: `The profile in this file has problems: ${formatProfileErrors(checked.errors)}`,
    };
  }
  const draft = checked.profile;
  if (draft.accountId === MISSING_ACCOUNT) draft.accountId = null;
  for (const section of draft.sections) {
    if (section.counterAccountId === MISSING_COUNTER)
      section.counterAccountId = null;
  }
  return { ok: true, draft, unmatched };
}

// ── Between the Settings list and the editor ────────────────────────────────

/**
 * A file chosen on the Settings list, waiting for the editor it opens. A plain
 * module slot, read once: the list sets it and then goes to the editor with a
 * client-side navigation, so the same module is still loaded. Only browser
 * code sets it. After a reload it is empty, and the editor opens as it would.
 */
let waiting: { file: ProfileFile; fileName: string } | null = null;

export function stashImportedFile(file: ProfileFile, fileName: string): void {
  waiting = { file, fileName };
}

export function takeImportedFile(): {
  file: ProfileFile;
  fileName: string;
} | null {
  const taken = waiting;
  waiting = null;
  return taken;
}

/** Saves a value as a JSON file through the browser's download. */
export function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has started the download, not during it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
