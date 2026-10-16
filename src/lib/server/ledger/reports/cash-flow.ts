import {
  AccountSubType,
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { expenseBucket, liabilityBucket } from "../account-type.js";
import type {
  CashFlowLine,
  CashFlowReport,
  CashFlowSection,
  Minor,
} from "../types.js";
import { historyGapNotes } from "./notes.js";

/**
 * Where the period's cash came from and what it went on (FR-006, FR-010).
 *
 * Pure: the rows arrive already narrowed by `queries/reports.ts`, so this
 * module never sees a date on a movement and never touches a database — the
 * same split every other report module keeps.
 *
 * **`rows` is every side that is not itself cash-and-cash-equivalent, from
 * every record that touches a "fund" account** — cash-and-equivalent
 * (FR-006) or a needs-review Asset account (subType `null`), because until an
 * account is classified there is no way to know which side of that line it
 * belongs on. `queries/reports.ts` selects this the same way
 * `fundsFlowStatement` selects its rows, substituting the fund predicate for
 * the current-asset one.
 *
 * A needs-review Asset account's own movement is one of these rows too — it
 * is not cash-and-equivalent, so it is not excluded — but it is deliberately
 * routed to `needsReviewMinor` instead of a section (FR-005), never folded
 * into Operating by default. `input.needsReviewMinor` carries that
 * contribution, read independently by `queries/reports.ts` — safe to do
 * because `IS_FUND_ACCOUNT` already admits every needs-review Asset by
 * definition, so its whole-ledger total and its `rows`-scoped total are the
 * same number.
 *
 * A needs-review **Liability**'s movement does not have that guarantee — most
 * Liability activity never touches a fund account at all (an accrual against
 * an expense, say), so sweeping every needs-review Liability total in
 * unconditionally would count movements that were never going to appear on
 * this statement anyway. `cashFlow` below instead adds up the Liability rows
 * `lineFor` returns `null` for — which, being in `rows`, are already scoped to
 * records that touched a fund account — and folds that into `needsReviewMinor`
 * itself, rather than asking `queries/reports.ts` for a second independent
 * total the way it does for Asset.
 *
 * Why `ties` is a real check and not a restatement of the arithmetic above it:
 * every record's movements sum to zero, so for the whole ledger,
 * `Σ(cash-and-equivalent sides) + Σ(needs-review sides) + Σ(everything else)`
 * is zero for any period. Rearranged: `closing − opening = netChangeMinor −
 * needsReviewMinor`. `openingCashMinor`/`closingCashMinor` are read
 * independently (never derived from the rows), so a database that does not
 * balance shows itself here exactly the way `balances` does on the Balance
 * Sheet and `ties` does on the retired Funds Flow panel.
 */

export type CashFlowRow = {
  accountId: number;
  type: AccountTypeCode;
  /**
   * Absent for Equity/Revenue. For Asset/Liability, `null` means "needs
   * review". For Expense, `null` defaults safely to Operating.
   */
  subType: AccountSubTypeCode | null;
  amountMinor: Minor;
};

export type CashFlowInput = {
  dateFrom: string;
  dateTo: string;
  /** Cash and cash equivalents, independently read, as at the day before `dateFrom`. */
  openingCashMinor: Minor;
  /** Cash and cash equivalents, independently read, as at `dateTo`. */
  closingCashMinor: Minor;
  /**
   * The needs-review Asset accounts' own movement over the period — read
   * independently, not derived from `rows`. `cashFlow` adds the needs-review
   * Liability contribution on top of this, from `rows`, before returning it.
   */
  needsReviewMinor: Minor;
  /** Every non-cash-and-equivalent side of the records that touched a fund account. */
  rows: CashFlowRow[];
  /** The day the ledger began, so a period reaching further back says so (FR-030). */
  trackingStartedOn?: string | null;
};

type Activity = "Operating" | "Investing" | "Financing";

type LineSpec = { activity: Activity; key: string; label: string };

/**
 * Which line a non-cash side belongs on (research.md §5), or `null` for a
 * needs-review Asset or Liability side — `rows` can carry one of these (the
 * other side of a fund-touching record may itself be an unclassified Asset or
 * Liability), and `cashFlow` below routes it to `needsReviewMinor` instead of
 * a section (FR-005).
 */
function lineFor(row: CashFlowRow): LineSpec | null {
  if (row.type === AccountType.Asset) {
    switch (row.subType) {
      case null:
        return null;
      case AccountSubType.FixedAsset:
      case AccountSubType.IntangibleAsset:
      case AccountSubType.OtherNonCurrentAsset:
        return {
          activity: "Investing",
          key: "capital-expenditure",
          label: "Capital expenditure",
        };
      case AccountSubType.Receivable:
        return {
          activity: "Operating",
          key: "receivables",
          label: "Change in receivables",
        };
      case AccountSubType.Inventory:
        return {
          activity: "Operating",
          key: "inventory",
          label: "Change in inventory",
        };
      default:
        // Only AccountSubType.OtherCurrentAsset can reach here (see the
        // parameter doc — `queries/reports.ts` never hands over a
        // cash-and-equivalent side, and Equipment/Receivable/Inventory/null
        // are all handled above).
        return {
          activity: "Operating",
          key: "other-current-assets",
          label: "Change in other current assets",
        };
    }
  }
  if (row.type === AccountType.Liability) {
    switch (liabilityBucket(row.subType)) {
      case "needsReview":
        // `cashFlow` below adds this row's own amount into `needsReviewMinor`
        // instead of a section (FR-005) — see this file's top doc comment for
        // why that has to happen here, scoped to `rows`, rather than via an
        // independent whole-ledger total the way Asset's needs-review works.
        return null;
      case "nonCurrent":
        return {
          activity: "Financing",
          key: "long-term-debt",
          label: "Long-term debt",
        };
      case "current":
        return {
          activity: "Operating",
          key: "payables",
          label: "Change in payables and other current liabilities",
        };
    }
  }
  switch (row.type) {
    case AccountType.Equity:
      return {
        activity: "Financing",
        key: "owners-equity",
        label: "Owner contributions and drawings",
      };
    case AccountType.Revenue:
      return { activity: "Operating", key: "revenue", label: "Revenue" };
    default:
      // Only AccountType.Expense can reach here.
      switch (expenseBucket(row.subType)) {
        case "cogs":
          return {
            activity: "Operating",
            key: "cost-of-goods-sold",
            label: "Cost of goods sold",
          };
        case "other":
          return {
            activity: "Operating",
            key: "other-operating-expenses",
            label: "Other operating expenses",
          };
        case "operating":
          return {
            activity: "Operating",
            key: "operating-expenses",
            label: "Operating expenses",
          };
      }
  }
}

const LINE_ORDER = [
  "revenue",
  "receivables",
  "inventory",
  "other-current-assets",
  "payables",
  "cost-of-goods-sold",
  "operating-expenses",
  "other-operating-expenses",
  "capital-expenditure",
  "long-term-debt",
  "owners-equity",
];

function section(
  totals: Map<string, CashFlowLine & { activity: Activity; key: string }>,
  activity: Activity,
): CashFlowSection {
  const lines = [...totals.values()]
    .filter((line) => line.activity === activity)
    // A line that nets to nothing over the period says nothing about the cash.
    .filter((line) => line.amountMinor !== 0)
    .sort((a, b) => LINE_ORDER.indexOf(a.key) - LINE_ORDER.indexOf(b.key))
    .map(({ accountId, label, amountMinor }) => ({
      accountId,
      label,
      amountMinor,
    }));
  return {
    label: activity,
    lines,
    totalMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
  };
}

export function cashFlow(input: CashFlowInput): CashFlowReport {
  const totals = new Map<
    string,
    CashFlowLine & { activity: Activity; key: string }
  >();

  // A needs-review Liability row's contribution, scoped to `rows` — unlike
  // Asset, most Liability activity never touches a fund account at all, so
  // this must come from the rows already selected for that reason, not from
  // an independent whole-ledger total (`queries/reports.ts` covers Asset;
  // this is the Liability half of the same FR-005 rule).
  let liabilityNeedsReviewMinor: Minor = 0;

  for (const row of input.rows) {
    const spec = lineFor(row);
    // A needs-review side: its movement is already counted separately, so it
    // must not also land in a section.
    if (spec === null) {
      if (row.type === AccountType.Liability) {
        liabilityNeedsReviewMinor += row.amountMinor;
      }
      continue;
    }
    // Negated, the same sign convention `funds-flow.ts` uses: a side that took
    // value out of a non-cash account put cash in, and the other way round.
    const contribution = -row.amountMinor;
    const existing = totals.get(spec.key);
    if (existing) existing.amountMinor += contribution;
    else
      totals.set(spec.key, {
        accountId: null,
        key: spec.key,
        label: spec.label,
        amountMinor: contribution,
        activity: spec.activity,
      });
  }

  const needsReviewMinor = input.needsReviewMinor + liabilityNeedsReviewMinor;

  const operating = section(totals, "Operating");
  const investing = section(totals, "Investing");
  const financing = section(totals, "Financing");
  const netChangeMinor =
    operating.totalMinor + investing.totalMinor + financing.totalMinor;

  const differenceMinor =
    input.closingCashMinor -
    input.openingCashMinor -
    (netChangeMinor - needsReviewMinor);
  const ties = differenceMinor === 0;

  const notes = historyGapNotes(input.dateFrom, input.trackingStartedOn);
  if (needsReviewMinor !== 0) {
    notes.unshift(
      "Some asset or liability accounts have no sub-type. Their transactions show as " +
        "Unclassified, not as operating, investing or financing activities. Set a " +
        "sub-type for each of these accounts on its account page.",
    );
  }
  if (!ties) {
    notes.unshift(
      "The cash flow statement does not reconcile: the net cash flow does not " +
        "equal the change in cash and cash equivalents. Run the ledger integrity " +
        "check before you use this report.",
    );
  }

  return {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    operating,
    investing,
    financing,
    needsReviewMinor,
    openingCashMinor: input.openingCashMinor,
    closingCashMinor: input.closingCashMinor,
    netChangeMinor,
    ties,
    differenceMinor,
    notes,
  };
}
