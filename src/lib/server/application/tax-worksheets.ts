import { EventEmitter } from "node:events";
import {
  CapitalAllowanceError,
  blankCapitalRow,
  capitalInputSchema,
  capitalTotals,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import {
  capitalAssets,
  capitalHash,
  capitalScheduleFor,
  capitalDetail,
} from "../queries/capital-allowances.js";
import { deductionMinor, needsTaxReview } from "$lib/expense-tax.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { localToday } from "$lib/local-date.js";
import {
  TaxCalculationError,
  taxAdjustmentSchema,
  taxCreateSchema,
  taxReason,
  taxVersion,
  taxWorksheetTotals,
  safeTaxSum,
} from "$lib/tax-worksheet.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import {
  taxWorksheets,
  taxWorksheetRevisions,
  taxWorksheetAdjustments,
  taxCapitalSchedules,
  taxCapitalCommands,
} from "../db/schema.js";
import { recordAudit, type FieldChange } from "../audit.js";
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
import {
  fail,
  invalid,
  ok,
  Rollback,
  type AppResult,
  type AppFailure,
} from "./result.js";

export const taxWorksheetEvents = new EventEmitter();
taxWorksheetEvents.setMaxListeners(200);
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
function refuse(reason: string, code: AppFailure["code"] = "REFUSED"): never {
  throw new Rollback(fail(code, reason));
}
function audit(
  ctx: AppContext,
  worksheetId: number,
  changes: FieldChange[],
  emits: (() => void)[],
  create = false,
) {
  recordAudit(ctx.db, {
    recordType: "tax_worksheet",
    recordId: worksheetId,
    userId: actor(ctx),
    action: create ? "create" : "update",
    changes,
    deferredEmits: emits,
  });
}
type Target = {
  worksheetId: number;
  revisionNumber?: number;
  changed?: boolean;
};
/** One book connection, immediate transaction, and post-commit signals; never calls ledger writers. */
function write(
  ctx: AppContext,
  permission: LeafPermission,
  body: (emits: (() => void)[]) => Target,
): AppResult<TaxWorksheetDetail> {
  const denied = requirePermissions(ctx, ["tax.read", permission]);
  if (denied) return denied;
  if (
    (permission === "tax.finalise" || permission === "tax.amend") &&
    ctx.locals.credential
  )
    return fail(
      "FORBIDDEN",
      "Finalising or amending requires a signed-in session.",
    );
  const emits: (() => void)[] = [];
  try {
    const result = ctx.db.transaction(
      () => {
        const target = body(emits);
        const detail = taxWorksheetDetail(
          ctx.db,
          target.worksheetId,
          target.revisionNumber,
        );
        if (!detail)
          refuse("That tax worksheet no longer exists.", "NOT_FOUND");
        if (target.changed !== false)
          emits.push(() => taxWorksheetEvents.emit("changed"));
        return detail;
      },
      { behavior: "immediate" },
    );
    for (const emit of emits) emit();
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    if (
      error instanceof TaxCalculationError ||
      error instanceof CapitalAllowanceError
    )
      return fail("REFUSED", error.message);
    throw error;
  }
}
function current(ctx: AppContext, id: number, expectedVersion: number) {
  const worksheet = ctx.db
    .select()
    .from(taxWorksheets)
    .where(eq(taxWorksheets.id, id))
    .get();
  const revision = latestTaxRevision(ctx.db, id);
  if (!worksheet || !revision)
    refuse("That tax worksheet no longer exists.", "NOT_FOUND");
  if (revision.version !== expectedVersion)
    refuse(
      "This worksheet changed. Refresh and review it before trying again.",
      "CONFLICT",
    );
  return { worksheet, revision };
}
function draft(
  ctx: AppContext,
  revision: typeof taxWorksheetRevisions.$inferSelect,
) {
  if (revision.status === "finalised")
    refuse("This revision is finalised. Create an amendment to make changes.");
  ctx.db
    .update(taxWorksheetRevisions)
    .set({
      status: "draft",
      version: revision.version + 1,
      reviewedBy: null,
      reviewedAt: null,
    })
    .where(eq(taxWorksheetRevisions.id, revision.id))
    .run();
}

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
          .set({ snapshot: live, sourceHash: liveHash, capturedAt: now })
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
      replaceManual: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("rollover"),
      ...capitalCommandBase,
      liveAssetHash: z.string().length(64),
      rolloverHash: z.string().length(64),
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
    if (revision.snapshot.currency !== "MYR")
      refuse(
        "Capital allowance schedules currently support MYR books only. Keep reviewed manual totals for this worksheet.",
      );
    const before = capitalScheduleFor(ctx.db, revision.id);
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
        schedule = before.evidence;
      } else {
        schedule = {
          calculationVersion: 1,
          currency: "MYR",
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
        schedule = { ...before.evidence, ...v.input };
      }
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
      ],
      emits,
    );
    return { worksheetId: id };
  });
}
