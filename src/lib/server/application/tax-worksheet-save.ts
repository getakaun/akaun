import { eq } from "drizzle-orm";
import { taxWorksheetSaveSchema } from "$lib/tax-worksheet-save.js";
import { taxCapitalCommands, taxWorksheetRevisions } from "../db/schema.js";
import {
  taxAdjustmentsFor,
  captureTaxSources,
  taxHash,
  taxWorksheetDetail,
} from "../queries/tax-worksheets.js";
import {
  capitalDetail,
  capitalScheduleFor,
} from "../queries/capital-allowances.js";
import { requirePermissions, type AppContext } from "./context.js";
import { fail, invalid, Rollback, type AppResult } from "./result.js";
import { write, current, audit, refuse } from "./tax-worksheet-boundary.js";
import { addTaxAdjustment, changeTaxWorksheet } from "./tax-worksheets.js";
import {
  changeCapitalSchedule,
  refreshAutomaticUtilisation,
} from "./capital-allowances.js";
import type { TaxWorksheetDetail } from "../queries/tax-worksheets.js";

/** Stage every worksheet section under one authorization and atomic transaction. */
export function saveTaxWorksheet(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<TaxWorksheetDetail> {
  if (!Number.isSafeInteger(id) || id <= 0)
    return fail("INVALID_INPUT", "Choose a valid worksheet.");
  const parsed = taxWorksheetSaveSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  const denied = requirePermissions(ctx, [
    "tax.read",
    "tax.update",
    ...(v.target !== "draft" ? ["tax.review" as const] : []),
    ...(v.target === "finalised" ? ["tax.finalise" as const] : []),
  ]);
  if (denied) return denied;
  return write(
    ctx,
    v.target === "finalised" ? "tax.finalise" : "tax.update",
    (emits) => {
      const payloadHash = taxHash({ worksheetId: id, ...v });
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
            "This request key belongs to a different worksheet save.",
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
        refuse("Create an amendment to change a finalised worksheet.");
      const live = captureTaxSources(
        ctx.db,
        worksheet.dateFrom,
        worksheet.dateTo,
      );
      const before = taxWorksheetDetail(ctx.db, id)!;
      if (taxHash(live) !== v.liveHash)
        refuse(
          "Accounting records changed while saving. The latest figures are loading; check your changes and save again.",
          "CONFLICT",
        );
      for (const adjustment of v.adjustments) {
        if (adjustment.kind !== "source") continue;
        const source = live.expenses.find(
          (s) => s.movementId === adjustment.sourceMovementId,
        );
        if (
          !source ||
          v.sourceHashes[String(adjustment.sourceMovementId)] !==
            taxHash(source)
        )
          refuse(
            "An expense changed after its annual correction was entered. Review that correction against the latest record.",
            "CONFLICT",
          );
      }
      const pending = before.sourceConflicts.map((c) => c.adjustmentId);
      ctx.db
        .update(taxWorksheetRevisions)
        .set({
          snapshot: { ...live, pendingCorrectionIds: pending },
          sourceHash: taxHash(live),
          capturedAt: new Date().toISOString(),
          status: "draft",
          reviewedAt: null,
          reviewedBy: null,
        })
        .where(eq(taxWorksheetRevisions.id, revision.id))
        .run();
      const accept = <T>(result: AppResult<T>): T => {
        if (!result.ok) throw new Rollback(result);
        return result.value;
      };
      const version = () =>
        ctx.db
          .select({ version: taxWorksheetRevisions.version })
          .from(taxWorksheetRevisions)
          .where(eq(taxWorksheetRevisions.id, revision.id))
          .get()!.version;
      for (const withdrawal of v.withdrawals)
        accept(
          changeTaxWorksheet(ctx, id, {
            action: "withdraw",
            expectedVersion: version(),
            ...withdrawal,
          }),
        );
      for (const adjustment of v.adjustments)
        accept(
          addTaxAdjustment(ctx, id, {
            ...adjustment,
            expectedVersion: version(),
          }),
        );
      const activeIds = new Set(
        taxAdjustmentsFor(ctx.db, revision.id)
          .filter((a) => a.withdrawnAt === null)
          .map((a) => a.id),
      );
      ctx.db
        .update(taxWorksheetRevisions)
        .set({
          snapshot: {
            ...live,
            pendingCorrectionIds: pending.filter((a) => activeIds.has(a)),
          },
        })
        .where(eq(taxWorksheetRevisions.id, revision.id))
        .run();
      if (v.capital) {
        const c = v.capital;
        const projection = capitalDetail(ctx.db, worksheet, revision.id, true);
        if (projection.liveAssetHash !== c.liveAssetHash)
          refuse(
            "Asset records changed. Review the updated assets before saving.",
            "CONFLICT",
          );
        const saved = capitalScheduleFor(ctx.db, revision.id);
        if (
          (projection.autoRollover || (!saved && projection.rollover)) &&
          c.rolloverHash !== projection.rolloverHash
        )
          refuse(
            "Prior-year balances changed. Review the latest worksheet figures before saving.",
            "CONFLICT",
          );
        if (saved && projection.autoRollover) {
          accept(
            changeCapitalSchedule(ctx, id, {
              action: "rollover",
              expectedVersion: version(),
              requestKey: crypto.randomUUID(),
              reason: "Updated prior-year balances with worksheet save",
              liveAssetHash: c.liveAssetHash,
              rolloverHash: c.rolloverHash ?? projection.rolloverHash,
            }),
          );
        } else if (!saved) {
          accept(
            changeCapitalSchedule(ctx, id, {
              action: projection.rollover ? "rollover" : "prepare",
              expectedVersion: version(),
              requestKey: crypto.randomUUID(),
              reason: "Prepared together with worksheet save",
              liveAssetHash: c.liveAssetHash,
              ...(projection.rollover
                ? { rolloverHash: c.rolloverHash ?? projection.rolloverHash }
                : {}),
              jurisdiction:
                c.input.jurisdiction ?? projection.defaultJurisdiction,
            }),
          );
        } else if (projection.assetsStale) {
          accept(
            changeCapitalSchedule(ctx, id, {
              action: "refresh-assets",
              expectedVersion: version(),
              requestKey: crypto.randomUUID(),
              reason: "Updated from records with worksheet save",
              liveAssetHash: c.liveAssetHash,
            }),
          );
        }
        accept(
          changeCapitalSchedule(ctx, id, {
            action: "save",
            expectedVersion: version(),
            requestKey: crypto.randomUUID(),
            reason: "Saved together with annual tax worksheet",
            liveAssetHash: c.liveAssetHash,
            input: c.input,
            confirmFirstYearTreatments: c.confirmFirstYearTreatments,
            utilisationHash: c.utilisationHash,
          }),
        );
      }
      refreshAutomaticUtilisation(ctx, worksheet, revision.id, emits);
      if (v.target !== "draft") {
        const detail = taxWorksheetDetail(ctx.db, id)!;
        if (detail.sourceConflicts.length)
          refuse(
            "Resolve changed expense corrections before completing the worksheet.",
          );
        accept(
          changeTaxWorksheet(ctx, id, {
            action: "review",
            expectedVersion: version(),
          }),
        );
        if (v.target === "finalised")
          accept(
            changeTaxWorksheet(ctx, id, {
              action: "finalise",
              expectedVersion: version(),
            }),
          );
      } else {
        ctx.db
          .update(taxWorksheetRevisions)
          .set({ version: version() + 1 })
          .where(eq(taxWorksheetRevisions.id, revision.id))
          .run();
      }
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
            field: "worksheetSave",
            before: {
              version: revision.version,
              sourceHash: revision.sourceHash,
            },
            after: {
              target: v.target,
              sourceHash: taxHash(live),
              confirmedFirstYearTreatments:
                v.capital?.confirmFirstYearTreatments ?? false,
            },
          },
        ],
        emits,
      );
      return { worksheetId: id };
    },
  );
}
