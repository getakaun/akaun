import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

// drizzle/meta/_journal.json: 0049_scheme_only_tax. Do not infer this from
// column names: phase 5 allowance adjustments are affected too.
export const SCHEME_ONLY_MIGRATION = 1794372723524;

export type TaxUpgradeImpact = {
  cleanupApplied: boolean;
  schedules: number;
  manualAdjustments: number;
  affectedRevisions: number;
  finalisedRevisions: number;
};

export function taxUpgradeImpact(raw: Database): TaxUpgradeImpact {
  const tables = new Set(
    (
      raw.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const cleanupApplied =
    tables.has("__drizzle_migrations") &&
    Boolean(
      raw
        .query(
          "SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1",
        )
        .get(SCHEME_ONLY_MIGRATION),
    );
  const impact: TaxUpgradeImpact = {
    cleanupApplied,
    schedules: 0,
    manualAdjustments: 0,
    affectedRevisions: 0,
    finalisedRevisions: 0,
  };
  // Current scheme evidence is valid and must not prevent future restarts.
  if (cleanupApplied) return impact;
  const revisions = new Set<number>();
  if (tables.has("tax_capital_schedules")) {
    const rows = raw
      .query("SELECT revision_id FROM tax_capital_schedules")
      .all() as { revision_id: number }[];
    impact.schedules = rows.length;
    for (const row of rows) revisions.add(row.revision_id);
  }
  if (tables.has("tax_worksheet_adjustments")) {
    // Includes withdrawn adjustments: 0049 deletes their history as well.
    const rows = raw
      .query(
        "SELECT revision_id FROM tax_worksheet_adjustments WHERE kind IN ('capital_allowance','allowance_brought_forward')",
      )
      .all() as { revision_id: number }[];
    impact.manualAdjustments = rows.length;
    for (const row of rows) revisions.add(row.revision_id);
  }
  impact.affectedRevisions = revisions.size;
  if (revisions.size && tables.has("tax_worksheet_revisions")) {
    const rows = raw
      .query("SELECT id FROM tax_worksheet_revisions WHERE status='finalised'")
      .all() as { id: number }[];
    impact.finalisedRevisions = rows.filter((row) =>
      revisions.has(row.id),
    ).length;
  }
  return impact;
}

export function assertTaxUpgradeSafe(impact: TaxUpgradeImpact): void {
  if (impact.cleanupApplied || impact.affectedRevisions === 0) return;
  throw new Error(
    `Upgrade blocked before migration 0049: ${impact.schedules} capital schedules and ${impact.manualAdjustments} allowance adjustments affect ${impact.affectedRevisions} tax revisions (${impact.finalisedRevisions} finalised). ` +
      "This migration deletes earlier allowance evidence and resets affected latest worksheets. " +
      "Keep the previous application and a stopped-application backup of the database and attachment store. " +
      "Review a copy with support to arrange evidence preservation before upgrading. Do not delete workings or change migration receipts to bypass this check.",
  );
}

/** Read before any writable open, chart conversion or automatic migration. */
export function checkTaxUpgradeAt(databasePath: string): TaxUpgradeImpact {
  if (!existsSync(databasePath))
    return {
      cleanupApplied: false,
      schedules: 0,
      manualAdjustments: 0,
      affectedRevisions: 0,
      finalisedRevisions: 0,
    };
  const raw = new Database(databasePath, { readonly: true });
  try {
    return raw.transaction(() => taxUpgradeImpact(raw))();
  } finally {
    raw.close();
  }
}
