import { LedgerRecordKind, type LedgerRecordKindCode } from "$lib/enums.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";

/**
 * Which permission a record of a given kind is checked against: `records.<verb>`,
 * for every kind.
 *
 * What this used to say, and why it stopped being true: the permission followed
 * the kind rather than the table, so income was checked against `income`, a
 * journal entry against `journal`, and transfers, payments and opening balances
 * against `expenses` — "because that is the screen they are recorded from".
 * That screen is gone. There is one list of everything that happened, so there
 * is one ability to see and write it (FR-028).
 *
 * The function is kept, and every call site keeps calling it: the answer is
 * the same for every kind, but the call sites are where a future kind would
 * need a different one.
 *
 * Free choice of account and a third side are a separate question, answered by
 * `records.adjust` at the point of derivation — not here, because whether a
 * record needs it is a fact about the accounts it names, not about its kind
 * (FR-031c).
 */
export function permissionForKind(
  _kind: LedgerRecordKindCode,
  verb: "read" | "create" | "update" | "delete",
): LeafPermission {
  return `records.${verb}`;
}

/**
 * An issued invoice's record is created only by the invoice endpoints, so the
 * records API never accepts one and never lets one be edited through it.
 */
export function isReadOnlyKind(kind: LedgerRecordKindCode): boolean {
  return kind === LedgerRecordKind.InvoiceIssue;
}
