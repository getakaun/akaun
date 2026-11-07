import { z } from "zod";
import { eq } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { AccountType, AssetSubType, LedgerRecordKind } from "$lib/enums.js";
import {
  accounts,
  fixedAssets,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import { isValidDate } from "../date.js";
import { inVoidPair } from "../queries/void-state.js";
import { sql } from "drizzle-orm";
import { recordAudit, diffRecords } from "../audit.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  invalid,
  ok,
  conflict,
  Rollback,
  type AppResult,
} from "./result.js";

export const assetEvents = new EventEmitter();
assetEvents.setMaxListeners(200);
const date = z.string().refine(isValidDate, "Enter a real date as YYYY-MM-DD.");
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const assetInput = z
  .object({
    assetCode: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(4000),
    category: z.string().trim().min(1).max(120),
    acquisitionDate: date,
    inServiceDate: date.nullable().default(null),
    costMinor: minor.refine((n) => n > 0),
    accountId: id,
    origin: z.enum(["purchase", "legacy"]),
    sourceMovementId: id.nullable().default(null),
    openingDate: date.nullable().default(null),
    openingAccumulatedMinor: minor.default(0),
    accumulatedAccountId: id.nullable().default(null),
    reconciliationNote: z.string().trim().min(1).max(4000),
    businessUseBps: z.number().int().min(0).max(10000).nullable().default(null),
    documentation: z.string().trim().min(1).max(4000),
    method: z.enum(["none", "straight_line"]).default("none"),
    usefulLifeMonths: z
      .number()
      .int()
      .min(1)
      .max(1200)
      .nullable()
      .default(null),
    residualMinor: minor.default(0),
    expenseAccountId: id.nullable().default(null),
    acknowledgedExistingGl: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (v.inServiceDate && v.inServiceDate < v.acquisitionDate)
      issue("In-service date cannot precede acquisition.");
    if (
      v.residualMinor > v.costMinor ||
      v.openingAccumulatedMinor > v.costMinor
    )
      issue(
        "Residual value and brought-forward depreciation cannot exceed cost.",
      );
    if (
      v.origin === "purchase" &&
      (!v.sourceMovementId || v.openingDate || v.openingAccumulatedMinor)
    )
      issue(
        "Purchase registration needs one source line and no opening values.",
      );
    if (
      v.origin === "legacy" &&
      (v.sourceMovementId ||
        !v.openingDate ||
        v.openingDate < v.acquisitionDate)
    )
      issue(
        "Legacy assets need an opening date on/after acquisition and no purchase line.",
      );
    if (v.openingAccumulatedMinor && !v.accumulatedAccountId)
      issue("Choose the existing accumulated depreciation account.");
    if (v.accumulatedAccountId === v.accountId)
      issue("Cost and accumulated depreciation need separate accounts.");
    if (v.method === "straight_line" && !v.usefulLifeMonths)
      issue("Enter useful life for the suggested straight-line profile.");
  });
export type AssetInput = z.output<typeof assetInput>;
export type FixedAsset = typeof fixedAssets.$inferSelect;

/** Registration only: this operation never calls a ledger posting or mutation function. */
export function saveAsset(
  ctx: AppContext,
  input: unknown,
  edit?: { id: number; expectedVersion: number; reason: string },
): AppResult<FixedAsset> {
  const denied = requirePermissions(ctx, ["accounts.read", "accounts.update"]);
  if (denied) return denied;
  const parsed = assetInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (parsed.data.origin === "purchase") {
    const denied = requirePermissions(ctx, ["records.read"]);
    if (denied) return denied;
  }
  if (
    edit &&
    (!Number.isSafeInteger(edit.id) ||
      edit.id <= 0 ||
      !Number.isSafeInteger(edit.expectedVersion) ||
      !edit.reason.trim() ||
      edit.reason.length > 4000)
  )
    return fail(
      "INVALID_INPUT",
      "A valid asset, version and correction reason are required.",
    );
  try {
    const result = ctx.db.transaction(
      (tx) => {
        const refuse = (reason: string): never => {
          throw new Rollback(fail("REFUSED", reason));
        };
        const v = parsed.data;
        const before = edit
          ? tx
              .select()
              .from(fixedAssets)
              .where(eq(fixedAssets.id, edit.id))
              .get()
          : null;
        if (edit && !before)
          throw new Rollback(
            fail("NOT_FOUND", "Asset not found in this book."),
          );
        if (edit && before && before.version !== edit.expectedVersion)
          throw new Rollback(conflict(String(before.version)));
        if (
          before &&
          (before.origin !== v.origin ||
            before.sourceMovementId !== v.sourceMovementId)
        )
          refuse("A registration's origin and source line cannot be replaced.");
        const account = tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, v.accountId))
          .get();
        if (
          !account ||
          account.archivedAt !== null ||
          account.type !== AccountType.Asset ||
          account.subType !== AssetSubType.FixedAsset
        )
          refuse(
            "Choose an active fixed-asset GL account in this book, not an expense account.",
          );
        if (v.accumulatedAccountId) {
          const contra = tx
            .select()
            .from(accounts)
            .where(eq(accounts.id, v.accumulatedAccountId))
            .get();
          if (
            !contra ||
            contra.archivedAt !== null ||
            contra.type !== AccountType.Asset ||
            contra.subType !== AssetSubType.FixedAsset
          )
            refuse(
              "Accumulated depreciation must be a separate active fixed-asset (contra-asset) account.",
            );
          if (
            tx
              .select()
              .from(fixedAssets)
              .where(eq(fixedAssets.accountId, v.accumulatedAccountId))
              .all()
              .some((a) => a.id !== before?.id)
          )
            refuse(
              "That accumulated account already holds registered asset costs.",
            );
        }
        if (
          tx
            .select()
            .from(fixedAssets)
            .where(eq(fixedAssets.accumulatedAccountId, v.accountId))
            .all()
            .some((a) => a.id !== before?.id)
        )
          refuse(
            "That cost account is already mapped as accumulated depreciation.",
          );
        if (v.expenseAccountId) {
          const expense = tx
            .select()
            .from(accounts)
            .where(eq(accounts.id, v.expenseAccountId))
            .get();
          if (
            !expense ||
            expense.archivedAt !== null ||
            expense.type !== AccountType.Expense
          )
            refuse(
              "Choose an active Expense account for the suggested profile.",
            );
        }
        let sourceRecordId: number | null = null;
        if (v.sourceMovementId) {
          const source = tx
            .select({
              movement: ledgerMovements,
              record: ledgerRecords,
              voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
            })
            .from(ledgerMovements)
            .innerJoin(
              ledgerRecords,
              eq(ledgerRecords.id, ledgerMovements.recordId),
            )
            .where(eq(ledgerMovements.id, v.sourceMovementId))
            .get();
          if (
            !source ||
            source.voided ||
            source.record.kind === LedgerRecordKind.OpeningBalance ||
            source.record.kind === LedgerRecordKind.Reversal ||
            source.movement.accountId !== v.accountId ||
            source.movement.amountMinor !== v.costMinor ||
            source.record.date !== v.acquisitionDate
          )
            refuse(
              "Source must be a non-void purchase/capital line (use legacy registration for opening balances) with the same account, positive cost and acquisition date. Refresh the source record.",
            );
          sourceRecordId = source!.record.id;
          if (before && before.sourceRecordId !== sourceRecordId)
            refuse(
              "The source line was replaced. Review its reconciliation exception.",
            );
        }
        const duplicate = tx
          .select()
          .from(fixedAssets)
          .all()
          .find(
            (a) =>
              a.id !== before?.id &&
              (a.assetCode === v.assetCode ||
                (v.sourceMovementId !== null &&
                  a.sourceMovementId === v.sourceMovementId)),
          );
        if (duplicate)
          refuse(
            "The asset identity or source line is already registered. Use its existing registration.",
          );
        // Do not persist the acknowledgement as an unexplained GL entry: the audit keeps the note.
        const { acknowledgedExistingGl: _ack, ...fields } = v;
        void _ack;
        const values = { ...fields, sourceRecordId };
        const asset = before
          ? tx
              .update(fixedAssets)
              .set({ ...values, version: before.version + 1 })
              .where(eq(fixedAssets.id, before.id))
              .returning()
              .get()!
          : tx
              .insert(fixedAssets)
              .values({ ...values, createdBy: actor(ctx) })
              .returning()
              .get()!;
        recordAudit(tx, {
          recordType: "fixed_asset",
          recordId: asset.id,
          userId: actor(ctx),
          action: before ? "update" : "create",
          label: asset.assetCode + " " + asset.name,
          changes: [
            ...diffRecords(before, asset),
            ...(edit
              ? [
                  {
                    field: "correctionReason",
                    before: null,
                    after: edit.reason.trim(),
                  },
                ]
              : []),
          ],
        });
        return asset;
      },
      { behavior: "immediate" },
    );
    assetEvents.emit("asset-update", { id: result.id });
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
