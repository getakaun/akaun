import { closedThrough } from "../closing/policy.js";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, sql } from "drizzle-orm";
import {
  AccountType,
  type AccountTypeCode,
  type AccountSubTypeCode,
  DefaultAccountPurpose,
  LedgerRecordKind,
} from "$lib/enums.js";
import { isContraRevenueAccount } from "$lib/account-classification.js";
import {
  everydayKindFor,
  type SidesAccount,
  type SidesContext,
} from "../ledger/sides-from-accounts.js";
import { lockStateFor } from "../queries/ledger.js";
import { nextNumber } from "../running-number.js";
import * as schema from "./schema.js";

const REASON = "contra-revenue reclassification";

/**
 * Startup data backfill, after Drizzle and the account sub-type backfill.
 * Like applySubTypeBackfill, the predicate is its idempotency guard. Numbers
 * normally survive upgrades; this narrowly scoped repair deliberately replaces
 * an incorrect IN number, retaining it in both the remark and system audit.
 * Never imports db/client: callers must supply the connection to upgrade.
 */
export function applyContraRevenueReclassification(
  raw: Database,
  log: { warn: (details: object, message: string) => void },
): number {
  const db = drizzle(raw, { schema });
  const skipped: {
    recordId: number;
    recordNumber: string | null;
    settled: boolean;
    reconciled: boolean;
    closed: boolean;
  }[] = [];
  const changed = db.transaction(
    (tx) => {
      const defaults = new Map(
        tx
          .select()
          .from(schema.accountDefaults)
          .all()
          .map((row) => [row.purpose, row.accountId]),
      );
      const ctx: SidesContext = {
        accountById: () => null,
        canAdjust: false,
        receivableAccountId:
          defaults.get(DefaultAccountPurpose.Receivable) ?? -1,
        payableAccountId: defaults.get(DefaultAccountPurpose.Payable) ?? -1,
        reimbursementPayableAccountId: defaults.get(
          DefaultAccountPurpose.ReimbursementsPayable,
        ),
        openingBalancesAccountId:
          defaults.get(DefaultAccountPurpose.OpeningBalances) ?? -1,
      };
      let count = 0;
      const boundary = closedThrough(tx);
      const records = tx
        .select()
        .from(schema.ledgerRecords)
        .where(eq(schema.ledgerRecords.kind, LedgerRecordKind.Income))
        .orderBy(schema.ledgerRecords.date, schema.ledgerRecords.id)
        .all();
      for (const record of records) {
        const lines = tx
          .select({
            account: schema.accounts,
            amountMinor: schema.ledgerMovements.amountMinor,
          })
          .from(schema.ledgerMovements)
          .innerJoin(
            schema.accounts,
            eq(schema.accounts.id, schema.ledgerMovements.accountId),
          )
          .where(eq(schema.ledgerMovements.recordId, record.id))
          .all();
        if (lines.some(({ account }) => account.type === null)) continue;
        const accounts: SidesAccount[] = lines.map(({ account }) => ({
          id: account.id,
          type: account.type as AccountTypeCode,
          role: account.role,
          subType: account.subType as AccountSubTypeCode | null,
          archived: account.archivedAt !== null,
        }));
        // Only old-rule revenue categories qualify: never repair unrelated income
        // misclassifications (e.g. expenses or asset purchases filed as income).
        const categories = accounts.filter(
          (account) => account.type === AccountType.Revenue,
        );
        if (!categories.length || !categories.every(isContraRevenueAccount))
          continue;
        if (everydayKindFor(accounts, ctx) !== LedgerRecordKind.Expense)
          continue;
        // Re-run the old rule too: only a change caused by contra awareness is
        // eligible. Mixed expense/contra splits were not income under that rule.
        const oldAccounts = accounts.map((account) =>
          isContraRevenueAccount(account)
            ? { ...account, subType: null }
            : account,
        );
        if (everydayKindFor(oldAccounts, ctx) !== LedgerRecordKind.Income)
          continue;
        const lock = lockStateFor(tx, record.id);
        const closed = boundary !== null && record.date <= boundary;
        if (lock.settled || lock.reconciled || closed) {
          skipped.push({
            recordId: record.id,
            recordNumber: record.recordNumber,
            ...lock,
            closed,
          });
          continue;
        }
        const recordNumber = nextNumber(tx, "expense", record.date);
        const remark = [
          record.remark,
          `${REASON}: previous number ${record.recordNumber ?? "(none)"}`,
        ]
          .filter(Boolean)
          .join("\n");
        tx.update(schema.ledgerRecords)
          .set({
            kind: LedgerRecordKind.Expense,
            recordNumber,
            remark,
            updatedAt: sql`datetime('now')`,
          })
          .where(eq(schema.ledgerRecords.id, record.id))
          .run();
        tx.insert(schema.auditLog)
          .values({
            recordType: "record",
            recordId: String(record.id),
            recordLabel: `${recordNumber} ${record.description}`.trim(),
            via: "system",
            operation: REASON,
            action: "update",
            changes: JSON.stringify([
              { field: "kind", before: "income", after: "expense" },
              {
                field: "recordNumber",
                before: record.recordNumber,
                after: recordNumber,
              },
              { field: "remark", before: record.remark, after: remark },
              { field: "reason", before: null, after: REASON },
            ]),
          })
          .run();
        // Preserve existing attachment/OCR search text while making both numbers
        // searchable. No movements or monetary fields are written by this repair.
        tx.insert(schema.recordSearchText)
          .values({
            recordId: record.id,
            text: `${recordNumber} ${remark} ${record.description}`,
          })
          .onConflictDoUpdate({
            target: schema.recordSearchText.recordId,
            set: {
              text: sql`${schema.recordSearchText.text} || ' ' || ${recordNumber} || ' ' || ${remark}`,
            },
          })
          .run();
        count++;
      }
      return count;
    },
    { behavior: "immediate" },
  );
  for (const details of skipped)
    log.warn(details, `Skipped locked record: ${REASON}`);
  return changed;
}
