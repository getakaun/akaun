/**
 * What the dashboard loader hands the page, section by section (007).
 *
 * Kept outside `$lib/server` so the section components can name their props;
 * the loader in `$lib/server/loaders/dashboard.ts` builds these. Every amount
 * is whole cents of the main currency, already signed the way its report
 * shows it — nothing on the page flips a sign.
 */

export type Delta = {
  diffMinor: number;
  /** Change as a fraction of the comparison figure; null when that was 0. */
  pct: number | null;
};

export type MonthPoint = {
  key: string;
  label: string;
  from: string;
  to: string;
  incomeMinor: number;
  expensesMinor: number;
  resultMinor: number;
};

export type TopLine = {
  /** Null for the "Other" line that folds in the rest. */
  accountId: number | null;
  name: string;
  amountMinor: number;
  prevMinor: number;
};

export type PerformanceSection = {
  totalIncomeMinor: number;
  totalIncomePrevMinor: number;
  totalExpensesMinor: number;
  totalExpensesPrevMinor: number;
  resultMinor: number;
  resultPrevMinor: number;
  netMarginPct: number | null;
  netMarginPrevPct: number | null;
  months: MonthPoint[];
  topExpenses: TopLine[];
  topIncome: TopLine[];
  notes: string[];
};

export type CashBridge = {
  netProfitMinor: number;
  operatingMinor: number;
  investingMinor: number;
  freeCashFlowMinor: number;
  financingMinor: number;
  netChangeMinor: number;
  /** Movement on accounts not yet classified, kept out of the three sections. */
  needsReviewMinor: number;
};

export type CashSection = {
  onHandMinor: number;
  onHandPrevMinor: number;
  monthEnds: { key: string; label: string; asAt: string; cashMinor: number }[];
  /** Months the cash would last at the last three months' average fall; null unless falling. */
  runwayMonths: number | null;
  monthlyBurnMinor: number | null;
  bridge: CashBridge;
  ties: boolean;
};

export type PositionSection = {
  asAt: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  equityMinor: number;
  balances: boolean;
  differenceMinor: number;
  /** Asset and liability accounts not yet given a sub-type. */
  needsReviewCount: number;
};

export type AgeingBandView = { label: string; count: number; totalMinor: number };

export type OwedSide = {
  totalMinor: number;
  overdueMinor: number;
  overdueCount: number;
  /** Every band, empty ones included, freshest first. */
  bands: AgeingBandView[];
  top: { contactId: number; contactName: string; outstandingMinor: number }[];
};

export type OwedSection = {
  owedToUs: OwedSide;
  weOwe: OwedSide;
  /** Whether the top contacts may link to their contact page. */
  canOpenContacts: boolean;
};

export type QuotationPipeline = {
  openCount: number;
  openMinor: number;
  expiringSoonCount: number;
  acceptedCount: number;
  acceptedMinor: number;
};

export type InvoicePipeline = {
  unpaidCount: number;
  unpaidMinor: number;
  overdueCount: number;
  overdueMinor: number;
  issuedInPeriodCount: number;
  issuedInPeriodMinor: number;
};

export type PipelineSection = {
  quotations: QuotationPipeline | null;
  invoices: InvoicePipeline | null;
};

/** Where an attention item leads; the page turns it into a resolved route. */
export type AttentionTarget =
  | { screen: "balance-sheet"; asAt: string }
  | { screen: "import" }
  | { screen: "invoices" }
  | { screen: "unpaid-expenses" }
  | { screen: "reconcile"; accountId: number }
  | { screen: "accounts" };

export type AttentionItem = {
  key: string;
  label: string;
  detail: string;
  target: AttentionTarget;
  tone: "red" | "amber" | "neutral";
};

export type RecentItem = {
  id: number;
  date: string;
  kindLabel: string;
  description: string;
  contactName: string | null;
  amountMinor: number;
  /** Whether money came in or went out; "neutral" when it only moved. */
  direction: "in" | "out" | "neutral";
};
