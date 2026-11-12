import { eq, sql } from "drizzle-orm";
import { RevenueSubType, AccountType } from "$lib/enums.js";
import type { TaxSourceSnapshot } from "$lib/tax-worksheet.js";
import type { UtilisationContext } from "$lib/capital-utilisation.js";
import {
  accounts,
  taxWorksheetAdjustments,
  taxWorksheetRevisions,
  taxWorksheets,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { evidenceHash, taxEvidenceRead } from "../tax-evidence.js";
import { captureTaxSources } from "./tax-sources.js";

export function taxUtilisationContext(
  db: LedgerDb,
  worksheet: typeof taxWorksheets.$inferSelect,
  revisionId: number,
  captured?: TaxSourceSnapshot,
): UtilisationContext {
  const live =
    captured ?? captureTaxSources(db, worksheet.dateFrom, worksheet.dateTo);
  const hints = taxEvidenceRead(db, "utilisation-account-types", () =>
    db
      .select({
        id: accounts.id,
        type: accounts.type,
        subType: accounts.subType,
      })
      .from(accounts)
      .all(),
  );
  const relevant = new Set(live.profitLines.map((l) => l.accountId));
  const types = hints
    .filter((a) => relevant.has(a.id))
    .sort((a, b) => a.id - b.id);
  const revision = db
    .select({
      pending: sql<
        string | null
      >`json_extract(${taxWorksheetRevisions.snapshot}, '$.pendingCorrectionIds')`,
    })
    .from(taxWorksheetRevisions)
    .where(eq(taxWorksheetRevisions.id, revisionId))
    .get();
  const { pendingCorrectionIds, ...source } = live;
  return {
    hash: evidenceHash({ source: evidenceHash(source), accounts: types }),
    snapshot: {
      ...live,
      pendingCorrectionIds:
        pendingCorrectionIds ??
        (revision?.pending
          ? (JSON.parse(revision.pending) as number[])
          : undefined),
    },
    adjustments: db
      .select()
      .from(taxWorksheetAdjustments)
      .where(eq(taxWorksheetAdjustments.revisionId, revisionId))
      .all(),
    businessIncomeAccounts: types
      .filter(
        (a) =>
          a.type === AccountType.Revenue &&
          (a.subType === RevenueSubType.OperatingRevenue ||
            a.subType === RevenueSubType.ContraOperatingRevenue),
      )
      .map((a) => a.id),
  };
}
