import {
  resolveFirstYear,
  firstYearDecision,
} from "$lib/first-year-allowance.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  taxJurisdictionSchema,
  calculateAssetTaxScheme,
  schemeApplies,
} from "$lib/asset-tax-scheme.js";
import {
  assetTaxSchemeVersions,
  schemeSnapshot,
} from "../queries/asset-tax-schemes.js";
import {
  blankCapitalRow,
  capitalInputSchema,
  capitalTotals,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import { taxReason, taxVersion } from "$lib/tax-worksheet.js";
import {
  firstYearContexts,
  capitalAssets,
  capitalHash,
  capitalScheduleFor,
  capitalDetail,
} from "../queries/capital-allowances.js";
import {
  taxWorksheetRevisions,
  taxWorksheetAdjustments,
  taxCapitalSchedules,
  taxCapitalCommands,
} from "../db/schema.js";
import {
  taxAdjustmentsFor,
  type TaxWorksheetDetail,
} from "../queries/tax-worksheets.js";
import { requirePermissions, type AppContext } from "./context.js";
import { fail, invalid, type AppResult } from "./result.js";
import {
  write,
  current,
  draft,
  audit,
  refuse,
} from "./tax-worksheet-boundary.js";
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const capitalCommandBase = {
  expectedVersion: taxVersion,
  requestKey: z.string().uuid(),
  reason: taxReason,
};
export const capitalCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      jurisdiction: taxJurisdictionSchema.nullable().optional(),
      replaceManual: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("rollover"),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      rolloverHash: z.string().length(64),
      jurisdiction: taxJurisdictionSchema.nullable().optional(),
      replaceManual: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("refresh-assets"),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      confirmFirstYearTreatments: z.boolean().optional(),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      input: capitalInputSchema,
    })
    .strict(),
  z.object({ action: z.literal("manual"), ...capitalCommandBase }).strict(),
]);

export function changeCapitalSchedule(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<TaxWorksheetDetail> {
  const denied = requirePermissions(ctx, ["tax.read", "tax.update"]);
  if (denied) return denied;
  const parsed = capitalCommandSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (!idSchema.safeParse(id).success)
    return fail("INVALID_INPUT", "Choose a valid worksheet.");
  const v = parsed.data;
  return write(ctx, "tax.update", (emits) => {
    const payloadHash = capitalHash({ worksheetId: id, ...v });
    const replay = ctx.db
      .select()
      .from(taxCapitalCommands)
      .where(eq(taxCapitalCommands.requestKey, v.requestKey))
      .get();
    if (replay) {
      const original = ctx.db
        .select()
        .from(taxWorksheetRevisions)
        .where(eq(taxWorksheetRevisions.id, replay.revisionId))
        .get();
      if (
        !original ||
        original.worksheetId !== id ||
        replay.payloadHash !== payloadHash
      )
        refuse(
          "This request key belongs to a different capital allowance command.",
          "CONFLICT",
        );
      return {
        worksheetId: id,
        revisionNumber: original.revision,
        changed: false,
      };
    }
    const { worksheet, revision } = current(ctx, id, v.expectedVersion);
    if (revision.status === "finalised")
      refuse("Create an amendment to change a finalised schedule.");
    const before = capitalScheduleFor(ctx.db, revision.id);
    if (
      before &&
      before.evidence.currency !== revision.snapshot.currency &&
      v.action !== "manual" &&
      v.action !== "rollover"
    )
      refuse(
        "The retained schedule currency differs from the worksheet. Use manual totals or a confirmed matching-currency rollover; amounts are never converted or relabelled automatically.",
        "CONFLICT",
      );
    const live = capitalAssets(ctx.db, worksheet.dateTo);
    const liveHash = capitalHash(live);
    if (v.action !== "manual" && v.liveAssetHash !== liveHash)
      refuse(
        "Asset evidence changed. Refresh and review the current asset list before saving.",
        "CONFLICT",
      );
    let schedule: CapitalSchedule;
    let active = true;
    if (v.action === "manual") {
      if (!before?.active)
        refuse("This worksheet already uses manual allowance totals.");
      schedule = before.evidence;
      active = false;
    } else if (v.action === "prepare" || v.action === "rollover") {
      const overlaps = taxAdjustmentsFor(ctx.db, revision.id).filter(
        (a) =>
          a.withdrawnAt === null &&
          ["capital_allowance", "allowance_brought_forward"].includes(a.kind),
      );
      if (overlaps.length && !v.replaceManual)
        refuse(
          "Confirm replacement of the existing manual allowance entries before using an asset schedule.",
        );
      if (v.action === "rollover") {
        const preview = capitalDetail(ctx.db, worksheet, revision.id, true);
        if (!preview.rollover || preview.rolloverHash !== v.rolloverHash)
          refuse(
            "The prior-year schedule changed or is not finalised. Review a fresh rollover preview.",
            "CONFLICT",
          );
        schedule = preview.rollover;
      } else if (before) {
        if (before.active) refuse("The asset schedule is already active.");
        if (capitalHash(before.evidence.assets) !== liveHash)
          refuse(
            "Retained asset evidence changed. Refresh the asset evidence before reactivating the schedule.",
            "CONFLICT",
          );
        schedule = {
          ...before.evidence,
          ...(v.jurisdiction !== undefined
            ? { calculationVersion: 2 as const, jurisdiction: v.jurisdiction }
            : {}),
        };
      } else {
        schedule = {
          calculationVersion: 2,
          currency: revision.snapshot.currency,
          jurisdiction: v.jurisdiction ?? null,
          evidence: "",
          assets: live,
          rows: live.map((a) => blankCapitalRow(a.assetId, worksheet.ya)),
          utilisation: [],
          predecessor: null,
        };
      }
      for (const entry of overlaps)
        ctx.db
          .update(taxWorksheetAdjustments)
          .set({
            withdrawnAt: new Date().toISOString(),
            withdrawalReason: `Replaced by asset schedule: ${v.reason}`,
          })
          .where(eq(taxWorksheetAdjustments.id, entry.id))
          .run();
      if (overlaps.length)
        audit(
          ctx,
          id,
          [
            {
              field: "replacedManualAllowances",
              before: overlaps,
              after: v.reason,
            },
          ],
          emits,
        );
    } else {
      if (!before) refuse("Prepare an asset schedule first.");
      if (v.action === "refresh-assets") {
        schedule = {
          ...before.evidence,
          assets: live,
          rows: live.map((asset) => {
            const old = before.evidence.rows.find(
              (row) => row.assetId === asset.assetId,
            );
            const oldAsset = before.evidence.assets.find(
              (a) => a.assetId === asset.assetId,
            );
            return old && capitalHash(oldAsset) === capitalHash(asset)
              ? old
              : {
                  ...(old ?? blankCapitalRow(asset.assetId, worksheet.ya)),
                  treatment: "pending" as const,
                  firstYearTreatment: undefined,
                };
          }),
        };
        active = before.active;
        // Reconcile current-year utilisation again after any changed asset workings.
        schedule.utilisation = schedule.utilisation.filter(
          (u) => u.originYa < worksheet.ya,
        );
      } else {
        if (!before.active)
          refuse("Activate the asset schedule before changing its workings.");
        if (capitalHash(before.evidence.assets) !== liveHash)
          refuse(
            "Refresh asset evidence before changing tax workings.",
            "CONFLICT",
          );
        const priorJurisdiction =
          before.evidence.jurisdiction ??
          (before.evidence.calculationVersion === 1 ? "MY" : null);
        const nextJurisdiction =
          v.input.jurisdiction === undefined
            ? priorJurisdiction
            : v.input.jurisdiction;
        schedule = {
          ...before.evidence,
          ...v.input,
          calculationVersion: 2,
          currency: revision.snapshot.currency,
          jurisdiction: nextJurisdiction,
        };
        if (priorJurisdiction !== nextJurisdiction)
          schedule.rows = schedule.rows.map((row) => ({
            ...row,
            treatment: "pending",
            schemeId: null,
            appliedScheme: undefined,
            schemeFirstYear: false,
            firstYearTreatment: undefined,
            schemeOverride: false,
          }));
      }
    }
    if (v.action === "save") {
      const versions = assetTaxSchemeVersions(ctx.db);
      const history = firstYearContexts(
        ctx.db,
        worksheet,
        schedule.assets,
        schedule.currency,
      );
      schedule.rows = schedule.rows.map((row) => {
        if (row.treatment !== "claim")
          return {
            ...row,
            disposal: null,
            schemeId: null,
            appliedScheme: undefined,
            schemeFirstYear: false,
            firstYearTreatment: undefined,
            schemeOverride: false,
          };
        if (!row.schemeId) {
          const { appliedScheme: _snapshot, ...manual } = row;
          void _snapshot;
          return manual;
        }
        const definition = versions.find((s) => s.id === row.schemeId);
        if (
          !definition ||
          !schemeApplies(
            definition.definition,
            schedule.jurisdiction,
            worksheet.ya,
          )
        )
          refuse(
            "Choose a scheme from this book matching the tax jurisdiction and year.",
            "INVALID_INPUT",
          );
        const appliedScheme = schemeSnapshot(definition);
        const asset = schedule.assets.find((a) => a.assetId === row.assetId);
        let firstYearTreatment = row.firstYearTreatment;
        if (firstYearTreatment) {
          if (row.schemeOverride)
            refuse(
              "Automatic first-year treatment cannot be combined with manually overridden allowance amounts.",
            );
          if (
            firstYearTreatment.historyHash !== history[row.assetId]?.historyHash
          )
            refuse(
              "First-year tax history changed. Refresh the worksheet and review the treatment.",
              "CONFLICT",
            );
          if (firstYearTreatment.version === 2) {
            const proposed = resolveFirstYear(
              firstYearTreatment.mode,
              definition.definition,
              row,
              asset,
              history[row.assetId],
              worksheet.dateFrom,
              worksheet.dateTo,
              row.note,
              "preview",
            );
            const oldRow = before?.evidence.rows.find(
              (r) => r.assetId === row.assetId,
            );
            const previouslyConfirmed =
              oldRow?.firstYearTreatment?.confirmation === "worksheet_save" &&
              capitalHash(oldRow) === capitalHash(row);
            if (
              proposed.confirmation === "pending_save" &&
              !v.confirmFirstYearTreatments &&
              !previouslyConfirmed
            )
              refuse(
                "Save asset deductions to confirm the worksheet's first-year treatments together.",
              );
            firstYearTreatment = resolveFirstYear(
              firstYearTreatment.mode,
              definition.definition,
              row,
              asset,
              history[row.assetId],
              worksheet.dateFrom,
              worksheet.dateTo,
              row.note,
              "worksheet_save",
            );
          } else {
            firstYearTreatment = resolveFirstYear(
              firstYearTreatment.mode,
              definition.definition,
              row,
              asset,
              history[row.assetId],
              worksheet.dateFrom,
              worksheet.dateTo,
              row.note,
            );
          }
          if (firstYearTreatment.included !== !!row.schemeFirstYear)
            refuse(
              "The first-year treatment does not match the current history. Recalculate the asset.",
              "CONFLICT",
            );
        } else if (
          (row.schemeFirstYear || (row.initialMinor ?? 0) > 0) &&
          firstYearDecision(
            definition.definition,
            row,
            asset,
            history[row.assetId],
            worksheet.dateFrom,
            worksheet.dateTo,
          ).blocked
        )
          refuse(
            "Initial allowance for this cost was already recorded in an earlier tax year.",
          );
        if (row.schemeOverride) {
          if (row.note.trim().length < 10)
            refuse(
              "Explain the manual override of custom scheme amounts.",
              "INVALID_INPUT",
            );
        } else {
          const preview = calculateAssetTaxScheme(definition.definition, {
            ...row,
            firstYear: row.schemeFirstYear ?? false,
          });
          if (
            preview &&
            (preview.firstYearMinor !== row.initialMinor ||
              preview.regularMinor !== row.annualMinor)
          )
            refuse(
              "The scheme preview does not match the submitted amounts. Recalculate or choose an explained manual override.",
              "CONFLICT",
            );
        }
        return {
          ...row,
          appliedScheme,
          ...(firstYearTreatment ? { firstYearTreatment } : {}),
        };
      });
    }
    capitalTotals(schedule, worksheet.ya, worksheet.dateFrom, worksheet.dateTo);
    draft(ctx, revision);
    ctx.db
      .insert(taxCapitalSchedules)
      .values({ revisionId: revision.id, active, evidence: schedule })
      .onConflictDoUpdate({
        target: taxCapitalSchedules.revisionId,
        set: { active, evidence: schedule },
      })
      .run();
    ctx.db
      .insert(taxCapitalCommands)
      .values({
        requestKey: v.requestKey,
        revisionId: revision.id,
        payloadHash,
      })
      .run();
    audit(
      ctx,
      id,
      [
        {
          field: "capitalAllowanceSchedule",
          before,
          after: { active, evidence: schedule },
        },
        { field: "capitalAllowanceReason", before: null, after: v.reason },
        ...(v.action === "save" && v.confirmFirstYearTreatments
          ? [
              {
                field: "firstYearWorksheetConfirmation",
                before: null,
                after: {
                  confirmed: true,
                  assetIds: schedule.rows
                    .filter((r) => r.treatment === "claim")
                    .map((r) => r.assetId),
                },
              },
            ]
          : []),
      ],
      emits,
    );
    return { worksheetId: id };
  });
}
