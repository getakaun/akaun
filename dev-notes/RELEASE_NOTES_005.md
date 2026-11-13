# Release notes — Agents get 28 workflow tools, batch writes with dry runs, and a merge scope

## If you connect an AI assistant, read this first

**The tool names changed.** The 68 tools of the previous release are replaced by 28, and every name now starts with `akaun_`: `list_records` became `akaun_search_records`, `create_record` became `akaun_create_records`, and so on. Nothing keeps the old names.

- A Claude Code permission rule for a single tool needs the new name. A rule such as `mcp__akaun__list_records` no longer matches anything; write `mcp__akaun__akaun_search_records`. (The full name looks doubled because Claude Code adds the server name `akaun` in front of the tool name.)
- A rule for the whole server, `mcp__akaun`, still works.
- Reconnect, or refresh the tool list, in each client. Clients keep the list they read last.
- Your connections keep what you granted. A connected app or a personal access token gains **no** new access from this release; the merge scope below is not granted to anyone until they choose it.

---

## What changed

### 28 tools, built for the jobs agents do

15 read tools and 13 write tools replace 68 tools that mirrored the endpoints. They are shaped by the work: find records, read a report, reconcile a bank account, correct a record, merge duplicate contacts. A new first call, `akaun_get_books_overview`, tells the assistant the currency, today's date, the closed-through date, the work waiting and what it may do. New reads cover totals by category, account, contact or month, a trial balance, ranked bank-match candidates, the categories past records used, and `akaun_review_books`, a list of things that may need attention (missing receipts, duplicate records, unresolved tax, overdue invoices and more).

Answers are shorter, money is always a decimal string ("1285.50") with its currency, and every error says how to fix the input.

The server also sends the assistant short instructions, and three prompts that Claude Code shows as slash commands: `month-end-review`, `categorise-expenses` and `reconcile-account`. The old description-review prompt and the `akaun://context` and description-policy resources are gone; their content moved into the new tools.

### Writes are batched, and you can preview them

A write tool saves when it is called, as before. A call now carries up to 50 items and is **all or nothing**: every item is saved, or none is, and the result says how each item went.

- **`dry_run`.** Add `dry_run: true` and the call runs every rule and rolls back, returning exactly what a save would change. The assistant is told to do this first for corrections, voids, deletes, merges, unmatching, journals and applying a tax default to existing entries, and to save only after you agree. This is guidance, not a lock: the protection that the server enforces is the opt-in scopes, which stay off unless you choose them when you connect.
- **Corrections pick their own path.** The assistant says what a record should end up saying; Akaun chooses the plain edit or the right correction (settled date, supplier, amount, reimbursement) and says what it would reverse and reapply. A settled expense whose amount left out freight is fixed in one step.
- **Safe retries.** An `idempotency_key` makes a retried call return the first result instead of saving twice. Keys last 24 hours.
- **One request, one history.** Each write returns a `request_id`. `akaun_get_change_history` lists everything that call changed, and each change is still audited under your name.

Changing an account's **tax default** still changes only the lines you enter after it. Existing entries change only through the same **Apply default to unclassified entries** choice as in the app, which an assistant reaches with `apply_tax_default`: a dry run first, then the change with the revision it returned.

### Merging contacts has its own scope

An assistant could not merge contacts before, because a merge cannot be undone. It now can, behind a new opt-in scope, **`contacts:merge`**. The Connect page shows it beside the deletes, unchecked: "Merge duplicate contacts — moves every record of the merged contacts to the one kept and deletes the others. Cannot be undone."

- It is off unless you tick it. Change access and delete access do not include it, so no existing connection gains it.
- A merge still needs the user's own **Merge**, **Change** and **Delete** permissions on **Contacts**.
- A dry run lists every record that would move. Run it first.

These stay in the app and are still not offered to an assistant: closing and reopening a month, editing or deleting a line of a bank statement, deleting an attachment, platform payouts and new Auto Import uploads.

### Fixed: the paid filter of the records list

Asking the records query for **paid** records returned none of them. The condition was written so that it only matched voided records with an amount still owed. The unpaid filter was correct. It is fixed in the shared query, so everything that filters records by paid state now gets the paid records: `GET /api/records?paid=true` and the assistant's `status: "paid"`.

---

## Upgrading

The upgrade runs itself when the app starts. It adds one table (`mcp_idempotency`, for the retry keys) and one column (`record_attachments.sha256`, so duplicate receipts can be found) and removes nothing. As always, copy `data/akaun.db` and the whole `data/storage/` folder somewhere outside `data/` before you install.

A file attached through an assistant gets its checksum at that moment. Every other file gets its checksum the first time a duplicate check needs it.

`BODY_SIZE_LIMIT` must still be at least `21M` for an assistant to attach the largest files. The Docker image sets it.

The user guide page [Connect AI assistants](../docs/docs/09-administration/connect-ai-assistants.md) and the developer contract [MCP](MCP.md) describe the new tools.
