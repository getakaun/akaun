import { firstYearDecision } from "$lib/first-year-allowance.js";
import { evidenceHash } from "../tax-evidence.js";
import { and, eq, inArray } from "drizzle-orm";
import { LedgerRecordKind } from "$lib/enums.js";
import {
  blankCapitalRow,
  capitalTotals,
  type CapitalAssetEvidence,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import {
  ledgerRecords,
  taxCapitalSchedules,
  taxWorksheetAdjustments,
  taxWorksheetRevisions,
  taxWorksheets,
} from "../db/schema.js";
import type {
  FirstYearContext,
  FirstYearRecord,
} from "$lib/first-year-allowance.js";
import type { LedgerDb } from "../ledger/types.js";
import { assetTaxSchemeVersions } from "./asset-tax-schemes.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
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
/** Effective earlier claims and pending amendments, scoped to this book/asset; utilisation is irrelevant. */
export function firstYearContexts(
  db: LedgerDb,
  worksheet: { id: number; ya: number },
  assets: CapitalAssetEvidence[],
  currency?: string,
): Record<number, FirstYearContext> {
  const sourceIds = [
    ...new Set(
      assets.flatMap((a) =>
        a.sourceRecordId === null ? [] : [a.sourceRecordId],
      ),
    ),
  ];
  const purchaseIds = new Set(
    sourceIds.length
      ? db
          .select({ id: ledgerRecords.id })
          .from(ledgerRecords)
          .where(
            and(
              inArray(ledgerRecords.id, sourceIds),
              eq(ledgerRecords.kind, LedgerRecordKind.Expense),
            ),
          )
          .all()
          .map((r) => r.id)
      : [],
  );
  const earlier = db
    .select()
    .from(taxWorksheets)
    .all()
    .filter((w) => w.id !== worksheet.id && w.ya < worksheet.ya);
  const revisions = db.select().from(taxWorksheetRevisions).all();
  const schedules = db.select().from(taxCapitalSchedules).all();
  const latestByWorksheet = new Map<number, (typeof revisions)[number]>();
  const finalisedByWorksheet = new Map<number, (typeof revisions)[number]>();
  for (const revision of revisions) {
    if (
      (latestByWorksheet.get(revision.worksheetId)?.revision ?? 0) <
      revision.revision
    )
      latestByWorksheet.set(revision.worksheetId, revision);
    if (
      revision.status === "finalised" &&
      (finalisedByWorksheet.get(revision.worksheetId)?.revision ?? 0) <
        revision.revision
    )
      finalisedByWorksheet.set(revision.worksheetId, revision);
  }
  const savedByRevision = new Map(schedules.map((s) => [s.revisionId, s]));
  const recordsByAsset = new Map<number, FirstYearRecord[]>(
    assets.map((a) => [a.assetId, []]),
  );
  for (const item of earlier) {
    const latest = latestByWorksheet.get(item.id);
    if (!latest) continue;
    const finalised = finalisedByWorksheet.get(item.id);
    // An unfinished amendment does not erase the previously finalised claim.
    const relevant = [
      latest,
      ...(latest.status !== "finalised" && finalised ? [finalised] : []),
    ];
    for (const revision of relevant) {
      const saved = savedByRevision.get(revision.id);
      if (!saved) continue;
      for (const row of saved.evidence.rows) {
        if (row.treatment !== "claim") continue;
        recordsByAsset.get(row.assetId)?.push({
          ya: item.ya,
          jurisdiction:
            saved.evidence.jurisdiction ??
            (saved.evidence.calculationVersion === 1 ? "MY" : null),
          currency: saved.evidence.currency,
          revisionId: revision.id,
          status: revision.status,
          active: saved.active,
          qualifyingMinor: row.qualifyingMinor,
          businessUseBps: row.businessUseBps,
          additionsMinor: row.additionsMinor,
          initialMinor: row.initialMinor,
          annualMinor: row.annualMinor,
        });
      }
    }
  }
  return Object.fromEntries(
    assets.map((asset) => {
      const records = recordsByAsset.get(asset.assetId)!;
      const purchaseLinked =
        asset.sourceRecordId !== null && purchaseIds.has(asset.sourceRecordId);
      records.sort((a, b) => a.ya - b.ya || a.revisionId - b.revisionId);
      return [
        asset.assetId,
        {
          records,
          purchaseLinked,
          currentCurrency: currency,
          historyHash: capitalHash({
            assetId: asset.assetId,
            records,
            purchaseLinked,
            currency: currency ?? null,
          }),
        },
      ];
    }),
  );
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
  const priorRollover = compareLive
    ? capitalRollover(
        db,
        worksheet,
        candidates,
        revision?.snapshot.currency ?? "MYR",
      )
    : null;
  const configuredJurisdiction =
    getSetting(db, SETTING_KEYS.taxJurisdiction) || null;
  const expectedJurisdiction =
    saved?.evidence.jurisdiction ?? configuredJurisdiction;
  // Defaults can change countries; prior tax balances must not follow implicitly.
  const rollover =
    priorRollover &&
    (!expectedJurisdiction ||
      priorRollover.jurisdiction === expectedJurisdiction)
      ? priorRollover
      : null;
  const contexts = compareLive
    ? firstYearContexts(db, worksheet, candidates, revision?.snapshot.currency)
    : {};
  const working =
    compareLive &&
    revision?.status !== "finalised" &&
    latest(db, worksheet.id)?.id === revisionId;
  const manualOverlap = db
    .select()
    .from(taxWorksheetAdjustments)
    .all()
    .some(
      (a) =>
        a.revisionId === revisionId &&
        a.withdrawnAt === null &&
        ["capital_allowance", "allowance_brought_forward"].includes(a.kind),
    );
  const earlierWorksheets = new Map(
    db
      .select()
      .from(taxWorksheets)
      .all()
      .filter((w) => w.ya < worksheet.ya && w.dateTo < worksheet.dateFrom)
      .map((w) => [w.id, w.ya]),
  );
  const priorRevisions = db
    .select()
    .from(taxWorksheetRevisions)
    .all()
    .filter(
      (r) => earlierWorksheets.has(r.worksheetId) && r.status === "finalised",
    )
    .sort(
      (a, b) =>
        earlierWorksheets.get(b.worksheetId)! -
          earlierWorksheets.get(a.worksheetId)! || b.revision - a.revision,
    );
  const priorJurisdiction =
    priorRevisions.flatMap((r) => {
      const prior = capitalScheduleFor(db, r.id);
      return prior?.active && prior.evidence.jurisdiction
        ? [prior.evidence.jurisdiction]
        : [];
    })[0] ?? null;
  const defaultJurisdiction =
    configuredJurisdiction || rollover?.jurisdiction || priorJurisdiction;
  const autoPrepared =
    working &&
    !saved &&
    !manualOverlap &&
    (candidates.length > 0 || !!rollover);
  let schedule = saved?.evidence ?? null;
  if (autoPrepared)
    schedule = rollover ?? {
      calculationVersion: 2,
      currency: revision!.snapshot.currency,
      jurisdiction: defaultJurisdiction,
      evidence: "",
      assets: candidates,
      rows: candidates.map((a) => blankCapitalRow(a.assetId, worksheet.ya)),
      utilisation: [],
      predecessor: null,
    };
  if (
    working &&
    saved?.active &&
    schedule &&
    schedule.currency === revision?.snapshot.currency
  ) {
    schedule = {
      ...schedule,
      assets: candidates,
      rows: candidates.map((a) => {
        const old = saved.evidence.rows.find((r) => r.assetId === a.assetId);
        const oldAsset = saved.evidence.assets.find(
          (r) => r.assetId === a.assetId,
        );
        return old && capitalHash(oldAsset) === capitalHash(a)
          ? old
          : {
              ...(old ?? blankCapitalRow(a.assetId, worksheet.ya)),
              treatment: "pending" as const,
              firstYearTreatment: undefined,
            };
      }),
    };
  }
  const predecessorChanged =
    !!saved && !capitalPredecessorCurrent(db, saved.evidence);
  const autoRollover =
    working &&
    !!saved?.active &&
    predecessorChanged &&
    !!rollover &&
    schedule?.currency === rollover.currency &&
    schedule?.jurisdiction === rollover.jurisdiction;
  if (autoRollover && schedule && rollover) {
    schedule = {
      ...schedule,
      predecessor: rollover.predecessor,
      rows: schedule.rows.map((row) => {
        const opening = rollover.rows.find((r) => r.assetId === row.assetId);
        if (!opening || opening.treatment === "pending") return row;
        if (opening.treatment === "exclude") return opening;
        return {
          ...row,
          openingResidualMinor: opening.openingResidualMinor,
          annualMinor: null,
          firstYearTreatment: undefined,
        };
      }),
      utilisation: rollover.utilisation,
    };
  }
  const totals = schedule
    ? capitalTotals(
        schedule,
        worksheet.ya,
        worksheet.dateFrom,
        worksheet.dateTo,
      )
    : null;
  if (
    compareLive &&
    saved &&
    totals &&
    saved.evidence.rows.some(
      (r) =>
        r.firstYearTreatment &&
        r.firstYearTreatment.historyHash !== contexts[r.assetId]?.historyHash,
    )
  )
    totals.problems.push(
      "First-year allowance history changed. Recheck and save the affected asset treatment.",
    );
  if (compareLive && saved && totals && revision?.status !== "finalised") {
    for (const row of saved.evidence.rows) {
      if (
        row.treatment !== "claim" ||
        !row.appliedScheme ||
        !(row.initialMinor && row.initialMinor > 0)
      )
        continue;
      if (
        firstYearDecision(
          row.appliedScheme.definition,
          row,
          saved.evidence.assets.find((a) => a.assetId === row.assetId),
          contexts[row.assetId],
          worksheet.dateFrom,
          worksheet.dateTo,
        ).blocked
      )
        totals.problems.push(
          "Initial allowance for this asset cost was already recorded in an earlier year. Review its first-year treatment.",
        );
    }
  }
  return {
    firstYearContexts: contexts,
    schemes: compareLive ? assetTaxSchemeVersions(db) : [],
    active: autoPrepared || (saved?.active ?? false),
    autoPrepared,
    autoRollover,
    defaultJurisdiction,
    schedule,
    totals,
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
