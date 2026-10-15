/**
 * Calendar days for the sales documents, in the **local** timezone.
 *
 * An issue, due or expiry date is a plain day the user typed, so "today" has to
 * be the user's day too. A UTC `toISOString()` puts it a day behind for anyone
 * east of Greenwich for part of every morning, which made an invoice due today
 * read as overdue (or a quote valid today read as expired) before lunch.
 *
 * Used by both the server (overdue, expired) and the forms (the default issue
 * date), so it sits outside `$lib/server`. On the server, local means the
 * business timezone configured with TZ; in the browser it means the device
 * timezone. Set TZ to the business timezone when self-hosting. The rest of the
 * app still takes "today" in UTC.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's date, YYYY-MM-DD, in the local timezone. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `iso` moved by `days` calendar days (negative goes back).
 *
 * The arithmetic is done in UTC on the date alone, so a daylight-saving change
 * between the two days cannot shift the answer by one.
 */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `from` to `to` (negative when `to` is earlier).
 * The inverse of `addDaysISO`, and done the same way, in UTC on the dates
 * alone. Used to tell which payment term an existing document's two dates
 * already describe.
 */
export function daysBetweenISO(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}
