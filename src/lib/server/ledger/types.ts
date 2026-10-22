/**
 * The ledger's shared vocabulary: every row shape, every DTO, and the argument
 * and result types that fix the signature of each function in
 * `src/lib/server/ledger/**` and `src/lib/server/queries/{ledger,accounts,
 * settlements,reports}.ts`.
 *
 * This file is the interface freeze. It exists so a rule module, a query, a
 * service and a page component can be written at the same time without
 * inventing each other's shapes. It holds no logic and no bodies — changing a
 * type here is a change every one of those callers sees, so it is a broadcast
 * rather than a quiet edit.
 *
 * Money: a `Minor` is whole cents of the MAIN currency, signed. A movement's
 * amount is positive when value goes INTO that account and negative when it
 * leaves, and a record's movements always add up to zero. The decimal `amount`
 * on a record is the figure as the user typed it, in the record's own
 * `currency` — it is for display and audit and is never summed for a report.
 *
 * See specs/002-double-entry-ledger/data-model.md.
 */

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  AccountRoleCode,
  AccountSubTypeCode,
  AccountTypeCode,
  LedgerRecordKindCode,
} from "$lib/enums.js";
import type * as schema from "../db/schema.js";

export type LedgerDb = BunSQLiteDatabase<typeof schema>;

/** Whole cents of the main currency, signed. Positive = value in. */
export type Minor = number;

/** Which old table a migrated record came from — the upgrade's idempotency key. */
export type LegacyKind = "expense" | "income" | "claim";

/**
 * The shape every rule that can refuse returns. `reason` is the plain sentence
 * shown to the user and sent as the `409` body's `reason` (contracts/api.md).
 */
export type Refusable<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** The same, for a rule that answers "may I?" and produces no value. */
export type Allowed = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountRow = {
  id: number;
  /** Legacy storage value retained only until the conversion release drops the column. */
  role: number;
  code?: number;
  type: AccountTypeCode;
  /** Meaningful only when `type === Asset`. `null` means "needs review". */
  subType: AccountSubTypeCode | null;
  name: string;
  mergedIntoAccountId?: number | null;
  contactId: number | null;
  isSystem: boolean;
  rank: string;
  archivedAt: string | null;
};

/** Account query view. Legacy fields remain until every UI consumer is migrated. */
export type AccountView = AccountRow & {
  active?: boolean;
  postingEligible?: boolean;
  owedContactRequired?: boolean;
  balanceMinor: Minor;
  movementCount: number;
  canDelete: boolean;
  /** Why the delete button is disabled, or null when it is not. */
  cannotDeleteReason: string | null;
};

/** The minimum an `entry-builder` rule needs to know about an account. */
export type AccountRef = { id: number; type: AccountTypeCode };

export type AccountCreate = {
  /** Omit to allocate the lowest free code in the selected type range. */
  code?: number;
  name: string;
  type: AccountTypeCode;
  /**
   * Required by the service layer for `type === Asset` or `Liability`
   * (no safe default); optional for `Expense`/`Revenue` (defaults to
   * Operating); rejected for `Equity`.
   */
  subType?: AccountSubTypeCode;
};
export type AccountPatch = {
  name?: string;
  type?: AccountTypeCode;
  active?: boolean;
  subType?: AccountSubTypeCode;
  code?: number;
};

/** The system accounts the upgrade seeds, resolved once per request. */
export type SystemAccountIds = {
  defaultAccountId: number;
  receivableAccountId: number;
  payableAccountId: number;
  openingBalancesAccountId: number;
  uncategorisedAccountId: number;
};

// ---------------------------------------------------------------------------
// Records and movements
// ---------------------------------------------------------------------------

export type ExpensePaymentSource = "company" | "personal" | "unpaid";

export type LedgerRecordRow = {
  expensePaymentSource?: ExpensePaymentSource | null;
  supplierContactId?: number | null;
  id: number;
  kind: LedgerRecordKindCode;
  date: string;
  recordNumber: string | null;
  description: string;
  contactId: number | null;
  reference: string;
  remark: string;
  currency: string;
  exchangeRate: number;
  amount: number;
  extractedText: string | null;
  legacyKind: LegacyKind | null;
  legacyId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type MovementRow = {
  id: number;
  recordId: number;
  accountId: number;
  amountMinor: Minor;
  sortOrder: number;
  /** The line's own name, or null to fall back to the record's description. */
  label: string | null;
};

/** One side of a record before it has an id — what `entry-builder.ts` produces. */
export type MovementDraft = {
  accountId: number;
  amountMinor: Minor;
  sortOrder: number;
  label: string | null;
};

/** One side of a record as a screen shows it. */
export type MovementView = {
  id: number;
  accountId: number;
  accountName: string;
  accountType: AccountTypeCode;
  /**
   * Carried beside the type because the two together are what say whether this
   * side is a place money sits or a statement of what it was for: equipment is
   * an asset that belongs with the categories (002 FR-006b), and the type alone
   * cannot tell it from a bank account. `isCategoryMovement` in
   * `components/accounts/display-sign.ts` is the client's copy of that rule.
   */
  accountRole: number;
  /** Meaningful only when `accountType === Asset`. `null` means "needs review". */
  accountSubType: AccountSubTypeCode | null;
  amountMinor: Minor;
  /**
   * The line's own name, raw — null when it has none. This is what an edit
   * form must read: never the record's description filled in as a fallback,
   * or re-saving would freeze that text onto the line as a permanent
   * override.
   */
  label: string | null;
  /**
   * What this line is called on screen — `label`, or the record's own
   * description when it has none. Resolved once by `toRecordView` in
   * `queries/ledger.ts` (`ledger/movement-label.ts`'s `resolveMovementLabel`),
   * so any screen that only displays a movement's name reads this and never
   * writes its own copy of the fallback.
   */
  displayLabel: string;
};

/** What `GET /api/records` returns for one record. */
export type RecordView = LedgerRecordRow & {
  supplierContactName?: string | null;
  contactName: string | null;
  /** The record's own figure in cents: round(amount × exchangeRate × 100). */
  amountMinor: Minor;
  movements: MovementView[];
  /** Derived from settlements — never stored (FR-012). */
  paid: boolean;
  outstandingMinor: Minor;
  /** Derived from settlements and reconciliation allocations (FR-017a). */
  locked: boolean;
  lockedReason: string | null;
  /**
   * Whether a bank line has been matched to this record.
   *
   * Separate from `locked`, which collapses "settled" and "reconciled" into one
   * answer and only speaks up once the record is locked. A screen needs to say
   * "cleared" or "not cleared yet" about a record that is neither, which is what
   * the expenses list showed before the one store existed.
   *
   * Also separate from `cleared` below, and the difference is load-bearing.
   * `reconciled` is existence — one allocation row is enough — and that is the
   * right answer for locking: if any bank line points at a record its amount
   * must not change, covered or not. `cleared` is coverage, which is the right
   * answer for a worklist (research.md R-08). `locked` continues to read
   * `reconciled`, never `cleared`.
   *
   * Any bank line points at this record. Drives `locked`. Existence only.
   */
  reconciled: boolean;
  /** Fully covered by bank lines. Drives the "not yet cleared" filter and the row label. */
  cleared: boolean;
  /** How much of this record bank lines account for, in cents. */
  clearedMinor: Minor;
  /** How many sides this record has — a row shows the count instead of two accounts when > 2. */
  sideCount: number;
  attachmentCount: number;
};

export type RecordAttachmentRow = {
  id: number;
  recordId: number;
  filename: string;
  displayName: string;
  addedDate: string;
  legacyFilename: string | null;
};

/**
 * The everyday-terms body `POST /api/records` accepts. The API never asks a
 * caller to construct movements except for a journal entry (FR-020).
 */
export type RecordCreate = {
  expensePaymentSource?: ExpensePaymentSource | null;
  supplierContactId?: number | null;
  paidByContactId?: number | null;
  date: string;
  description: string;
  amount: number;
  currency: string;
  exchangeRate: number;
  reference?: string;
  remark?: string;
  contactId?: number | null;
  extractedText?: string | null;
  /** Set only by the upgrade and only for a converted row. */
  recordNumber?: string | null;
} & RecordCreateSides;

export type RecordCreateSides =
  | {
      kind: "expense";
      expensePaymentSource?: ExpensePaymentSource | null;
      categoryAccountId: number;
      /** Null means someone else paid, so it is owed to `contactId` (FR-008). */
      paidFromAccountId: number | null;
    }
  | { kind: "income"; categoryAccountId: number; receivedIntoAccountId: number }
  | { kind: "transfer"; fromAccountId: number; toAccountId: number }
  | {
      kind: "payment";
      settlementAccountId?: number;
      paidFromAccountId: number;
      /** we-pay settles Money we owe; we-receive settles Money owed to us. */
      direction: PaymentDirection;
      settlements?: AllocationRequest[];
      /** Explicit application of earlier payments; never inferred or auto-applied. */
      creditApplications?: {
        paymentMovementId: number;
        owedMovementId: number;
        amountMinor: Minor;
      }[];
    }
  | {
      kind: "reimbursement-transfer";
      clearingAccountId: number;
      leg:
        | "supplier"
        | "recipient"
        | "supplier-reversal"
        | "recipient-reversal";
    }
  | { kind: "opening-balance"; accountId: number }
  | { kind: "invoice-issue"; incomeAccountId: number }
  | {
      kind: "journal";
      movements: {
        accountId: number;
        amountMinor: Minor;
        /** This line's own name. Absent or null falls back to the record's description. */
        label?: string | null;
      }[];
      /**
       * What this record really was, when its sides are an everyday purchase or
       * sale that happens to span several categories.
       *
       * One supplier bill can cover fuel and paper: three sides, two of them
       * categories. Structurally that is the `journal` shape, because the
       * `expense` variant above holds exactly one `categoryAccountId` — but it
       * is a purchase, and filing it as an adjustment would put ordinary
       * spending under the heading reserved for corrections.
       *
       * Set only by `sides-from-accounts.ts`, and only for the shapes it
       * recognises as everyday. Absent on a real adjustment.
       */
      storedKind?: LedgerRecordKindCode;
    };

export type PaymentDirection =
  | "we-pay"
  | "we-receive"
  | "refund-received"
  | "refund-paid";

/**
 * What the one form sends. The kind is derived, never stated (D-01, research.md
 * R-02).
 *
 * `RecordCreateSides` above keeps all seven of its variants and the API keeps
 * accepting them — Invoices, Auto Import and reconciliation's transfer action
 * construct them in-process today and FR-036 leaves those untouched. The form
 * sends this eighth shape instead, and `ledger/sides-from-accounts.ts` derives
 * which of the seven it means.
 */
export type RecordCreateFromSides = {
  /** The account money left. */
  fromAccountId: number;
  /** The account money went to. */
  toAccountId: number;
  /** Third and later sides. Requires the `adjustments` ability (FR-031). */
  extraSides?: {
    accountId: number;
    amountMinor: Minor;
    label?: string | null;
  }[];
  /** The named category's own typed amount, alongside `extraSides`. */
  categoryAmountMinor?: Minor;
  /** The named category's own name, alongside `extraSides`. Absent or null falls back to the record's description. */
  categoryLabel?: string | null;
};

/** Only the fields a `PATCH /api/records/[id]` may carry. */
export type RecordPatch = {
  expensePaymentSource?: ExpensePaymentSource | null;
  supplierContactId?: number | null;
  paidByContactId?: number | null;
  date?: string;
  description?: string;
  amount?: number;
  currency?: string;
  exchangeRate?: number;
  reference?: string;
  remark?: string;
  contactId?: number | null;
  categoryAccountId?: number;
  paidFromAccountId?: number | null;
  receivedIntoAccountId?: number;
  fromAccountId?: number;
  toAccountId?: number;
  /** Third and later sides. Requires the `adjustments` ability, same as on create (FR-031). */
  extraSides?: {
    accountId: number;
    amountMinor: Minor;
    label?: string | null;
  }[];
  /**
   * The named category's own typed amount, alongside `extraSides` or
   * `categoryAccountId`. Always a positive magnitude. Absent means "whatever
   * the extra sides leave" — see `services/ledger.ts`'s `sidesFor` and
   * `sides-from-accounts.ts`'s `levelPrimarySide`.
   */
  categoryAmountMinor?: Minor;
  /**
   * The named category's own name, alongside `extraSides` or
   * `categoryAccountId`. Absent means "leave whatever it already had" — see
   * `services/ledger.ts`'s `sidesFor`. Null means "clear it back to the
   * record's description".
   */
  categoryLabel?: string | null;
};

/** Every filter `GET /api/records` accepts. */
export type RecordListFilters = {
  kind?: LedgerRecordKindCode | LedgerRecordKindCode[];
  accountId?: number;
  contactId?: number;
  categoryAccountId?: number;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  paid?: boolean;
  /** FR-056 — every account, not just those with a statement. */
  cleared?: boolean;
  /** FR-043 — which sort is in force, because the running balance depends on date order. */
  sort?: "date" | "amount";
  search?: string;
  limit?: number;
  offset?: number;
};

export type RecordListResult = { records: RecordView[]; total: number };

// ---------------------------------------------------------------------------
// ledger/money.ts
// ---------------------------------------------------------------------------

/**
 * `toMinor(amount, exchangeRate)` — the record's entered figure at its own
 * stored rate, in whole cents of the main currency. Half-up at the cent.
 * `fromMinor(minor)` — cents back to a decimal, for display only.
 * `allocateMinor(total, weights)` — splits `total` in proportion to `weights`
 * so the parts sum to exactly `total`, with the rounding remainder handed to
 * the largest weights first.
 */
export type AllocateMinor = (total: Minor, weights: Minor[]) => Minor[];

// ---------------------------------------------------------------------------
// ledger/account-type.ts
// ---------------------------------------------------------------------------

/**
 * `accountTypeFor(role)` — the one map from role to type; the type is never
 * stored, so the two can never disagree (D-05).
 * `displaySign(role)` — what a report multiplies a balance by so the reader
 * sees a positive figure where they expect one (D-03).
 */
export type AccountTypeFor = (role: AccountRoleCode) => AccountTypeCode;

// ---------------------------------------------------------------------------
// ledger/entry-builder.ts — the single place movements are constructed
// ---------------------------------------------------------------------------

/** Everything a builder needs beyond the record itself, gathered once. */
export type BuildContext = {
  reimbursementPayableAccountId?: number;
  /** Every account the input names, so a role can be checked without a query. */
  accounts: ReadonlyMap<number, AccountRef>;
  receivableAccountId: number;
  payableAccountId: number;
  openingBalancesAccountId: number;
};

export type BuildInput = {
  amountMinor: Minor;
  contactId: number | null;
} & RecordCreateSides;

/** `buildMovements(input, ctx)` — refuses rather than throws (FR-002, FR-007, FR-008). */
export type BuildMovements = (
  input: BuildInput,
  ctx: BuildContext,
) => Refusable<MovementDraft[]>;

// ---------------------------------------------------------------------------
// ledger/settlement-rules.ts
// ---------------------------------------------------------------------------

/** One side of a settlement: a movement on a shared owed account. */
export type SettlementSide = {
  movementId: number;
  /** The movement's own signed amount. */
  amountMinor: Minor;
  /** How much of it settlements already cover. Always ≥ 0. */
  settledMinor: Minor;
};

export type AllocationRequest = { owedMovementId: number; amountMinor: Minor };

/** What one outstanding item looks like on a payment screen and in US6's ageing. */
export type OutstandingItem = {
  expensePaymentSource?: ExpensePaymentSource | null;
  supplierContactName?: string | null;
  movementId: number;
  recordId: number;
  recordNumber: string | null;
  date: string;
  dueDate: string | null;
  description: string;
  contactId: number | null;
  contactName: string | null;
  amountMinor: Minor;
  settledMinor: Minor;
  outstandingMinor: Minor;
  daysOverdue: number;
  /** Original signed control-account movement; magnitudes above remain unsigned. */
  signedAmountMinor?: Minor;
  position?: "obligation" | "credit";
};

export type OutstandingDirection = "owed-to-us" | "we-owe";

export type OutstandingResult = {
  items: OutstandingItem[];
  totalOutstandingMinor: Minor;
  totalObligationsMinor?: Minor;
  totalCreditsMinor?: Minor;
};

/** A record's paid state, computed from its shared-owed movements (FR-012). */
export type RecordSettlementState = { paid: boolean; outstandingMinor: Minor };

// ---------------------------------------------------------------------------
// ledger/locking.ts
// ---------------------------------------------------------------------------

/** Why a record might be locked. Both can be true at once (FR-017a). */
export type LockState = { settled: boolean; reconciled: boolean };

export type LockResult = {
  locked: boolean;
  /** The fields refused while locked — amount, date and any account field. */
  lockedFields: readonly string[];
  /** The plain sentence naming what to undo first, or null when not locked. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// ledger/integrity.ts
// ---------------------------------------------------------------------------

/** One record reduced to the figures the balance rules need. */
export type RecordBalanceInput = {
  recordId: number;
  kind: LedgerRecordKindCode;
  movementCount: number;
  /** SUM(amount_minor) over the record's movements — must be 0 (invariant 1). */
  movementSumMinor: Minor;
  /** SUM of the positive movements — must equal `expectedMinor` (invariant 6). */
  positiveSumMinor: Minor;
  /** round(amount × exchange_rate × 100) from the record's own figure. */
  expectedMinor: Minor;
  /** True when any of the record's movements is zero (invariant 3). */
  hasZeroMovement: boolean;
  /** True when a shared owed account is touched with no contact (invariant 4). */
  missingContact: boolean;
};

export type UnbalancedRecord = {
  recordId: number;
  differenceMinor: Minor;
  /** Which invariant failed, in plain words. */
  problem: string;
};

export type IntegrityReport = {
  ok: boolean;
  recordsChecked: number;
  unbalancedRecords: UnbalancedRecord[];
  totalDifferenceMinor: Minor;
  /** Invariant 5 — SUM(amount_minor) across the whole table. */
  booksBalance: boolean;
  wholeBooksDifferenceMinor: Minor;
};

// ---------------------------------------------------------------------------
// ledger/reports/*
// ---------------------------------------------------------------------------

export type ReportLine = {
  accountId: number;
  accountName: string;
  amountMinor: Minor;
};

export type ProfitLossReport = {
  dateFrom: string;
  dateTo: string;
  income: ReportLine[];
  totalIncomeMinor: Minor;
  expenses: ReportLine[];
  totalExpensesMinor: Minor;
  /** Income less expenses over the period. */
  resultMinor: Minor;
  /** "Gross profit" (income less Cost of Goods Sold) and "Operating income" (gross profit less Operating expense). */
  subtotals: { label: string; amountMinor: Minor }[];
  notes: string[];
};

export type BalanceSheetSubsection = {
  label: "Current" | "Non-current" | "Unclassified";
  lines: ReportLine[];
  totalMinor: Minor;
};

export type BalanceSheetSection = {
  lines: ReportLine[];
  totalMinor: Minor;
  /** Present only for `owned` and `owed` — `ownersStake` has no sub-type to bucket by. */
  subsections?: BalanceSheetSubsection[];
};

export type BalanceSheetReport = {
  asAt: string;
  /** What the business owns. */
  owned: BalanceSheetSection;
  /** What the business owes. */
  owed: BalanceSheetSection;
  /** What the owners have in it, including the accumulated result. */
  ownersStake: BalanceSheetSection;
  accumulatedResultMinor: Minor;
  /** False only if the books do not balance; `differenceMinor` says by how much. */
  balances: boolean;
  differenceMinor: Minor;
  notes: string[];
};

/**
 * One line of a Cash Flow Statement activity. `accountId` is `null` for every
 * line here: each is an aggregation by activity/classification (e.g. "Change
 * in receivables" can span several receivable accounts), never a single
 * account's own line the way `ReportLine` is.
 */
export type CashFlowLine = {
  accountId: number | null;
  label: string;
  amountMinor: Minor;
};

export type CashFlowSection = {
  label: "Operating" | "Investing" | "Financing";
  lines: CashFlowLine[];
  totalMinor: Minor;
};

export type CashFlowReport = {
  dateFrom: string;
  dateTo: string;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  /** Movement on "needs review" accounts, shown separately (FR-005). */
  needsReviewMinor: Minor;
  /** Cash and cash equivalents, independently read, as at the day before `dateFrom`. */
  openingCashMinor: Minor;
  /** Cash and cash equivalents, independently read, as at `dateTo`. */
  closingCashMinor: Minor;
  /** Sum of the three sections' totals — excludes `needsReviewMinor` (FR-005). */
  netChangeMinor: Minor;
  /** False only if the figures do not add up; `differenceMinor` says by how much. */
  ties: boolean;
  differenceMinor: Minor;
  notes: string[];
};

export type PartnerStatementBlock = {
  contactId: number;
  contactName: string;
  contributionsMinor: Minor;
  shareOfResultMinor: Minor;
  drawingsMinor: Minor;
  netMinor: Minor;
};

export type PartnerStatementReport = {
  dateFrom: string;
  dateTo: string;
  partners: PartnerStatementBlock[];
  notes: string[];
};

export type AccountHistoryEntry = {
  movementId: number;
  recordId: number;
  recordNumber: string | null;
  date: string;
  kind: LedgerRecordKindCode;
  description: string;
  contactName: string | null;
  amountMinor: Minor;
  runningBalanceMinor: Minor;
};

export type AccountHistoryReport = {
  account: AccountView;
  entries: AccountHistoryEntry[];
  openingBalanceMinor: Minor;
  closingBalanceMinor: Minor;
  total: number;
  notes: string[];
};

/** What `ledger/reports/csv.ts` turns into a CSV document (FR-029). */
export type CsvTable = {
  columns: string[];
  rows: (string | number | null)[][];
  /** Rendered under the table, one per line, as a single quoted cell (FR-030). */
  notes?: string[];
};

// ---------------------------------------------------------------------------
// queries/reports.ts — the aggregates the three report modules consume
// ---------------------------------------------------------------------------

/** One account's total over a date range, or up to a date. */
export type AccountTotal = {
  accountId: number;
  code: number;
  accountName: string;
  type: AccountTypeCode;
  role: AccountRoleCode;
  /**
   * Absent for Equity. For Asset/Liability, `null` means "needs review". For
   * Expense/Revenue, `null` defaults safely to Operating.
   */
  subType: AccountSubTypeCode | null;
  contactId: number | null;
  amountMinor: Minor;
};

// ---------------------------------------------------------------------------
// The upgrade (src/lib/server/ledger/upgrade/**)
// ---------------------------------------------------------------------------

/** Which of FR-036b's ordered steps decided a migrated reimbursement's payer. */
export type PayerStep =
  | "email-match"
  | "name-match"
  | "sole-user-email-match"
  | "sole-user-name-match"
  | "created-contact"
  | "named-contact"
  | "bank-fallback";

export type PayerDecision = {
  step: PayerStep;
  contactId: number | null;
  /** Set only when `step` is "created-contact" — the name to create it under. */
  createName: string | null;
};

export type UpgradePhase =
  | "not-started"
  | "backed-up"
  | "accounts-seeded"
  | "records-converted"
  | "attachments-moved"
  | "reconciliation-backfilled"
  | "verified"
  | "done";

/** What the before/after comparison measures (SC-001, SC-013, SC-014). */
export type UpgradeSnapshot = {
  expenseTotalMinor: Minor;
  incomeTotalMinor: Minor;
  claimTotalMinor: Minor;
  expenseCount: number;
  incomeCount: number;
  claimCount: number;
  /** Every reference number, character for character. */
  referenceNumbers: string[];
  attachmentCount: number;
  /** SHA-256 by the attachment's path relative to STORAGE_PATH. */
  attachmentHashes: Record<string, string>;
  categoryTotalsMinor: Record<string, Minor>;
};

export type VerifyFinding = { what: string; before: string; after: string };

export type VerifyResult = {
  ok: boolean;
  findings: VerifyFinding[];
};

export type UpgradeReport = {
  /** Records that landed on Uncategorised because no category could be read. */
  uncategorisedRecordIds: number[];
  /** Attachments whose file could not be found; each still points where it was. */
  missingAttachments: string[];
  /** Where converting to cents lost a fraction, with the record it happened on. */
  roundingDifferences: { recordId: number; differenceMinor: Minor }[];
  /** Every payer attribution with the step that chose it (FR-036b). */
  payerAttributions: {
    legacyKind: LegacyKind;
    legacyId: number;
    step: PayerStep;
    contactId: number | null;
    contactName: string | null;
  }[];
  /** Unpaid, unclaimed expenses naming nobody, sent to the bank (FR-036c). */
  bankFallbackRecordIds: number[];
  /** Allocations the backfill could not repoint at a movement (FR-034). */
  unrepointedAllocationIds: number[];
};

export type UpgradeState = {
  phase: UpgradePhase;
  backupPath: string | null;
  before: UpgradeSnapshot | null;
  verify: VerifyResult | null;
  report: UpgradeReport;
  startedAt: string | null;
  finishedAt: string | null;
};

/** The `settings` key holding `UpgradeState` as JSON (D-15). */
export const UPGRADE_STATE_KEY = "ledger_upgrade_state";

/** The `settings` key naming the account new records default to (FR-011). */
export const DEFAULT_ACCOUNT_KEY = "ledger_default_account_id";
