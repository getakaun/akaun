import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  accounts,
  accountDefaults,
  contacts,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import type {
  AccountHistoryEntry,
  AccountHistoryReport,
  AccountRef,
  AccountRow,
  AccountView,
  LedgerDb,
  Minor,
} from "../ledger/types.js";
import { resolveMovementLabel } from "../ledger/movement-label.js";

/**
 * Reading the chart of accounts.
 *
 * An account's balance is `SUM(amount_minor)` over its movements — nothing is
 * stored, so the chart of accounts and a report can never disagree (FR-031).
 * The type shown beside each account is looked up from its role, never read
 * from a column (D-05).
 */

/** A row as it comes back from the table, with the enum widened to its code type. */
function toAccountRow(row: typeof accounts.$inferSelect): AccountRow {
  return {
    id: row.id,
    role: row.role,
    type: row.type as AccountTypeCode,
    subType: row.subType as AccountSubTypeCode | null,
    code: row.code ?? row.id,
    name: row.name,
    mergedIntoAccountId: row.mergedIntoAccountId,
    contactId: row.contactId,
    isSystem: row.isSystem,
    rank: row.rank,
    archivedAt: row.archivedAt,
  };
}

/** Why an account cannot be deleted, or null when it can (FR-009). */
function cannotDeleteReason(
  row: AccountRow,
  movementCount: number,
): string | null {
  if (row.isSystem) {
    return "This is one of the accounts the app needs to work, so it cannot be deleted.";
  }
  if (movementCount > 0) {
    return movementCount === 1
      ? "One record uses this account. Archive it instead — it will stop being offered for new records and its history stays."
      : `${movementCount} records use this account. Archive it instead — it will stop being offered for new records and its history stays.`;
  }
  return null;
}

export type AccountFilters = {
  type?: AccountTypeCode | AccountTypeCode[];
  search?: string;
  includeArchived?: boolean;
  contactId?: number;
};

function accountConditions(filters: AccountFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.contactId !== undefined) {
    conditions.push(eq(accounts.contactId, filters.contactId));
  }
  if (filters.type !== undefined)
    conditions.push(
      Array.isArray(filters.type)
        ? inArray(accounts.type, filters.type)
        : eq(accounts.type, filters.type),
    );
  if (!filters.includeArchived) conditions.push(isNull(accounts.archivedAt));
  return conditions;
}

/**
 * The chart of accounts with each account's balance, how many records use it,
 * and whether it can be deleted.
 *
 * One grouped aggregate over the movements table rather than a per-account
 * query, so the screen is two statements however many accounts there are.
 */
export function listAccounts(
  db: LedgerDb,
  filters: AccountFilters = {},
): AccountView[] {
  const conditions = accountConditions(filters);
  const rows = db
    .select()
    .from(accounts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(accounts.type), asc(accounts.code), asc(accounts.rank))
    .all();

  if (rows.length === 0) return [];

  const totals = db
    .select({
      accountId: ledgerMovements.accountId,
      balanceMinor: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
      movementCount: sql<number>`count(*)`,
    })
    .from(ledgerMovements)
    .where(
      inArray(
        ledgerMovements.accountId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(ledgerMovements.accountId)
    .all();

  const totalsById = new Map(totals.map((t) => [t.accountId, t]));
  const owedAccountIds = new Set(
    db
      .select({ accountId: accountDefaults.accountId })
      .from(accountDefaults)
      .where(
        inArray(accountDefaults.purpose, [
          DefaultAccountPurpose.Receivable,
          DefaultAccountPurpose.Payable,
          DefaultAccountPurpose.ReimbursementsPayable,
        ]),
      )
      .all()
      .map((row) => row.accountId),
  );
  const accountRows = rows.map(toAccountRow);

  const views = accountRows.map((row) => {
    const totalsFor = totalsById.get(row.id);
    const movementCount = totalsFor?.movementCount ?? 0;
    const reason = cannotDeleteReason(row, movementCount);
    const balanceMinor = totalsFor?.balanceMinor ?? 0;
    return {
      ...row,
      active: row.archivedAt === null && row.mergedIntoAccountId === null,
      postingEligible:
        row.archivedAt === null && row.mergedIntoAccountId === null,
      owedContactRequired: owedAccountIds.has(row.id),
      balanceMinor,
      movementCount,
      canDelete: reason === null,
      cannotDeleteReason: reason,
    };
  });
  const term = filters.search?.trim().toLocaleLowerCase();
  if (!term) return views;
  return views.filter(
    (view) =>
      String(view.code).includes(term) ||
      view.name.toLocaleLowerCase().includes(term),
  );
}

export function getAccount(db: LedgerDb, id: number): AccountView | null {
  const raw = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!raw) return null;
  const canonicalId = raw.mergedIntoAccountId ?? id;
  return (
    listAccounts(db, { includeArchived: true }).find(
      (row) => row.id === canonicalId,
    ) ?? null
  );
}

export function canonicalAccountId(db: LedgerDb, id: number): number | null {
  const row = db
    .select({ mergedIntoAccountId: accounts.mergedIntoAccountId })
    .from(accounts)
    .where(eq(accounts.id, id))
    .get();
  return row ? (row.mergedIntoAccountId ?? id) : null;
}

/** One account's balance, without the rest of the chart. */
export function accountBalanceMinor(db: LedgerDb, id: number): Minor {
  const row = db
    .select({
      balanceMinor: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.accountId, id))
    .get();
  return row?.balanceMinor ?? 0;
}

export function movementCountFor(db: LedgerDb, id: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.accountId, id))
    .get();
  return row?.n ?? 0;
}

/** Whether an account may be deleted outright, and why not when it may not. */
export function canDeleteAccount(
  db: LedgerDb,
  id: number,
): { ok: boolean; reason: string | null } {
  const raw = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!raw) return { ok: false, reason: "That account no longer exists." };
  const reason = cannotDeleteReason(
    toAccountRow(raw),
    movementCountFor(db, id),
  );
  return { ok: reason === null, reason };
}

/**
 * Just enough about the accounts an entry names for `entry-builder.ts` to check
 * a role without reaching for the database itself.
 */
export function accountRefs(
  db: LedgerDb,
  ids: number[],
): Map<number, AccountRef> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return new Map();
  const rows = db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(inArray(accounts.id, unique))
    .all();
  return new Map(
    rows.map((r) => [r.id, { id: r.id, type: r.type as AccountTypeCode }]),
  );
}

/**
 * The account new records pre-select (FR-011). Falls back to the first bank
 * account so a database whose setting was cleared by hand still works.
 */
export function defaultAccountId(db: LedgerDb): number | null {
  const saved = db
    .select({ id: accounts.id })
    .from(accountDefaults)
    .innerJoin(accounts, eq(accounts.id, accountDefaults.accountId))
    .where(
      eq(accountDefaults.purpose, DefaultAccountPurpose.EverydayTransaction),
    )
    .get();
  if (saved) return saved.id;

  // Conversion seeds the default, but retaining a type-based fallback keeps a
  // damaged/pre-conversion database usable without reviving role semantics.
  return (
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.type, AccountType.Asset),
          inArray(accounts.subType, [
            AccountSubType.Cash,
            AccountSubType.Bank,
            AccountSubType.Wallet,
            AccountSubType.Card,
            AccountSubType.Clearing,
          ]),
          isNull(accounts.archivedAt),
        ),
      )
      .orderBy(asc(accounts.code), asc(accounts.id))
      .get()?.id ?? null
  );
}

/**
 * The account a contact was last paid from, or last paid into, on a record of
 * the given kind — so a repeat vendor or customer pre-fills the account that
 * was actually used for them last time instead of the one global default
 * (import worker, FR-011/FR-019). Nothing is stored for this: it is read
 * straight off the ledger, so it can never drift from what actually happened
 * and a reviewer's own correction becomes next time's answer automatically.
 */
export function lastPaymentAccountForContact(
  db: LedgerDb,
  contactId: number,
  kind: typeof LedgerRecordKind.Expense | typeof LedgerRecordKind.Income,
): number | null {
  const record = db
    .select({ id: ledgerRecords.id })
    .from(ledgerRecords)
    .where(
      and(eq(ledgerRecords.contactId, contactId), eq(ledgerRecords.kind, kind)),
    )
    .orderBy(desc(ledgerRecords.date), desc(ledgerRecords.id))
    .limit(1)
    .get();
  if (!record) return null;

  // An expense's paying side is the negative half of `twoSided(category,
  // paidFrom, amount)` — true whether it landed on a bank account or, when
  // the expense was owed, on the shared Payable account itself. An income's
  // receiving side is the positive half of `twoSided(receivedInto, category,
  // amount)`.
  const side =
    kind === LedgerRecordKind.Expense
      ? lt(ledgerMovements.amountMinor, 0)
      : gt(ledgerMovements.amountMinor, 0);

  return (
    db
      .select({ accountId: ledgerMovements.accountId })
      .from(ledgerMovements)
      .where(and(eq(ledgerMovements.recordId, record.id), side))
      .get()?.accountId ?? null
  );
}

/**
 * One account's full history with a running balance (FR-028).
 *
 * The running balance is cumulative from the beginning of the account, not from
 * the start of the window, so a page showing March still says what the account
 * actually held on each of those days. That is why the opening figure is a
 * separate aggregate over everything before `dateFrom` rather than a total of
 * the rows on screen.
 *
 * There is deliberately NO `offset`. It is the one parameter that cannot simply
 * be passed through: the opening figure covers everything before `dateFrom`, so
 * skipping rows inside the window would leave every running balance — and the
 * closing balance — counted from the wrong starting point, silently. Narrowing
 * the window with `dateFrom`/`dateTo` is the way to look at part of a long
 * history, and it is the affordance the screen already offers. If real paging is
 * ever wanted, this function has to fold the skipped movements into
 * `openingBalanceMinor` first; until then the caller is told what it is not
 * seeing rather than shown something wrong.
 */
export function accountHistory(
  db: LedgerDb,
  accountId: number,
  options: {
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  } = {},
): AccountHistoryReport | null {
  const account = getAccount(db, accountId);
  if (!account) return null;

  const window: SQL[] = [eq(ledgerMovements.accountId, accountId)];
  if (options.dateFrom) window.push(gte(ledgerRecords.date, options.dateFrom));
  if (options.dateTo) window.push(lte(ledgerRecords.date, options.dateTo));

  const openingBalanceMinor = options.dateFrom
    ? (db
        .select({
          total: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
        })
        .from(ledgerMovements)
        .innerJoin(
          ledgerRecords,
          eq(ledgerRecords.id, ledgerMovements.recordId),
        )
        .where(
          and(
            eq(ledgerMovements.accountId, accountId),
            lt(ledgerRecords.date, options.dateFrom),
          ),
        )
        .get()?.total ?? 0)
    : 0;

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(ledgerMovements)
      .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
      .where(and(...window))
      .get()?.n ?? 0;

  const rows = db
    .select({
      movementId: ledgerMovements.id,
      amountMinor: ledgerMovements.amountMinor,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      date: ledgerRecords.date,
      kind: ledgerRecords.kind,
      description: ledgerRecords.description,
      label: ledgerMovements.label,
      contactName: contacts.legalName,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(and(...window))
    .orderBy(asc(ledgerRecords.date), asc(ledgerMovements.id))
    .limit(options.limit ?? 500)
    .all();

  let running = openingBalanceMinor;
  const entries: AccountHistoryEntry[] = rows.map((row) => {
    running += row.amountMinor;
    return {
      movementId: row.movementId,
      recordId: row.recordId,
      recordNumber: row.recordNumber,
      date: row.date,
      kind: row.kind as LedgerRecordKindCode,
      description: resolveMovementLabel(row.label, row.description),
      contactName: row.contactName ?? null,
      amountMinor: row.amountMinor,
      runningBalanceMinor: running,
    };
  });

  return {
    account,
    entries,
    openingBalanceMinor,
    closingBalanceMinor: running,
    total,
    notes: [],
  };
}

/** One account's opening balance, as the account page and its editor both need it. */
export type OpeningBalanceView = {
  recordId: number;
  date: string;
  /** Signed cents on *this* account — the same convention as any movement. */
  amountMinor: Minor;
};

/**
 * The account's one opening-balance record, or null when it has none.
 *
 * An opening balance is the one record whose two sides are this account and the
 * account chosen as the opening-balances default, so both are matched here — an
 * account can appear on other records of the same kind (it is the other side of
 * somebody else's opening balance), and those are not its own.
 *
 * `setOpeningBalance` in `services/accounts.ts` reads the same answer through
 * this function, so the figure the page shows and the record the save replaces
 * can never be two different records.
 */
export function openingBalanceFor(
  db: LedgerDb,
  accountId: number,
): OpeningBalanceView | null {
  const openingAccountId = db
    .select({ accountId: accountDefaults.accountId })
    .from(accountDefaults)
    .where(eq(accountDefaults.purpose, DefaultAccountPurpose.OpeningBalances))
    .get()?.accountId;
  if (openingAccountId == null) return null;

  const other = db
    .select({ recordId: ledgerMovements.recordId })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.accountId, openingAccountId));

  return (
    db
      .select({
        recordId: ledgerRecords.id,
        date: ledgerRecords.date,
        amountMinor: ledgerMovements.amountMinor,
      })
      .from(ledgerRecords)
      .innerJoin(
        ledgerMovements,
        eq(ledgerMovements.recordId, ledgerRecords.id),
      )
      .where(
        and(
          eq(ledgerRecords.kind, LedgerRecordKind.OpeningBalance),
          eq(ledgerMovements.accountId, accountId),
          inArray(ledgerRecords.id, other),
        ),
      )
      .get() ?? null
  );
}
