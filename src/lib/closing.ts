/** Small public contracts shared by the closing screen and its endpoints. */
export type ClosingStatus = { closedThrough: string | null };
/**
 * What a closing item points at. Typed ids, never a URL: the page turns them
 * into its own links, and an API caller gets ids it can use.
 */
export type ClosingItemRef =
  | { kind: "depreciation"; month: string }
  | { kind: "record"; id: number }
  | { kind: "account"; id: number }
  | { kind: "invoice"; id: number }
  /** A document read as several items, which has a page of its own. */
  | { kind: "import-group"; id: string }
  /** A single-item import, reviewed from the import queue. */
  | { kind: "import-queue" }
  | { kind: "statement"; accountId: number; statementId: number }
  | { kind: "statements"; accountId: number };

/** One exact thing behind a check, so a reader never has to go looking. */
export type ClosingItem = {
  key: string;
  label: string;
  detail: string;
  /** A signed difference to show beside the item. Display only. */
  amountMinor?: number;
  ref: ClosingItemRef | null;
};

/** Each check lists at most this many items; `total` says how many exist. */
export const CLOSING_ITEM_LIMIT = 20;

export type ClosingWarning = {
  id: string;
  /** What was found, in one line. */
  message: string;
  /** Why it matters and what to do. Absent on a note that explains itself. */
  hint?: string;
  items?: ClosingItem[];
  /** How many items exist when more than `items` holds. */
  total?: number;
};
export type ClosingPreview = ClosingStatus & {
  monthEnd: string;
  dateFrom: string | null;
  revision: string;
  warnings: ClosingWarning[];
  taxReview: {
    ok: boolean;
    unresolvedLineCount: number;
    unresolvedMinor: number;
    items: ClosingItem[];
  };
  integrity: {
    ok: boolean;
    recordsChecked: number;
    problemCount: number;
    /** The unbalanced records, when the check fails. */
    problems: ClosingItem[];
    /** False when the whole book does not add up to zero. */
    booksBalance: boolean;
  };
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
  canReadAccounts: boolean;
  canReadRecords: boolean;
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
