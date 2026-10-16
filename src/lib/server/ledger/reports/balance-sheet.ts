import { AccountType } from "$lib/enums.js";
import type { AccountSubTypeCode } from "$lib/enums.js";
import { assetBucket, liabilityBucket } from "../account-type.js";
import type {
  AccountTotal,
  BalanceSheetReport,
  BalanceSheetSection,
  BalanceSheetSubsection,
  Minor,
  ReportLine,
} from "../types.js";
import { historyGapNotes } from "./notes.js";

/**
 * What the business owns, what it owes, and what the owners have in it, as at a
 * date (FR-026).
 *
 * Pure: the totals arrive already narrowed to everything up to `asAt` by
 * `queries/reports.ts`.
 *
 * Why it balances, rather than "we hope it balances": every movement is
 * positive into an account and negative out of it, and every record's movements
 * add up to zero, so the sum across *all* accounts is zero. Rearranged, that is
 * exactly "what it owns = what it owes + what the owners have in it", with the
 * categories' running total standing in as the accumulated result. So the
 * `balances` flag is not a second calculation checking the first — it is the
 * one place a broken database shows itself (SC-007, FR-003).
 */

export type BalanceSheetInput = {
  asAt: string;
  /** Every account's total up to and including `asAt`, from `accountTotalsUpTo`. */
  totals: AccountTotal[];
  /** The day the ledger began, so a sheet reaching back past it says so (FR-030). */
  trackingStartedOn?: string | null;
};

/**
 * The one line that is not an account: revenue less expenses, from the first
 * record up to this date. Id 0 marks it as having nothing to open — no account
 * holds it, it is the revenue and expense accounts' running total brought
 * across.
 *
 * "Current earnings", not "Retained earnings": the seeded chart has a real
 * Retained Earnings account (code 3100) for results that have been closed off,
 * and two lines with one name on the same statement would be read as a
 * duplicate.
 */
const ACCUMULATED_RESULT_ACCOUNT_ID = 0;
const ACCUMULATED_RESULT_LABEL = "Current earnings";

function sectionFrom(
  lines: ReportLine[],
  subsections?: BalanceSheetSubsection[],
): BalanceSheetSection {
  return {
    lines,
    totalMinor: lines.reduce((running, line) => running + line.amountMinor, 0),
    ...(subsections ? { subsections } : {}),
  };
}

const SUBSECTION_ORDER: {
  key: "current" | "nonCurrent" | "needsReview";
  label: BalanceSheetSubsection["label"];
}[] = [
  { key: "current", label: "Current" },
  { key: "nonCurrent", label: "Non-current" },
  { key: "needsReview", label: "Unclassified" },
];

/**
 * Buckets a flat `lines` list (one account type) into Current / Non-current /
 * Unclassified, by each account's own `subType`.
 */
function subsectionsFor(
  lines: ReportLine[],
  subTypeById: Map<number, AccountSubTypeCode | null>,
  bucketFor: (
    subType: AccountSubTypeCode | null,
  ) => "current" | "nonCurrent" | "needsReview",
): BalanceSheetSubsection[] {
  const groups = new Map<string, ReportLine[]>();
  for (const line of lines) {
    const bucket = bucketFor(subTypeById.get(line.accountId) ?? null);
    const group = groups.get(bucket) ?? [];
    group.push(line);
    groups.set(bucket, group);
  }

  return SUBSECTION_ORDER.filter(({ key }) => groups.has(key)).map(
    ({ key, label }) => {
      const groupLines = groups.get(key)!;
      return {
        label,
        lines: groupLines,
        totalMinor: groupLines.reduce((sum, line) => sum + line.amountMinor, 0),
      };
    },
  );
}

function reportLines(totals: AccountTotal[], type: number): ReportLine[] {
  const sign = type === AccountType.Asset ? 1 : -1;
  return totals
    .filter((total) => total.type === type && total.amountMinor !== 0)
    .map((total) => ({
      accountId: total.accountId,
      accountName: total.accountName,
      amountMinor: total.amountMinor * sign,
    }));
}

export function balanceSheet(input: BalanceSheetInput): BalanceSheetReport {
  const owned: ReportLine[] = [];
  const owed: ReportLine[] = [];
  const ownersStake: ReportLine[] = [];
  let categoriesMinor: Minor = 0;

  for (const total of input.totals) {
    const type = total.type;

    // The categories never get a line of their own here. Their running total is
    // the accumulated result, which the owners' stake carries as one figure.
    if (type === AccountType.Revenue || type === AccountType.Expense) {
      categoriesMinor += total.amountMinor;
      continue;
    }

    // An account holding nothing at this date is not worth a line.
    if (total.amountMinor === 0) continue;
  }

  owned.push(...reportLines(input.totals, AccountType.Asset));
  owed.push(...reportLines(input.totals, AccountType.Liability));
  ownersStake.push(...reportLines(input.totals, AccountType.Equity));

  const accumulatedResultMinor = -categoriesMinor;
  ownersStake.push({
    accountId: ACCUMULATED_RESULT_ACCOUNT_ID,
    accountName: ACCUMULATED_RESULT_LABEL,
    amountMinor: accumulatedResultMinor,
  });

  const subTypeById = new Map(
    input.totals.map((total) => [total.accountId, total.subType]),
  );

  const ownedSection = sectionFrom(
    owned,
    subsectionsFor(owned, subTypeById, assetBucket),
  );
  const owedSection = sectionFrom(
    owed,
    subsectionsFor(owed, subTypeById, liabilityBucket),
  );
  const ownersStakeSection = sectionFrom(ownersStake);

  const differenceMinor =
    ownedSection.totalMinor -
    (owedSection.totalMinor + ownersStakeSection.totalMinor);
  const balances = differenceMinor === 0;

  const notes = historyGapNotes(null, input.trackingStartedOn);
  if (!balances) {
    notes.unshift(
      "The balance sheet is out of balance: total assets do not equal total " +
        "liabilities plus equity. Run the ledger integrity check in Settings before " +
        "you use this report.",
    );
  }

  return {
    asAt: input.asAt,
    owned: ownedSection,
    owed: owedSection,
    ownersStake: ownersStakeSection,
    accumulatedResultMinor,
    balances,
    differenceMinor,
    notes,
  };
}
