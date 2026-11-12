import { localToday } from "$lib/local-date.js";
import { evidenceHash } from "../tax-evidence.js";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  TAX_PREPARATION_NOTE,
  taxDecimal,
  taxAdjustmentLabels,
  taxWorksheetTotals,
  safeTaxSum,
  type TaxSourceSnapshot,
} from "$lib/tax-worksheet.js";
import { TaxTreatmentLabels } from "$lib/expense-tax.js";
import {
  taxWorksheets,
  taxWorksheetRevisions,
  taxWorksheetAdjustments,
} from "../db/schema.js";
import type { LedgerDb, CsvTable } from "../ledger/types.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import { expenseTaxReport } from "./expense-tax-report.js";
import { profitLossReport } from "./reports.js";
import { capitalDetail } from "./capital-allowances.js";
import { capitalExportLines } from "$lib/asset-tax-export.js";

export const taxHash = evidenceHash;

/** No current defaults, dates of capture or live-source FKs in retained evidence. */
export function captureTaxSources(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
): TaxSourceSnapshot {
  const pl = profitLossReport(db, dateFrom, dateTo);
  const report = expenseTaxReport(db, dateFrom, dateTo);
  const expenses = report.rows.map((r) => ({
    movementId: r.movementId,
    recordId: r.recordId,
    recordNumber: r.recordNumber,
    date: r.date,
    description: r.description,
    label: r.label,
    accountId: r.accountId,
    accountName: r.accountName,
    expenseMinor: r.expenseMinor,
    classification: r.classification,
    voided: r.voided,
  }));
  const incomeMinor = safeTaxSum(pl.income.map((l) => l.amountMinor));
  const expenseMinor = safeTaxSum(pl.expenses.map((l) => l.amountMinor));
  if (safeTaxSum(expenses.map((l) => l.expenseMinor)) !== expenseMinor)
    throw new Error("Expense tax sources do not reconcile to Profit & Loss.");
  return {
    calculationVersion: 1,
    currency: getSetting(db, SETTING_KEYS.currencyCode) || "MYR",
    companyName: getSetting(db, SETTING_KEYS.companyName) || "Akaun",
    incomeMinor,
    expenseMinor,
    profitMinor: safeTaxSum([incomeMinor, -expenseMinor]),
    notes: pl.notes,
    profitLines: [
      ...pl.income.map((l) => ({ ...l, type: "income" as const })),
      ...pl.expenses.map((l) => ({ ...l, type: "expense" as const })),
    ],
    expenses,
  };
}

export function taxSourceChanges(
  before: TaxSourceSnapshot,
  after: TaxSourceSnapshot,
) {
  const old = new Map(before.expenses.map((l) => [l.movementId, l]));
  const next = new Map(after.expenses.map((l) => [l.movementId, l]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
    const a = old.get(id) ?? null;
    const b = next.get(id) ?? null;
    return taxHash(a) === taxHash(b)
      ? []
      : [{ movementId: id, before: a, after: b }];
  });
}

export function latestTaxRevision(db: LedgerDb, worksheetId: number) {
  return db
    .select()
    .from(taxWorksheetRevisions)
    .where(eq(taxWorksheetRevisions.worksheetId, worksheetId))
    .orderBy(desc(taxWorksheetRevisions.revision))
    .get();
}

export function taxWorksheetDetail(
  db: LedgerDb,
  id: number,
  revisionNumber?: number,
  compareLive = true,
) {
  const worksheet = db
    .select()
    .from(taxWorksheets)
    .where(eq(taxWorksheets.id, id))
    .get();
  if (!worksheet) return null;
  const revisions = db
    .select()
    .from(taxWorksheetRevisions)
    .where(eq(taxWorksheetRevisions.worksheetId, id))
    .orderBy(desc(taxWorksheetRevisions.revision))
    .all();
  const revision =
    revisionNumber === undefined
      ? revisions[0]
      : revisions.find((r) => r.revision === revisionNumber);
  if (!revision) return null;
  const adjustments = db
    .select()
    .from(taxWorksheetAdjustments)
    .where(eq(taxWorksheetAdjustments.revisionId, revision.id))
    .orderBy(asc(taxWorksheetAdjustments.id))
    .all();
  // Exporting retained evidence must not depend on the current ledger being readable.
  const live = compareLive
    ? captureTaxSources(db, worksheet.dateFrom, worksheet.dateTo)
    : revision.snapshot;
  const isLatest = revision.id === revisions[0].id;
  const working = compareLive && isLatest && revision.status !== "finalised";
  const changedIds = new Set(
    taxSourceChanges(revision.snapshot, live).map((c) => c.movementId),
  );
  const sourceConflicts = adjustments
    .filter(
      (a) =>
        a.kind === "source" &&
        a.withdrawnAt === null &&
        (revision.snapshot.pendingCorrectionIds?.includes(a.id) ||
          (working && changedIds.has(a.sourceMovementId!))),
    )
    .map((a) => ({
      adjustmentId: a.id,
      movementId: a.sourceMovementId!,
      reason:
        "The accounting record changed after this annual correction. Replace or withdraw the correction.",
    }));
  const snapshot = working
    ? {
        ...live,
        pendingCorrectionIds: sourceConflicts.map((c) => c.adjustmentId),
      }
    : revision.snapshot;
  const capital = capitalDetail(db, worksheet, revision.id, compareLive);
  return {
    worksheet,
    revision: working
      ? {
          ...revision,
          snapshot,
          status:
            taxHash(live) !== revision.sourceHash ||
            capital.assetsStale ||
            capital.predecessorStale ||
            !!capital.totals?.problems.length
              ? ("draft" as const)
              : revision.status,
        }
      : revision,
    savedRevision: revision,
    sourceConflicts,
    sourceHashes: Object.fromEntries(
      snapshot.expenses.map((source) => [
        String(source.movementId),
        taxHash(source),
      ]),
    ),
    working,
    periodEnded: worksheet.dateTo < localToday(),
    revisions: revisions.map(
      ({ id, revision, status, capturedAt, finalisedAt, amendmentReason }) => ({
        id,
        revision,
        status,
        capturedAt,
        finalisedAt,
        amendmentReason,
      }),
    ),
    isLatest,
    adjustments,
    totals: taxWorksheetTotals(
      snapshot,
      adjustments,
      capital.active && !capital.currencyMismatch ? capital.totals : null,
    ),
    capital,
    stale: taxHash(live) !== revision.sourceHash,
    liveHash: taxHash(live),
    changes: taxSourceChanges(revision.snapshot, live),
    profitChanged:
      taxHash(revision.snapshot.profitLines) !== taxHash(live.profitLines),
    liveProfitMinor: live.profitMinor,
  };
}
export type TaxWorksheetDetail = NonNullable<
  ReturnType<typeof taxWorksheetDetail>
>;

export function taxWorksheetList(db: LedgerDb) {
  return db
    .select()
    .from(taxWorksheets)
    .orderBy(desc(taxWorksheets.ya))
    .all()
    .map((w) => {
      const revision = latestTaxRevision(db, w.id)!;
      return {
        ...w,
        revision: revision.revision,
        status: revision.status,
        finalisedAt: revision.finalisedAt,
      };
    });
}

/** Exports use retained evidence only; source drift never changes a saved version. */
export function taxWorksheetCsv(detail: TaxWorksheetDetail): CsvTable {
  const { worksheet: w, revision: r, adjustments, totals: t } = detail;
  const money = (n: number | null) => (n === null ? null : taxDecimal(n));
  const rows: CsvTable["rows"] = [
    ["Summary", "Accounting profit", money(r.snapshot.profitMinor)],
    ["Summary", "Original estimated add-backs", money(t.baseAddBackMinor)],
    ["Summary", "Annual treatment corrections", money(t.correctionMinor)],
    ["Summary", "Effective add-backs", money(t.addBackMinor)],
    ["Summary", "Other tax adjustments", money(t.adjustmentMinor)],
    ["Summary", "Preparatory tax result", money(t.resultMinor)],
    ["Summary", "Unresolved expense lines", t.unresolvedCount],
    ["Summary", "Unresolved expense amount", money(t.unresolvedMinor)],
  ];
  for (const l of r.snapshot.profitLines)
    rows.push([
      "Profit & Loss",
      l.accountName,
      money(l.amountMinor),
      null,
      null,
      l.accountId,
      l.type,
    ]);
  for (const l of t.lines)
    rows.push([
      "Expense",
      l.label ?? l.description,
      money(l.expenseMinor),
      l.date,
      l.recordNumber,
      l.movementId,
      l.accountName,
      l.classification?.percentageBps == null
        ? null
        : l.classification.percentageBps / 100,
      l.effectivePercentageBps == null ? null : l.effectivePercentageBps / 100,
      money(l.addBackMinor),
      TaxTreatmentLabels[l.effectiveTreatment],
      l.unresolved ? "Needs review" : l.voided ? "Void pair" : "Classified",
      l.classification?.reason ?? null,
      l.classification?.classifiedBy ?? null,
      l.classification?.classifiedAt ?? null,
      l.classification?.source ?? "historical_unreviewed",
      l.classification?.provenance ?? "historical",
      l.recordId,
    ]);
  for (const a of adjustments)
    rows.push([
      "Adjustment",
      a.kind === "source"
        ? "Annual expense treatment"
        : taxAdjustmentLabels[a.kind],
      money(a.direction === "increase" ? a.amountMinor : -a.amountMinor),
      a.createdAt,
      null,
      a.sourceMovementId,
      a.reason,
      a.percentageBps == null ? null : a.percentageBps / 100,
      null,
      null,
      a.treatment,
      a.withdrawnAt ? "Withdrawn" : "Active",
      a.evidence,
      a.actorName,
      a.createdAt,
      money(a.balanceMinor),
      a.originYa,
      a.id,
      a.withdrawalReason,
    ]);
  if (detail.capital.schedule) {
    rows.push(["Summary", "Asset schedule effect", money(t.capitalMinor)]);
    rows.push(
      ...capitalExportLines(detail.capital.schedule, w.ya).map(
        ([label, value]) => ["Capital allowances", label, value],
      ),
    );
  }
  const columns = [
    "Section",
    "Description",
    "Amount",
    "Date",
    "Record",
    "Movement / account",
    "Account / reason",
    "Saved percentage / revised percentage",
    "Annual percentage",
    "Add-back",
    "Treatment",
    "Status",
    "Reason / evidence",
    "Actor",
    "Timestamp",
    "Source / brought-forward balance",
    "Provenance / origin YA",
    "Record ID / adjustment ID",
    "Withdrawal reason",
  ];
  return {
    columns,
    rows: rows.map((row) => [
      ...row,
      ...Array(Math.max(0, columns.length - row.length)).fill(null),
    ]),
    notes: [
      TAX_PREPARATION_NOTE,
      `${r.snapshot.companyName}; YA ${w.ya}; ${w.dateFrom} to ${w.dateTo}; ${r.snapshot.currency}; revision ${r.revision}; ${r.status}; captured ${r.capturedAt}; reviewed ${r.reviewedAt ?? "—"}; finalised ${r.finalisedAt ?? "—"}.`,
      ...(detail.capital.currencyMismatch
        ? [
            "The retained asset schedule currency differs from this worksheet; its amounts are excluded from the annual result and have not been converted.",
          ]
        : []),
      ...r.snapshot.notes,
    ],
  };
}

export function taxAdjustmentsFor(db: LedgerDb, revisionId: number) {
  return db
    .select()
    .from(taxWorksheetAdjustments)
    .where(and(eq(taxWorksheetAdjustments.revisionId, revisionId)))
    .orderBy(asc(taxWorksheetAdjustments.id))
    .all();
}

/** Standalone, escaped and script-free print view. No live figures or timestamps. */
export function taxWorksheetHtml(detail: TaxWorksheetDetail): string {
  const { worksheet: w, revision: r, totals: t, adjustments } = detail;
  const escape = (v: unknown) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const money = (n: number | null) =>
    n === null ? "Unresolved" : taxDecimal(n);
  const row = (cells: unknown[]) =>
    `<tr>${cells.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YA ${w.ya} — revision ${r.revision}</title><style>body{font:14px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#222}h1{font-size:24px}h2{margin-top:28px;font-size:18px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#f5f5f5}p{line-height:1.6}.muted{color:#555}@media print{body{margin:0;padding:0}.print-help{display:none}thead{display:table-header-group}tr{break-inside:avoid}}</style></head><body>
  <p class="print-help">Use your browser's Print command to print or save as PDF.</p><h1>${escape(r.snapshot.companyName)} — YA ${w.ya}</h1><p>${escape(w.dateFrom)} to ${escape(w.dateTo)} · ${escape(r.snapshot.currency)} · Revision ${r.revision} · ${escape(r.status)}</p><p class="muted">${escape(TAX_PREPARATION_NOTE)}</p>${detail.capital.currencyMismatch ? "<p>The retained asset schedule currency differs from this worksheet. Its amounts are excluded from the annual result; no conversion has been performed.</p>" : ""}
  <p>Captured ${escape(r.capturedAt)} · Reviewed ${escape(r.reviewedAt ?? "—")} · Finalised ${escape(r.finalisedAt ?? "—")}</p>
  ${r.amendmentReason ? `<p>Amendment: ${escape(r.amendmentReason)}</p>` : ""}
  <h2>Reconciliation bridge</h2><table><tbody>${[
    ["Accounting profit", money(r.snapshot.profitMinor)],
    ["Original estimated add-backs", money(t.baseAddBackMinor)],
    ["Annual treatment corrections", money(t.correctionMinor)],
    ["Effective expense add-backs", money(t.addBackMinor)],
    ...adjustments
      .filter((a) => a.kind !== "source" && a.withdrawnAt === null)
      .map((a) => [
        a.kind === "source" ? "" : taxAdjustmentLabels[a.kind],
        money(a.direction === "increase" ? a.amountMinor : -a.amountMinor),
      ]),
    ...(detail.capital.active
      ? [["Asset schedule effect", money(t.capitalMinor)]]
      : []),
    ["Preparatory tax result", money(t.resultMinor)],
    ["Unresolved lines", t.unresolvedCount],
    ["Unresolved amount", money(t.unresolvedMinor)],
  ]
    .map(row)
    .join("")}</tbody></table>
  ${
    detail.capital.schedule
      ? `<h2>Capital allowance schedule</h2><table><thead><tr><th>Working</th><th>Value</th></tr></thead><tbody>${capitalExportLines(
          detail.capital.schedule,
          w.ya,
        )
          .map((line) => row(line))
          .join("")}</tbody></table>`
      : ""
  }<h2>Profit &amp; Loss evidence</h2><table><thead><tr><th>Type</th><th>Account</th><th>Amount</th></tr></thead><tbody>${r.snapshot.profitLines.map((l) => row([l.type, l.accountName, money(l.amountMinor)])).join("")}</tbody></table>
  <h2>Expense classifications</h2><table><thead><tr><th>Date / record</th><th>Expense / account</th><th>Book expense</th><th>Saved %</th><th>Annual % / treatment</th><th>Add-back</th></tr></thead><tbody>${t.lines.map((l) => row([`${l.date} / ${l.recordNumber ?? l.recordId} / line ${l.movementId}`, `${l.label ?? l.description} / ${l.accountName}`, money(l.expenseMinor), l.classification?.percentageBps == null ? "Unclassified" : l.classification.percentageBps / 100, `${l.effectivePercentageBps == null ? "—" : l.effectivePercentageBps / 100} / ${TaxTreatmentLabels[l.effectiveTreatment]}${l.voided ? " / Void pair" : ""}`, money(l.addBackMinor)])).join("")}</tbody></table>
  <h2>Adjustments and retained history</h2><table><thead><tr><th>Entry</th><th>Decision / amount</th><th>Reason / evidence</th><th>Actor / timestamp</th><th>Status</th></tr></thead><tbody>${adjustments.map((a) => row([`${a.id} / ${a.kind === "source" ? `Expense line ${a.sourceMovementId}` : taxAdjustmentLabels[a.kind]}`, a.kind === "source" ? `${a.percentageBps! / 100}% / ${a.treatment}` : `${a.direction} ${money(a.amountMinor)}${a.originYa ? ` / origin YA ${a.originYa}, balance ${money(a.balanceMinor)}` : ""}`, `${a.reason} / ${a.evidence}`, `${a.actorName} / ${a.createdAt}`, a.withdrawnAt ? `Withdrawn ${a.withdrawnAt}: ${a.withdrawalReason}` : "Active"])).join("")}</tbody></table>${r.snapshot.notes.map((n) => `<p class="muted">${escape(n)}</p>`).join("")}</body></html>`;
}
