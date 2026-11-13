import type { AccountSubTypeCode, AccountTypeCode } from "$lib/enums.js";
import type { LedgerDb, Minor } from "../ledger/types.js";
import { accountTotalsUpTo } from "./reports.js";

/**
 * A trial balance: every account's balance on a date, split into a debit
 * column and a credit column.
 *
 * Nothing here is new arithmetic. `accountTotalsUpTo` already sums
 * `ledger_movements.amount_minor` per account from the first record up to the
 * date, and a movement is positive when value goes INTO an account and
 * negative when it leaves (CLAUDE.md § The Ledger). That is exactly the
 * debit/credit split: a positive balance is a debit, a negative balance is a
 * credit. The movements of one record sum to zero and a record's movements all
 * share its date, so the two columns always total the same figure — the
 * trial balance cannot disagree with itself unless the books are corrupt.
 *
 * A void is a reversal record that negates the original, so the pair nets to
 * zero here without this file knowing about voids.
 *
 * The local types below are deliberate: `ledger/types.ts` is a frozen
 * interface.
 */

export type TrialBalanceRow = {
  accountId: number;
  code: number;
  name: string;
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
  /** Value that sits in the account (a positive balance). Whole minor units. */
  debitMinor: Minor;
  /** Value owed out of the account (a negative balance), as a positive figure. */
  creditMinor: Minor;
};

export type TrialBalanceReport = {
  asAt: string;
  rows: TrialBalanceRow[];
  totals: { debitMinor: Minor; creditMinor: Minor };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The trial balance as at a date, both ends of the book included: every
 * record dated on or before `asAt`.
 *
 * An account whose balance is exactly zero is left out unless `includeZero`
 * is set — an account that was used and nets to zero (a voided record, a
 * settled receivable) is as quiet as one never used. Rows are ordered by
 * account code, then name.
 *
 * Throws `RangeError` on a date that is not `YYYY-MM-DD`: the report compares
 * dates as strings, so a malformed one would silently return the wrong book
 * instead of failing.
 */
export function trialBalance(
  db: LedgerDb,
  options: { asAt: string; includeZero?: boolean },
): TrialBalanceReport {
  const { asAt, includeZero = false } = options;
  if (!ISO_DATE.test(asAt))
    throw new RangeError(
      `asAt must be an ISO date (YYYY-MM-DD), got "${asAt}".`,
    );

  const rows: TrialBalanceRow[] = [];
  let debitMinor: Minor = 0;
  let creditMinor: Minor = 0;
  for (const total of accountTotalsUpTo(db, asAt)) {
    if (total.amountMinor === 0 && !includeZero) continue;
    const debit = total.amountMinor > 0 ? total.amountMinor : 0;
    const credit = total.amountMinor < 0 ? -total.amountMinor : 0;
    debitMinor += debit;
    creditMinor += credit;
    rows.push({
      accountId: total.accountId,
      code: total.code,
      name: total.accountName,
      type: total.type,
      subType: total.subType,
      debitMinor: debit,
      creditMinor: credit,
    });
  }
  rows.sort(
    (a, b) =>
      a.code - b.code ||
      a.name.localeCompare(b.name) ||
      a.accountId - b.accountId,
  );
  return { asAt, rows, totals: { debitMinor, creditMinor } };
}
