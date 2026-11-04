# Research: Month closing

## Date lock rather than monthly closing journals

**Decision**: One inclusive `accounting.closedThrough` setting; no monthly financial postings.  
**Rationale**: Existing reports calculate dated ledger activity and accumulated earnings. Xero's date lock and Zoho's common lock show a simple usable pattern.  
**Alternatives**: QuickBooks warning/password overrides are weaker than existing individual permissions; NetSuite module workflows exceed this book's needs; ERPNext profit-transfer vouchers solve a separate year-end task.

Official sources: [Xero](https://central.xero.com/0/article/Set-up-and-work-with-lock-dates), [QuickBooks](https://quickbooks.intuit.com/learn-support/en-us/help-article/close-books/close-books-quickbooks-online/L59LelyPM_US_en_US), [Zoho](https://www.zoho.com/us/books/help/accountant/transaction-lock.html), [NetSuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1452509.html), [ERPNext](https://docs.frappe.io/erpnext/period-closing-voucher).

## Shared enforcement and atomic writes

**Decision**: Guard `queries/ledger.ts` insert/update/delete under immediate SQLite transactions. Keep compound application operations transactional and convert a known closed-period exception only after rollback. All financial entry points use these helpers, except contact merges and report-affecting master-data changes, which receive their own guards.  
**Rationale**: Inspection found invoice/import/reimbursement/correction paths converge here; low-level enforcement avoids REST/MCP bypasses. SQLite serializes writers and refuses a stale deferred WAL snapshot's upgrade. Mutations, numbering and audit must commit together; events must follow commit.  
**Alternatives**: Route-only checks miss specialty tools. Custom SQL triggers cannot be expressed by the existing Drizzle schema and would complicate typed refusals/migrations.

## Master data affects historical reports

**Decision**: Protect account classification/financial attribution used in closed history and contact merges that rewrite it. Protect Partner roster changes whenever closed ledger history exists.  
**Rationale**: Reports use current account subtypes, and partnerStatement divides historical results among current partners, even partners without postings. Guard role creation/removal/merge as well as ordinary editing. Names/codes/archives and other non-financial notes remain editable.  
**Alternatives**: Effective-dated master data would enable more changes but requires a wider reporting redesign.

## Review, permissions and evidence

**Decision**: Two explicit sensitive nondelegable permission leaves; existing administrators obtain them. Review/history use reports.read; status is narrow and authenticated. Reuse settings audit rows scoped to recordId closing, leaving global audit permissions unchanged. SSE shares status to the shell.  
**Rationale**: Existing catalog, audit and eventStream patterns cover all necessary behavior without schema or permission migration. Hash the review's audit high-water mark, boundary and computed warnings/integrity; recompute while holding the close transaction.  
**Alternatives**: Independent approval workflow and immutable report snapshots are deferred. Review invalidation may conservatively include unrelated audited writes, a safe and simple tradeoff for this book.

## Operational state and reopening

**Decision**: Pure matching/allocations remain live; later payments can settle closed invoices. Reopen from a month moves the boundary to the preceding month end, or clears it when all actual protected history is reopened. Require a reason and show all affected months.  
**Rationale**: Existing settlement state is current, not historical aging. NetSuite also reopens subsequent closed periods because earlier changes affect later balances. Open-period reversal postings can remain available when the original closed postings are unchanged.

All implementation unknowns resolved by repository inspection and accepted proposal. Research agents inspected write paths and UI/permission integration; no live books were accessed.

## Approved interaction revision (2026-11-04)

One confirmation replaces manual checklist and notice acknowledgments. Existing automated guards remain. Accounts main is the best current entry because it represents the whole chart; account detail would imply a single-account scope, Reports is read-oriented, and a new Accounting navigation section is unnecessary for one monthly feature. Use `/accounts/closing`, preserve `/closing` as a redirect, and reuse app primitives plus a custom month grid.
