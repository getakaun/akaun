# Data model: Month closing

## Closing state

Existing settings row: key `accounting.closedThrough`, value a valid `YYYY-MM-DD` elapsed month end. Missing/empty means no protected history. No new tables or per-entry closed flags.

## Review (computed, not stored)

`closedThrough`, `monthEnd`, `dateFrom`, opaque `revision`, warnings `{id,message}[]`, integrity `{ok,recordsChecked,problemCount}`. Based on canonical reports and review queues, scoped to the newly protected range. Drafts and queues remain unposted.

## Audit history

Reuse audit_log: recordType settings, recordId closing, action update. Changes include old/new boundary, close/reopen operation, checklist/warnings or reopen reason. Actor/channel/time use existing audit scope. Never delete old events. Return a narrow history containing no unrelated settings.

## Transitions

- Unset -> elapsed month end: first close protects all earlier history, with explicit acknowledgment.
- Date A -> later month end B: close protects the entire new range, after fresh review.
- Date B -> predecessor of reopen month: reopen the requested month and all subsequent closed months.
- Date B -> unset: reopen all actual protected history.
- Same/earlier close, future/invalid date, stale revision, incomplete checklist, failed integrity or missing permission -> no change.

Financial fields and actual movement content are compared on updates. Metadata-only and unchanged values remain permissible. Master-data classification and partner membership are guarded because they alter historical report results.
