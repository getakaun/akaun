# Feature Specification: Month closing

**Feature Branch**: `008-month-closing`  
**Created**: 2026-11-03  
**Status**: Accepted for implementation  
**Input**: Follow the researched recommendation, plan and implement month closing, and open a PR.

## Glossary

| Term           | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| Ledger         | The dated entries from which reports are calculated.             |
| Posting        | An entry that changes account balances.                          |
| Closed through | The last date protected from accounting changes, inclusive.      |
| Reopen         | Move the protected boundary backward so corrections can be made. |

## User Scenarios & Testing

### User Story 1 - Review and close a month (Priority: P1)

A bookkeeper reviews transactions, bank differences, adjustments and reports, then protects the book through an elapsed month end. They can continue entering the following month's work.

**Why this priority**: Prevent accidental changes to reviewed figures.

**Independent Test**: Close October; October financial edits fail while November entries and payments against October invoices succeed.

**Acceptance Scenarios**:

1. Given an open book, when automated checks pass and an authorized person confirms closing once, then the selected month end and all earlier dates become protected, with actor/time/review evidence in history.
2. Given a ledger integrity failure, invalid month end or stale review, when closing is attempted, then nothing changes.
3. Given outstanding invoices or reimbursements, when closing is attempted, then those normal balances do not prevent closing.

### User Story 2 - Protect every accounting write path (Priority: P1)

A user receives a clear refusal when an action would change protected accounting figures, regardless of how they submit it.

**Why this priority**: A lock with alternate routes around it gives false assurance.

**Independent Test**: Exercise ordinary records, invoice issue/void, opening balances, imports, specialty corrections and report classification changes against a closed boundary.

**Acceptance Scenarios**:

1. Given October closed, creating/deleting/recategorizing or moving a posting across its boundary is refused without partial changes.
2. Given an unchanged financial field resent by a form, when only a description changes, then saving remains possible.
3. Given a new November payment against an October invoice, when posted, then October amounts remain intact.
4. Given a report-affecting account or partner roster change, when protected history would be affected, then it is refused.

### User Story 3 - Reopen and correct deliberately (Priority: P2)

An authorized person reopens from an earlier month with a reason, corrects entries and closes again.

**Why this priority**: Real books need corrections with visible accountability.

**Independent Test**: Reopen October in a book closed through December and confirm the boundary moves to September end and history remains.

**Acceptance Scenarios**:

1. Given December closed, reopening from October opens October through December and records the old/new boundary and reason.
2. Given only ordinary record editing permission, reopening is forbidden.
3. Given a reopened book, existing settlement, reconciliation and document restrictions still apply.

### Edge Cases

- First close protects all earlier history with an explicit warning.
- Leap years, month ends and business-calendar dates are validated without timezone shifts.
- A concurrent write invalidates an outstanding review; no backdated posting can race past close.
- Failed compound operations leave no partial postings, numbering, allocations, attachments or success events.
- Current paid/matched status may change after close without changing financial postings.

## Requirements

### Functional Requirements

- **FR-001**: Maintain one inclusive book-wide boundary, unset by default; no automatic postings or historical rewriting on rollout.
- **FR-002**: Permit closing only through an elapsed calendar month end, after automated date, integrity and revision checks pass and one close confirmation.
- **FR-003**: Block failed integrity checks; show non-blocking notices about pending relevant imports/drafts, bank differences, incomplete history and classification notes. Never infer completeness from uploaded data alone.
- **FR-004**: Require distinct explicit permissions to close and reopen; delegated tokens/apps cannot exercise them in this release.
- **FR-005**: Atomically protect additions, removals and financial updates through the boundary across all entry points. Check original and proposed dates, dependent postings, account/category, currency/rate and financial attribution.
- **FR-006**: Protect account classification and partner membership/attribution changes that alter closed-period reports.
- **FR-007**: Permit non-financial annotations and attachments, non-posting drafts, later payments against closed obligations, and pure matching/allocations, retaining existing permissions and audit history.
- **FR-008**: Reopening from a month moves the boundary to the preceding month end (or unsets it when all protected history is reopened); require a reason and show the whole affected range.
- **FR-009**: Keep append-only close/reopen history with actor, time, old/new boundary and review/reason evidence; show narrow history without exposing unrelated administration.
- **FR-010**: Place month closing under Accounts, reachable from the Accounts main page without placing an action on individual account details, while clearly stating it covers all accounts. Use existing app buttons, cards and a custom popover month picker; preserve old closing links with a redirect. Show the boundary to signed-in entry users and report readers, with live updates and an actionable error for refused writes.
- **FR-011**: Reject stale reviews and serialize closing with financial writes. Failed operations roll back fully.
- **FR-012**: Keep current operational status distinct from frozen report evidence. Immutable report bundles, fiscal-year profit transfers, partial holes, module locks and automatic adjustments are deferred.

### Key Entities

- **Closing boundary**: One protected through-date for the book.
- **Closing review**: Selected date, integrity result, warnings and a revision identifying what was reviewed.
- **Closing history**: Existing audit events with close/reopen evidence.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every protected-date financial mutation in the acceptance matrix is refused without changing the book.
- **SC-002**: Later-period payments and non-financial annotations remain usable in all corresponding scenarios.
- **SC-003**: Every successful close/reopen has one retained history entry; unauthorized and stale actions have none.
- **SC-004**: Closing uses one custom month selection, automatic checks and one confirmation, with no checklist or notice acknowledgments, without configuring fiscal periods or module locks.

## Assumptions

- One installed database is one book; calendar months match the agreed first release.
- Existing business date conventions, financial queries, permissions and audit storage are reused.
- A close protects accounting amounts/grouping, not immutable copies of live report presentation or historical aging.
- Financial and permission rules require isolated test-first verification. UI uses static checks and maintainer review.
