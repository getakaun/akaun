import { LedgerRecordKind } from "$lib/enums.js";
import { listContacts } from "../queries/contacts.js";
import { getRecord } from "../queries/ledger.js";
import {
  requireAnyPermissions,
  requirePermissions,
  type AppContext,
} from "./context.js";
import { prepareExpenseContactCorrection } from "./expense-contact-correction.js";
import { prepareRecipientCorrection } from "./payment-recipient.js";
import { missing, ok } from "./result.js";

/** Same access as the correction flow; no additional directory permission needed. */
export function searchContactCorrectionContacts(
  ctx: AppContext,
  id: number,
  search: string,
) {
  const denied = requirePermissions(ctx, ["records.read", "records.update"]);
  if (denied) return denied;
  const record = getRecord(ctx.db, id);
  if (!record) return missing("That record no longer exists.");
  if (record.kind === LedgerRecordKind.Expense) {
    const prepared = prepareExpenseContactCorrection(ctx, id);
    if (!prepared.ok) return prepared;
  } else {
    const denied =
      requirePermissions(ctx, ["records.create"]) ??
      requireAnyPermissions(ctx, [
        ["records.correctPaymentRecipient"],
        ["records.delete"],
      ]);
    if (denied) return denied;
    const prepared = prepareRecipientCorrection(ctx, id);
    if (!prepared.ok) return prepared;
  }
  return ok(
    listContacts(ctx.db, { search: search.trim() || undefined, limit: 50 }).map(
      ({ id, legalName }) => ({ id, legalName }),
    ),
  );
}
