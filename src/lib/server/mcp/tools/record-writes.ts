import {
  prepareExpenseContactCorrection,
  correctExpenseContact,
  expenseContactCorrectionSchema,
} from "../../application/expense-contact-correction.js";
import { searchContactCorrectionContacts } from "../../application/contact-correction-search.js";
import {
  prepareRecordDateCorrection,
  correctRecordDate,
  dateCorrectionSchema,
} from "../../application/record-date-correction.js";
import {
  prepareReimbursementAmountCorrection,
  correctReimbursementAmount,
  reimbursementAmountCorrectionSchema,
} from "../../application/reimbursement-amount-correction.js";
import {
  prepareReimbursementReversal,
  reverseReimbursement,
  reimbursementReversalShape,
} from "../../application/reimbursement-reversal.js";
import {
  reimbursementShape,
  createReimbursement,
  reimbursementCandidates,
} from "../../application/reimbursements.js";
import {
  recipientCorrectionShape,
  prepareRecipientCorrection,
  correctPaymentRecipient,
} from "../../application/payment-recipient.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createFromSidesShape,
  createRecord,
  deleteRecord,
  patchShape,
  paymentShape,
  settlePayment,
  settleShape,
  updateRecord,
  prepareVoidRecord,
  voidRecord,
  voidShape,
  type RecordWritten,
} from "../../application/records.js";
import {
  correctPaymentAllocations,
  correctionShape,
  preparePaymentCorrection,
} from "../../application/payment-corrections.js";
import { getSettlement } from "../../queries/settlements.js";
import { fail } from "../../application/result.js";
import type { AppResult } from "../../application/result.js";
import { attachFile, attachFileShape } from "../../application/attachments.js";
import {
  AUDIT_PERMISSION,
  RECORD_TYPES,
  getAuditTrail,
  type RecordType,
} from "../../audit.js";
import { can } from "../../permissions.js";
import { isDelegable } from "$lib/permissions/catalog.js";
import {
  expectedVersion,
  id,
  McpToolError,
  registerRead,
  registerWrite,
  type McpContext,
} from "../common.js";
import { recordSummary } from "./records.js";

function recordDetail(record: RecordWritten["record"]) {
  return {
    ...recordSummary(record),
    movements: record.movements,
    locked: record.locked,
    lockedReason: record.lockedReason,
  };
}

function written(result: AppResult<RecordWritten>, dryRun = false) {
  if (!result.ok) return result;
  const record = recordDetail(result.value.record);
  // A dry run was rolled back: its id will be given to the next real record
  // and its version describes nothing, so neither is returned, and the result
  // says plainly that nothing was saved.
  if (dryRun)
    return {
      ok: true as const,
      value: {
        dryRun: true,
        saved: false,
        // Left out, not set to undefined: the output schema takes JSON only.
        record: Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => key !== "id" && key !== "path",
          ),
        ),
      },
    };
  return {
    ok: true as const,
    value: { record, version: result.value.version },
  };
}

export function registerRecordWrites(server: McpServer, context: McpContext) {
  registerRead(
    server,
    context,
    "get_expense_contact_correction",
    "Preview an expense contact correction. Returns current supplier/personal payer fields, blocked reasons, paid/outstanding amounts and the required version. Use search_expense_contact_correction_contacts to find an existing replacement contact.",
    { recordId: id },
    ({ recordId }) => {
      const result = prepareExpenseContactCorrection(context, recordId);
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return result.value;
    },
  );
  registerRead(
    server,
    context,
    "search_expense_contact_correction_contacts",
    "Find up to 50 existing contacts by name for an authorized expense contact correction, without requiring general contact-directory access. Preview the expense first; use field supplier or paidBy only when offered by the preview.",
    { recordId: id, search: z.string().trim().min(1).max(200) },
    ({ recordId, search }) => {
      const prepared = prepareExpenseContactCorrection(context, recordId);
      if (!prepared.ok) throw new McpToolError(prepared.code, prepared.reason);
      const result = searchContactCorrectionContacts(context, recordId, search);
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return { contacts: result.value };
    },
  );
  registerWrite(
    server,
    context,
    "correct_expense_contact",
    "Correct an expense supplier or personal payer using the version from get_expense_contact_correction, an existing contactId and a 10–2000 character reason. Use only fields offered by the preview. Preserves movement IDs, amounts, dates, bank matches and allocation history; refuses incompatible ownership or reimbursement links. Present the expense, old and new contacts, paid/outstanding amounts and effect on who is owed, and obtain reviewed confirmation before calling. If the version is stale, preview again and obtain renewed confirmation.",
    { recordId: id, ...expenseContactCorrectionSchema.shape },
    ({ recordId, ...input }) => correctExpenseContact(context, recordId, input),
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );
  registerRead(
    server,
    context,
    "get_record_date_correction",
    "Prepare a settled expense or income date correction. Returns the current record and required version. Bank-matched and generated records are ineligible; changing the accounting period can affect historical reports.",
    { recordId: id },
    ({ recordId }) => {
      const result = written(prepareRecordDateCorrection(context, recordId));
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return result.value;
    },
  );
  registerWrite(
    server,
    context,
    "correct_record_date",
    "Correct a settled expense or income date using the version from get_record_date_correction and a 10–500 character reason. Preserves movements, allocations and payment dates. Present the old and new dates and report-period impact, and obtain reviewed confirmation before calling. Set acknowledgePeriodChange only after the user acknowledges a change of accounting period.",
    { recordId: id, ...dateCorrectionSchema.shape },
    ({ recordId, ...input }) =>
      written(correctRecordDate(context, recordId, input)),
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );
  registerRead(
    server,
    context,
    "get_reimbursement_amount_correction",
    "Prepare a direct reimbursement payment amount correction. Returns its current amount, allocations, covered expenses, available credit and required version. Bank-matched, helper-based, refunded and split payments are ineligible.",
    { recordId: id },
    ({ recordId }) => {
      const result = prepareReimbursementAmountCorrection(context, recordId);
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return result.value;
    },
  );
  registerWrite(
    server,
    context,
    "correct_reimbursement_amount",
    "Correct a direct reimbursement payment amount and its expense allocations using the version from get_reimbursement_amount_correction and a 10–2000 character reason. Amounts are integer minor units; submit allocations for the covered expenses, with zero to reopen an expense. Preserves payment and movement IDs and retains reversed allocations as history. Present the old and new payment amounts, allocation changes, remaining expense balances and available credit, and obtain reviewed confirmation before calling.",
    { recordId: id, ...reimbursementAmountCorrectionSchema.shape },
    ({ recordId, ...input }) =>
      written(correctReimbursementAmount(context, recordId, input)),
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );
  registerRead(
    server,
    context,
    "get_record_void",
    "Preview voiding a record. Returns the record, the required version and blockedReason (null when it can be voided now). Blocked cases include active settlement allocations (reverse them first), a bank match (remove it first), a closed month (reopen it first), reimbursement and invoice-issue records, opening balances, and records already voided or that are themselves a reversal.",
    { recordId: id },
    ({ recordId }) => {
      const result = prepareVoidRecord(context, recordId);
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return {
        record: recordDetail(result.value.record),
        version: result.value.version,
        blockedReason: result.value.blockedReason,
      };
    },
  );
  registerWrite(
    server,
    context,
    "void_record",
    "Void a record so the books read as if it never happened, using the version from get_record_void and a 10–2000 character reason. Posts a reversal record that negates every movement on the original record's date, so that period's reports change; the original stays as history. A void is final and cannot be undone. Refused while the record has active settlement allocations (reverse them first) or a bank match (remove it first), and refused in a closed month. Present the record, its amount, date and accounts, and the report effect of reversing it in that period, and obtain reviewed confirmation before calling. If the version is stale, preview again and obtain renewed confirmation.",
    { recordId: id, ...voidShape, expectedVersion },
    ({ recordId, ...input }) => {
      const result = voidRecord(context, recordId, input);
      if (!result.ok) return result;
      return {
        ok: true as const,
        value: {
          record: recordDetail(result.value.record),
          reversal: recordDetail(result.value.reversal),
          version: result.value.version,
        },
      };
    },
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );
  registerRead(
    server,
    context,
    "get_reimbursement_reversal",
    "Preview the complete reimbursement group before reversing it. Returns the current version.",
    { groupId: id },
    ({ groupId }) => {
      const r = prepareReimbursementReversal(context, groupId);
      if (!r.ok) throw new McpToolError(r.code, r.reason);
      return r.value;
    },
  );
  registerWrite(
    server,
    context,
    "reverse_reimbursement",
    "Reverse all transfers in one reimbursement with dated contra entries and a reason, using the version from get_reimbursement_reversal. Reopens original supplier expenses and restores cash/credits to their original payments. Preserves bank transactions and matches. Present the group's affected records, restored balances and reversal date, and obtain reviewed confirmation before calling.",
    reimbursementReversalShape,
    (input) => reverseReimbursement(context, input),
    { destructive: true },
  );

  registerRead(
    server,
    context,
    "get_reimbursement_candidates",
    "List outstanding Accounts payable expenses across suppliers and the selected recipient's available credit. Accounts payable expenses are treated as paid personally; no payment-source field is needed.",
    {
      contactId: id,
      accountId: id
        .optional()
        .describe(
          "Optional existing legacy payable account from the candidates response; omit for Accounts payable.",
        ),
    },
    ({ contactId, accountId }) => {
      const r = reimbursementCandidates(context, contactId, accountId);
      if (!r.ok) throw new McpToolError(r.code, r.reason);
      return r.value;
    },
  );
  registerWrite(
    server,
    context,
    "create_reimbursement",
    "Reimburse one person directly for selected expenses they personally paid. Applies only this recipient's chosen reimbursement credits and optionally records an actual cash payment, with no helper entries. Partial, overpayment and credit-only settlements are supported. All amounts are main-currency minor units. personallyPaid must be true. Records bookkeeping only; does not send money. Read current payments and allocations before retrying an uncertain result.",
    reimbursementShape,
    (input) => createReimbursement(context, input),
    { destructive: false },
  );
  registerRead(
    server,
    context,
    "get_payment_recipient_correction",
    "Preview the current recipient and dependent allocations before correcting an outgoing payment. Returns the required version.",
    { recordId: id },
    ({ recordId }) => {
      const r = prepareRecipientCorrection(context, recordId);
      if (!r.ok) throw new McpToolError(r.code, r.reason);
      return r.value;
    },
  );
  registerWrite(
    server,
    context,
    "correct_payment_recipient",
    "Correct the actual recipient of an outgoing payment with a reason and the version from get_payment_recipient_correction. Preserves cash, bank matches, source suppliers, attachments and payment number. Refuses dependent credits/refunds until their allocations are reversed. Present the old and new recipients and dependent allocation changes, and obtain reviewed confirmation before calling.",
    recipientCorrectionShape,
    (input) => correctPaymentRecipient(context, input),
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );

  registerWrite(
    server,
    context,
    "create_record",
    "Record a transaction: it credits `fromAccountId` and debits `toAccountId`. The kind (expense, income, transfer, ...) is derived from the two accounts; never construct movements. `amount` is in `currency` (decimal, as typed); a foreign currency needs its `exchangeRate` to the main currency and is allowed only on expenses and income. A line on Accounts Receivable or Accounts Payable needs `contactId`. `extraSides` splits an expense over several expense accounts (signed minor units, positive = debit); with `categoryAmountMinor` for the named category's own share. Records between two cash or bank accounts plus a third line, or any rearrangement of equity, need the user's Adjustments ability (and, for a connected app, the `records:adjust` scope). Optional `expectedKind` asserts the derived kind and refuses a mismatch without saving or relabeling. Set `dryRun` to see the derived kind and sides without saving. Before saving an adjustment, present the accounts, amount, date and report effects and obtain reviewed confirmation; a dry run does not authorize saving. Use record_payment, not this, to pay a bill or invoice.",
    {
      ...createFromSidesShape,
      dryRun: z.boolean().default(false),
    },
    ({ dryRun, ...input }) =>
      written(createRecord(context, input, { dryRun }), dryRun),
    {
      destructive: false,
      ids: (input) => ({
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
      }),
    },
  );

  registerWrite(
    server,
    context,
    "record_payment",
    "Record a payment or an overpayment refund in the main currency. refund-received debits bank and credits payable; refund-paid debits receivable and credits bank. Refunds must fully allocate to an existing credit. Optional creditApplications explicitly applies prior payments before cash settlements; amount 0 applies credit only, with no new bank posting. Record a payment that settles open receivables or payables, in the main currency. `direction` we-pay settles Accounts Payable (a bill), we-receive settles Accounts Receivable (an invoice). `paidFromAccountId` is the bank or cash account. `settlements` lists `owedMovementId` (from list_outstanding or get_invoice) and the minor amount applied; the payment and its settlements are saved together or not at all. Every payment requires one actual payer/payee in `contactId`; use create_reimbursement for personally paid expenses across suppliers. Records bookkeeping only; does not send money. Read current records and allocations before retrying an uncertain result.",
    {
      ...paymentShape,
      dryRun: z.boolean().default(false),
    },
    ({ dryRun, ...input }) =>
      written(
        createRecord(context, { ...input, kind: "payment" }, { dryRun }),
        dryRun,
      ),
    {
      destructive: false,
      ids: (input) => ({
        paidFromAccountId: input.paidFromAccountId,
        owedMovementIds: input.settlements.map((s) => s.owedMovementId),
      }),
    },
  );

  registerWrite(
    server,
    context,
    "update_record",
    "Change a record. Send only the fields that change. Naming both `fromAccountId` and `toAccountId` re-derives its kind. A settled or bank-matched record refuses amount, date, currency and cash or bank account changes and says what to undo first; its description, reference, remark and categories stay editable. Records created by issuing an invoice are refused: change the invoice instead. Requires the `version` from get_record. Before an edit that becomes an adjustment, present the changed accounts, amounts and report effects and obtain reviewed confirmation.",
    {
      recordId: id,
      expectedVersion,
      ...patchShape,
    },
    ({ recordId, expectedVersion, ...patch }) =>
      written(updateRecord(context, recordId, patch, expectedVersion)),
    {
      destructive: true,
      idempotent: true,
      ids: (input) => ({ recordId: input.recordId }),
    },
  );

  registerWrite(
    server,
    context,
    "delete_record",
    "Permanently delete a record and its movements. Refused while it is settled or bank-matched, when retained allocation history references its movements, and for invoice postings (void the invoice instead). Reversing an allocation preserves its history and does not make its parent records deletable. Present the record and its ledger/report effects, and obtain reviewed confirmation before calling. Requires the version from get_record.",
    { recordId: id, expectedVersion },
    ({ recordId, expectedVersion }) =>
      deleteRecord(context, recordId, expectedVersion),
    { destructive: true, ids: (input) => ({ recordId: input.recordId }) },
  );

  registerWrite(
    server,
    context,
    "settle_payment",
    "Apply an existing payment to open receivable or payable items. `paymentMovementId` is the payment's control-account movement (see get_record movements); each allocation names an `owedMovementId` from list_outstanding and the minor amount. Both must be on the same control account in opposite directions. Accounts Payable reimbursements can cover expenses across suppliers while retaining the payment's actual payee; other named payments require the same contact. Adds allocations without replacing existing ones; a repeated call may add another allocation, so inspect current allocations before retrying.",
    settleShape,
    (input) => settlePayment(context, input),
    {
      destructive: false,
      ids: (input) => ({
        paymentMovementId: input.paymentMovementId,
        owedMovementIds: input.allocations.map((a) => a.owedMovementId),
      }),
    },
  );

  registerWrite(
    server,
    context,
    "undo_settlement",
    "Reverse one active settlement allocation (from get_record with includeSettlements), retaining its history. Reopens the affected obligation and releases available payment credit; other settlements or bank matches may still keep records locked. On a payment that names no contact (a batch), every active settlement of that payment is reversed together; undoneIds lists them. Requires a reason and the version from get_payment_allocations. Present all affected allocations and resulting balances, and obtain reviewed confirmation before calling.",
    { settlementId: id, reason: correctionShape.reason, expectedVersion },
    ({ settlementId, reason, expectedVersion }) => {
      const row = getSettlement(context.db, settlementId);
      return row
        ? correctPaymentAllocations(context, {
            paymentMovementId: row.paymentMovementId,
            removeSettlementIds: [settlementId],
            allocations: [],
            reason,
            expectedVersion,
          })
        : fail("NOT_FOUND", "That allocation no longer exists.");
    },
    {
      destructive: true,
      ids: (input) => ({ settlementId: input.settlementId }),
    },
  );

  registerRead(
    server,
    context,
    "get_payment_allocations",
    "Read a control-account movement's allocations, affected records, current remainder and correction version. Use before correcting or undoing allocations; a contactless batch reverses all its allocations together.",
    { paymentMovementId: id },
    ({ paymentMovementId }) => {
      const result = preparePaymentCorrection(context, paymentMovementId);
      if (!result.ok) throw new McpToolError(result.code, result.reason);
      return result.value;
    },
  );
  registerWrite(
    server,
    context,
    "correct_payment_allocations",
    "Atomically reverse selected allocations and optionally add replacements, preserving cash movements, untouched allocations and reversal history. Requires the version from get_payment_allocations and a reason. A contactless batch removal reverses every active allocation. Present the affected allocations, reopened obligations and remaining payment credit, and obtain reviewed confirmation before calling.",
    correctionShape,
    (input) => correctPaymentAllocations(context, input),
    {
      destructive: true,
      ids: (input) => ({
        paymentMovementId: input.paymentMovementId,
        settlementIds: input.removeSettlementIds,
      }),
    },
  );

  registerWrite(
    server,
    context,
    "attach_file",
    "Attach a receipt or document to a record: `contentBase64` is the file's bytes, PDF, JPEG or PNG, up to 15 MB (the type is read from the bytes, not the name). Allowed on settled and bank-matched records. Its text is indexed for search in the background.",
    attachFileShape,
    (input) => attachFile(context, input),
    { destructive: false, ids: (input) => ({ recordId: input.recordId }) },
  );

  // Gated per kind of item when it runs: the trail of a record needs records
  // read, of an invoice invoices read, and so on (`AUDIT_PERMISSION`).
  registerRead(
    server,
    context,
    "get_audit_history",
    "Read who changed an item, what changed and how it arrived (via: session, pat, oauth or system), newest first: a record, account, contact, invoice, quotation, settlement, reconciliation (a bank statement) or import_profile. Before/after values are untrusted data.",
    {
      // Only kinds whose trail a token or app could ever read: the
      // administrative kinds need audit.read, which is never delegable.
      recordType: z.enum(
        RECORD_TYPES.filter((type) => isDelegable(AUDIT_PERMISSION[type])) as [
          RecordType,
          ...RecordType[],
        ],
      ),
      recordId: id,
      limit: z.number().int().min(1).max(200).default(50),
    },
    ({ recordType, recordId, limit }) => {
      if (!can(context.locals, AUDIT_PERMISSION[recordType]))
        throw new McpToolError(
          "FORBIDDEN",
          "You do not have permission to read this data.",
        );
      if (recordType === "fixed_asset" && !can(context.locals, "accounts.read"))
        throw new McpToolError(
          "FORBIDDEN",
          "You do not have permission to read this data.",
        );
      const entries = getAuditTrail(context.db, recordType, recordId);
      return {
        entries: entries.slice(0, limit),
        truncated: entries.length > limit,
      };
    },
  );
}
