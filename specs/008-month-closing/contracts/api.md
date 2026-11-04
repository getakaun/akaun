# Closing API contract

All endpoints authenticate; modifying actions also use normal same-origin protection. Closed-date financial refusals use the existing 409 `{error,reason}` shape; MCP returns REFUSED. No closing tools are delegated to tokens/apps.

| Endpoint                                     | Access                                         | Result                                                                                       |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET /api/closing/status                      | Signed in                                      | `{closedThrough}` only.                                                                      |
| GET /api/closing/stream                      | Signed in                                      | SSE initial status and subsequent boundary events.                                           |
| GET /api/closing                             | reports.read                                   | Closing page data and narrow closing history.                                                |
| GET /api/closing/preview?monthEnd=YYYY-MM-DD | reports.read                                   | Review DTO from data-model.md.                                                               |
| POST /api/closing/close                      | reports.read + closing.close; browser session  | `{monthEnd,revision}`. Revalidate atomically.                                                |
| POST /api/closing/reopen                     | reports.read + closing.reopen; browser session | `{fromMonth:YYYY-MM,expectedClosedThrough:string,reason:string}`; reason 10–2000 characters. |

Failures preserve existing authorization/validation/refusal/conflict status conventions. Do not expose unrelated financial reports/history in status streams. UI /accounts/closing uses the same authorized operations as API actions.

`/closing` redirects to `/accounts/closing`. Month changes automatically prepare the review; a single confirmation submits closing. Notices are non-blocking and are recorded with server-computed checks in the audit.
