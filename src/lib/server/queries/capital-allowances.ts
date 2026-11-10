import { createHash } from "node:crypto";
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
import { taxDecimal } from "$lib/tax-worksheet.js";
import { fixedAssetRegister } from "./fixed-assets.js";

export const capitalHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  if (!previous?.active || !capitalPredecessorCurrent(db, previous.evidence))
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
    calculationVersion: 1,
    currency: "MYR",
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
  const candidates = compareLive
    ? capitalAssets(db, worksheet.dateTo)
    : (saved?.evidence.assets ?? []);
  const rollover = compareLive
    ? capitalRollover(db, worksheet, candidates)
    : null;
  return {
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

/** Fully labelled retained workings shared by CSV and print; never reads live assets. */
export function capitalExportLines(
  schedule: CapitalSchedule,
  active: boolean,
  ya: number,
  dateFrom: string,
  dateTo: string,
): [string, string][] {
  const totals = capitalTotals(schedule, ya, dateFrom, dateTo);
  const amount = (n: number | null) =>
    n === null ? "Unreviewed" : taxDecimal(n);
  const lines: [string, string][] = [
    [
      "Mode",
      active ? "Asset schedule" : "Retained schedule; manual totals active",
    ],
    [
      "Calculation",
      "Version 1; manually reviewed MYR amounts; no statutory rate engine",
    ],
    ["Shared working-paper reference", schedule.evidence],
    ["Allowances available", amount(totals.allowanceMinor)],
    ["Allowances utilised", amount(totals.usedMinor)],
    ["Balancing charges", amount(totals.balancingChargeMinor)],
    ["Unabsorbed allowances carried forward", amount(totals.carryForwardMinor)],
    ["Predecessor evidence", JSON.stringify(schedule.predecessor)],
  ];
  for (const r of totals.rows) {
    const prefix = `${r.asset.name} (FA-${r.assetId})`;
    const fields: [string, string][] = [
      ["Treatment", r.treatment],
      ["Tax class", r.taxClass],
      ["Business source", r.businessSource],
      [
        "Qualifying expenditure before business-use adjustment",
        amount(r.qualifyingMinor),
      ],
      [
        "Business use",
        r.businessUseBps === null ? "Unreviewed" : `${r.businessUseBps / 100}%`,
      ],
      ["Opening tax residual", amount(r.openingResidualMinor)],
      [
        "Qualifying additions (business-use adjusted)",
        amount(r.additionsMinor),
      ],
      ["Initial allowance", amount(r.initialMinor)],
      ["Annual allowance", amount(r.annualMinor)],
      ["Residual expenditure adjustment", amount(r.residualAdjustmentMinor)],
      ["Closing tax residual", amount(r.closingResidualMinor)],
      ["Tax residual removed on full disposal", amount(r.residualRemovedMinor)],
      ["Reason / notes", r.note],
      ["Rule / evidence reference", r.ruleReference],
      ["Effective YA", String(r.effectiveYa)],
      ["Asset and purchase evidence", JSON.stringify(r.asset)],
    ];
    if (r.disposal)
      fields.push(
        ["Disposal date", r.disposal.date],
        ["Disposal proceeds", amount(r.disposal.proceedsMinor)],
        ["Balancing allowance", amount(r.disposal.balancingAllowanceMinor)],
        ["Balancing charge", amount(r.disposal.balancingChargeMinor)],
        ["Disposal evidence", r.disposal.evidence],
        [
          "Book disposal",
          "Tax evidence only; book disposal and stopping depreciation require separate accounting attention.",
        ],
      );
    lines.push(
      ...fields.map(([label, value]): [string, string] => [
        `${prefix} · ${label}`,
        value,
      ]),
    );
  }
  for (const u of schedule.utilisation)
    lines.push(
      [
        `${u.businessSource} · origin YA ${u.originYa} · available balance`,
        amount(u.balanceMinor),
      ],
      [
        `${u.businessSource} · origin YA ${u.originYa} · utilisation`,
        amount(u.usedMinor),
      ],
      [
        `${u.businessSource} · origin YA ${u.originYa} · unabsorbed balance`,
        amount(u.balanceMinor - u.usedMinor),
      ],
    );
  lines.push(
    ...totals.problems.map((problem): [string, string] => [
      "Needs review",
      problem,
    ]),
  );
  return lines;
}
