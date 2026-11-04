import { LedgerRecordKind, type LedgerRecordKindCode } from "$lib/enums.js";
import type {
  IntegrityReport,
  Minor,
  RecordBalanceInput,
  UnbalancedRecord,
} from "./types.js";

/**
 * One void, reduced to what invariant 7 needs: a reversal (a record with
 * `reverses_record_id`, or of kind Reversal) and what it points at.
 *
 * Declared here rather than in `types.ts`, which is a frozen interface: only
 * this check and `integrityInputs` exchange it.
 */
export type VoidPairInput = {
  reversalId: number;
  reversalKind: LedgerRecordKindCode;
  /** `reverses_record_id`; null on a Reversal-kind record that points nowhere. */
  originalId: number | null;
  originalExists: boolean;
  /** The target is itself a reversal — a void of a void. */
  originalIsReversal: boolean;
  sameDate: boolean;
  /** Σ |net per account| over the movements of both records — must be 0. */
  accountImbalanceMinor: Minor;
};

/**
 * The whole-books check: does every record's two sides still cancel out, and do
 * they cancel out across the entire table?
 *
 * `entry-builder.ts` is the only writer and enforces these rules on the way in,
 * so a failure here means something got past it — a hand-edited database, a
 * half-applied upgrade, a movement whose record was deleted without it. That is
 * exactly the kind of wrong that is silent, which is why there is a button for
 * it (FR-003, SC-002).
 *
 * Pure arithmetic over rows an aggregate query already reduced, so the sweep is
 * two indexed aggregates and a loop rather than a scan of every movement.
 */

function checkOne(record: RecordBalanceInput): UnbalancedRecord | null {
  // Invariant 1 — the two sides cancel out. Reported first: it is the rule the
  // whole design rests on, and its difference is the most useful number.
  if (record.movementSumMinor !== 0) {
    return {
      recordId: record.recordId,
      differenceMinor: record.movementSumMinor,
      problem: "Its debits and credits do not balance.",
    };
  }

  // Invariant 2 — a record with one side does not say where the money went.
  if (record.movementCount < 2) {
    return {
      recordId: record.recordId,
      differenceMinor: 0,
      problem:
        "It has only one line. A journal entry needs a debit and a credit.",
    };
  }

  // Invariant 3.
  if (record.hasZeroMovement) {
    return {
      recordId: record.recordId,
      differenceMinor: 0,
      problem: "One of its lines has a zero amount.",
    };
  }

  // Invariant 4 — money owed has to be owed to somebody.
  if (record.missingContact) {
    return {
      recordId: record.recordId,
      differenceMinor: 0,
      problem: "It uses a receivable or payable account but has no contact.",
    };
  }

  // Invariant 6 — the figure the user typed still agrees with the sides built
  // from it. A journal entry is exempt: its many sides have no single entered
  // figure to agree with. So is a reversal: it copies the figure of whatever it
  // voids (a journal included), and invariant 7 checks it against that record.
  if (
    record.kind !== LedgerRecordKind.Journal &&
    record.kind !== LedgerRecordKind.Reversal
  ) {
    const difference = record.positiveSumMinor - record.expectedMinor;
    if (difference !== 0) {
      return {
        recordId: record.recordId,
        differenceMinor: difference,
        problem: "The amount entered on it no longer matches its lines.",
      };
    }
  }

  return null;
}

/**
 * Invariant 7 — a void cancels exactly what it voids. Every void-aware screen
 * hides the pair on the promise that it nets to zero on each account on one
 * date; a pair that does not would hide real money.
 */
function checkVoid(pair: VoidPairInput): UnbalancedRecord | null {
  const at = (problem: string, differenceMinor = 0): UnbalancedRecord => ({
    recordId: pair.reversalId,
    differenceMinor,
    problem,
  });
  if (pair.reversalKind !== LedgerRecordKind.Reversal)
    return at("It voids another record but is not a reversal.");
  if (pair.originalId === null)
    return at("It is a reversal but does not say which record it voids.");
  if (!pair.originalExists) return at("The record it voids no longer exists.");
  if (pair.originalIsReversal)
    return at("It voids a reversal. Only an ordinary record can be voided.");
  if (!pair.sameDate)
    return at("It is not dated the same day as the record it voids.");
  if (pair.accountImbalanceMinor !== 0)
    return at(
      "It does not cancel the record it voids on every account.",
      pair.accountImbalanceMinor,
    );
  return null;
}

export function checkIntegrity(input: {
  records: RecordBalanceInput[];
  wholeBooksSumMinor: Minor;
  voidPairs?: VoidPairInput[];
}): IntegrityReport {
  const unbalancedRecords: UnbalancedRecord[] = [];
  for (const record of input.records) {
    const problem = checkOne(record);
    if (problem) unbalancedRecords.push(problem);
  }
  // A reversal already reported for its own balance is not reported twice.
  const reported = new Set(unbalancedRecords.map((r) => r.recordId));
  for (const pair of input.voidPairs ?? []) {
    if (reported.has(pair.reversalId)) continue;
    const problem = checkVoid(pair);
    if (problem) unbalancedRecords.push(problem);
  }

  // Magnitudes, so two records a pound out in opposite directions read as two
  // pounds of error rather than cancelling into a clean-looking zero.
  const totalDifferenceMinor = unbalancedRecords.reduce(
    (sum, r) => sum + Math.abs(r.differenceMinor),
    0,
  );

  // Invariant 5. Checked separately because every record can balance while the
  // table does not — a movement belonging to no record would pass the loop
  // above and still leave the books out.
  const booksBalance = input.wholeBooksSumMinor === 0;

  return {
    ok: unbalancedRecords.length === 0 && booksBalance,
    recordsChecked: input.records.length,
    unbalancedRecords,
    totalDifferenceMinor,
    booksBalance,
    wholeBooksDifferenceMinor: input.wholeBooksSumMinor,
  };
}
