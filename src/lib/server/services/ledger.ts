import { depreciationRecordReason } from "../queries/depreciation.js";
import { ExpenseTaxError } from "../queries/expense-tax.js";
import { assetRecordDeletionReason } from "../queries/fixed-assets.js";
import { closedPeriodReason } from "../closing/policy.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import {
  activeAllocation,
  allocationHistoryDeletionReason,
  ALLOCATION_HISTORY_EDIT_REASON,
} from "../queries/allocation-state.js";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  contacts,
  ledgerMovements,
  reconciliationAllocations,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  settlements,
} from "../db/schema.js";
import {
  listMovementAllocations,
  replaceMovementAllocations as replaceMovementAllocationsQuery,
} from "../queries/reconciliation.js";
import { reconciliationEvents } from "../reconciliation/events.js";
import { VOIDED_RECORD_REASON } from "../queries/void-state.js";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import { diffRecords, recordAudit } from "../audit.js";
import { buildMovements, buildReversal } from "../ledger/entry-builder.js";
import { ledgerEvents } from "../ledger/events.js";
import { canDeleteRecord, canEditField } from "../ledger/locking.js";
import { isReadOnlyKind } from "../ledger/record-permissions.js";
import { remainderMinor, toMinor } from "../ledger/money.js";
import type {
  BuildInput,
  BuildContext,
  LedgerDb,
  MovementDraft,
  RecordCreate,
  RecordPatch,
  RecordView,
  Refusable,
} from "../ledger/types.js";
import { accountRefs, getAccount } from "../queries/accounts.js";
import { sidesFromAccounts } from "../ledger/sides-from-accounts.js";
import {
  deleteRecord,
  getRecord,
  getRecordRow,
  insertRecord,
  kindCodeFor,
  lockStateFor,
  snapshotForAudit,
  updateRecord,
  wouldRemoveAllocationHistory,
} from "../queries/ledger.js";
import { getInvoice, invoiceIdsForLedgerRecords } from "../queries/invoices.js";
import { invoiceEvents } from "../finance/events.js";
import { touchAccounts } from "./accounts.js";
import { accountDefaultId, requireAccountDefault } from "./account-defaults.js";

/**
 * Creating, changing and removing a record.
 *
 * This is where the everyday description a screen sends — "an expense someone
 * else paid", "a withdrawal from the Shopee wallet" — becomes movements, by way
 * of `entry-builder.ts`, which is the only code allowed to construct them. The
 * service adds what a route must not do inline: the locking rules, the audit
 * entry, and the one emit that tells every open view something moved.
 */

/** Which accounts an input names, so the builder can check their roles. */
function accountIdsIn(sides: RecordCreate | BuildInput): number[] {
  switch (sides.kind) {
    case "reimbursement-transfer":
      return [sides.clearingAccountId];
    case "expense":
      return [sides.categoryAccountId, sides.paidFromAccountId ?? -1];
    case "income":
      return [sides.categoryAccountId, sides.receivedIntoAccountId];
    case "transfer":
      return [sides.fromAccountId, sides.toAccountId];
    case "payment":
      return [sides.paidFromAccountId];
    case "opening-balance":
      return [sides.accountId];
    case "invoice-issue":
      return [sides.incomeAccountId];
    case "journal":
      return sides.movements.map((m) => m.accountId);
  }
}

/** Gathers everything `buildMovements` needs, in one place. */
function contextFor(
  db: LedgerDb,
  sides: RecordCreate | BuildInput,
): Refusable<BuildContext> {
  const needsReceivable =
    sides.kind === "invoice-issue" ||
    (sides.kind === "payment" &&
      ["we-receive", "refund-paid"].includes(sides.direction));
  const needsPayable =
    sides.kind === "reimbursement-transfer" ||
    (sides.kind === "expense" && sides.paidFromAccountId == null) ||
    (sides.kind === "payment" &&
      ["we-pay", "refund-received"].includes(sides.direction));
  const needsOpening = sides.kind === "opening-balance";
  const personal =
    sides.kind === "expense" && sides.expensePaymentSource === "personal";
  const reimbursements = personal
    ? requireAccountDefault(db, DefaultAccountPurpose.ReimbursementsPayable)
    : ({
        ok: true,
        value:
          accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable) ??
          0,
      } as const);
  if (!reimbursements.ok) return reimbursements;
  if (sides.kind === "payment" && sides.settlementAccountId !== undefined) {
    const allowed = ["we-pay", "refund-received"].includes(sides.direction)
      ? [
          accountDefaultId(db, DefaultAccountPurpose.Payable),
          accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable),
        ]
      : [accountDefaultId(db, DefaultAccountPurpose.Receivable)];
    if (!allowed.includes(sides.settlementAccountId))
      return {
        ok: false,
        reason: "Choose the saved payable account for this payment direction.",
      };
    const selected = getAccount(db, sides.settlementAccountId);
    if (!selected || selected.archivedAt !== null)
      return {
        ok: false,
        reason: "The selected settlement account is no longer active.",
      };
  }

  const resolve = (
    needed: boolean,
    purpose: Parameters<typeof requireAccountDefault>[1],
  ) =>
    needed
      ? requireAccountDefault(db, purpose)
      : ({ ok: true, value: 0 } as const);
  const receivable = resolve(needsReceivable, DefaultAccountPurpose.Receivable);
  if (!receivable.ok) return receivable;
  const payable = resolve(needsPayable, DefaultAccountPurpose.Payable);
  if (!payable.ok) return payable;
  const openingBalances = resolve(
    needsOpening,
    DefaultAccountPurpose.OpeningBalances,
  );
  if (!openingBalances.ok) return openingBalances;

  return {
    ok: true,
    value: {
      accounts: accountRefs(db, [
        ...accountIdsIn(sides),
        ...(reimbursements.value ? [reimbursements.value] : []),
        ...(sides.kind === "payment" && sides.settlementAccountId
          ? [sides.settlementAccountId]
          : []),
        ...(needsReceivable ? [receivable.value] : []),
        ...(needsPayable ? [payable.value] : []),
        ...(needsOpening ? [openingBalances.value] : []),
      ]),
      receivableAccountId: receivable.value,
      payableAccountId: payable.value,
      reimbursementPayableAccountId: reimbursements.value || undefined,
      openingBalancesAccountId: openingBalances.value,
    },
  };
}

function emitRecord(db: LedgerDb, id: number): RecordView | null {
  const record = getRecord(db, id);
  if (record) {
    if (
      !db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, id))
        .get()
    )
      ledgerEvents.emit("record-update", { record });
    // An account's balance is the sum of its movements, so a record write moves
    // every account it touched — the accounts screen has to hear about it too.
    touchAccounts(
      db,
      record.movements.map((m) => m.accountId),
    );
  }
  return record;
}

/**
 * Emits a caller holds back until its own transaction commits.
 *
 * An emit tells every open tab that something was saved. Sent from inside a
 * transaction, it would reach them before the save is final, and a rollback
 * afterwards would leave them showing a record that was never kept. A caller
 * that wraps `createRecord` in a transaction passes an empty list, and runs
 * each entry once the transaction has committed. When it rolls back, the
 * caller drops the list and nothing is sent.
 */
export type DeferredEmits = (() => void)[];

export function createRecord(
  ...args: Parameters<typeof createRecordInTransaction>
): Refusable<RecordView> {
  const [db, actingUserId, data, deferredEmits, auditUserId] = args;
  const pending: DeferredEmits = [];
  try {
    const result = db.transaction(
      (tx) =>
        createRecordInTransaction(tx, actingUserId, data, pending, auditUserId),
      { behavior: "immediate" },
    );
    if (result.ok) {
      if (deferredEmits) deferredEmits.push(...pending);
      else for (const emit of pending) emit();
    }
    return result;
  } catch (error) {
    // A compound caller must roll back its earlier writes as well.
    const reason =
      closedPeriodReason(error) ??
      (error instanceof ExpenseTaxError ? error.message : null);
    if (deferredEmits || !reason) throw error;
    return { ok: false, reason };
  }
}

function createRecordInTransaction(
  db: LedgerDb,
  actingUserId: number,
  data: RecordCreate & {
    /** Supplied only by the upgrade — see queries/ledger.ts. */
    id?: number;
    legacyKind?: "expense" | "income" | "claim" | null;
    legacyId?: number | null;
  },
  deferredEmits?: DeferredEmits,
  /**
   * Who the audit trail names, when that is not the record's owner. An import
   * is confirmed by one person into a record owned by whoever uploaded the
   * document; the trail should say who confirmed it.
   */
  auditUserId?: number,
): Refusable<RecordView> {
  const expenseLike =
    data.kind === "expense" ||
    (data.kind === "journal" && data.storedKind === LedgerRecordKind.Expense);
  if (
    data.paidByContactId !== undefined &&
    data.expensePaymentSource !== "personal"
  )
    return {
      ok: false,
      reason: "Paid personally by applies only to personally paid expenses.",
    };
  if (data.expensePaymentSource && !expenseLike)
    return {
      ok: false,
      reason: "Payment source is only available for expenses.",
    };
  if (expenseLike && data.expensePaymentSource === "personal") {
    const payer = data.paidByContactId ?? data.contactId;
    if (
      !payer ||
      !db.select().from(contacts).where(eq(contacts.id, payer)).get()
    )
      return {
        ok: false,
        reason: "Select who paid personally before saving this expense.",
      };
    data = { ...data, contactId: payer };
    if (data.kind === "expense" && data.paidFromAccountId !== null)
      return {
        ok: false,
        reason:
          "A personally paid expense cannot also use a company payment account.",
      };
  }
  if (
    expenseLike &&
    (data.expensePaymentSource === "company" ||
      data.expensePaymentSource === "unpaid") &&
    data.supplierContactId
  )
    data = { ...data, contactId: data.supplierContactId };
  if (
    data.supplierContactId &&
    !db
      .select()
      .from(contacts)
      .where(eq(contacts.id, data.supplierContactId))
      .get()
  )
    return { ok: false, reason: "Select an existing supplier." };
  if (
    data.kind === "expense" &&
    data.expensePaymentSource === "company" &&
    (!data.paidFromAccountId ||
      !isMoneyPotAccountFor(db, data.paidFromAccountId))
  )
    return {
      ok: false,
      reason: "Select the company account that paid this expense.",
    };
  if (
    data.kind === "expense" &&
    data.expensePaymentSource === "unpaid" &&
    data.paidFromAccountId !== null
  )
    return {
      ok: false,
      reason: "An unpaid supplier bill cannot use a company payment account.",
    };
  // A foreign currency is offered on an expense or income only — see
  // `RecordForm.svelte`'s `looksLikeExpenseOrIncome` — and on an invoice, whose
  // issue posting carries the invoice's own currency and rate so the amount
  // owed is `toMinor(total, rate)`. Checked here, the one choke point every
  // caller passes through (the records API, auto-import, reconciliation's
  // transfer action, `services/invoices.ts`), rather than in each route
  // (FR-031c's pattern: enforced on the server, never by hiding a control on
  // just one of them). A rate other than 1 is what "foreign" means on a record
  // — a main-currency one is always sent with `exchangeRate: 1` — so that alone
  // is the signal, with no need to know the main currency itself.
  //
  // The customer's payment is recorded in the main currency at that day's rate.
  // When it differs from the invoice's rate the settlement leaves a few cents
  // either way; there is no exchange gain/loss account to put them in.
  if (
    data.kind !== "expense" &&
    data.kind !== "income" &&
    data.kind !== "invoice-issue" &&
    data.exchangeRate !== 1
  ) {
    return {
      ok: false,
      reason:
        "Only expense, income and invoice records can be recorded in another currency.",
    };
  }

  if (data.kind === "payment" && data.contactId == null)
    return { ok: false, reason: "Select the payer or payee for this payment." };

  const amountMinor = toMinor(data.amount, data.exchangeRate);

  const context = contextFor(db, data);
  if (!context.ok) return context;
  const built = buildMovements(
    { ...data, amountMinor } as BuildInput,
    context.value,
  );
  if (!built.ok) return built;

  const row = insertRecord(
    db,
    actingUserId,
    {
      // A journal-shaped record that is really an everyday purchase or sale
      // says so, so ordinary spending is not filed under the heading reserved
      // for corrections (see `storedKind` in ledger/types.ts).
      kind:
        data.kind === "journal" && data.storedKind !== undefined
          ? data.storedKind
          : kindCodeFor(data.kind),
      date: data.date,
      taxOverrides: data.taxOverrides,
      taxActorId: auditUserId ?? actingUserId,
      description: data.description,
      amount: data.amount,
      currency: data.currency,
      exchangeRate: data.exchangeRate,
      contactId: data.contactId ?? null,
      supplierContactId: data.supplierContactId ?? null,
      expensePaymentSource: data.expensePaymentSource ?? null,
      reference: data.reference,
      remark: data.remark,
      extractedText: data.extractedText,
      recordNumber: data.recordNumber,
      id: data.id,
      legacyKind: data.legacyKind,
      legacyId: data.legacyId,
    },
    built.value,
  );

  recordAudit(db, {
    recordType: "record",
    recordId: row.id,
    userId: auditUserId ?? actingUserId,
    action: "create",
    changes: [
      {
        field: "movements",
        before: null,
        after: snapshotForAudit(db, row.id)?.movements,
      },
    ],
  });

  if (deferredEmits) {
    // Read now, emit later: by the time the caller runs this, the record may
    // have more on it (an attachment), and the emit reads it again then.
    deferredEmits.push(() => emitRecord(db, row.id));
    return { ok: true, value: getRecord(db, row.id)! };
  }
  return { ok: true, value: emitRecord(db, row.id)! };
}

/**
 * Changes a record.
 *
 * A record whose money has already been settled or matched to a bank line
 * refuses its amount, its date and any account, and says what to undo first;
 * what it *says* stays editable, because correcting a description cannot make
 * another record wrong (FR-017a).
 */
export function patchRecord(
  db: LedgerDb,
  id: number,
  actingUserId: number,
  patch: RecordPatch,
): Refusable<RecordView> {
  const pending: DeferredEmits = [];
  try {
    const result = db.transaction(
      (tx) => patchRecordInTransaction(tx, id, actingUserId, patch, pending),
      { behavior: "immediate" },
    );
    if (result.ok) for (const emit of pending) emit();
    return result;
  } catch (error) {
    const reason =
      closedPeriodReason(error) ??
      (error instanceof ExpenseTaxError ? error.message : null);
    if (!reason) throw error;
    return { ok: false, reason };
  }
}

/** Caller owns the write transaction and flushes events only after commit. */
export function patchRecordInTransaction(
  db: LedgerDb,
  id: number,
  actingUserId: number,
  patch: RecordPatch,
  deferredEmits: DeferredEmits,
  taxReviewBatch?: { id: string; movementIds: number[] },
): Refusable<RecordView> {
  const depreciationReason = depreciationRecordReason(db, id);
  if (depreciationReason) return { ok: false, reason: depreciationReason };
  if (
    db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return {
      ok: false,
      reason:
        "Reimbursement transfer entries are read-only. Correct the reimbursement payment instead.",
    };
  const existing = getRecord(db, id);
  if (!existing) return { ok: false, reason: "That record no longer exists." };
  if (existing.voidedByRecordId !== null || existing.reversesRecordId !== null)
    return { ok: false, reason: VOIDED_RECORD_REASON };
  const effectiveSource =
    patch.expensePaymentSource !== undefined
      ? patch.expensePaymentSource
      : existing.expensePaymentSource;
  if (existing.expensePaymentSource && patch.expensePaymentSource === null)
    return {
      ok: false,
      reason:
        "Choose how this expense was paid instead of clearing its payment source.",
    };
  if (patch.paidByContactId !== undefined && effectiveSource !== "personal")
    return {
      ok: false,
      reason: "Paid personally by applies only to personally paid expenses.",
    };
  if (
    patch.supplierContactId &&
    (effectiveSource === "company" || effectiveSource === "unpaid")
  )
    patch = { ...patch, contactId: patch.supplierContactId };

  // Who a payment names — one contact, or none because its settlements each
  // point at their own — is decided once, at creation. `contactId` is not a
  // money field, so an ordinary patch never rebuilds movements to re-check it;
  // without this, a change to it could silently turn a batch payment into a
  // single-contact one (or the reverse) with no re-validation at all. The
  // form resends the unchanged value on every save, so only an actual change
  // is refused here.
  if (
    existing.kind === LedgerRecordKind.Payment &&
    patch.contactId !== undefined &&
    patch.contactId !== existing.contactId
  ) {
    return {
      ok: false,
      reason:
        "A payment's contact cannot be changed by an ordinary edit. For an outgoing payment, use Correct payee instead.",
    };
  }

  if (patch.paidByContactId !== undefined)
    patch = { ...patch, contactId: patch.paidByContactId };
  if (patch.expensePaymentSource && existing.kind !== LedgerRecordKind.Expense)
    return {
      ok: false,
      reason: "Payment source is only available for expenses.",
    };
  if (
    patch.supplierContactId &&
    !db
      .select()
      .from(contacts)
      .where(eq(contacts.id, patch.supplierContactId))
      .get()
  )
    return { ok: false, reason: "Select an existing supplier." };
  const lock = lockStateFor(db, id);
  if (
    existing.kind === LedgerRecordKind.Expense &&
    (lock.settled || lock.reconciled) &&
    ((patch.contactId !== undefined &&
      patch.contactId !== existing.contactId) ||
      (patch.supplierContactId !== undefined &&
        patch.supplierContactId !== existing.supplierContactId))
  ) {
    return {
      ok: false,
      reason:
        "Use Correct contact with the required permission to correct a paid or reconciled expense contact.",
    };
  }
  if (
    lock.settled &&
    patch.contactId !== undefined &&
    patch.contactId !== existing.contactId
  ) {
    return {
      ok: false,
      reason:
        "Reverse the active allocations before changing this record's contact.",
    };
  }
  for (const field of Object.keys(patch) as (keyof RecordPatch)[]) {
    if (patch[field] === undefined) continue;
    if (
      field === "expensePaymentSource" &&
      patch.expensePaymentSource === existing.expensePaymentSource
    )
      continue;
    if (
      field === "paidByContactId" &&
      patch.paidByContactId === existing.contactId
    )
      continue;
    if (!canEditField(field, lock)) {
      return {
        ok: false,
        reason: existing.lockedReason ?? "That cannot be changed.",
      };
    }
  }

  if (effectiveSource === "personal") {
    const payer =
      patch.contactId !== undefined ? patch.contactId : existing.contactId;
    if (
      !payer ||
      !db.select().from(contacts).where(eq(contacts.id, payer)).get()
    )
      return { ok: false, reason: "Select the person who paid personally." };
  }
  const before = snapshotForAudit(db, id);

  // Any change to what the money did means rebuilding the sides from scratch —
  // there is no partial edit of a movement, because the balance rule is a
  // property of the whole set.
  const rebuild = touchesMoney({
    ...patch,
    expensePaymentSource:
      patch.expensePaymentSource === existing.expensePaymentSource
        ? undefined
        : patch.expensePaymentSource,
  });
  let movements: MovementDraft[] | undefined;

  if (rebuild) {
    const sides = sidesFor(db, existing, patch);
    if (!sides.ok) return sides;
    const amount = patch.amount ?? existing.amount;
    const exchangeRate = patch.exchangeRate ?? existing.exchangeRate;
    // Both accounts named means the kind is re-derived (see `sidesFor`), so the
    // currency gate is checked against what it is *becoming*, not what it was
    // — an expense turned transfer cannot keep a foreign figure just because
    // it had one a moment ago. A rate other than 1 is what "foreign" means on
    // a record (a main-currency one is always sent with `exchangeRate: 1`).
    if (
      sides.value.kind !== "expense" &&
      sides.value.kind !== "income" &&
      exchangeRate !== 1
    ) {
      return {
        ok: false,
        reason:
          "Only expense and income records can be recorded in another currency.",
      };
    }
    if (
      sides.value.kind === "expense" &&
      ["personal", "unpaid"].includes(effectiveSource ?? "") &&
      sides.value.paidFromAccountId !== null
    )
      return {
        ok: false,
        reason: "Change the payment source before choosing a company account.",
      };
    if (
      sides.value.kind === "expense" &&
      effectiveSource === "company" &&
      sides.value.paidFromAccountId === null
    )
      return {
        ok: false,
        reason: "Select the company account that paid this expense.",
      };
    const context = contextFor(db, sides.value);
    if (!context.ok) return context;
    const built = buildMovements(
      {
        ...sides.value,
        amountMinor: toMinor(amount, exchangeRate),
        contactId:
          patch.contactId !== undefined ? patch.contactId : existing.contactId,
      } as BuildInput,
      context.value,
    );
    if (!built.ok) return built;
    movements = built.value;
  } else if (
    patch.exchangeRate !== undefined &&
    patch.exchangeRate !== 1 &&
    existing.kind !== LedgerRecordKind.Expense &&
    existing.kind !== LedgerRecordKind.Income
  ) {
    return {
      ok: false,
      reason:
        "Only expense and income records can be recorded in another currency.",
    };
  }

  if (movements && wouldRemoveAllocationHistory(db, id, movements))
    return { ok: false, reason: ALLOCATION_HISTORY_EDIT_REASON };

  updateRecord(
    db,
    id,
    actingUserId,
    {
      date: patch.date,
      taxOverrides: patch.taxOverrides,
      description: patch.description,
      amount: patch.amount,
      currency: patch.currency,
      exchangeRate: patch.exchangeRate,
      contactId: patch.contactId,
      supplierContactId: patch.supplierContactId,
      expensePaymentSource: patch.expensePaymentSource,
      reference: patch.reference,
      remark: patch.remark,
    },
    movements,
  );

  recordAudit(db, {
    recordType: "record",
    recordId: id,
    userId: actingUserId,
    action: "update",
    changes: [
      ...diffRecords(before, snapshotForAudit(db, id)),
      ...(taxReviewBatch
        ? [{ field: "taxReviewBatch", before: null, after: taxReviewBatch }]
        : []),
    ],
    deferredEmits,
  });

  const updated = getRecord(db, id)!;
  deferredEmits.push(() => {
    emitRecord(db, id);
    // The accounts it moved away from need their balances refreshed too.
    touchAccounts(
      db,
      existing.movements.map((m) => m.accountId),
    );
  });
  return { ok: true, value: updated };
}

const MONEY_FIELDS: (keyof RecordPatch)[] = [
  "amount",
  "expensePaymentSource",
  "exchangeRate",
  "categoryAccountId",
  "paidFromAccountId",
  "receivedIntoAccountId",
  "fromAccountId",
  "toAccountId",
  "extraSides",
];

function touchesMoney(patch: RecordPatch): boolean {
  return MONEY_FIELDS.some((f) => patch[f] !== undefined);
}

/**
 * The sides a patched record should be rebuilt from: what the patch says where
 * it says anything, and what the record already does where it does not.
 *
 * Reading the existing sides back out of the movements — rather than storing
 * them a second time on the record — is what keeps the movements the single
 * account of where the money went.
 */
function sidesFor(
  db: LedgerDb,
  existing: RecordView,
  patch: RecordPatch,
): Refusable<RecordCreate> {
  const base = {
    date: patch.date ?? existing.date,
    description: patch.description ?? existing.description,
    amount: patch.amount ?? existing.amount,
    currency: patch.currency ?? existing.currency,
    exchangeRate: patch.exchangeRate ?? existing.exchangeRate,
    expensePaymentSource:
      patch.expensePaymentSource !== undefined
        ? patch.expensePaymentSource
        : existing.expensePaymentSource,
  };

  // Both accounts named means the user re-answered the two questions the form
  // asks, so the kind is derived again from scratch — an expense whose paying
  // side becomes another bank account really is a transfer now, and keeping the
  // old kind would file it under a heading that is no longer true (FR-012).
  //
  // The `adjustments` gate is applied by the route before this runs; the
  // derivation is pure, so asking it twice gives the same answer.
  if (patch.fromAccountId !== undefined && patch.toAccountId !== undefined) {
    const receivable = requireAccountDefault(
      db,
      DefaultAccountPurpose.Receivable,
    );
    if (!receivable.ok) return receivable;
    const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
    if (!payable.ok) return payable;
    const opening = requireAccountDefault(
      db,
      DefaultAccountPurpose.OpeningBalances,
    );
    if (!opening.ok) return opening;
    const derived = sidesFromAccounts(
      {
        fromAccountId: patch.fromAccountId,
        toAccountId: patch.toAccountId,
        amountMinor: toMinor(base.amount, base.exchangeRate),
        contactId:
          patch.contactId !== undefined ? patch.contactId : existing.contactId,
        extraSides: patch.extraSides,
        categoryAmountMinor: patch.categoryAmountMinor,
        categoryLabel: patch.categoryLabel,
      },
      {
        accountById: (id) => {
          const account = getAccount(db, id);
          return account
            ? {
                id: account.id,
                type: account.type,
                role: account.role,
                subType: account.subType,
                archived: account.archivedAt !== null,
              }
            : null;
        },
        canAdjust: true,
        receivableAccountId: receivable.value,
        payableAccountId: payable.value,
        reimbursementPayableAccountId:
          accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable) ??
          undefined,
        openingBalancesAccountId: opening.value,
      },
    );
    if (!derived.ok) return derived;
    return {
      ok: true,
      value: {
        ...base,
        ...derived.value,
        expensePaymentSource: base.expensePaymentSource,
      },
    };
  }

  const into = existing.movements.find((m) => m.amountMinor > 0);
  const outOf = existing.movements.find((m) => m.amountMinor < 0);
  if (!into || !outOf) {
    return {
      ok: false,
      reason:
        "This record's sides cannot be worked out automatically. Edit it on the journal screen instead.",
    };
  }

  // A bill that spans more than one category is handled here — restating the
  // primary category, adding or resizing its extra lines, or dropping back to
  // one, all without needing both accounts named (which the branch above
  // handles instead, and is the only patch this record's money side ever
  // refuses). Locked or not: a settlement or a bank match points at the money
  // side, never a category, so splitting what an already-settled record was
  // *for* into more than one line is exactly as safe as correcting its one
  // category already was (`locking.ts`'s `LOCKED_FIELDS`).
  const extraMovements = existing.movements.filter(
    (m) => m !== into && m !== outOf,
  );
  const extraSides =
    patch.extraSides ??
    extraMovements.map((m) => ({
      accountId: m.accountId,
      amountMinor: m.amountMinor,
      label: m.label,
    }));
  if (
    extraSides.length > 0 &&
    patch.amount === undefined &&
    patch.exchangeRate === undefined &&
    (existing.kind === LedgerRecordKind.Expense ||
      existing.kind === LedgerRecordKind.Income)
  ) {
    const isExpense = existing.kind === LedgerRecordKind.Expense;
    let moneyAccountId: number;
    if (isExpense && patch.paidFromAccountId === null) {
      const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
      if (!payable.ok) return payable;
      moneyAccountId = payable.value;
    } else if (isExpense) {
      moneyAccountId = patch.paidFromAccountId ?? outOf.accountId;
    } else {
      moneyAccountId = patch.receivedIntoAccountId ?? into.accountId;
    }
    const categoryAccountId =
      patch.categoryAccountId ?? (isExpense ? into.accountId : outOf.accountId);
    const moneyMovement = isExpense ? outOf : into;
    const primaryCategoryMovement = isExpense ? into : outOf;

    // The named category's own typed figure, when given — same convention as
    // `sides-from-accounts.ts`'s `levelPrimarySide`: whether it actually
    // cancels with the money side and the extras is `buildMovements`'s
    // zero-sum check below, not a rule enforced here. Absent it, the money
    // side never moves, so the total it names is what the category lines
    // must add up to, and that much is worth refusing early with a clearer
    // reason than "does not cancel out".
    let categoryMagnitude: number;
    if (patch.categoryAmountMinor !== undefined) {
      categoryMagnitude = Math.abs(patch.categoryAmountMinor);
    } else {
      categoryMagnitude = remainderMinor(
        Math.abs(moneyMovement.amountMinor),
        extraSides.map((side) => side.amountMinor),
      );
      if (categoryMagnitude <= 0) {
        return {
          ok: false,
          reason:
            "The other lines already account for the whole amount, or more of it. Reduce them, or increase the total.",
        };
      }
    }

    // Preserved when the patch doesn't explicitly restate it — same
    // convention as `categoryAccountId`/`paidFromAccountId` above, so editing
    // something unrelated (the date, the description) never silently drops a
    // label the user already set.
    const categoryLabel =
      patch.categoryLabel !== undefined
        ? patch.categoryLabel
        : primaryCategoryMovement.label;

    const moneyValue = {
      accountId: moneyAccountId,
      amountMinor: moneyMovement.amountMinor,
      label: moneyMovement.label,
    };
    const primaryCategoryValue = {
      accountId: categoryAccountId,
      amountMinor: isExpense ? categoryMagnitude : -categoryMagnitude,
      label: categoryLabel,
    };
    // `replaceMovements` (queries/ledger.ts) matches an existing row to a new
    // one by position, not by account — so the money movement has to land
    // back in the same slot it already occupies, or the settlement/bank match
    // that points at its id would end up pointing at the category's row
    // instead. Which position that is depends on how the record was first
    // built: `expense`/`income` puts the category first, a split built
    // through `extraSides` puts the money side first.
    const moneyGoesFirst =
      existing.movements.indexOf(moneyMovement) <
      existing.movements.indexOf(primaryCategoryMovement);
    const namedPair = moneyGoesFirst
      ? [moneyValue, primaryCategoryValue]
      : [primaryCategoryValue, moneyValue];

    return {
      ok: true,
      value: {
        ...base,
        kind: "journal",
        movements: [...namedPair, ...extraSides],
        storedKind: existing.kind,
      },
    };
  }

  switch (existing.kind) {
    case LedgerRecordKind.Expense:
      return {
        ok: true,
        value: {
          ...base,
          kind: "expense",
          categoryAccountId: patch.categoryAccountId ?? into.accountId,
          paidFromAccountId: ["personal", "unpaid"].includes(
            patch.expensePaymentSource ?? existing.expensePaymentSource ?? "",
          )
            ? null
            : patch.paidFromAccountId !== undefined
              ? patch.paidFromAccountId
              : outOf.accountId,
        },
      };
    case LedgerRecordKind.Income:
      return {
        ok: true,
        value: {
          ...base,
          kind: "income",
          categoryAccountId: patch.categoryAccountId ?? outOf.accountId,
          receivedIntoAccountId: patch.receivedIntoAccountId ?? into.accountId,
        },
      };
    case LedgerRecordKind.Transfer:
      return {
        ok: true,
        value: {
          ...base,
          kind: "transfer",
          fromAccountId: patch.fromAccountId ?? outOf.accountId,
          toAccountId: patch.toAccountId ?? into.accountId,
        },
      };
    default:
      return {
        ok: false,
        reason:
          "The amount and accounts on this kind of record cannot be changed after it is created. Delete it and record it again.",
      };
  }
}

/**
 * Removes a record and both of its sides.
 *
 * An invoice's issue posting is refused: it is the invoice's to remove, when the
 * invoice is voided, and deleting it from the records side would leave a sent
 * invoice with nothing owed behind it. `allowReadOnlyKind` is for voiding the
 * invoice itself, and `deferredEmits` for a caller running this inside its own
 * transaction (see `DeferredEmits`).
 */
export function removeRecord(
  ...args: Parameters<typeof removeRecordInTransaction>
): Refusable<null> {
  const [db, id, actingUserId, opts = {}] = args;
  const pending: DeferredEmits = [];
  try {
    const result = db.transaction(
      (tx) =>
        removeRecordInTransaction(tx, id, actingUserId, {
          ...opts,
          deferredEmits: pending,
        }),
      { behavior: "immediate" },
    );
    if (result.ok) {
      if (opts.deferredEmits) opts.deferredEmits.push(...pending);
      else for (const emit of pending) emit();
    }
    return result;
  } catch (error) {
    const reason = closedPeriodReason(error);
    if (opts.deferredEmits || !reason) throw error;
    return { ok: false, reason };
  }
}

function removeRecordInTransaction(
  db: LedgerDb,
  id: number,
  actingUserId: number,
  opts: { allowReadOnlyKind?: boolean; deferredEmits?: DeferredEmits } = {},
): Refusable<null> {
  const depreciationReason = depreciationRecordReason(db, id);
  if (depreciationReason) return { ok: false, reason: depreciationReason };
  if (
    db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return {
      ok: false,
      reason:
        "Reimbursement transfer entries are read-only. Correct the reimbursement payment instead.",
    };
  const existing = getRecord(db, id);
  if (!existing) return { ok: false, reason: "That record no longer exists." };
  // A void is final: deleting the reversal would bring the original back, and
  // the original cannot go while its reversal points at it.
  if (existing.voidedByRecordId !== null || existing.reversesRecordId !== null)
    return { ok: false, reason: VOIDED_RECORD_REASON };

  if (isReadOnlyKind(existing.kind) && !opts.allowReadOnlyKind) {
    return {
      ok: false,
      reason:
        "This record was created by issuing an invoice. Cancel the invoice instead.",
    };
  }

  const allowed = canDeleteRecord(lockStateFor(db, id));
  if (!allowed.ok) return allowed;
  const historyReason = allocationHistoryDeletionReason(db, id);
  if (historyReason) return { ok: false, reason: historyReason };

  const assetReason = assetRecordDeletionReason(db, id);
  if (assetReason) return { ok: false, reason: assetReason };

  const before = snapshotForAudit(db, id);
  const touched = existing.movements.map((m) => m.accountId);

  if (!deleteRecord(db, id)) {
    return { ok: false, reason: "That record no longer exists." };
  }

  recordAudit(db, {
    recordType: "record",
    recordId: id,
    userId: actingUserId,
    action: "delete",
    changes: diffRecords(before, null),
  });
  const emit = () => {
    ledgerEvents.emit("record-deleted", { id });
    touchAccounts(db, touched);
  };
  if (opts.deferredEmits) opts.deferredEmits.push(emit);
  else emit();
  return { ok: true, value: null };
}

/**
 * Why this record cannot be voided right now, or null when it can.
 *
 * A void means "this never happened", so nothing else may still rely on the
 * record: no active payment allocation, no bank line, no reimbursement group.
 * Reversed allocations are fine — they are history, and the void keeps it.
 * The month-close boundary is checked by `insertRecord` when the reversal is
 * written, because the reversal carries the original's date.
 */
export function voidRefusal(
  db: LedgerDb,
  id: number,
  release: VoidRelease = "none",
): string | null {
  const depreciationReason = depreciationRecordReason(db, id);
  if (depreciationReason) return depreciationReason;
  const existing = getRecord(db, id);
  if (!existing) return "That record no longer exists.";
  if (existing.reversesRecordId !== null)
    return "This is the reversal of a voided record. A void is final.";
  if (existing.voidedByRecordId !== null)
    return "This record is already voided.";
  if (
    db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return "Reimbursement transfer entries are read-only. Correct the reimbursement payment instead.";
  if (existing.kind === LedgerRecordKind.InvoiceIssue)
    return "This record was created by issuing an invoice. Void the invoice instead.";
  if (existing.kind === LedgerRecordKind.OpeningBalance)
    return "Change the opening balance from its account instead.";
  if (inActiveReimbursementGroup(db, id))
    return "This record is part of a reimbursement. Take it out with Correct allocation, or reverse the reimbursement, before you void it.";
  const lock = lockStateFor(db, id);
  if (release === "none") {
    if (lock.settled && lock.reconciled)
      return "This record is settled by a payment and reconciled to a bank statement line. Reverse the allocation and unmatch the bank statement line before you void it.";
    if (lock.settled)
      return "This record is settled by a payment. Reverse the allocation (Correct allocation) before you void it.";
    if (lock.reconciled)
      return "This record is reconciled to a bank statement line. Unmatch it from that line before you void it.";
    return null;
  }
  // Releasing the allocations reverses each one on its own. A payment that
  // names nobody must stay fully allocated, so reversing one of its rows
  // reverses all of them — including the ones on other records. That is a
  // correction of the payment, never a side effect of voiding this record.
  for (const allocation of voidReleasePlan(db, id).allocations) {
    const other = getRecordRow(db, allocation.otherRecordId);
    if (
      db
        .select({ id: reimbursementEntries.recordId })
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, allocation.otherRecordId))
        .get()
    )
      return "This record is settled through a reimbursement transfer. Correct the reimbursement first, then void the record.";
    if (allocation.side === "owed" && other && other.contactId === null)
      return `This record is settled by ${other.recordNumber ?? "a payment"}, which covers several contacts. Correct that payment's allocations first, then void the record.`;
  }
  if (lock.reconciled && release !== "all")
    return "This record is reconciled to a bank statement line. Unmatch it from that line, or release its bank matches as well, before you void it.";
  return null;
}

/**
 * What releasing a record before its void would undo, or nothing.
 *
 * `"allocations"` reverses every active allocation in which this record is the
 * owed side or the paying side; the reversed rows stay as history, exactly as
 * Correct allocation leaves them. `"all"` also removes the bank lines matched
 * to its movements. Every other reason a record cannot be voided still holds.
 */
export type VoidRelease = "none" | "allocations" | "all";

export type VoidReleasePlan = {
  allocations: {
    settlementId: number;
    /** Which side of the allocation this record is. */
    side: "owed" | "payment";
    paymentMovementId: number;
    owedMovementId: number;
    /** The record on the other side of it. */
    otherRecordId: number;
    amountMinor: number;
  }[];
  bankMatches: {
    movementId: number;
    lineId: number;
    /** Decimal, as the statement line stores it. */
    amount: number;
  }[];
};

/** Every active allocation and bank match on this record's movements, oldest first. */
export function voidReleasePlan(db: LedgerDb, id: number): VoidReleasePlan {
  const movementIds = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, id))
    .all()
    .map((m) => m.id);
  if (!movementIds.length) return { allocations: [], bankMatches: [] };
  const own = new Set(movementIds);
  const rows = db
    .select()
    .from(settlements)
    .where(
      and(
        activeAllocation(),
        or(
          inArray(settlements.owedMovementId, movementIds),
          inArray(settlements.paymentMovementId, movementIds),
        ),
      ),
    )
    .orderBy(asc(settlements.id))
    .all();
  const otherIds = rows.map((r) =>
    own.has(r.owedMovementId) ? r.paymentMovementId : r.owedMovementId,
  );
  const owner = new Map(
    (otherIds.length
      ? db
          .select({
            id: ledgerMovements.id,
            recordId: ledgerMovements.recordId,
          })
          .from(ledgerMovements)
          .where(inArray(ledgerMovements.id, otherIds))
          .all()
      : []
    ).map((m) => [m.id, m.recordId]),
  );
  return {
    allocations: rows.map((row, i) => ({
      settlementId: row.id,
      side: own.has(row.owedMovementId) ? "owed" : "payment",
      paymentMovementId: row.paymentMovementId,
      owedMovementId: row.owedMovementId,
      otherRecordId: owner.get(otherIds[i]) ?? id,
      amountMinor: row.amountMinor,
    })),
    bankMatches: db
      .select({
        movementId: reconciliationAllocations.movementId,
        lineId: reconciliationAllocations.lineId,
        amount: reconciliationAllocations.amount,
      })
      .from(reconciliationAllocations)
      .where(inArray(reconciliationAllocations.movementId, movementIds))
      .orderBy(asc(reconciliationAllocations.id))
      .all()
      .map((m) => ({ ...m, movementId: m.movementId! })),
  };
}

/**
 * Removes every bank line matched to this record's movements, inside the
 * caller's transaction. Audited per movement the way a manual unmatch is;
 * the live update waits for the caller's commit. Returns what was removed.
 */
export function releaseBankMatchesInTransaction(
  db: LedgerDb,
  recordId: number,
  actingUserId: number,
  deferredEmits: DeferredEmits,
): VoidReleasePlan["bankMatches"] {
  const released: VoidReleasePlan["bankMatches"] = [];
  const movementIds = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .orderBy(asc(ledgerMovements.sortOrder))
    .all()
    .map((m) => m.id);
  for (const movementId of movementIds) {
    const before = listMovementAllocations(db, movementId);
    if (!before.length) continue;
    replaceMovementAllocationsQuery(db, movementId, 0, [], actingUserId);
    recordAudit(db, {
      recordType: "record",
      recordId,
      userId: actingUserId,
      action: "update",
      changes: [
        { field: `allocations:movement:${movementId}`, before, after: [] },
      ],
      deferredEmits,
    });
    const lineIds = [...new Set(before.map((a) => a.lineId))];
    deferredEmits.push(() =>
      reconciliationEvents.emit("allocation-update", { movementId, lineIds }),
    );
    released.push(
      ...before.map((a) => ({
        movementId,
        lineId: a.lineId,
        amount: a.amount,
      })),
    );
  }
  return released;
}

/**
 * Whether this record is still part of an active reimbursement group: as its
 * payable or payment record, or through an expense movement the group covers.
 */
export function inActiveReimbursementGroup(db: LedgerDb, id: number): boolean {
  const movementIds = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, id))
    .all()
    .map((m) => m.id);
  const inGroup = db
    .select({ id: reimbursements.id })
    .from(reimbursements)
    .where(
      and(
        isNull(reimbursements.reversedAt),
        or(
          eq(reimbursements.payableRecordId, id),
          eq(reimbursements.paymentRecordId, id),
          movementIds.length
            ? inArray(
                reimbursements.id,
                db
                  .select({ id: reimbursementItems.groupId })
                  .from(reimbursementItems)
                  .where(
                    and(
                      inArray(reimbursementItems.sourceMovementId, movementIds),
                      // Taken out by Correct allocation: no longer part of it.
                      isNull(reimbursementItems.removedAt),
                    ),
                  ),
              )
            : undefined,
        ),
      ),
    )
    .get();
  return inGroup !== undefined;
}

/**
 * `voidRefusal`, plus the closed-month boundary: the one answer every screen
 * shows for "why can't I void this?" (the record page on load and on every
 * settlement refresh, the void dialog, MCP's preview). The write itself is
 * still refused by `insertRecord` if the month closes in between.
 */
export function voidBlockedReason(
  db: LedgerDb,
  id: number,
  release: VoidRelease = "none",
): string | null {
  const refused = voidRefusal(db, id, release);
  if (refused) return refused;
  const record = getRecord(db, id);
  return record?.periodClosedThrough
    ? `This record is in a closed month (closed through ${record.periodClosedThrough}). Reopen the month before you void it.`
    : null;
}

/**
 * Voids a record: writes a Reversal record that negates it on the same date.
 *
 * The original is not edited, so its history, attachments and reversed
 * allocations stay exactly as they were. Both records become read-only, and
 * every list of individual items hides the pair (`queries/void-state.ts`).
 * There is no undo: a mistaken void is fixed by entering the record again.
 */
export function voidRecordInTransaction(
  db: LedgerDb,
  id: number,
  actingUserId: number,
  reason: string,
  deferredEmits: DeferredEmits,
  /** What the caller released just before, in this transaction, for the audit. */
  released?: VoidReleasePlan,
): Refusable<{ original: RecordView; reversal: RecordView }> {
  const refused = voidRefusal(db, id);
  if (refused) return { ok: false, reason: refused };
  const original = getRecord(db, id)!;
  const built = buildReversal(
    original.movements.map((m) => ({
      accountId: m.accountId,
      amountMinor: m.amountMinor,
      label: m.label,
    })),
  );
  if (!built.ok) return built;

  const row = insertRecord(
    db,
    actingUserId,
    {
      kind: LedgerRecordKind.Reversal,
      date: original.date,
      description: `Void of ${original.recordNumber ?? `#${original.id}`}${original.description ? ` — ${original.description}` : ""}`,
      amount: original.amount,
      currency: original.currency,
      exchangeRate: original.exchangeRate,
      contactId: original.contactId,
      supplierContactId: original.supplierContactId ?? null,
      remark: reason,
      reversesRecordId: original.id,
    },
    built.value,
  );

  recordAudit(db, {
    recordType: "record",
    recordId: row.id,
    userId: actingUserId,
    action: "create",
  });
  recordAudit(db, {
    recordType: "record",
    recordId: original.id,
    userId: actingUserId,
    action: "update",
    changes: [
      { field: "voidedByRecordId", before: null, after: row.id },
      { field: "voidReason", before: null, after: reason },
      ...(released?.allocations.length
        ? [
            {
              field: "releasedAllocations",
              before: released.allocations,
              after: null,
            },
          ]
        : []),
      ...(released?.bankMatches.length
        ? [
            {
              field: "releasedBankMatches",
              before: released.bankMatches,
              after: null,
            },
          ]
        : []),
    ],
  });

  deferredEmits.push(() => {
    emitRecord(db, row.id);
    emitRecord(db, original.id);
  });
  return {
    ok: true,
    value: {
      original: getRecord(db, original.id)!,
      reversal: getRecord(db, row.id)!,
    },
  };
}

/**
 * Tells every open view that a record's derived paid state may have moved,
 * without anyone having edited it. Settling is the one action that does that,
 * which is why it has its own event (contracts/events.md).
 *
 * An invoice's paid state is its issue posting's, so the invoices list hears
 * about it too — otherwise a payment shows there only after a reload.
 */
export function emitSettlementChanged(db: LedgerDb, recordIds: number[]): void {
  ledgerEvents.emit("settlement-changed", { recordIds });
  for (const id of recordIds) {
    const record = getRecord(db, id);
    // Generated reimbursement entries are never on a Records list, so a
    // record-update would only add them to the top of an open one. Their own
    // page still refreshes from `settlement-changed`.
    if (
      record &&
      !db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, id))
        .get()
    )
      ledgerEvents.emit("record-update", { record });
  }
  for (const invoiceId of invoiceIdsForLedgerRecords(db, recordIds)) {
    const item = getInvoice(db, invoiceId);
    if (item) invoiceEvents.emit("invoice-update", { item });
  }
}

/** Re-emits one record, for a caller that changed something around it. */
export function emitRecordUpdate(db: LedgerDb, id: number): void {
  emitRecord(db, id);
}

export { getRecordRow };

function isMoneyPotAccountFor(db: LedgerDb, id: number) {
  const account = getAccount(db, id);
  return !!account && account.archivedAt === null && isMoneyPotAccount(account);
}
