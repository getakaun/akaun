import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { getSetting, SETTING_KEYS } from "../settings.js";

/** What a term setting falls back to when it was never saved, or holds junk. */
export const DEFAULT_TERM_DAYS = 30;

export type DocumentDefaults = {
  /** Days from an invoice's issue date to its due date. Null: no due date. */
  invoiceDueDays: number | null;
  /** Days from a quotation's issue date to its expiry date. Null: no expiry. */
  quotationValidDays: number | null;
};

/**
 * One stored term setting, read.
 *
 * - never saved → 30, the standard term most small businesses start from;
 * - saved empty → null, which the user chose: new documents get no date;
 * - a whole number of days, 0 or more → that number (0 is "on receipt");
 * - anything else → 30, rather than a nonsense date on every new document.
 */
export function parseTermDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_TERM_DAYS;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_TERM_DAYS;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) ? days : DEFAULT_TERM_DAYS;
}

/**
 * The terms a new quotation or invoice starts with, and the due date a
 * converted quotation's invoice gets. The one reader of both settings, so the
 * create forms and the conversion cannot disagree about what "unset" means.
 */
export function documentDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
): DocumentDefaults {
  return {
    invoiceDueDays: parseTermDays(getSetting(db, SETTING_KEYS.invoiceDueDays)),
    quotationValidDays: parseTermDays(
      getSetting(db, SETTING_KEYS.quotationValidDays),
    ),
  };
}

/** The longest term the settings accept: a year. */
export const MAX_TERM_DAYS = 365;

/**
 * A term as typed on the Settings page, made ready to store — or null when it
 * is not a term. Blank is kept as "" (none); otherwise a whole number of days
 * from 0 to a year, written without leading zeros so the page reads back what
 * it saved.
 */
export function termDaysInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days <= MAX_TERM_DAYS ? String(days) : null;
}
