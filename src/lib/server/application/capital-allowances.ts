import { resolveFirstYear } from "$lib/first-year-allowance.js";
import { automaticUtilisation } from "$lib/capital-utilisation-policy.js";
import { calculateUtilisation } from "$lib/capital-utilisation.js";
import { taxUtilisationContext } from "../queries/tax-utilisation.js";
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
  taxCapitalSchedules,
  taxCapitalCommands,
} from "../db/schema.js";
import type { TaxWorksheetDetail } from "../queries/tax-worksheets.js";
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
    })
    .strict(),
  z
    .object({
      action: z.literal("rollover"),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      rolloverHash: z.string().length(64),
      jurisdiction: taxJurisdictionSchema.nullable().optional(),
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
      utilisationHash: z.string().length(64).optional(),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      input: capitalInputSchema,
    })
    .strict(),
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
      v.action !== "rollover"
    )
      refuse(
        "The retained schedule currency differs from the worksheet. Use a confirmed matching-currency rollover; amounts are never converted or relabelled automatically.",
        "CONFLICT",
      );
    const live = capitalAssets(ctx.db, worksheet.dateTo);
    const liveHash = capitalHash(live);
    if (v.liveAssetHash !== liveHash)
      refuse(
        "Asset evidence changed. Refresh and review the current asset list before saving.",
        "CONFLICT",
      );
    let schedule: CapitalSchedule;
    if (v.action === "prepare" || v.action === "rollover") {
      if (v.action === "rollover") {
        const preview = capitalDetail(ctx.db, worksheet, revision.id, true);
        if (!preview.rollover || preview.rolloverHash !== v.rolloverHash)
          refuse(
            "The prior-year schedule changed or is not finalised. Review a fresh rollover preview.",
            "CONFLICT",
          );
        schedule = preview.rollover;
      } else if (before) {
        refuse("The asset schedule is already prepared.");
      } else {
        schedule = {
          calculationVersion: 2,
          currency: revision.snapshot.currency,
          jurisdiction: v.jurisdiction ?? null,
          evidence: "",
          assets: live,
          rows: live.map((a) => blankCapitalRow(a.assetId)),
          utilisation: [],
          utilisationPolicy: automaticUtilisation(),
          predecessor: null,
        };
      }
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
                  ...(old ?? blankCapitalRow(asset.assetId)),
                  treatment: "pending" as const,
                  firstYearTreatment: undefined,
                };
          }),
        };
        // Reconcile current-year utilisation again after any changed asset workings.
        schedule.utilisation = schedule.utilisation.filter(
          (u) => u.originYa < worksheet.ya,
        );
      } else {
        if (capitalHash(before.evidence.assets) !== liveHash)
          refuse(
            "Refresh asset evidence before changing tax workings.",
            "CONFLICT",
          );
        const priorJurisdiction = before.evidence.jurisdiction;
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
            schemeId: null,
            appliedScheme: undefined,
            schemeFirstYear: false,
            firstYearTreatment: undefined,
          };
        if (!row.schemeId)
          refuse(
            "Choose a configured scheme for every claimed asset.",
            "INVALID_INPUT",
          );
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
        if (
          row.firstYearTreatment &&
          row.firstYearTreatment.historyHash !==
            history[row.assetId]?.historyHash
        )
          refuse(
            "First-year tax history changed. Refresh the worksheet and review the treatment.",
            "CONFLICT",
          );
        const mode = row.firstYearTreatment?.mode ?? "auto";
        const proposed = resolveFirstYear(
          mode,
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
            "Save the worksheet to confirm its first-year treatments together.",
          );
        const firstYearTreatment = resolveFirstYear(
          mode,
          definition.definition,
          row,
          asset,
          history[row.assetId],
          worksheet.dateFrom,
          worksheet.dateTo,
          row.note,
          "worksheet_save",
        );
        if (firstYearTreatment.included !== !!row.schemeFirstYear)
          refuse(
            "The first-year treatment does not match the current history. Recalculate the asset.",
            "CONFLICT",
          );
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
            "The scheme calculation does not match the submitted amounts. Recalculate the asset.",
            "CONFLICT",
          );
        return {
          ...row,
          appliedScheme,
          firstYearTreatment,
        };
      });
    }
    if (schedule.utilisationPolicy) {
      const context = taxUtilisationContext(ctx.db, worksheet, revision.id);
      if (
        v.action === "save" &&
        schedule.rows.some((r) => r.treatment === "claim") &&
        v.utilisationHash !== context.hash
      )
        refuse(
          "Income evidence changed. Refresh the allowance calculation before saving.",
          "CONFLICT",
        );
      schedule = calculateUtilisation(schedule, worksheet.ya, context, true);
    }
    capitalTotals(schedule, worksheet.ya);
    draft(ctx, revision);
    ctx.db
      .insert(taxCapitalSchedules)
      .values({ revisionId: revision.id, evidence: schedule })
      .onConflictDoUpdate({
        target: taxCapitalSchedules.revisionId,
        set: { evidence: schedule },
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
          after: { evidence: schedule },
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

/** Persist derived uses before review/finalisation, in the caller's tax transaction. */
export function refreshAutomaticUtilisation(
  ctx: AppContext,
  worksheet: Parameters<typeof taxUtilisationContext>[1],
  revisionId: number,
  emits: (() => void)[],
) {
  const saved = capitalScheduleFor(ctx.db, revisionId);
  if (!saved?.evidence.utilisationPolicy) return;
  const calculated = calculateUtilisation(
    saved.evidence,
    worksheet.ya,
    taxUtilisationContext(ctx.db, worksheet, revisionId),
    true,
  );
  if (capitalHash(calculated) === capitalHash(saved.evidence)) return;
  ctx.db
    .update(taxCapitalSchedules)
    .set({ evidence: calculated })
    .where(eq(taxCapitalSchedules.revisionId, revisionId))
    .run();
  audit(
    ctx,
    worksheet.id,
    [
      {
        field: "allowanceUtilisation",
        before: saved.evidence,
        after: calculated,
      },
    ],
    emits,
  );
}
