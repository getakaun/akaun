/**
 * The sentences a report carries under it, in plain words.
 *
 * A report that is silent about what it does not know reads as complete. The
 * one gap this app actually has is the day the ledger began: invoices sent
 * before it were never recorded as money owed by a customer, so any report
 * reaching back past that day is missing them. FR-030 asks for that to be said
 * rather than implied, and all three reports say it the same way — which is why
 * the sentence is written once, here.
 */

/**
 * The gap sentence, or nothing when there is no gap to report.
 *
 * `coversFrom` is the first day the report covers, or `null` for a report that
 * always reaches back to the beginning — a balance sheet is everything up to a
 * date, so it always crosses the gap when there is one.
 */
export function historyGapNotes(
  coversFrom: string | null,
  trackingStartedOn: string | null | undefined,
): string[] {
  if (!trackingStartedOn) return [];
  if (coversFrom !== null && coversFrom >= trackingStartedOn) return [];
  return [
    `This report includes dates before ${trackingStartedOn}, the ledger start date. ` +
      `Invoices issued before that date are not in accounts receivable, so the figures for ` +
      `the earlier period are incomplete.`,
  ];
}
