# Data model: Month closing

## Closing state

Existing settings row: key `accounting.closedThrough`, value a valid `YYYY-MM-DD` elapsed month end. Missing/empty means no protected history. No new tables or per-entry closed flags.

## Review (computed, not stored)

`closedThrough`, `monthEnd`, `dateFrom`, opaque `revision`, warnings `{id,message}[]`, integrity `{ok,recordsChecked,problemCount}`. Based on canonical reports and review queues, scoped to the newly protected range. Drafts and queues remain unposted.

## Audit history

Reuse audit_log: recordType settings, recordId closing, action update. Changes include old/new boundary, close/reopen operation, server-derived automated checks/notices or reopen reason. Actor/channel/time use existing audit scope. Never delete old events. Return a narrow history containing no unrelated settings.

## Transitions

- Unset -> elapsed month end: first close protects all earlier history, with a single confirmation covering all earlier history.
- Date A -> later month end B: close protects the entire new range, after fresh review.
- Date B -> predecessor of reopen month: reopen the requested month and all subsequent closed months.
- Date B -> unset: reopen all actual protected history.
- Same/earlier close, future/invalid date, stale revision, failed integrity or missing permission -> no change.

Every update checks original and proposed dates, including metadata-only, movement-label and unchanged patches. Attachments use the parent entry date; posted invoice edits use their linked posting date. Master-data classification and partner membership are guarded because they alter historical report results.

## Shared read-interface extension

`RecordView.periodClosedThrough: string | null` is an explicit additive change to the frozen shared ledger interface and REST/MCP/SSE payloads. It contains the inclusive boundary only when `record.date <= closedThrough`, otherwise null. It is derived once per batch, never stored. Existing `locked` / `lockedReason` retain settlement/reconciliation semantics for operational allocation callers. Invoice views expose the same separate flag for the linked posting. Statement selection metadata includes date and period boundary. Consumers and typed fixtures must be updated.
