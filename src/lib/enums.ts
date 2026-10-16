// src/lib/enums.ts — client-safe; it imports nothing.
// Single source of truth for ALL closed-set enum codes in the app.
// Stored in the DB as INTEGER. Codes are APPEND-ONLY — never reuse or renumber
// a retired code, or historical rows silently change meaning.
//
// Every enum has two maps here:
// - `*Labels` — wire values (lowercase snake_case) for URLs, API bodies and
//   zod. Never shown to a reader.
// - `*DisplayLabels` — the name a reader sees, in a list, a badge or the audit
//   log. A screen takes a name from here, never from a private copy, so a code
//   reads the same everywhere. (`EntityTypeLabels` and `RoleLabels` were
//   always Title Case and serve as both.)
// `enums.spec.ts` fails if a code has no display name.
//
// Open-ended string keys that grow as the app gains features
// (e.g. group_permissions.resource, user-defined category) stay TEXT — they are
// keys, not value enums, and do not belong here.

// --- contacts ---
export const EntityType = { Individual: 1, Business: 2 } as const;
export const Role = {
  Customer: 1,
  Supplier: 2,
  Employee: 3,
  Partner: 4,
} as const;

// --- expenses / claims ---
// `ExpenseStatus` and `ClaimStatus` were here. Payment state is never stored:
// paid, part-paid and owed are derived from settlements at read time, so there
// is no status code left to name (FR-037, FR-012). `DocumentType` below stays —
// it is still live in the import pipeline.

// --- import_queue ---
export const ImportState = {
  Queued: 1,
  Extracting: 2,
  Processing: 3,
  PendingReview: 4,
  Confirmed: 5,
  Imported: 6,
  Skipped: 7,
  Failed: 8,
  // A document read as several items. Its items are reviewed on their own
  // (import_items); the queue row stays to hold the file and the group, and is
  // neither in review nor done while any item is still waiting.
  Grouped: 9,
} as const;
// DocumentType is also used for import_queue.result_type. Append-only: the
// codes are stored. A transfer (006 FR-058) is money moved between two of the
// business's own accounts, and its direction is said from the account the
// document is about (an import item's `account_id`): out of it to the item's
// other account, or into it from there. Only an import profile's transfer
// section makes one; a receipt is always an expense or an income.
export const DocumentType = {
  Expense: 1,
  Income: 2,
  TransferOut: 3,
  TransferIn: 4,
} as const;

// --- reset scope ---
export const ResetScope = { Settings: 1, Data: 2, Everything: 3 } as const;

// ---------------------------------------------------------------------------
// Label maps + helpers. API bodies use INT codes; responses may also include a
// resolved label for client convenience.
// ---------------------------------------------------------------------------

export type EntityTypeCode = (typeof EntityType)[keyof typeof EntityType];
export type RoleCode = (typeof Role)[keyof typeof Role];
export type ImportStateCode = (typeof ImportState)[keyof typeof ImportState];
export type DocumentTypeCode = (typeof DocumentType)[keyof typeof DocumentType];
export type ResetScopeCode = (typeof ResetScope)[keyof typeof ResetScope];

export const EntityTypeLabels: Record<number, string> = {
  [EntityType.Individual]: "Individual",
  [EntityType.Business]: "Business",
};

export const RoleLabels: Record<number, string> = {
  [Role.Customer]: "Customer",
  [Role.Supplier]: "Supplier",
  [Role.Employee]: "Employee",
  [Role.Partner]: "Partner",
};

export const ImportStateLabels: Record<number, string> = {
  [ImportState.Queued]: "queued",
  [ImportState.Extracting]: "extracting",
  [ImportState.Processing]: "processing",
  [ImportState.PendingReview]: "pending_review",
  [ImportState.Confirmed]: "confirmed",
  [ImportState.Imported]: "imported",
  [ImportState.Skipped]: "skipped",
  [ImportState.Failed]: "failed",
  [ImportState.Grouped]: "grouped",
};

export const ImportStateDisplayLabels: Record<number, string> = {
  [ImportState.Queued]: "Queued",
  [ImportState.Extracting]: "Reading",
  [ImportState.Processing]: "Processing",
  [ImportState.PendingReview]: "Waiting for review",
  [ImportState.Confirmed]: "Confirmed",
  [ImportState.Imported]: "Imported",
  [ImportState.Skipped]: "Skipped",
  [ImportState.Failed]: "Failed",
  [ImportState.Grouped]: "Grouped",
};

export const DocumentTypeLabels: Record<number, string> = {
  [DocumentType.Expense]: "expense",
  [DocumentType.Income]: "income",
  [DocumentType.TransferOut]: "transfer_out",
  [DocumentType.TransferIn]: "transfer_in",
};

export const DocumentTypeDisplayLabels: Record<number, string> = {
  [DocumentType.Expense]: "Expense",
  [DocumentType.Income]: "Income",
  [DocumentType.TransferOut]: "Transfer out",
  [DocumentType.TransferIn]: "Transfer in",
};

/** Whether a DocumentType code is a transfer, either way (006 FR-058). */
export function isTransferType(code: number | null | undefined): boolean {
  return code === DocumentType.TransferOut || code === DocumentType.TransferIn;
}

export const ResetScopeLabels: Record<number, string> = {
  [ResetScope.Settings]: "settings",
  [ResetScope.Data]: "data",
  [ResetScope.Everything]: "everything",
};

export const ResetScopeDisplayLabels: Record<number, string> = {
  [ResetScope.Settings]: "Settings",
  [ResetScope.Data]: "Data",
  [ResetScope.Everything]: "Everything",
};

function invert(labels: Record<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, label] of Object.entries(labels)) out[label] = Number(code);
  return out;
}

function makeEnum(labels: Record<number, string>) {
  const byLabel = invert(labels);
  return {
    toLabel(code: number | null | undefined): string | null {
      if (code == null) return null;
      return labels[code] ?? null;
    },
    fromLabel(label: string | null | undefined): number | null {
      if (label == null) return null;
      return byLabel[label] ?? null;
    },
  };
}

export const entityTypeEnum = makeEnum(EntityTypeLabels);
export const roleEnum = makeEnum(RoleLabels);
export const importStateEnum = makeEnum(ImportStateLabels);
export const documentTypeEnum = makeEnum(DocumentTypeLabels);
export const resetScopeEnum = makeEnum(ResetScopeLabels);

// --- quotations ---
export const QuotationStatus = {
  Draft: 1,
  Sent: 2,
  Accepted: 3,
  Declined: 4,
  Converted: 5,
  // Replaced by a revision. Reached only by revising; never set by hand.
  Superseded: 6,
} as const;
// reserved (DERIVED, never stored): Expired — expiry_date < today && status ∈ {Draft, Sent}
export type QuotationStatusCode =
  (typeof QuotationStatus)[keyof typeof QuotationStatus];
export const QuotationStatusLabels: Record<number, string> = {
  [QuotationStatus.Draft]: "draft",
  [QuotationStatus.Sent]: "sent",
  [QuotationStatus.Accepted]: "accepted",
  [QuotationStatus.Declined]: "declined",
  [QuotationStatus.Converted]: "converted",
  [QuotationStatus.Superseded]: "superseded",
};
export const QuotationStatusDisplayLabels: Record<number, string> = {
  [QuotationStatus.Draft]: "Draft",
  [QuotationStatus.Sent]: "Sent",
  [QuotationStatus.Accepted]: "Accepted",
  [QuotationStatus.Declined]: "Declined",
  [QuotationStatus.Converted]: "Converted",
  [QuotationStatus.Superseded]: "Superseded",
};
export const quotationStatusEnum = makeEnum(QuotationStatusLabels);

// --- invoices ---
export const InvoiceStatus = {
  Draft: 1,
  Sent: 2,
  Paid: 3,
  Cancelled: 4,
} as const;
// reserved (DERIVED, never stored): Overdue — due_date < today && status !== Paid
// reserved (FUTURE): PartiallyPaid = 5
export type InvoiceStatusCode =
  (typeof InvoiceStatus)[keyof typeof InvoiceStatus];
export const InvoiceStatusLabels: Record<number, string> = {
  [InvoiceStatus.Draft]: "draft",
  [InvoiceStatus.Sent]: "sent",
  [InvoiceStatus.Paid]: "paid",
  [InvoiceStatus.Cancelled]: "cancelled",
};
export const InvoiceStatusDisplayLabels: Record<number, string> = {
  [InvoiceStatus.Draft]: "Draft",
  [InvoiceStatus.Sent]: "Sent",
  [InvoiceStatus.Paid]: "Paid",
  [InvoiceStatus.Cancelled]: "Cancelled",
};
export const invoiceStatusEnum = makeEnum(InvoiceStatusLabels);

// --- reconciliation ---
// RETIRED, RESERVED. Which ledger table a polymorphic reconciliation reference
// used to point at, before an allocation began pointing at a ledger movement
// (`reconciliation_allocations.movement_id`). Nothing writes these codes any
// more; they stay here so codes 1-3 are never reused and any surviving
// pre-upgrade `item_type` value keeps its original meaning while the two legacy
// columns are still readable. Removed with them in the release that drops the
// legacy tables. See specs/002-double-entry-ledger research.md D-11.
export const ReconItemType = { Expense: 1, Claim: 2, Income: 3 } as const;
// ClosedMatched = every statement line was matched; ClosedWithLeftovers = the
// session closed with unresolved records or statement lines.
// Statement amounts are stored positive; the sign lives here.
export const StatementDirection = { In: 1, Out: 2 } as const;
// NotYetCleared = a timing difference, the item stays in scope. WillNotClear =
// never a bank transaction, excluded from candidates and from leftovers.
// Progress of the most recent statement upload into a session.
export const StatementExtractionState = {
  Idle: 1,
  Extracting: 2,
  Ready: 3,
  Failed: 4,
} as const;

export type ReconItemTypeCode =
  (typeof ReconItemType)[keyof typeof ReconItemType];
export type StatementDirectionCode =
  (typeof StatementDirection)[keyof typeof StatementDirection];
export type StatementExtractionStateCode =
  (typeof StatementExtractionState)[keyof typeof StatementExtractionState];

export const ReconItemTypeLabels: Record<number, string> = {
  [ReconItemType.Expense]: "expense",
  [ReconItemType.Claim]: "claim",
  [ReconItemType.Income]: "income",
};

export const StatementDirectionLabels: Record<number, string> = {
  [StatementDirection.In]: "in",
  [StatementDirection.Out]: "out",
};

export const StatementDirectionDisplayLabels: Record<number, string> = {
  [StatementDirection.In]: "Credit",
  [StatementDirection.Out]: "Debit",
};

export const StatementExtractionStateLabels: Record<number, string> = {
  [StatementExtractionState.Idle]: "idle",
  [StatementExtractionState.Extracting]: "extracting",
  [StatementExtractionState.Ready]: "ready",
  [StatementExtractionState.Failed]: "failed",
};

export const StatementExtractionStateDisplayLabels: Record<number, string> = {
  [StatementExtractionState.Idle]: "Idle",
  [StatementExtractionState.Extracting]: "Reading",
  [StatementExtractionState.Ready]: "Ready",
  [StatementExtractionState.Failed]: "Failed",
};

export const reconItemTypeEnum = makeEnum(ReconItemTypeLabels);
export const statementDirectionEnum = makeEnum(StatementDirectionLabels);
export const statementExtractionStateEnum = makeEnum(
  StatementExtractionStateLabels,
);

// --- ledger ---
// Retired account roles remain append-only while existing books are converted.
export const AccountRole = {
  Bank: 1,
  Wallet: 2,
  Cash: 3,
  Card: 4, // places money sits
  Equipment: 5, // things the business owns and keeps
  Receivable: 6, // shared "money owed to us"   (system)
  Payable: 7, // shared "money we owe"       (system)
  OpeningBalances: 8, // where opening balances come from (system)
  PartnerCapital: 9,
  PartnerDrawings: 10, // one pair per partner contact
  ExpenseCategory: 11,
  IncomeCategory: 12, // what everyday screens call a category
} as const;

const FixedAccountType = {
  Asset: 1,
  Liability: 2,
  Equity: 3,
  Revenue: 4,
  Expense: 5,
} as const;

// Income was the old name for numeric code 4. Keep a non-enumerable source
// compatibility alias while all consumers migrate; labels and enumeration
// expose Revenue as the sole fixed type name.
export const AccountType = FixedAccountType as typeof FixedAccountType & {
  readonly Income: typeof FixedAccountType.Revenue;
};
Object.defineProperty(AccountType, "Income", {
  value: FixedAccountType.Revenue,
  enumerable: false,
});

export const AccountCodeRanges = {
  [AccountType.Asset]: { start: 1000, end: 1999 },
  [AccountType.Liability]: { start: 2000, end: 2999 },
  [AccountType.Equity]: { start: 3000, end: 3999 },
  [AccountType.Revenue]: { start: 4000, end: 4999 },
  [AccountType.Expense]: { start: 5000, end: 5999 },
} as const;

// The finer classification within `type`. `type` is the main group; `subType`
// says which kind of asset, liability, expense or revenue this is. Nullable
// on the account row. For Asset and Liability, NULL means "needs review", not
// a distinct sentinel value — there is no safe default classification for an
// account that could be a payable or a long-term loan. For Expense and
// Revenue, NULL is a safe default of "Operating" (see `isNeedsReview` and the
// `*Bucket` functions in `server/ledger/account-type.ts`) — Equity has no
// sub-type. Append-only, same convention as every other enum here.
//
// Grouped into one small object per account type, then merged below into the
// single stored/wire value every reader still imports as `AccountSubType` —
// this keeps each type's codes from drifting out of sync with
// `AccountSubTypesByType`, which is derived from these groups rather than
// hand-listed.
export const AssetSubType = {
  Cash: 1,
  Bank: 2,
  Wallet: 3,
  Card: 4,
  Receivable: 5,
  Inventory: 6,
  OtherCurrentAsset: 7,
  FixedAsset: 8,
  PrepaymentsAndDeposits: 20,
  Clearing: 21,
  TaxReceivable: 22,
  IntangibleAsset: 23,
  OtherNonCurrentAsset: 24,
} as const;
export const LiabilitySubType = {
  AccountsPayable: 9,
  AccruedLiabilities: 10,
  ShortTermLoan: 11,
  LongTermLoan: 12,
  OtherCurrentLiability: 13,
  OtherNonCurrentLiability: 14,
  CreditCard: 25,
  TaxPayable: 26,
} as const;
export const ExpenseSubType = {
  CostOfGoodsSold: 15,
  OperatingExpense: 16,
  OtherExpense: 17,
} as const;
export const RevenueSubType = {
  OperatingRevenue: 18,
  OtherRevenue: 19,
  ContraOperatingRevenue: 27,
  ContraOtherRevenue: 28,
} as const;

const FixedAccountSubType = {
  ...AssetSubType,
  ...LiabilitySubType,
  ...ExpenseSubType,
  ...RevenueSubType,
} as const;
export const AccountSubType =
  FixedAccountSubType as typeof FixedAccountSubType & {
    readonly Equipment: typeof FixedAccountSubType.FixedAsset;
  };
// Numeric code 8 was previously named Equipment. Keep a source-compatible,
// non-enumerable alias while new code uses the broader accounting term.
Object.defineProperty(AccountSubType, "Equipment", {
  value: AssetSubType.FixedAsset,
  enumerable: false,
});

export const DefaultAccountPurpose = {
  Receivable: 1,
  Payable: 2,
  OpeningBalances: 3,
  SalesRevenue: 4,
  UncategorisedExpense: 5,
  EverydayTransaction: 6,
  UncategorisedIncome: 7,
} as const;

// A kind belongs to one *event* on one date. It carries intent the movements
// cannot: equipment bought looks exactly like money moved, and a direct journal
// entry looks exactly like an expense.
export const LedgerRecordKind = {
  Expense: 1,
  Income: 2,
  Transfer: 3,
  Payment: 4,
  OpeningBalance: 5,
  InvoiceIssue: 6,
  Journal: 7,
} as const;

export type AccountRoleCode = (typeof AccountRole)[keyof typeof AccountRole];
export type AccountTypeCode = (typeof AccountType)[keyof typeof AccountType];
export type AccountSubTypeCode =
  (typeof AccountSubType)[keyof typeof AccountSubType];
export type DefaultAccountPurposeCode =
  (typeof DefaultAccountPurpose)[keyof typeof DefaultAccountPurpose];
export type LedgerRecordKindCode =
  (typeof LedgerRecordKind)[keyof typeof LedgerRecordKind];

// Roles have no wire map: they are never sent by name. These are the words the
// screens use for each kind of account.
export const AccountRoleDisplayLabels: Record<number, string> = {
  [AccountRole.Bank]: "Bank",
  [AccountRole.Wallet]: "Wallet",
  [AccountRole.Cash]: "Cash",
  [AccountRole.Card]: "Card",
  [AccountRole.Equipment]: "Equipment",
  [AccountRole.Receivable]: "Accounts receivable",
  [AccountRole.Payable]: "Accounts payable",
  [AccountRole.OpeningBalances]: "Opening balances",
  [AccountRole.PartnerCapital]: "Partner capital",
  [AccountRole.PartnerDrawings]: "Partner drawings",
  [AccountRole.ExpenseCategory]: "Expense category",
  [AccountRole.IncomeCategory]: "Income category",
};

export const AccountTypeLabels: Record<number, string> = {
  [AccountType.Asset]: "asset",
  [AccountType.Liability]: "liability",
  [AccountType.Equity]: "equity",
  [AccountType.Revenue]: "revenue",
  [AccountType.Expense]: "expense",
};

/**
 * The same five types as a reader sees them.
 *
 * `AccountTypeLabels` above are wire values — they go into URLs, API payloads
 * and the zod enum, so they stay lowercase. A screen that rendered them
 * directly showed an account-type picker reading "asset", "liability",
 * "revenue"; these are the names for a label, an option or a column.
 */
export const AccountTypeDisplayLabels: Record<number, string> = {
  [AccountType.Asset]: "Asset",
  [AccountType.Liability]: "Liability",
  [AccountType.Equity]: "Equity",
  [AccountType.Revenue]: "Revenue",
  [AccountType.Expense]: "Expense",
};

export const AccountSubTypeLabels: Record<number, string> = {
  [AccountSubType.Cash]: "cash",
  [AccountSubType.Bank]: "bank",
  [AccountSubType.Wallet]: "wallet",
  [AccountSubType.Card]: "card",
  [AccountSubType.Receivable]: "receivable",
  [AccountSubType.Inventory]: "inventory",
  [AccountSubType.OtherCurrentAsset]: "other_current_asset",
  [AccountSubType.FixedAsset]: "fixed_asset",
  [AccountSubType.PrepaymentsAndDeposits]: "prepayments_and_deposits",
  [AccountSubType.Clearing]: "clearing",
  [AccountSubType.TaxReceivable]: "tax_receivable",
  [AccountSubType.IntangibleAsset]: "intangible_asset",
  [AccountSubType.OtherNonCurrentAsset]: "other_non_current_asset",
  [AccountSubType.AccountsPayable]: "accounts_payable",
  [AccountSubType.AccruedLiabilities]: "accrued_liabilities",
  [AccountSubType.ShortTermLoan]: "short_term_loan",
  [AccountSubType.LongTermLoan]: "long_term_loan",
  [AccountSubType.OtherCurrentLiability]: "other_current_liability",
  [AccountSubType.OtherNonCurrentLiability]: "other_non_current_liability",
  [AccountSubType.CreditCard]: "credit_card",
  [AccountSubType.TaxPayable]: "tax_payable",
  [AccountSubType.CostOfGoodsSold]: "cost_of_goods_sold",
  [AccountSubType.OperatingExpense]: "operating_expense",
  [AccountSubType.OtherExpense]: "other_expense",
  [AccountSubType.OperatingRevenue]: "operating_revenue",
  [AccountSubType.OtherRevenue]: "other_revenue",
  [AccountSubType.ContraOperatingRevenue]: "contra_operating_revenue",
  [AccountSubType.ContraOtherRevenue]: "contra_other_revenue",
};

// Same split as `AccountTypeDisplayLabels` above — the wire labels stay
// lowercase snake_case for URLs/API payloads/the zod enum; these are for a
// picker, a badge or a column a reader sees.
export const AccountSubTypeDisplayLabels: Record<number, string> = {
  [AccountSubType.Cash]: "Cash",
  [AccountSubType.Bank]: "Bank",
  [AccountSubType.Wallet]: "Wallet",
  [AccountSubType.Card]: "Prepaid/debit card",
  [AccountSubType.Receivable]: "Accounts receivable",
  [AccountSubType.Inventory]: "Inventory",
  [AccountSubType.OtherCurrentAsset]: "Other current asset",
  [AccountSubType.FixedAsset]: "Fixed asset",
  [AccountSubType.PrepaymentsAndDeposits]: "Prepayments and deposits",
  [AccountSubType.Clearing]: "Clearing",
  [AccountSubType.TaxReceivable]: "Tax receivable",
  [AccountSubType.IntangibleAsset]: "Intangible asset",
  [AccountSubType.OtherNonCurrentAsset]: "Other non-current asset",
  [AccountSubType.AccountsPayable]: "Accounts payable",
  [AccountSubType.AccruedLiabilities]: "Accrued liabilities",
  [AccountSubType.ShortTermLoan]: "Short-term loan",
  [AccountSubType.LongTermLoan]: "Long-term loan",
  [AccountSubType.OtherCurrentLiability]: "Other current liability",
  [AccountSubType.OtherNonCurrentLiability]: "Other non-current liability",
  [AccountSubType.CreditCard]: "Credit card",
  [AccountSubType.TaxPayable]: "Tax payable",
  [AccountSubType.CostOfGoodsSold]: "Cost of goods sold",
  [AccountSubType.OperatingExpense]: "Operating expense",
  [AccountSubType.OtherExpense]: "Other expense",
  [AccountSubType.OperatingRevenue]: "Operating revenue",
  [AccountSubType.OtherRevenue]: "Other revenue",
  [AccountSubType.ContraOperatingRevenue]: "Contra operating revenue",
  [AccountSubType.ContraOtherRevenue]: "Contra other revenue",
};

/**
 * Which sub-type codes are valid for a given account type — derived from the
 * per-type groups above, not hand-listed, so a new code added to e.g.
 * `LiabilitySubType` can't be forgotten here. Equity is absent: it has no
 * sub-type.
 */
export const AccountSubTypesByType: Partial<
  Record<AccountTypeCode, AccountSubTypeCode[]>
> = {
  [AccountType.Asset]: Object.values(AssetSubType),
  [AccountType.Liability]: Object.values(LiabilitySubType),
  [AccountType.Expense]: Object.values(ExpenseSubType),
  [AccountType.Revenue]: Object.values(RevenueSubType),
};

export const DefaultAccountPurposeLabels: Record<number, string> = {
  [DefaultAccountPurpose.Receivable]: "receivable",
  [DefaultAccountPurpose.Payable]: "payable",
  [DefaultAccountPurpose.OpeningBalances]: "opening_balances",
  [DefaultAccountPurpose.SalesRevenue]: "sales_revenue",
  [DefaultAccountPurpose.UncategorisedExpense]: "uncategorised_expense",
  [DefaultAccountPurpose.EverydayTransaction]: "everyday_transaction",
  [DefaultAccountPurpose.UncategorisedIncome]: "uncategorised_income",
};

export const DefaultAccountPurposeDisplayLabels: Record<number, string> = {
  [DefaultAccountPurpose.Receivable]: "Accounts receivable",
  [DefaultAccountPurpose.Payable]: "Accounts payable",
  [DefaultAccountPurpose.OpeningBalances]: "Opening balances",
  [DefaultAccountPurpose.SalesRevenue]: "Sales revenue",
  [DefaultAccountPurpose.UncategorisedExpense]: "Uncategorised expense",
  [DefaultAccountPurpose.EverydayTransaction]: "Default transaction account",
  [DefaultAccountPurpose.UncategorisedIncome]: "Uncategorised income",
};

export const DefaultAccountPurposeTypes: Record<
  DefaultAccountPurposeCode,
  AccountTypeCode
> = {
  [DefaultAccountPurpose.Receivable]: AccountType.Asset,
  [DefaultAccountPurpose.Payable]: AccountType.Liability,
  [DefaultAccountPurpose.OpeningBalances]: AccountType.Equity,
  [DefaultAccountPurpose.SalesRevenue]: AccountType.Revenue,
  [DefaultAccountPurpose.UncategorisedExpense]: AccountType.Expense,
  [DefaultAccountPurpose.EverydayTransaction]: AccountType.Asset,
  [DefaultAccountPurpose.UncategorisedIncome]: AccountType.Revenue,
};

export const LedgerRecordKindLabels: Record<number, string> = {
  [LedgerRecordKind.Expense]: "expense",
  [LedgerRecordKind.Income]: "income",
  [LedgerRecordKind.Transfer]: "transfer",
  [LedgerRecordKind.Payment]: "payment",
  [LedgerRecordKind.OpeningBalance]: "opening_balance",
  [LedgerRecordKind.InvoiceIssue]: "invoice_issue",
  [LedgerRecordKind.Journal]: "journal",
};

/**
 * Display names, not the enum's names (Principle VII). Screens use the
 * standard accounting term as the label, with a short ASD-STE100 hint where a
 * hint helps.
 */
export const LedgerRecordKindDisplayLabels: Record<number, string> = {
  [LedgerRecordKind.Expense]: "Expense",
  [LedgerRecordKind.Income]: "Income",
  [LedgerRecordKind.Transfer]: "Transfer",
  [LedgerRecordKind.Payment]: "Payment",
  [LedgerRecordKind.OpeningBalance]: "Opening balance",
  [LedgerRecordKind.InvoiceIssue]: "Invoice",
  [LedgerRecordKind.Journal]: "Journal entry",
};

export const accountTypeEnum = makeEnum(AccountTypeLabels);
const canonicalAccountSubTypeEnum = makeEnum(AccountSubTypeLabels);
export const accountSubTypeEnum = {
  ...canonicalAccountSubTypeEnum,
  fromLabel(label: string | null | undefined): number | null {
    return label === "equipment"
      ? AccountSubType.FixedAsset
      : canonicalAccountSubTypeEnum.fromLabel(label);
  },
};
export const defaultAccountPurposeEnum = makeEnum(DefaultAccountPurposeLabels);
export const ledgerRecordKindEnum = makeEnum(LedgerRecordKindLabels);
