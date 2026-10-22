/**
 * Turns what was read off a document into the fields a reviewer checks: the
 * contact match, the exchange rate, the accounts the record starts on, the
 * category, and the duplicate warning.
 *
 * A receipt goes through this once, and each item of a document with several
 * items goes through it once per item, so a receipt card and an item show the
 * same kind of proposal worked out the same way (006 FR-007, FR-024).
 */

import {
  DefaultAccountPurpose,
  DocumentType,
  Role,
  isTransferType,
} from "$lib/enums.js";
import { getExchangeRate } from "../currency/rates.js";
import { mainCurrencyCode } from "../currency/form.js";
import type { LedgerDb } from "../ledger/types.js";
import { getAccount } from "../queries/accounts.js";
import { resolveContactCandidates } from "../queries/contacts.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import {
  categoryAccountForImport,
  categoryChoices,
  type CategoryChoice,
} from "./category-accounts.js";
import { isImportTransactionAsset } from "./account-policy.js";
import { detectDuplicate } from "./duplicate-detector.js";
import type { ReviewFields } from "./review-fields.js";

/** What was read off the document for one record. */
export interface ReadFields {
  /**
   * A DocumentType code: expense or income, or for an item of a profile's
   * transfer section a transfer out of or into the document's account.
   */
  documentType: number;
  itemName: string;
  /** The other party's name, whether it was paid or it paid. */
  supplier: string;
  amount: number;
  /** `YYYY-MM-DD`. */
  date: string;
  reference: string;
  currency: string;
  /** The reader's pick of category; it is checked against the user's list. */
  categoryAccountId: number | null;
  remark: string | null;
  /**
   * What the duplicate check may use besides the fields above. A receipt gives
   * all three. An item gives none: its document's file name and wording are
   * shared by every item, and by last month's document too, so they are no
   * evidence that one item was booked before (FR-025).
   */
  duplicateEvidence: {
    originalFilename: string | null;
    fileHash: string | null;
    extractedText: string | null;
    /**
     * True for an item read from a table's columns, or in Every transaction
     * mode by the AI: a record with a different reference of its own is then
     * never its duplicate (FR-063). Absent, as for a receipt, keeps the check
     * as it was.
     */
    referenceVeto?: boolean;
  };
  /**
   * The account the document is about, when its profile names one (FR-008,
   * FR-058): the item starts on it instead of on Accounts payable or
   * Accounts receivable, and a transfer has it as one side. Absent for a
   * receipt.
   */
  documentAccountId?: number | null;
  /** A transfer's other account, from its section. Absent otherwise. */
  counterAccountId?: number | null;
}

type ContactMatch = ReturnType<typeof resolveContactCandidates>;

/**
 * What stays the same for every record read from one document. Look-ups that
 * give the same answer for every item (an exchange rate for one date, a
 * contact for one name) are kept here, so a document of a hundred items on one
 * date asks for its rate once.
 */
export interface ReviewContext {
  mainCurrency: string;
  expenseChoices: CategoryChoice[];
  incomeChoices: CategoryChoice[];
  rates: Map<string, Promise<number | null>>;
  contacts: Map<string, ContactMatch>;
  /** Whether an account still holds money, by id; see `moneyAccount`. */
  moneyAccounts: Map<number, number | null>;
}

export function createReviewContext(db: LedgerDb): ReviewContext {
  return {
    mainCurrency: mainCurrencyCode(db),
    // The AI picks from the chart of accounts, so what it answers can be
    // matched straight back to an account on confirm (FR-006a).
    expenseChoices: categoryChoices(db, "expense"),
    incomeChoices: categoryChoices(db, "income"),
    rates: new Map(),
    contacts: new Map(),
    moneyAccounts: new Map(),
  };
}

function rateFor(
  db: LedgerDb,
  ctx: ReviewContext,
  currency: string,
  date: string,
): Promise<number | null> {
  if (currency === ctx.mainCurrency) return Promise.resolve(1);
  const key = `${currency}|${date}`;
  let rate = ctx.rates.get(key);
  if (!rate) {
    rate = getExchangeRate(db, {
      from: currency,
      to: ctx.mainCurrency,
      date,
    }).then((result) => result.rate);
    ctx.rates.set(key, rate);
  }
  return rate;
}

function contactFor(
  db: LedgerDb,
  ctx: ReviewContext,
  name: string,
  role: number,
): ContactMatch {
  const key = `${role}|${name}`;
  let match = ctx.contacts.get(key);
  if (!match) {
    match = resolveContactCandidates(db, name, role);
    ctx.contacts.set(key, match);
  }
  return match;
}

/**
 * The account, when it is still one that holds money and can take records,
 * else null. A profile's account may have been archived since it was saved.
 */
function moneyAccount(
  db: LedgerDb,
  ctx: ReviewContext,
  id: number | null | undefined,
): number | null {
  if (id == null) return null;
  let found = ctx.moneyAccounts.get(id);
  if (found === undefined) {
    const account = getAccount(db, id);
    found = account && isImportTransactionAsset(account) ? account.id : null;
    ctx.moneyAccounts.set(id, found);
  }
  return found;
}

/**
 * The review fields of a transfer item (FR-058): its two accounts, and no
 * other party, no category and no receipt duplicate check. Whether it repeats
 * a transfer already in the books is asked for the whole reading at once
 * (`detectTransferDuplicates`), because one transfer may flag one item only.
 */
async function transferReviewFields(
  db: LedgerDb,
  input: ReadFields,
  ctx: ReviewContext,
): Promise<ReviewFields> {
  const currency = input.currency.toUpperCase();
  return {
    // Deprecated review metadata is left empty; the source account defines payment.
    expensePaymentSource: null,
    supplierContactId: null,
    paidByContactId: null,
    documentType: input.documentType,
    itemName: input.itemName,
    supplier: null,
    matchedContactId: null,
    matchCandidates: null,
    date: input.date,
    amount: input.amount,
    currency,
    exchangeRate: await rateFor(db, ctx, currency, input.date),
    reference: input.reference,
    category: null,
    categoryAccountId: null,
    remark: input.remark,
    duplicateOf: null,
    duplicateConfidence: null,
    duplicateReasons: null,
    accountId: moneyAccount(db, ctx, input.documentAccountId),
    reviewNote: null,
    checkNote: null,
    counterAccountId: moneyAccount(db, ctx, input.counterAccountId),
  };
}

/** The review fields for one record read off a document. */
export async function buildReviewFields(
  db: LedgerDb,
  input: ReadFields,
  ctx: ReviewContext,
): Promise<ReviewFields> {
  const docType = input.documentType;
  if (isTransferType(docType)) return transferReviewFields(db, input, ctx);
  const isIncome = docType === DocumentType.Income;

  const dup = detectDuplicate(db, {
    originalFilename: input.duplicateEvidence.originalFilename,
    fileHash: input.duplicateEvidence.fileHash,
    itemName: input.itemName,
    supplier: input.supplier,
    amount: input.amount,
    date: input.date,
    reference: input.reference,
    extractedText: input.duplicateEvidence.extractedText,
    documentType: docType,
    referenceVeto: input.duplicateEvidence.referenceVeto,
  });

  // Contact resolution — deterministic backend step (the LLM is never given
  // the contact list). `supplier` always carries the other party's name,
  // whether it's who was paid (expense) or who paid (income) — only which
  // contact bucket to search (Supplier vs Customer) depends on the kind.
  const role = isIncome ? Role.Customer : Role.Supplier;
  const { matchedId, candidates } = contactFor(
    db,
    ctx,
    input.supplier ?? "",
    role,
  );

  // Resolve the exchange rate up front when the currency is foreign, so the
  // review card shows a converted preview. Left null when no API key or the
  // rate is unavailable — the reviewer then enters it by hand.
  const currency = input.currency.toUpperCase();
  const exchangeRate = await rateFor(db, ctx, currency, input.date);

  // An imported document proves an amount is owed, not that money moved.
  // Payment is a separate event, so imports always start on Payable/Receivable.
  const settlementDefault = requireAccountDefault(
    db,
    isIncome ? DefaultAccountPurpose.Receivable : DefaultAccountPurpose.Payable,
  );
  const categoryDefault = requireAccountDefault(
    db,
    isIncome
      ? DefaultAccountPurpose.UncategorisedIncome
      : DefaultAccountPurpose.UncategorisedExpense,
  );
  const kind = isIncome ? "income" : "expense";
  const choices = isIncome ? ctx.incomeChoices : ctx.expenseChoices;
  const categoryResult = categoryAccountForImport(
    kind,
    choices,
    input.categoryAccountId,
    categoryDefault.ok ? categoryDefault.value : null,
  );
  const categoryAccountId = categoryResult.ok
    ? categoryResult.value.accountId
    : null;
  const category =
    categoryAccountId == null
      ? null
      : (choices.find((choice) => choice.id === categoryAccountId)?.name ??
        null);

  return {
    // Deprecated review metadata is left empty; the source account defines payment.
    expensePaymentSource: null,
    supplierContactId: null,
    paidByContactId: null,
    documentType: docType,
    itemName: input.itemName,
    supplier: input.supplier,
    matchedContactId: matchedId,
    matchCandidates: candidates.length ? JSON.stringify(candidates) : null,
    date: input.date,
    amount: input.amount,
    currency,
    exchangeRate,
    reference: input.reference,
    category,
    categoryAccountId,
    remark: input.remark,
    duplicateOf: dup?.duplicateOf ?? null,
    duplicateConfidence: dup?.confidence ?? null,
    duplicateReasons: dup ? JSON.stringify(dup.reasons) : null,
    // The profile's own account when it names one that still holds money:
    // a wallet report is about money already in the wallet (FR-008).
    accountId:
      moneyAccount(db, ctx, input.documentAccountId) ??
      (settlementDefault.ok ? settlementDefault.value : null),
    // Only the reading of an item has anything to say here; see `itemFields`
    // in `process-job.ts`.
    reviewNote: null,
    checkNote: null,
    counterAccountId: null,
  };
}
