import { LedgerRecordKind } from "$lib/enums.js";
import type { RecordView } from "$lib/server/ledger/types.js";

// Mirrors the derived states in src/lib/server/ledger/settlement-rules.ts:
// a record with no side on a shared owed account was paid straight from an
// account and reads paid the moment it exists; one that owes somebody reads
// owed until settlements cover it, and part paid while they cover only some of
// it (FR-012–FR-014).
//
// Hand-duplicated because $lib/server is stripped from client code at build
// time. This does no arithmetic of its own — it only names the state the server
// already worked out, so the two cannot drift on the figures. Keep the labels in
// step with StatusBadge's `byLabel` map (CLAUDE.md § Gotchas).
//
// A void pair comes first: a voided record and its reversal net to zero and owe
// nothing, so "paid" or "owed" would describe money that, as far as the books
// are concerned, never moved. The link itself is derived on the server
// (`voidedByRecordId` / `reversesRecordId`, src/lib/server/queries/void-state.ts).
export function statusLabelFor(record: RecordView): string {
  if (record.voidedByRecordId !== null) return "voided";
  if (record.reversesRecordId !== null) return "reversal";
  if (record.kind === LedgerRecordKind.Payment)
    return record.paid ? "allocated" : "unallocated";
  if (record.paid) return "paid";
  return record.outstandingMinor < Math.abs(record.amountMinor)
    ? "part-paid"
    : "owed";
}

/**
 * Whether bank lines account for the whole of this record.
 *
 * A separate question from `statusLabelFor` above, and from `locked`: settled
 * is about whether the money has moved, cleared is about whether the bank
 * agrees it has. A record can be paid and not yet cleared, or cleared and still
 * partly owed.
 *
 * No arithmetic here either. `cleared` is computed by
 * src/lib/server/ledger/coverage.ts and travels with the record, so this only
 * names what the server already worked out (FR-056).
 */
export function clearedLabelFor(record: RecordView): string {
  return record.cleared ? "cleared" : "not cleared";
}
