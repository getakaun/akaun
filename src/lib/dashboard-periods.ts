/**
 * The dashboard's periods, and the period each is compared against.
 *
 * Pure, and driven by a `today` string rather than a clock: the server decides
 * what today is (`localToday()`), resolves everything here, and hands the
 * result to the page. The page never reads its own clock, so a browser in
 * another timezone, or one left open across midnight, cannot label a range the
 * figures were not computed for (007 FR-003).
 *
 * Every date is a plain `YYYY-MM-DD` calendar day, the way `ledger_records.date`
 * stores it, and every range includes both ends.
 */
import { addDaysISO, daysBetweenISO } from "./local-date.js";

export type DashboardPeriodId = "month" | "quarter" | "ytd" | "l12m";
export type CompareMode = "prev" | "yoy";
export type DateRange = { from: string; to: string };

export type MonthBucket = DateRange & {
  /** `YYYY-MM`. */
  key: string;
  /** Short month name, e.g. "Oct". */
  label: string;
};

export type ResolvedPeriod = {
  id: DashboardPeriodId;
  compare: CompareMode;
  today: string;
  current: DateRange;
  comparison: DateRange;
  /** e.g. "October 2026", "Q4 2026". */
  label: string;
  /** e.g. "1–16 Sep 2026". */
  comparisonLabel: string;
  /** Whether "previous period" means anything different from "last year". */
  canComparePrevious: boolean;
  /** The twelve calendar months ending with today's, oldest first. */
  months: MonthBucket[];
};

export const PERIOD_OPTIONS: { id: DashboardPeriodId; label: string }[] = [
  { id: "month", label: "This month" },
  { id: "quarter", label: "This quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "l12m", label: "Last 12 months" },
];

export const COMPARE_OPTIONS: { id: CompareMode; label: string }[] = [
  { id: "prev", label: "Previous period" },
  { id: "yoy", label: "Same period last year" },
];

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Reads `?period=`. The pre-007 values still land somewhere sensible. */
export function parsePeriodId(value: string | null): DashboardPeriodId {
  if (value === "month" || value === "quarter" || value === "ytd" || value === "l12m")
    return value;
  if (value === "year") return "ytd";
  return "month";
}

export function parseCompareMode(value: string | null): CompareMode {
  return value === "yoy" ? "yoy" : "prev";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The first day of the month `offset` months from `(y, m)`. */
function monthStart(y: number, m: number, offset = 0): string {
  const index = y * 12 + (m - 1) + offset;
  return iso(Math.floor(index / 12), (index % 12) + 1, 1);
}

function monthEnd(start: string): string {
  const [y, m] = parts(start);
  return iso(y, m, daysInMonth(y, m));
}

/** One year earlier, with 29 February landing on the 28th. */
function yearEarlier(day: string): string {
  const [y, m, d] = parts(day);
  return iso(y - 1, m, Math.min(d, daysInMonth(y - 1, m)));
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

/** The range a period covers. Every period ends today. */
export function currentRange(id: DashboardPeriodId, today: string): DateRange {
  const [y, m] = parts(today);
  switch (id) {
    case "month":
      return { from: monthStart(y, m), to: today };
    case "quarter":
      return { from: monthStart(y, m - ((m - 1) % 3)), to: today };
    case "ytd":
      return { from: iso(y, 1, 1), to: today };
    case "l12m":
      return { from: monthStart(y, m, -11), to: today };
  }
}

/**
 * The range a period is compared against.
 *
 * `prev` is the same number of days into the previous month or quarter, so the
 * 16th of October compares with 1–16 September rather than with all of a
 * month that had two more weeks in it. It is clamped to that period's end, so
 * 31 March compares with all of February. For Year to date and Last 12 months
 * the previous period *is* the same dates last year, so both modes answer the
 * same.
 */
export function comparisonRange(
  id: DashboardPeriodId,
  mode: CompareMode,
  today: string,
): DateRange {
  const current = currentRange(id, today);
  if (mode === "yoy" || id === "ytd" || id === "l12m") {
    return { from: yearEarlier(current.from), to: yearEarlier(current.to) };
  }
  const [y, m] = parts(current.from);
  const span = id === "month" ? 1 : 3;
  const from = monthStart(y, m, -span);
  const end = addDaysISO(current.from, -1);
  const elapsed = daysBetweenISO(current.from, current.to);
  return { from, to: earlier(addDaysISO(from, elapsed), end) };
}

/** The twelve calendar months ending with today's; the last ends today. */
export function lastTwelveMonths(today: string): MonthBucket[] {
  const [y, m] = parts(today);
  const months: MonthBucket[] = [];
  for (let offset = -11; offset <= 0; offset++) {
    const from = monthStart(y, m, offset);
    const [, mm] = parts(from);
    months.push({
      key: from.slice(0, 7),
      label: MONTH_NAMES[mm - 1],
      from,
      to: offset === 0 ? today : monthEnd(from),
    });
  }
  return months;
}

/** "1–16 Sep 2026", "16 Oct 2025 – 16 Oct 2026", "1 Jul – 30 Sep 2026". */
export function formatRange({ from, to }: DateRange): string {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (fy === ty && fm === tm) return `${fd}–${td} ${MONTH_NAMES[tm - 1]} ${ty}`;
  if (fy === ty) return `${fd} ${MONTH_NAMES[fm - 1]} – ${td} ${MONTH_NAMES[tm - 1]} ${ty}`;
  return `${fd} ${MONTH_NAMES[fm - 1]} ${fy} – ${td} ${MONTH_NAMES[tm - 1]} ${ty}`;
}

function periodLabel(id: DashboardPeriodId, today: string): string {
  const [y, m] = parts(today);
  switch (id) {
    case "month":
      return `${MONTH_LONG[m - 1]} ${y}`;
    case "quarter":
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case "ytd":
      return `${y} to date`;
    case "l12m":
      return formatRange(currentRange(id, today));
  }
}

export function resolveDashboardPeriod(
  id: DashboardPeriodId,
  requested: CompareMode,
  today: string,
): ResolvedPeriod {
  const canComparePrevious = id === "month" || id === "quarter";
  const compare = canComparePrevious ? requested : "yoy";
  const comparison = comparisonRange(id, compare, today);
  return {
    id,
    compare,
    today,
    current: currentRange(id, today),
    comparison,
    label: periodLabel(id, today),
    comparisonLabel: formatRange(comparison),
    canComparePrevious,
    months: lastTwelveMonths(today),
  };
}
