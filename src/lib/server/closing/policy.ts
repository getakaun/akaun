import { lte } from "drizzle-orm";
import { ledgerRecords } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { getSetting, SETTING_KEYS } from "../settings.js";

/** One inclusive date protects the whole installed book. Empty means reopened. */
export function closedThrough(db: LedgerDb): string | null {
  return getSetting(db, SETTING_KEYS.accountingClosedThrough) || null;
}

export class ClosedPeriodError extends Error {
  constructor(public readonly boundary: string) {
    super(
      `Accounting is closed through ${boundary}. Reopen the affected months before changing accounting entries.`,
    );
    this.name = "ClosedPeriodError";
  }
}

/** Call inside the same write transaction as the guarded mutation. */
export function assertDatesOpen(db: LedgerDb, dates: readonly string[]): void {
  const boundary = closedThrough(db);
  if (boundary && dates.some((date) => date <= boundary)) {
    throw new ClosedPeriodError(boundary);
  }
}

/** Partner membership changes can redistribute every past period's result. */
export function assertNoClosedHistory(db: LedgerDb): void {
  const boundary = closedThrough(db);
  if (
    boundary &&
    db
      .select({ id: ledgerRecords.id })
      .from(ledgerRecords)
      .where(lte(ledgerRecords.date, boundary))
      .limit(1)
      .get()
  ) {
    throw new ClosedPeriodError(boundary);
  }
}

/** Drizzle may wrap a refusal as a query error; retain the actionable message. */
export function closedPeriodReason(error: unknown): string | null {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    if (current instanceof ClosedPeriodError) return current.message;
    visited.add(current);
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function isClosedPeriodError(error: unknown): boolean {
  return closedPeriodReason(error) !== null;
}
