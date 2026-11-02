# Expense contact correction

## Plan and implemented behavior

- Share the **Correct contact…** action and dialog between expenses and outgoing
  payments. Payment corrections keep their existing application operation, REST
  endpoint, permissions and MCP tools.
- Add a contact-only expense operation and GET/POST
  `/api/records/[id]/contact-correction`. Require `records.read`, `records.update`
  and the explicit, sensitive `records.correctContact` permission. This new
  permission is granted by name; no migration broadens existing roles, PATs or
  OAuth scopes. Superusers have it through the normal permission resolver.
- A supplier correction updates both supplier/contact attribution on ordinary
  expenses. On personally paid expenses it updates only the supplier; changing
  the person owed is a separate choice in the same dialog. Inspect the actual
  reimbursement control account for older personally paid records too.
- Search contacts on the server through the correction-authorized
  `/api/records/[id]/contact-correction/contacts` endpoint. The picker can find
  suppliers, personal payers and payment recipients beyond the page loader's
  first 500 contacts, without adding a separate directory permission. Retain
  fetched names for review and allow selecting existing contacts only.
- Show paid/outstanding amounts, old/new contact and the effect on ownership
  before confirmation. Require an existing different contact and a reason.
- Preserve movement IDs, amounts, dates, bank matches, active allocations and
  reversal history. Account totals and paid status remain derived as before.
- Validate live allocations against their actual control accounts. Ordinary
  Accounts Payable payments can cover expenses across suppliers, as already
  allowed by the settlement service. A personal-payer correction must agree
  with existing reimbursement recipients. Refuse ownership corrections linked
  to legacy generated reimbursement transfers; reverse that reimbursement first.
- Hash the expense, active allocations, linked record versions and reimbursement
  dependencies in the preview version. Recheck inside the write transaction.
  Write the field changes and reason in the same transaction, then emit record
  updates for the expense and linked records after commit.
- Keep ordinary settled/reconciled expense contact edits locked, including
  supplier and personal-payer aliases.

## Verification

Regression coverage lives in `application/records.spec.ts` and permission catalog
specs: partial/full settlement, contact balances, personally paid suppliers,
incompatible payers, bank matches, unchanged ledger history, stale allocations,
invalid input, explicit permissions, legacy transfer dependencies and audit
failure rollback. Existing payment and reimbursement suites exercise the shared
accounting behavior. The record action fixture and assertions use the new label.

Run type checking and lint. Browser verification is left to the user under the
repository's verification policy.

## OAuth and MCP

Agents can use `get_expense_contact_correction`,
`search_expense_contact_correction_contacts` and `correct_expense_contact` with
`records:read`, `records:write` and the independent opt-in
`records:correct-contact` scope. All three require `records.read`, `records.update`
and `records.correctContact`, bounded by role, delegation ceiling and credential.
The scope appears unchecked under Corrections. Existing grouped correction grants
remain unchanged and do not include expense-contact correction; reconnect and
select the new scope explicitly. PATs still select individual permissions.

Preview returns fields, blocked reasons, the record and its version. Search takes
`recordId` and a nonempty `search`, returns up to 50 existing contacts and needs no
separate `contacts.read` permission. Correction takes `recordId`, `field`
(`supplier` or `paidBy`, as offered in preview), `contactId`, `reason` and
`expectedVersion`, reusing the REST operation and all accounting safeguards.
Agents must present old/new contacts, paid/outstanding amounts and ownership effects
and obtain reviewed confirmation before writing, including renewed review after
stale-version failures. MCP annotations describe this as a destructive,
non-idempotent write; confirmation remains client-guided.
