import { eq } from "drizzle-orm";
import { reimbursementEntries } from "../db/schema.js";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import { diffRecords, recordAudit } from "../audit.js";
import { buildMovements } from "../ledger/entry-builder.js";
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
} from "../queries/ledger.js";
import { getInvoice, invoiceIdsForLedgerRecords } from "../queries/invoices.js";
import { invoiceEvents } from "../finance/events.js";
import { touchAccounts } from "./accounts.js";
import { requireAccountDefault } from "./account-defaults.js";

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
        ...(needsReceivable ? [receivable.value] : []),
        ...(needsPayable ? [payable.value] : []),
        ...(needsOpening ? [openingBalances.value] : []),
      ]),
      receivableAccountId: receivable.value,
      payableAccountId: payable.value,
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
      description: data.description,
      amount: data.amount,
      currency: data.currency,
      exchangeRate: data.exchangeRate,
      contactId: data.contactId ?? null,
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
        "A payment's contact is set when it is created and cannot be changed afterward. Delete it and record it again.",
    };
  }

  const lock = lockStateFor(db, id);
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
    if (!canEditField(field, lock)) {
      return {
        ok: false,
        reason: existing.lockedReason ?? "That cannot be changed.",
      };
    }
  }

  const before = snapshotForAudit(db, id);

  // Any change to what the money did means rebuilding the sides from scratch —
  // there is no partial edit of a movement, because the balance rule is a
  // property of the whole set.
  const rebuild = touchesMoney(patch);
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

  updateRecord(
    db,
    id,
    actingUserId,
    {
      date: patch.date,
      description: patch.description,
      amount: patch.amount,
      currency: patch.currency,
      exchangeRate: patch.exchangeRate,
      contactId: patch.contactId,
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
    changes: diffRecords(before, snapshotForAudit(db, id)),
  });

  const updated = emitRecord(db, id)!;
  // The accounts it moved *away* from need their balances refreshed too.
  touchAccounts(
    db,
    existing.movements.map((m) => m.accountId),
  );
  return { ok: true, value: updated };
}

const MONEY_FIELDS: (keyof RecordPatch)[] = [
  "amount",
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
        openingBalancesAccountId: opening.value,
      },
    );
    if (!derived.ok) return derived;
    return { ok: true, value: { ...base, ...derived.value } };
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
          paidFromAccountId:
            patch.paidFromAccountId !== undefined
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
  db: LedgerDb,
  id: number,
  actingUserId: number,
  opts: { allowReadOnlyKind?: boolean; deferredEmits?: DeferredEmits } = {},
): Refusable<null> {
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

  if (isReadOnlyKind(existing.kind) && !opts.allowReadOnlyKind) {
    return {
      ok: false,
      reason:
        "This record was created by issuing an invoice. Cancel the invoice instead.",
    };
  }

  const allowed = canDeleteRecord(lockStateFor(db, id));
  if (!allowed.ok) return allowed;

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
    if (record) ledgerEvents.emit("record-update", { record });
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
