import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { diffRecords, recordAudit } from "./audit.js";
import { getSetting } from "./settings.js";
import { getAllProviders, type ProviderRow } from "./llmProviders.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

/**
 * Auditing the Settings page. A save reads the keys it may write before and
 * after, and one entry per section records the keys that changed.
 *
 * This lives beside the Settings actions, not inside `setSetting`, because
 * `setSetting` is also how seeding and the app itself keep state: auditing it
 * would log the system talking to itself. The same goes for providers —
 * a ChatGPT sign-in refreshing its tokens updates the row, and is no one's
 * change.
 */
export type SettingsSection =
  | "general"
  | "company"
  | "pdf"
  | "numbering"
  | "intelligence";

/** The Settings tab a key is changed on, by its prefix. */
export function settingsSectionOf(key: string): SettingsSection {
  if (key.startsWith("company.")) return "company";
  if (key.startsWith("pdf.") || key.startsWith("documents.")) return "pdf";
  if (key.startsWith("documentNumbers.")) return "numbering";
  if (key.startsWith("autoImport.")) return "intelligence";
  return "general";
}

export type SettingValues = Record<string, string | null>;

export function readSettings(db: Db, keys: Iterable<string>): SettingValues {
  return Object.fromEntries([...keys].map((key) => [key, getSetting(db, key)]));
}

/** One entry for each section with a changed key. */
export function auditSettings(
  db: Db,
  actorId: number,
  before: SettingValues,
  after: SettingValues,
): void {
  const bySection = new Map<SettingsSection, ReturnType<typeof diffRecords>>();
  for (const change of diffRecords(before, after)) {
    const section = settingsSectionOf(change.field);
    bySection.set(section, [...(bySection.get(section) ?? []), change]);
  }
  for (const [section, changes] of bySection)
    recordAudit(db, {
      recordType: "settings",
      recordId: section,
      userId: actorId,
      action: "update",
      changes,
    });
}

/** What the log keeps of a provider: a key or a sign-in only as present. */
function providerFields(row: ProviderRow, position: number) {
  return {
    name: row.name,
    type: row.type,
    model: row.model,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    position: position + 1,
    // Redacted by recordAudit; a changed key still shows as a change.
    apiKey: row.apiKey || null,
    oauthCredentials: row.oauthCredentials ? row.oauthCredentials : null,
  };
}

export type ProviderSnapshot = Map<string, ReturnType<typeof providerFields>>;

export function providerSnapshot(db: Db): ProviderSnapshot {
  return new Map(
    getAllProviders(db).map((row, index) => [
      row.id,
      providerFields(row, index),
    ]),
  );
}

/** One entry per provider added, changed or removed between the snapshots. */
export function auditProviders(
  db: Db,
  actorId: number,
  before: ProviderSnapshot,
  after: ProviderSnapshot,
): void {
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id) ?? null;
    const now = after.get(id) ?? null;
    recordAudit(db, {
      recordType: "llm_provider",
      recordId: id,
      userId: actorId,
      action: was === null ? "create" : now === null ? "delete" : "update",
      changes: diffRecords(was, now),
      label: (now ?? was)?.name,
    });
  }
}
