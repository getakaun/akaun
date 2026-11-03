/** Small public contracts shared by the closing screen and its endpoints. */
export type ClosingStatus = { closedThrough: string | null };
export type ClosingWarning = { id: string; message: string };
export type ClosingChecks = {
  transactions: boolean;
  bank: boolean;
  adjustments: boolean;
  reports: boolean;
};
export type ClosingPreview = ClosingStatus & {
  monthEnd: string;
  dateFrom: string | null;
  revision: string;
  warnings: ClosingWarning[];
  integrity: { ok: boolean; recordsChecked: number; problemCount: number };
};
export type ClosingHistoryEntry = {
  id: number;
  createdAt: string;
  actorName: string | null;
  action: "close" | "reopen";
  before: string | null;
  after: string | null;
  reason: string | null;
};
export type ClosingPageData = ClosingStatus & {
  canClose: boolean;
  canReopen: boolean;
  latestMonthEnd: string;
  defaultMonth: string;
  history: ClosingHistoryEntry[];
};

/** A month is a calendar value, never converted to a local or UTC instant. */
export function monthEndFor(month: string): string | null {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const day = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  day.setUTCMonth(day.getUTCMonth() + 1);
  day.setUTCDate(0);
  return day.toISOString().slice(0, 10);
}

export function previousMonthEnd(month: string): string | null {
  if (month === "0001-01" || monthEndFor(month) === null) return null;
  const day = new Date(`${month}-01T00:00:00Z`);
  day.setUTCDate(0);
  return day.toISOString().slice(0, 10);
}
