# Month closing

Akaun stores one inclusive `accounting.closedThrough` boundary in existing settings. Missing/empty means open. No new schema, period rows, per-record closed flags, or monthly journals are introduced.

## Using it

Open **Accounts → Month closing** on the chart’s main page and select a completed month. Checks run automatically, then one dialog confirms the close. The workspace covers all accounts; individual account detail pages do not offer closing. The review checks ledger integrity and warns about pending imports/items, draft invoices, unresolved/unread bank statements, incomplete history and classification notes. A permanent completeness reminder explains that uploaded data cannot prove every receipt/statement was supplied. No checklist or notice acknowledgments are required. Notices are informational; integrity, expense tax classification, date, permission and stale-review checks block invalid closes. Unpaid invoices/bills/reimbursements do not block closing.

The first close protects all earlier history. Later closes can cover several months, with the review covering the newly protected range. Reopening from a month also opens every subsequent closed month; a reason and current boundary are required. All-history reopen clears the boundary. Existing settlement/reconciliation/document restrictions continue to apply.

## Mandatory expense tax review (owner-approved 5 November 2026)

Every active Expense movement in the newly protected range must have a saved classification before closing. Historical NULL snapshots, missing percentages and Requires review block closing. A resolved 0% classification is valid. The check counts lines independently of their signed net amount, so a refund and expense netting to zero do not escape review. True void pairs are excluded. The first close checks all earlier actual history; later closes check only dates after the current boundary. Existing closed history is never relabelled or silently reopened.

The preview displays the unresolved count, signed net amount and record links, with a link to the Expense tax report filtered to Needs tax review. Its result and line identities participate in the review revision. Closing recomputes this check inside the same immediate transaction as the boundary/audit write and refuses unresolved or stale reviews. Successful closing retains a `taxReviewCheck` audit field. Informational notices remain non-blocking; tax classification is a separate blocking check. Classification completeness does not imply accountant approval or tax-law eligibility.

## Authorization and evidence

`closing.close` and `closing.reopen` are explicit, sensitive, nondelegable leaves. Both require `reports.read`, and both reject token/OAuth credentials even if supplied artificially. Existing Administrators receive new leaves through normal superuser permission resolution. Other users require a deliberate grant. Preview and narrow history require `reports.read`; signed-in users can read only the boundary from status/stream. Unrelated settings/history remain protected by their existing permissions.

Close/reopen use existing append-only audit rows (`settings`, recordId `closing`). Rows contain old/new boundary, actor/time/channel and server-derived automated checks/notices or reason. The page shows the latest 50 actions. SSE publishes only the boundary after commit. Existing live paid/matched statuses and report presentation are not archived report snapshots.

## Enforcing the boundary

`server/closing/policy.ts` is the common policy and typed refusal. `queries/ledger.ts` guards insert/update/delete inside immediate SQLite transactions. Every update checks both original and proposed dates, including metadata-only and unchanged patches. Attachment mutations check the parent entry date; posted-invoice edits check the linked posting date. Delayed OCR leaves closed stored text untouched; derived search indexes can still be rebuilt. Numbering and movement writes remain inside the transaction.

Services retain their original typed refusals while combining financial mutations and audit writes atomically. Compound invoice/import/reimbursement/correction operations let the closed-period exception unwind the outer transaction before application wrappers turn it into REFUSED. Import cleanup restores its original receipt location. Success events are deferred until commit. SQLite BUSY/LOCKED failures are returned as conflicts at the application boundary without automatic retries.

Master-data guards protect account classifications used in closed history, direct contact-merge attribution and Partner roster changes. The roster is global because current partners divide all historical net profit. Partner share rounding uses stable numeric contact IDs, preserving shares across alphabetical display/name changes. Startup subtype and contra-revenue repairs skip protected history, so an upgrade cannot silently regroup closed periods.

Pure payment allocation and bank matching remain available when they change no posting or financial attribution. Later open-period payments and explicit open-period reversal postings can reference closed obligations without rewriting original closed entries. Do not present live allocation/match status as historical aging or frozen reconciliation evidence.

## Concurrency

Closing recomputes the review while holding an immediate write transaction and compares an opaque revision based on the boundary, audit high-water mark, warning content and integrity inputs. The preview uses a consistent read transaction. Unrelated audited changes can conservatively invalidate a review; refreshing is intentional. SQLite serializes writers, and a stale deferred WAL reader cannot upgrade to a write after another connection closes the book. Reopening similarly requires the current boundary. No operation silently advances an accounting date around the lock.

## Validation

New isolated tests cover policy boundaries, no-op edits, numbering/transaction rollback, two WAL connections, close/reopen authorization and warnings, master-data/startup protection, invoice/import/correction paths, later settlement, MCP refusals and stable partner rounding. Fixtures migrate temporary/in-memory SQLite databases and use temporary receipt storage. No real book is opened and no application dev server is started.

The plan, contracts and maintainer UI validation scenarios are in [specs/008-month-closing](../specs/008-month-closing/quickstart.md).

The canonical UI address is `/accounts/closing`; `/closing` redirects for existing bookmarks. Month selection uses a custom Popover month grid, styled like the existing DatePicker, and supports constrained months plus year navigation. The page is built on the shared `DetailPage` frame. The hero shows the boundary, the main column holds the close card (checks, notices and report links), and the rail holds the history. Reopening is a drawer opened from the topbar. The app has no global banner. The boundary is shown in three places: the Accounts toolbar status link, which is live through the layout's closing context and is also the way in; the orange record and invoice lock icons; and the read-only notes on locked forms. The close request is only `{monthEnd, revision}`; automated check evidence is recomputed and audited by the server.

The shared read contract explicitly adds `RecordView.periodClosedThrough: string | null`, derived once per batch. Invoice views and statement selection metadata also expose period closure. Existing `locked`/`lockedReason` remain dependency-only, preserving settlement/reconciliation logic. Orange month-close locks take precedence over gray dependency locks, with “Month closed — reopen to edit” as the tooltip. The app layout shares the reactive SSE boundary through per-layout context; a live null boundary means reopened and overrides stale DTO flags. Fields, correction dialogs and attachment upload/delete handlers all respect this state. Viewing/downloading remains available.
