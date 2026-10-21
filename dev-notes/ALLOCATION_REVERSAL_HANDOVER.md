# Handover: retain reversed allocations without complicating reimbursements

Prepared: 21 October 2026, for handover on 22 October 2026.

Status: design recommendation for implementation. This document changes no application behavior or database schema.

Baseline: branch `feat/reimbursement-corrections`, implementation commit `2452942`, [PR #52](https://github.com/getakaun/akaun/pull/52) targeting `main`.

## Objective and rationale

Keep reversed allocation rows as explicit business history while preserving the simple expense → allocation ← payment model. The previous reimbursement complexity came from extra summary, clearing, and supplier-transfer records. Retaining an allocation does not require any of those records.

An allocation links a payment movement to an owed movement for a positive amount. Reversing it changes whether that relationship counts toward settlement. It does not reverse the bank payment, remove the expense, or create a new accounting entry. Audit logs should continue to explain actions, but new reversed allocation relationships should be readable directly from `settlements`.

Scope is allocation retention and the queries and workflows affected by it. Preserve the existing direct reimbursement flow, recipient-specific credit, supplier attribution, permissions, required reasons, stale-submission checks, and bank reconciliation behavior. Legacy whole-reimbursement reversal remains a separate operation with its existing contra entries and safeguards.

## Current implementation, verified at the baseline

- `settlements` stores `id`, `paymentMovementId`, `owedMovementId`, `amountMinor`, `createdBy`, and `createdAt`. There are no allocation reversal fields.
- `undoSettlement()` physically deletes the row and records a settlement audit with `action: "delete"`, the full allocation in `changes[].before`, and the supplied reason. Deletion and its audit happen in a transaction.
- `correctPaymentAllocations()` wraps removals, optional replacement allocations, and a payment-record audit in one transaction. The record audit contains allocation lists before and after plus `correctionReason`.
- Current balances and record relationships assume every row in `settlements` is active.
- A unique index on `(payment_movement_id, owed_movement_id)` prevents duplicate allocation pairs.
- Reimbursement history currently reads deleted allocations from audit JSON. Correction summaries use the payment-record audit to avoid counting overlapping settlement audits twice.
- Both settlement movement foreign keys currently use `ON DELETE CASCADE`. Retaining allocation rows alone will therefore not guarantee that history survives deletion of their parent movements.

## Proposed model

Add nullable columns to `settlements` using the project's schema naming conventions:

| Application field | Database column   | Meaning                                      |
| ----------------- | ----------------- | -------------------------------------------- |
| `reversedAt`      | `reversed_at`     | Timestamp of reversal; null means active     |
| `reversedBy`      | `reversed_by`     | User who reversed the allocation             |
| `reversalReason`  | `reversal_reason` | Required explanation for the reversal action |

Use `reversedAt` as the single state indicator; a separate status column is unnecessary. Keep the original ID, amount, movement links, creator, and creation timestamp unchanged after reversal. Do not reactivate a reversed row. A subsequent allocation is a new row with a new ID.

Amounts remain positive and stored in minor currency units. No negative allocation rows or new ledger postings are needed for an ordinary allocation reversal.

Replace the existing pair uniqueness rule with uniqueness for active rows only, conceptually:

```sql
CREATE UNIQUE INDEX settlements_pair_idx
ON settlements (payment_movement_id, owed_movement_id)
WHERE reversed_at IS NULL;
```

The migration must drop the old index before recreating it. This permits one active allocation for a pair alongside any number of reversed historical allocations. Preserve the existing behavior for adding to an already active pair; inspect the insertion path before changing the index.

## Balance example

A RM100 payment fully covers a RM100 expense. Its allocation is `amountMinor = 10000`.

| State                                   | Expense outstanding | Payment available credit |
| --------------------------------------- | ------------------- | ------------------------ |
| Allocation active                       | RM0                 | RM0                      |
| Allocation reversed                     | RM100               | RM100                    |
| New RM60 allocation to the same expense | RM40                | RM40                     |

The original RM100 allocation remains visible as reversed. The new RM60 allocation is a separate active row. The original payment, expense, ledger postings, and bank matches are unchanged throughout.

## Implementation steps

1. Add the nullable reversal columns and active-only unique index through a new Drizzle migration and snapshot. Follow the repository's migration process; do not rewrite migrations already committed in PR #52.
2. Introduce a shared active-allocation predicate (`reversed_at IS NULL`) and clearly named active/history query paths. Default operational queries to active rows; history queries must opt in to reversed rows. A helper alone is insufficient: audit every direct join, aggregate, existence check, and lookup.
3. Change allocation undo to a conditional update that only succeeds for an active row. Write reversal metadata and audit in the same transaction. Preserve already-undone handling, legacy batch behavior, reimbursement-transfer restrictions, deferred events, and permissions.
4. Keep correction atomic: reverse selected rows, create replacements, capture before/after active allocation lists, and emit changes only after commit. A failed replacement must roll back reversals and audits. Stale-version checks must observe active allocation changes.
5. Update every balance and eligibility calculation: outstanding amounts, available credit, allocation caps, paid status, contact/account compatibility, correction previews, recipient correction, record locks, date-correction checks, dashboard/contact totals, and legacy reimbursement dependency checks.
6. Read newly reversed relationships from retained rows for history displays. Keep a compatibility path for allocations deleted before this migration, without showing duplicate history. Continue using the record audit for correction-event summaries where it already supplies the authoritative event and reason.
7. Preserve UI, REST, and MCP behavior through the shared application layer. Current relationships should show active allocations; history should label reversed allocations and show reversal metadata. A reversed row must not be offered for reversal again or counted as current funding.
8. Resolve parent-record deletion behavior explicitly, as described below, and add regression coverage before shipping.

## Migration and historical compatibility

Existing settlement rows become active because the new columns default to null. Do not invent reversal timestamps or metadata for them.

Previously deleted allocations exist only in audit snapshots. The simplest first release retains that historical fallback and starts retaining rows for future reversals. Backfilling old rows is optional separate work, not a prerequisite. Do not silently restore snapshots as active allocations. Any future backfill needs deduplication, ID-conflict handling, metadata validation, and a policy for missing parent movements.

Do not convert legacy reimbursement accounts or helper records as part of this change. Ensure legacy whole-reimbursement reversal ignores already reversed allocations when testing for active dependencies, while retaining historical funding links.

### Parent-record deletion decision

Today, undoing all allocations can permit deleting a record, and movement deletion cascades to settlement rows. Merely adding `reversedAt` does not solve that history-retention boundary.

Recommended first implementation: block hard deletion of records/movements referenced by retained historical allocations, explain the reason in the existing deletion UI, and choose an appropriate database restriction as a backstop. This changes deletion eligibility and must be reviewed explicitly. Exclude reversed rows from ordinary settlement locks and balances; evaluate historical references through a separate deletion safeguard.

If deleting those records must remain supported, agree on an alternative before shipping, such as preserving parent records through archival or retaining independent historical snapshots. Do not introduce nullable links or cascade away the promised history without an explicit decision. Test whichever policy is selected.

## Main files to inspect

Paths are relative to the repository root.

| Area                                           | Starting points                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema and migration                           | `src/lib/server/db/schema.ts`, `drizzle/`                                                                                                                                             |
| Allocation persistence and balances            | `src/lib/server/queries/settlements.ts`                                                                                                                                               |
| Allocation creation and undo                   | `src/lib/server/services/settlements.ts`                                                                                                                                              |
| Atomic correction and versions                 | `src/lib/server/application/payment-corrections.ts`                                                                                                                                   |
| Other direct settlement consumers              | `src/lib/server/queries/ledger.ts`, `queries/contacts.ts`, `queries/invoices.ts`, `services/ledger.ts`                                                                                |
| Reimbursement history and correction summaries | `src/lib/server/queries/reimbursements.ts`                                                                                                                                            |
| Legacy whole-group reversal                    | `src/lib/server/application/reimbursement-reversal.ts`                                                                                                                                |
| Recipient corrections and deletion/locking     | `src/lib/server/application/payment-recipient.ts`, `application/records.ts`, `application/record-date-correction.ts`, `src/lib/server/locking.ts`, `src/lib/server/ledger/locking.ts` |
| Audit history                                  | `src/lib/server/audit.ts`, `src/lib/server/audit-feed.ts`                                                                                                                             |
| Presentation                                   | `src/lib/components/ledger/SettlementList.svelte`, `src/lib/components/records/AllocationCorrectionDialog.svelte`, `ReimbursementDetails.svelte`, `RecordDetail.svelte`               |
| API and MCP                                    | `src/routes/api/settlements/`, `src/routes/api/payments/[movementId]/allocations/`, `src/lib/server/mcp/tools/record-writes.ts`                                                       |

Find additional consumers with `rg -n '\bsettlements\b' src`; the table is shared beyond reimbursements.

## Acceptance checks

- Reversal preserves the original allocation row and immutable allocation data, records actor/time/reason, and creates no new payment or ledger posting.
- Active balances match the example above, including partial payments, multiple expenses, credit-only applications, and overpayments. Unrelated allocations and bank matches remain unchanged.
- Reallocating the same payment/expense pair succeeds after reversal; duplicate active pairs remain prevented. Existing active-pair update behavior still works.
- Reversing an already reversed row is refused without changing history. Invalid or stale correction submissions have no effects.
- A failed replacement allocation rolls back the entire correction, including reversal metadata and audit writes.
- Reversed rows do not consume available credit, reduce expense outstanding, trigger active-allocation locks, or block recipient/date corrections merely by being historical. Separate deletion-history safeguards still apply.
- Legacy batch and whole-reimbursement reversal safeguards still work; reversed dependencies are not mistaken for active ones.
- History shows newly retained reversals and older audit-only reversals once each, with appropriate reasons and timestamps where available.
- Migration preserves existing balances and active allocations. The selected parent-deletion policy preserves promised history and has database/service/UI coverage.
- UI, REST, and MCP produce consistent results through the shared application layer.

## Known validation baseline

At implementation commit `2452942`, `bun run check` passed with zero errors and warnings. `bun run test` reported 2,000 passing server tests and two failures in `src/lib/server/services/ledger-defaults.spec.ts`: its `account-defaults.js` mock does not export `accountDefaultId`. The client suite was not reached because the server suite failed. This is a recorded baseline, not evidence that future changes pass.

During implementation, run focused allocation/correction/query tests first, then `bun run check` and the full `bun run test`. Address or explicitly account for the baseline mock failures. This handover document itself requires no application test run.
