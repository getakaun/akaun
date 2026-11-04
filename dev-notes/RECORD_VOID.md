# Voiding a record

A record that must read as if it never happened, but cannot be deleted. The case
that prompted it: two personally paid 2025 expenses, reimbursed by a real bank
payment. Reversing the allocations (Correct allocation) reopens them, but the
reversed settlement rows are kept as history and block deletion for good
(`allocationHistoryDeletionReason`, FK `RESTRICT`).

## How it works

Voiding record R writes a second record V:

- kind `LedgerRecordKind.Reversal` (8), `ledger_records.reverses_record_id = R.id`
  (unique, FK restrict; migration `0040_record_void.sql`);
- **R's date**, contact, currency, rate and amount; every movement of R negated
  (`buildReversal` in `ledger/entry-builder.ts`); the reason in `remark`.

R itself is not edited. "Voided" is derived from V existing — no status column,
the same rule as payment state.

Because the pair nets to zero on every account on one date, **no balance, report,
contact total or closing figure needed a change**. Only screens that list
individual items hide the pair, all through `queries/void-state.ts`
(`notVoided` / `inVoidPair`): the records list (`voided` filter, default exclude),
outstanding / contact balances, account history and statement, reconciliation
candidates and matching, import duplicate checks, contact expense/income counts.

## Rules

- Allowed only with no active allocation, no bank match, not in an active
  reimbursement group, not an invoice posting or opening balance, period open
  (`voidRefusal` in `services/ledger.ts`; the date is checked by `insertRecord`).
- Final. R and V are read-only everywhere (patch, delete, corrections, settlements,
  matching; backstop in `queries/ledger.ts` `updateRecord`). A mistaken void is
  fixed by entering the record again.
- Permission `records.void` (explicit, sensitive) + `records.read`; OAuth scope
  `records:void`. REST `GET/POST /api/records/[id]/void`; MCP `get_record_void`,
  `void_record`.
- Integrity invariant 7 (`ledger/integrity.ts`) checks every pair cancels exactly.

## Why not a void flag

About 55 query sites in 20 files read `ledger_movements` directly, with no shared
base query. A flag would have to be excluded at each one, and a miss is a wrong
report total. Physically removing or zeroing R's movements is blocked by the
`RESTRICT` keys and breaks invariants 1–6. The reversal is also the standard
immutable-ledger correction (reversing entry that references the original).

## Frozen interface change (`ledger/types.ts`)

Additive only: `RecordView.voidedByRecordId`, `RecordView.reversesRecordId`,
`RecordListFilters.voided`.

## Using it on a closed year

Reopen the months (Accounts › Closing › Reopen months) → Correct allocation on the
payment for each expense → Void each expense → close again. The payment stays; its
freed amount is the person's credit (refund it or apply it later).
