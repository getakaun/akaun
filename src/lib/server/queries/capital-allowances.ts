import { evidenceHash } from "../tax-evidence.js";
import { eq } from "drizzle-orm";
import {
  blankCapitalRow,
  capitalTotals,
  type CapitalAssetEvidence,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import {
  taxCapitalSchedules,
  taxWorksheetRevisions,
  taxWorksheets,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { assetTaxSchemeVersions } from "./asset-tax-schemes.js";
import { fixedAssetRegister } from "./fixed-assets.js";

export const capitalHash = evidenceHash;
export function capitalAssets(
  db: LedgerDb,
  dateTo: string,
): CapitalAssetEvidence[] {
  return fixedAssetRegister(db, dateTo)
    .assets.filter((a) => a.acquisitionDate <= dateTo)
    .map((a) => ({
      assetId: a.id,
      name: a.name,
      assetType: a.assetType,
      acquisitionDate: a.acquisitionDate,
      inServiceDate: a.inServiceDate,
      costMinor: a.costMinor,
      sourceRecordId: a.sourceRecordId,
      documentReference: a.documentReference,
      version: a.version,
      sourceVersion: a.sourceVersion,
      reviewReason: a.reviewReason,
    }));
}
export function capitalScheduleFor(db: LedgerDb, revisionId: number) {
  return (
    db
      .select()
      .from(taxCapitalSchedules)
      .where(eq(taxCapitalSchedules.revisionId, revisionId))
      .get() ?? null
  );
}
function latest(db: LedgerDb, worksheetId: number) {
  return db
    .select()
    .from(taxWorksheetRevisions)
    .where(eq(taxWorksheetRevisions.worksheetId, worksheetId))
    .all()
    .sort((a, b) => b.revision - a.revision)[0];
}
export function capitalPredecessorCurrent(
  db: LedgerDb,
  schedule: CapitalSchedule,
) {
  const visited = new Set<number>();
  let evidence = schedule;
  while (evidence.predecessor) {
    const reference = evidence.predecessor;
    if (visited.has(reference.worksheetId)) return false;
    visited.add(reference.worksheetId);
    const revision = latest(db, reference.worksheetId);
    const previous = revision && capitalScheduleFor(db, revision.id);
    if (
      !revision ||
      revision.status !== "finalised" ||
      !previous?.active ||
      revision.id !== reference.revisionId ||
      capitalHash(previous.evidence) !== reference.hash
    )
      return false;
    evidence = previous.evidence;
  }
  return true;
}
export function capitalRollover(
  db: LedgerDb,
  worksheet: typeof taxWorksheets.$inferSelect,
  assets: CapitalAssetEvidence[],
  currency: string,
): CapitalSchedule | null {
  const previousWorksheet = db
    .select()
    .from(taxWorksheets)
    .all()
    .filter((w) => w.ya < worksheet.ya && w.dateTo < worksheet.dateFrom)
    .sort((a, b) => b.ya - a.ya)[0];
  if (!previousWorksheet) return null;
  const previousRevision = latest(db, previousWorksheet.id);
  if (!previousRevision || previousRevision.status !== "finalised") return null;
  const previous = capitalScheduleFor(db, previousRevision.id);
  if (
    !previous?.active ||
    previous.evidence.currency !== currency ||
    !capitalPredecessorCurrent(db, previous.evidence)
  )
    return null;
  const totals = capitalTotals(
    previous.evidence,
    previousWorksheet.ya,
    previousWorksheet.dateFrom,
    previousWorksheet.dateTo,
  );
  if (totals.problems.length) return null;
  const rows = assets.map((asset) => {
    const old = totals.rows.find((r) => r.assetId === asset.assetId);
    const blank = blankCapitalRow(asset.assetId, worksheet.ya);
    if (!old) return blank;
    if (old.treatment === "exclude" || old.disposal)
      return {
        ...blank,
        treatment: "exclude" as const,
        note: old.disposal
          ? `Tax disposal recorded in YA ${previousWorksheet.ya}.`
          : old.note,
      };
    return {
      ...blank,
      treatment: "claim" as const,
      schemeId: old.schemeId,
      schemeFirstYear: false,
      schemeOverride: false,
      appliedScheme: old.appliedScheme,
      taxClass: old.taxClass,
      businessSource: old.businessSource,
      qualifyingMinor: old.qualifyingMinor,
      businessUseBps: old.businessUseBps,
      openingResidualMinor: old.closingResidualMinor,
      additionsMinor: 0,
      initialMinor: 0,
      // AA and reference/YA are explicitly reviewed again, rather than asserted by rollover.
      annualMinor: null,
      note: `Opening from finalised YA ${previousWorksheet.ya}, revision ${previousRevision.revision}.`,
    };
  });
  return {
    calculationVersion: 2,
    currency,
    jurisdiction:
      previous.evidence.jurisdiction ??
      (previous.evidence.calculationVersion === 1 ? "MY" : null),
    assets,
    rows,
    evidence: "",
    utilisation: previous.evidence.utilisation
      .filter((u) => u.balanceMinor > u.usedMinor)
      .map((u) => ({
        ...u,
        balanceMinor: u.balanceMinor - u.usedMinor,
        usedMinor: 0,
      })),
    predecessor: {
      worksheetId: previousWorksheet.id,
      revisionId: previousRevision.id,
      ya: previousWorksheet.ya,
      hash: capitalHash(previous.evidence),
    },
  };
}
export function capitalDetail(
  db: LedgerDb,
  worksheet: typeof taxWorksheets.$inferSelect,
  revisionId: number,
  compareLive: boolean,
) {
  const saved = capitalScheduleFor(db, revisionId);
  const revision = db
    .select()
    .from(taxWorksheetRevisions)
    .where(eq(taxWorksheetRevisions.id, revisionId))
    .get();
  const candidates = compareLive
    ? capitalAssets(db, worksheet.dateTo)
    : (saved?.evidence.assets ?? []);
  const rollover = compareLive
    ? capitalRollover(
        db,
        worksheet,
        candidates,
        revision?.snapshot.currency ?? "MYR",
      )
    : null;
  return {
    schemes: compareLive ? assetTaxSchemeVersions(db) : [],
    active: saved?.active ?? false,
    schedule: saved?.evidence ?? null,
    totals: saved
      ? capitalTotals(
          saved.evidence,
          worksheet.ya,
          worksheet.dateFrom,
          worksheet.dateTo,
        )
      : null,
    candidates,
    liveAssetHash: capitalHash(candidates),
    currencyMismatch:
      !!saved && saved.evidence.currency !== revision?.snapshot.currency,
    assetsStale:
      compareLive &&
      !!saved &&
      capitalHash(saved.evidence.assets) !== capitalHash(candidates),
    predecessorStale:
      compareLive && !!saved && !capitalPredecessorCurrent(db, saved.evidence),
    rollover,
    rolloverHash: rollover ? capitalHash(rollover) : null,
  };
}

/** Asset detail exposes tax history only after its loader checks tax.read. */
export function assetCapitalHistory(db: LedgerDb, assetId: number) {
  return db
    .select({
      worksheetId: taxWorksheets.id,
      ya: taxWorksheets.ya,
      revision: taxWorksheetRevisions.revision,
      status: taxWorksheetRevisions.status,
      evidence: taxCapitalSchedules.evidence,
    })
    .from(taxCapitalSchedules)
    .innerJoin(
      taxWorksheetRevisions,
      eq(taxWorksheetRevisions.id, taxCapitalSchedules.revisionId),
    )
    .innerJoin(
      taxWorksheets,
      eq(taxWorksheets.id, taxWorksheetRevisions.worksheetId),
    )
    .all()
    .filter((s) => s.evidence.assets.some((a) => a.assetId === assetId))
    .sort((a, b) => b.ya - a.ya || b.revision - a.revision)
    .map(({ worksheetId, ya, revision, status }) => ({
      worksheetId,
      ya,
      revision,
      status,
    }));
}

export { capitalExportLines } from "$lib/asset-tax-export.js";
