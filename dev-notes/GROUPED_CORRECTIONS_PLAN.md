# Grouped record correction access

Status: implemented and verified, 28 October 2026.

## Outcome and boundaries

An assistant can reopen an incorrectly settled expense, correct its amount,
correct the outgoing payment's payee, and reapply the original payment credit
without receiving permission to permanently delete records. Actual cash paid,
bank matches, source suppliers, IDs and retained allocation history follow the
existing accounting rules.

Add an opt-in `records:correction` OAuth scope with an explicit four-permission
allowlist: allocation correction, payment-recipient correction, settled-date
correction and reimbursement-amount correction. Keep separate internal role,
delegation and PAT permissions. Preserve the existing narrow date and amount
scopes. Keep ordinary write, permanent deletion and general adjustment access
independent. The grouped scope does not include legacy reimbursement-group
reversal, invoice voids, opening-balance removal, or bank-match removal.

## Research and design

- [OAuth security BCP, RFC 9700 section 2.3](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.3): limit token privileges to the application's use case.
- [Curity scope best practices](https://curity.io/resources/learn/scope-best-practices/): use stable business capabilities and retain detailed authorization behind scope checks.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): request minimum necessary scopes and support step-up authorization.
- [Xero granular scopes](https://developer.xero.com/faq/granular-scopes): preserve meaningful integration boundaries and require explicit authorization of new scopes.

Grouping simplifies consent, but an administrator granting the grouped scope
authorizes every correction in its allowlist. Internal role permissions cannot
make that app grant narrower for a user who holds every permission. Existing
narrow scopes remain available for integrations needing only dates or amounts.

## Implementation sequence

1. Add explicit, sensitive, delegable `records.correctAllocations` and
   `records.correctPaymentRecipient` leaves. Root/Full permissions and default
   delegation ceilings must not acquire them automatically. Add the grouped
   scope, its Corrections-tier classification and explicit consent wording.
2. Represent complete alternative scope/permission requirements in the MCP
   requirements table. Reuse these alternatives for discovery, invocation and
   step-up challenges; never treat alternative scopes as all required. Prefer a
   grantable route requiring the least additional access and avoid consent loops
   when the user's role cannot perform the action.
3. Allow the new leaves through the shared application operations, REST and UI.
   Retain existing delete-based authorization as a compatibility route, without
   changing any stored grants or expanding old scopes. Replacement allocations
   still require creation access; payee correction retains create/update access.
   Other accounting validation, concurrency, audit and transaction rules stay in
   the existing operations.
4. Update consent and administration documentation with the exact grouped scope
   boundary, prerequisites, compatibility behavior and re-consent requirements.
   Replace obsolete delete/recreate-payment advice and fix the same-contact
   settlement description to describe cross-supplier reimbursements accurately.
   Expose per-operation availability and missing scope/permission alternatives
   through the existing `akaun://context` resource.
5. Add regression coverage for the complete correction sequence, including lower
   and higher corrected expense amounts, unchanged cash postings, retained
   reversal history, supplier identity, stale versions, restricted roles and
   delegation revocation. Cover grouped OAuth, narrow scopes, PATs and legacy
   authorization, including correction without deletion.
6. Run isolated fixture tests, Svelte/TypeScript checks and lint; review the diff.
   Commit and publish a feature branch, then open a PR with results and any
   remaining limitations.

## Compatibility and rollout

No data migration or token rewrite is required: the legacy authorization path
retains the same actions, and new correction leaves are opt-in. Existing date and
amount grants retain only their original capabilities. The new scope never
expands `records:write`, `records:delete`, or a narrow correction scope. A new
consent grant is needed for grouped access. Administrators explicitly choose
the new role/delegation leaves; PAT owners explicitly choose token permissions.
Future materially broader correction operations require a separate scope or new
reviewed consent design, rather than silently extending this allowlist.

## Verification and acceptance

- Grouped correction + ordinary record read/write exposes permitted corrections
  and never exposes `delete_record`, adjustments or group reversal.
- Each correction remains limited by its individual role and delegation leaf.
- Existing delete-based and narrow-scope grants retain their prior behavior.
- A correction-only PAT can reverse an allocation without deleting records.
- An OAuth challenge names one complete grantable alternative, never a union of
  mutually alternative scopes or an unavailable permission.
- Reversal -> fresh expense amount edit -> fresh payee correction -> credit
  reapplication preserves the original payment and calculates correct remainders.
- Only in-memory databases and temporary storage fixtures are used; no dev
  server, production data access or browser testing is needed.

## Verification results

- 419 fixture tests pass across 13 suites, including MCP read/write, OAuth,
  permission catalog/levels, role/delegation, application corrections, ledger,
  settlement and API permission coverage.
- `bun run check`: zero errors and zero warnings.
- ESLint passes for all changed TypeScript and Svelte files.
- Changed TypeScript files and the new plan pass Prettier checks. Repository-wide
  `bun run lint` stops on existing formatting issues; baseline comparison confirms
  the remaining warnings also fail formatting at the unchanged base commit.
- `git diff --check` passes. The checks use isolated databases and temporary file
  storage; no application server or production data is used.
