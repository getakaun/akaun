import { eq, inArray } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import {
  taxOverrideSchema,
  accountTaxDefault,
  type ExpenseTaxSnapshot,
  type TaxOverride,
} from "$lib/expense-tax.js";
import { accounts, ledgerMovements } from "../db/schema.js";
import type { LedgerDb, MovementDraft } from "../ledger/types.js";

export class ExpenseTaxError extends Error {}
export type TaxMovementDraft = MovementDraft & {
  taxClassification: ExpenseTaxSnapshot | null;
};

/** Called only inside the record's immediate write transaction. */
export function classifiedMovements(
  db: LedgerDb,
  recordId: number,
  drafts: MovementDraft[],
  actor: number | null,
  overrides: TaxOverride[] = [],
  options: { reversalOf?: number | null; historical?: boolean } = {},
): TaxMovementDraft[] {
  const parsed = taxOverrideSchema.array().safeParse(overrides);
  if (!parsed.success)
    throw new ExpenseTaxError(parsed.error.issues[0].message);
  const pending = new Map<string, TaxOverride>();
  for (const override of parsed.data) {
    const key = `${override.accountId}:${override.occurrence}`;
    if (pending.has(key))
      throw new ExpenseTaxError("Classify each expense line only once.");
    pending.set(key, override);
  }
  const chart = new Map(
    db
      .select()
      .from(accounts)
      .where(inArray(accounts.id, [...new Set(drafts.map((m) => m.accountId))]))
      .all()
      .map((a) => [a.id, a]),
  );
  const previous = db
    .select()
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, options.reversalOf ?? recordId))
    .all()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const previousByOrder = new Map(previous.map((m) => [m.sortOrder, m]));
  const occurrences = new Map<number, number>();
  const now = new Date().toISOString();
  const result = drafts.map((m, index): TaxMovementDraft => {
    const occurrence = occurrences.get(m.accountId) ?? 0;
    occurrences.set(m.accountId, occurrence + 1);
    const key = `${m.accountId}:${occurrence}`;
    const override = pending.get(key);
    pending.delete(key);
    const account = chart.get(m.accountId);
    if (account?.type !== AccountType.Expense) {
      if (override)
        throw new ExpenseTaxError(
          "Tax deductions apply only to Expense lines.",
        );
      return { ...m, taxClassification: null };
    }
    if (options.reversalOf != null) {
      if (override)
        throw new ExpenseTaxError(
          "A void reversal must retain the original tax classification.",
        );
      return {
        ...m,
        taxClassification: previous[index]?.taxClassification ?? null,
      };
    }
    const currentDefault = accountTaxDefault(account);
    const old = previousByOrder.get(m.sortOrder);
    if (override?.source === "account_default") {
      if (
        override.percentageBps !== currentDefault.percentageBps ||
        override.treatment !== currentDefault.treatment
      )
        throw new ExpenseTaxError(
          "The account tax default changed. Refresh this record, then choose Use current account default again.",
        );
      return {
        ...m,
        taxClassification: {
          ...currentDefault,
          source:
            currentDefault.percentageBps === null
              ? "unreviewed"
              : "account_default",
          reason: override.reason,
          classifiedBy: actor,
          classifiedAt: now,
          provenance: old ? "account_default_reset" : "record_creation",
        },
      };
    }
    const provenance = old
      ? old.accountId === m.accountId
        ? "line_override"
        : "account_change"
      : "record_creation";
    if (override)
      return {
        ...m,
        taxClassification: {
          percentageBps: override.percentageBps,
          treatment: override.treatment,
          reason: override.reason,
          source: "override",
          classifiedBy: actor,
          classifiedAt: now,
          provenance,
        },
      };
    // Retain NULL too: saving a historical line is not a classification review.
    if (old?.accountId === m.accountId)
      return { ...m, taxClassification: old.taxClassification };
    if (options.historical) return { ...m, taxClassification: null };
    const { percentageBps, treatment } = currentDefault;
    return {
      ...m,
      taxClassification: {
        percentageBps,
        source: percentageBps == null ? "unreviewed" : "account_default",
        treatment,
        reason: null,
        classifiedBy: actor,
        classifiedAt: now,
        provenance,
      },
    };
  });
  if (pending.size)
    throw new ExpenseTaxError(
      "One of the tax overrides does not identify an expense line on this record.",
    );
  return result;
}
