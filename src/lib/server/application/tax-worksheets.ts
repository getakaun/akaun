export { saveTaxWorksheet } from "./tax-worksheet-save.js";
import {
  capitalScheduleFor,
  capitalDetail,
} from "../queries/capital-allowances.js";
import {
  write,
  current,
  draft,
  audit,
  refuse,
} from "./tax-worksheet-boundary.js";
export { taxWorksheetEvents } from "./tax-worksheet-boundary.js";
export {
  changeCapitalSchedule,
  capitalCommandSchema,
} from "./capital-allowances.js";
import { deductionMinor, needsTaxReview } from "$lib/expense-tax.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { localToday } from "$lib/local-date.js";
import {
  taxAdjustmentSchema,
  taxCreateSchema,
  taxReason,
  taxVersion,
  taxWorksheetTotals,
  safeTaxSum,
} from "$lib/tax-worksheet.js";
import {
  taxWorksheets,
  taxWorksheetRevisions,
  taxWorksheetAdjustments,
  taxCapitalSchedules,
} from "../db/schema.js";
import {
  captureTaxSources,
  latestTaxRevision,
  taxAdjustmentsFor,
  taxHash,
  taxSourceChanges,
  taxWorksheetDetail,
  taxWorksheetList,
  type TaxWorksheetDetail,
} from "../queries/tax-worksheets.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, invalid, ok, type AppResult } from "./result.js";

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commandBase = { expectedVersion: taxVersion };
export const taxCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), ...commandBase }).strict(),
  z.object({ action: z.literal("finalise"), ...commandBase }).strict(),
  z
    .object({
      action: z.literal("refresh"),
      ...commandBase,
      liveHash: z.string().length(64),
      reason: taxReason,
    })
    .strict(),
  z
    .object({
      action: z.literal("amend"),
      ...commandBase,
      requestKey: z.string().uuid(),
      reason: taxReason,
    })
    .strict(),
  z
    .object({
      action: z.literal("withdraw"),
      ...commandBase,
      adjustmentId: idSchema,
      reason: taxReason,
    })
    .strict(),
  z.object({ action: z.literal("resume"), ...commandBase }).strict(),
]);
export function readTaxWorksheets(ctx: AppContext) {
  const denied = requirePermissions(ctx, ["tax.read"]);
  if (denied) return denied;
  return ok(ctx.db.transaction(() => taxWorksheetList(ctx.db)));
}
export function readTaxWorksheet(
  ctx: AppContext,
  id: number,
  revisionNumber?: number,
  compareLive = true,
): AppResult<TaxWorksheetDetail> {
  const denied = requirePermissions(ctx, ["tax.read"]);
  if (denied) return denied;
  if (
    !idSchema.safeParse(id).success ||
    (revisionNumber !== undefined &&
      !idSchema.safeParse(revisionNumber).success)
  )
    return fail("INVALID_INPUT", "Choose a valid worksheet and revision.");
  const result = ctx.db.transaction(() =>
    taxWorksheetDetail(ctx.db, id, revisionNumber, compareLive),
  );
  return result
    ? ok(result)
    : fail("NOT_FOUND", "That tax worksheet revision does not exist.");
}
export function createTaxWorksheet(
  ctx: AppContext,
  input: unknown,
): AppResult<TaxWorksheetDetail> {
  const denied = requirePermissions(ctx, ["tax.read", "tax.create"]);
  if (denied) return denied;
  const parsed = taxCreateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, "tax.create", (emits) => {
    const v = parsed.data;
    const existing = ctx.db.select().from(taxWorksheets).all();
    const replay = existing.find((w) => w.requestKey === v.requestKey);
    if (replay) {
      if (
        replay.ya !== v.ya ||
        replay.dateFrom !== v.dateFrom ||
        replay.dateTo !== v.dateTo
      )
        refuse(
          "This request key was already used for a different worksheet.",
          "CONFLICT",
        );
      return { worksheetId: replay.id, changed: false };
    }
    if (existing.some((w) => w.ya === v.ya))
      refuse(
        "A worksheet already exists for this YA. Open it or create an amendment.",
        "CONFLICT",
      );
    if (existing.some((w) => w.dateFrom <= v.dateTo && w.dateTo >= v.dateFrom))
      refuse(
        "This accounting period overlaps an existing annual worksheet.",
        "CONFLICT",
      );
    const snapshot = captureTaxSources(ctx.db, v.dateFrom, v.dateTo);
    const now = new Date().toISOString();
    const worksheet = ctx.db
      .insert(taxWorksheets)
      .values({ ...v, createdBy: actor(ctx), createdAt: now })
      .returning()
      .get();
    ctx.db
      .insert(taxWorksheetRevisions)
      .values({
        worksheetId: worksheet.id,
        revision: 1,
        snapshot,
        sourceHash: taxHash(snapshot),
        capturedAt: now,
        requestKey: v.requestKey,
      })
      .run();
    audit(
      ctx,
      worksheet.id,
      [
        {
          field: "annualPeriod",
          before: null,
          after: { ya: v.ya, dateFrom: v.dateFrom, dateTo: v.dateTo },
        },
        { field: "sourceEvidence", before: null, after: snapshot },
      ],
      emits,
      true,
    );
    return { worksheetId: worksheet.id };
  });
}

export function addTaxAdjustment(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<TaxWorksheetDetail> {
  const denied = requirePermissions(ctx, ["tax.read", "tax.update"]);
  if (denied) return denied;
  const parsed = taxAdjustmentSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (!idSchema.safeParse(id).success)
    return fail("INVALID_INPUT", "Choose a valid worksheet.");
  return write(ctx, "tax.update", (emits) => {
    const v = parsed.data;
    const revision = latestTaxRevision(ctx.db, id);
    if (!revision) refuse("That tax worksheet no longer exists.", "NOT_FOUND");
    const rows = taxAdjustmentsFor(ctx.db, revision.id);
    const source =
      v.kind === "source"
        ? revision.snapshot.expenses.find(
            (l) => l.movementId === v.sourceMovementId,
          )
        : null;
    if (v.kind === "source" && (!source || source.voided))
      refuse(
        "Choose an eligible, non-voided expense line from this revision.",
        "INVALID_INPUT",
      );
    const sourceDelta =
      v.kind === "source" && source
        ? safeTaxSum([
            source.expenseMinor,
            -deductionMinor(source.expenseMinor, v.percentageBps!),
            ...(needsTaxReview(source.classification)
              ? []
              : [
                  -source.expenseMinor,
                  deductionMinor(
                    source.expenseMinor,
                    source.classification!.percentageBps!,
                  ),
                ]),
          ])
        : 0;
    const values =
      v.kind === "source"
        ? {
            kind: v.kind,
            sourceMovementId: v.sourceMovementId,
            percentageBps: v.percentageBps,
            treatment: v.treatment,
            amountMinor: Math.abs(sourceDelta),
            direction:
              sourceDelta > 0 ? ("increase" as const) : ("decrease" as const),
            balanceMinor: 0,
            originYa: null,
            reason: v.reason,
            evidence: v.evidence,
          }
        : {
            kind: v.kind,
            sourceMovementId: null,
            percentageBps: null,
            treatment: null,
            amountMinor: v.amountMinor,
            direction: v.direction,
            balanceMinor: v.balanceMinor,
            originYa: v.originYa,
            reason: v.reason,
            evidence: v.evidence,
          };
    const replay = rows.find((a) => a.requestKey === v.requestKey);
    if (replay) {
      if (
        Object.entries(values).some(
          ([key, value]) => replay[key as keyof typeof replay] !== value,
        )
      )
        refuse(
          "This request key was already used for a different adjustment.",
          "CONFLICT",
        );
      return { worksheetId: id, changed: false };
    }
    const { worksheet } = current(ctx, id, v.expectedVersion);
    if (revision.status === "finalised")
      refuse("Create an amendment to change a finalised worksheet.");
    if (
      (v.kind === "capital_allowance" ||
        v.kind === "allowance_brought_forward") &&
      capitalScheduleFor(ctx.db, revision.id)?.active
    )
      refuse(
        "This revision uses its asset schedule. Change the schedule or explicitly switch to manual totals before adding allowance entries.",
      );
    if (values.originYa !== null && values.originYa >= worksheet.ya)
      refuse(
        "Brought-forward balances must originate in an earlier YA.",
        "INVALID_INPUT",
      );
    const snapshot = revision.snapshot;
    if (v.kind === "source") {
      const source = snapshot.expenses.find(
        (l) => l.movementId === v.sourceMovementId,
      );
      if (!source || source.voided)
        refuse(
          "Choose an eligible, non-voided expense line from this revision.",
          "INVALID_INPUT",
        );
      const live = captureTaxSources(
        ctx.db,
        worksheet.dateFrom,
        worksheet.dateTo,
      );
      if (taxHash(live) !== revision.sourceHash)
        refuse(
          "Accounting records changed. Review and refresh the worksheet before adding annual treatment corrections.",
          "CONFLICT",
        );
      const old = rows.find(
        (a) =>
          a.kind === "source" &&
          a.sourceMovementId === v.sourceMovementId &&
          a.withdrawnAt === null,
      );
      if (old)
        ctx.db
          .update(taxWorksheetAdjustments)
          .set({
            withdrawnAt: new Date().toISOString(),
            withdrawalReason: `Replaced: ${v.reason}`,
          })
          .where(eq(taxWorksheetAdjustments.id, old.id))
          .run();
    } else if (
      v.kind !== "other" &&
      rows.some(
        (a) =>
          a.kind === v.kind &&
          a.originYa === v.originYa &&
          a.withdrawnAt === null,
      )
    ) {
      refuse(
        "A claim or balance for this category and origin YA already exists. Withdraw it before replacing it.",
        "CONFLICT",
      );
    }
    const adjustment = ctx.db
      .insert(taxWorksheetAdjustments)
      .values({
        ...values,
        revisionId: revision.id,
        requestKey: v.requestKey,
        createdBy: actor(ctx),
        actorName: ctx.locals.user!.name ?? ctx.locals.user!.username,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
    draft(ctx, revision);
    // Validate aggregate safety before committing any adjustment or supersession.
    taxWorksheetTotals(snapshot, taxAdjustmentsFor(ctx.db, revision.id));
    audit(
      ctx,
      id,
      [
        {
          field: "annualTaxAdjustment",
          before: rows.filter(
            (a) =>
              a.withdrawnAt === null &&
              a.sourceMovementId === adjustment.sourceMovementId &&
              a.kind === "source",
          ),
          after: adjustment,
        },
        ...(v.kind === "source"
          ? [
              {
                field: "originalExpenseEvidence",
                before: null,
                after: snapshot.expenses.find(
                  (l) => l.movementId === v.sourceMovementId,
                ),
              },
            ]
          : []),
      ],
      emits,
    );
    return { worksheetId: id };
  });
}

export function changeTaxWorksheet(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<TaxWorksheetDetail> {
  const parsed = taxCommandSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (!idSchema.safeParse(id).success)
    return fail("INVALID_INPUT", "Choose a valid worksheet.");
  const v = parsed.data;
  const permission =
    v.action === "review"
      ? "tax.review"
      : v.action === "finalise"
        ? "tax.finalise"
        : v.action === "amend"
          ? "tax.amend"
          : "tax.update";
  return write(ctx, permission, (emits) => {
    if (v.action === "amend") {
      const replay = ctx.db
        .select()
        .from(taxWorksheetRevisions)
        .where(eq(taxWorksheetRevisions.requestKey, v.requestKey))
        .get();
      if (replay) {
        if (replay.worksheetId !== id || replay.amendmentReason !== v.reason)
          refuse(
            "This request key belongs to a different amendment.",
            "CONFLICT",
          );
        return {
          worksheetId: id,
          revisionNumber: replay.revision,
          changed: false,
        };
      }
    }
    const { worksheet, revision } = current(ctx, id, v.expectedVersion);
    const now = new Date().toISOString();
    const adjustments = taxAdjustmentsFor(ctx.db, revision.id);
    if (v.action === "amend") {
      if (revision.status !== "finalised")
        refuse("Finalise the current revision before creating an amendment.");
      const next = ctx.db
        .insert(taxWorksheetRevisions)
        .values({
          worksheetId: id,
          revision: revision.revision + 1,
          // Keep versions increasing across amendments: an old tab must never
          // accidentally match a newly created revision's initial version.
          version: revision.version + 1,
          snapshot: revision.snapshot,
          sourceHash: revision.sourceHash,
          capturedAt: revision.capturedAt,
          amendmentReason: v.reason,
          requestKey: v.requestKey,
        })
        .returning()
        .get();
      for (const a of adjustments.filter((a) => a.withdrawnAt === null)) {
        const { id: _id, ...copy } = a;
        void _id;
        ctx.db
          .insert(taxWorksheetAdjustments)
          .values({ ...copy, revisionId: next.id })
          .run();
      }
      const schedule = capitalScheduleFor(ctx.db, revision.id);
      if (schedule)
        ctx.db
          .insert(taxCapitalSchedules)
          .values({ ...schedule, revisionId: next.id })
          .run();
      audit(
        ctx,
        id,
        [
          {
            field: "amendment",
            before: { revision: revision.revision, status: revision.status },
            after: { revision: next.revision, reason: v.reason },
          },
        ],
        emits,
      );
      return { worksheetId: id };
    }
    if (revision.status === "finalised")
      refuse(
        "This revision is finalised. Create an amendment to make changes.",
      );
    if (v.action === "withdraw") {
      const adjustment = adjustments.find(
        (a) => a.id === v.adjustmentId && a.withdrawnAt === null,
      );
      if (!adjustment)
        refuse(
          "That active adjustment does not belong to this revision.",
          "NOT_FOUND",
        );
      ctx.db
        .update(taxWorksheetAdjustments)
        .set({ withdrawnAt: now, withdrawalReason: v.reason })
        .where(
          and(
            eq(taxWorksheetAdjustments.id, adjustment.id),
            eq(taxWorksheetAdjustments.revisionId, revision.id),
          ),
        )
        .run();
      draft(ctx, revision);
      audit(
        ctx,
        id,
        [
          {
            field: "withdrawnAdjustment",
            before: adjustment,
            after: { id: adjustment.id, reason: v.reason },
          },
        ],
        emits,
      );
    } else if (v.action === "resume") {
      if (revision.status !== "reviewed")
        refuse("This worksheet is already editable.");
      draft(ctx, revision);
      audit(
        ctx,
        id,
        [{ field: "status", before: "reviewed", after: "draft" }],
        emits,
      );
    } else {
      const live = captureTaxSources(
        ctx.db,
        worksheet.dateFrom,
        worksheet.dateTo,
      );
      const liveHash = taxHash(live);
      if (v.action === "refresh") {
        if (v.liveHash !== liveHash)
          refuse(
            "Accounting records changed again. Review the latest differences before refreshing.",
            "CONFLICT",
          );
        const changedIds = new Set(
          taxSourceChanges(revision.snapshot, live).map((c) => c.movementId),
        );
        if (
          adjustments.some(
            (a) =>
              a.kind === "source" &&
              a.withdrawnAt === null &&
              changedIds.has(a.sourceMovementId!),
          )
        )
          refuse(
            "Withdraw annual corrections on changed or removed expense lines before refreshing. Their history will be retained.",
          );
        draft(ctx, revision);
        ctx.db
          .update(taxWorksheetRevisions)
          .set({
            snapshot: {
              ...live,
              ...(revision.snapshot.pendingCorrectionIds
                ? {
                    pendingCorrectionIds:
                      revision.snapshot.pendingCorrectionIds,
                  }
                : {}),
            },
            sourceHash: liveHash,
            capturedAt: now,
          })
          .where(eq(taxWorksheetRevisions.id, revision.id))
          .run();
        audit(
          ctx,
          id,
          [
            { field: "sourceEvidence", before: revision.snapshot, after: live },
            { field: "refreshReason", before: null, after: v.reason },
          ],
          emits,
        );
      } else {
        if (liveHash !== revision.sourceHash)
          refuse(
            "Accounting records changed. Review and refresh the worksheet before reviewing or finalising.",
            "CONFLICT",
          );
        const capital = capitalDetail(ctx.db, worksheet, revision.id, true);
        if (capital.active && capital.currencyMismatch)
          refuse(
            "The retained schedule currency differs from this worksheet. Use manual totals or a confirmed matching-currency rollover; amounts cannot be relabelled.",
            "CONFLICT",
          );
        if (capital.active && (capital.assetsStale || capital.predecessorStale))
          refuse(
            "Capital allowance evidence changed. Refresh the asset evidence or bring forward the latest finalised predecessor and review again.",
            "CONFLICT",
          );
        if (capital.active && capital.totals?.problems.length)
          refuse(
            `Complete the capital allowance review: ${capital.totals.problems[0]}`,
          );
        if (
          capital.active &&
          adjustments.some(
            (a) =>
              a.withdrawnAt === null &&
              ["capital_allowance", "allowance_brought_forward"].includes(
                a.kind,
              ),
          )
        )
          refuse(
            "Remove overlapping manual allowance claims before reviewing the asset schedule.",
          );
        const totals = taxWorksheetTotals(
          revision.snapshot,
          adjustments,
          capital.active ? capital.totals : null,
        );
        if (
          revision.snapshot.pendingCorrectionIds?.some((id) =>
            adjustments.some((a) => a.id === id && a.withdrawnAt === null),
          )
        )
          refuse(
            "Resolve changed expense corrections before reviewing or finalising.",
          );
        if (totals.unresolvedCount)
          refuse(
            `Resolve ${totals.unresolvedCount} expense classification(s) before reviewing or finalising.`,
          );
        if (v.action === "review") {
          if (revision.status !== "draft")
            refuse("This worksheet is already reviewed.");
          ctx.db
            .update(taxWorksheetRevisions)
            .set({
              status: "reviewed",
              version: revision.version + 1,
              reviewedBy: actor(ctx),
              reviewedAt: now,
            })
            .where(eq(taxWorksheetRevisions.id, revision.id))
            .run();
        } else {
          if (revision.status !== "reviewed")
            refuse("Review this revision before finalising it.");
          if (worksheet.dateTo >= localToday())
            refuse("Only a completed accounting period can be finalised.");
          ctx.db
            .update(taxWorksheetRevisions)
            .set({
              status: "finalised",
              version: revision.version + 1,
              finalisedBy: actor(ctx),
              finalisedAt: now,
            })
            .where(eq(taxWorksheetRevisions.id, revision.id))
            .run();
        }
        audit(
          ctx,
          id,
          [
            {
              field: "status",
              before: revision.status,
              after: v.action === "review" ? "reviewed" : "finalised",
            },
            {
              field: "revision",
              before: revision.revision,
              after: revision.revision,
            },
          ],
          emits,
        );
      }
    }
    return { worksheetId: id };
  });
}
