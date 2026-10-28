# Permissions: catalog, delegation ceilings, tokens and apps

Date: 2026-10-15. Replaces the view/add/change/delete grid (`group_permissions`,
`user_permissions`) and the raw one-per-user API token (`users.bearer_token`).

## The model

Every request is checked against one set of leaf permissions, worked out in the
request hook:

```
effective = role                       groups' grants ∪ the user's own grants; a superuser: everything
          ∩ delegation ceiling          only through a credential: what the user's groups let members hand on
          ∩ credential permissions      a personal access token's own list, or an OAuth app's scopes expanded
```

- A browser session acts with the whole role.
- A personal access token or an OAuth app acts with role ∩ ceiling ∩ its own permissions.
- The intersection is taken on **every request**, so narrowing a group's grants or its ceiling takes effect on every existing token and app at once. Nothing stored on a credential needs rewriting.
- The superuser shortcut is inside "role", so a superuser's token is still bounded by what the token was granted.

Code: `effectivePermissions` / `loadRoleAccess` / `resolveAccess` / `can` / `canAll` in `src/lib/server/permissions.ts`. A route asks `can(locals, "invoices.issue")`. An authorized operation asks `requirePermissions(ctx, [...])`. Nothing reads a superuser flag (a spec enforces this).

## The catalog

`src/lib/permissions/catalog.ts` holds one tree of `root.verb` leaves. Each leaf has a label and a description. The file is shared with the pages.

- **Implication.** A root (`invoices`) grants its leaves except those marked `explicit`. No verb implies another: `update` does not imply `read`. The seeded Data Entry group adds records it cannot read.
- **Flags:**
  - `explicit`: never implied by the root (`records.adjust`).
  - `sensitive`: left out of default ceilings (`records.adjust`, `settings.manage`).
  - `delegable: false`: never in a token or app (`users.manage`).
  - `superuserOnly` (on a root): never granted to an ordinary group (`users`).
- **Unknown strings are dropped on read** and refused on write. A retired permission therefore makes stored data inert rather than broken.

Special abilities that used to hide behind a grid flag each have a leaf now:
- `import.confirm`, `import.profiles`
- `contacts.merge`
- `quotations.revise`, `quotations.convert`
- `invoices.issue`, `invoices.void`
- `reconciliation.match`
- `records.adjust` (was the `adjustments` resource)
- `settings.read`, `settings.manage` (Settings had no check at all)
- `users.manage` (was `locals.isSuperuser`)

Composite rules are kept exactly as before:

| Action | Needs |
|---|---|
| Send an invoice | `invoices.issue` ∧ `records.create` |
| Void an invoice | `invoices.void` ∧ `records.update` (∧ `invoices.create` to reissue) |
| Revise a quotation | `quotations.revise` ∧ `quotations.create` |
| Convert a quotation | `quotations.convert` ∧ `invoices.create` |
| Merge contacts | `contacts.merge` ∧ `contacts.update` ∧ `contacts.delete` |
| Record a bank line as a transfer | `reconciliation.create` ∧ `records.create` |
| Set an opening balance | `accounts.update` ∧ (`records.create` or `records.update`) |

Import confirm needs `import.confirm` alone (006 FR-045).

## Storage

| Table | Holds |
|---|---|
| `group_grants(group_id, permission)` | What a group's members can do |
| `user_grants(user_id, permission)` | Extra permissions for one user. They only add, and are **never delegable**: given to the person, not to their tools. |
| `group_delegations(group_id, permission)` | The ceiling. Always ⊆ that group's grants: saving grants trims it in the same transaction (`trimDelegations`, `admin/access.ts`). A user's delegable set is the union over groups of (ceiling ∩ grants). |
| `personal_access_tokens` | Hashed tokens. See below. |

Screens store leaves only. A stored root would widen silently when a leaf is added to it.

Migration `0033_permission_grants_data.sql` converted the grid row for row through the mapping in `permissions/legacy-map.ts` (`LEGACY_MAP`), and a spec keeps the two equal. It also:
- seeded each group's ceiling as its grants minus the sensitive ones and minus settings;
- gave every non-superuser group `settings.read`;
- revoked every legacy API token.

The old tables and `users.bearer_token` are unread and are dropped in the next release.

## Personal access tokens

`src/lib/server/tokens/pat.ts` handles the format and authentication; `src/lib/server/tokens/manage.ts` handles create, update, regenerate and revoke.

- **Format.** `akp_` + 36 base62 characters + a 6-character CRC32 checksum. The prefix lets secret scanners recognise a leaked token, and the checksum lets a malformed one be refused without a lookup.
- **Storage.** Only a SHA-256 of the token is stored, looked up by an index.
- **Permissions.** Chosen at creation, ⊆ the owner's delegable set (validated), and intersected again on every request.
- **Expiry.** Optional. The owner picks a date (`expiresOn`, `YYYY-MM-DD`); it is stored as the end of that day in UTC (`23:59:59.999Z`) and must be in the future. No date is stored as NULL and never expires. The New token page offers 6 months from today by default. There is no maximum: the `tokens.maxLifetimeDays` setting and `/api/tokens/policy` are gone.
- **Regenerate.** A new secret; name, permissions **and expiry** stay. An expired token is refused ("Create a new one") rather than brought back.
- **Limit.** 50 live tokens per user.
- **Last used.** `last_used_at` is written at most once a minute.
- **Where they work.** On `/api/*` and `/mcp`. The old `akn_` tokens get a 401 that says what replaced them.
- **Who manages them.** Only the owner creates a token: the form action on `/profile/tokens/new`, signed in as themselves. Regenerate and revoke are form actions on Profile → Access tokens (`/profile?tab=token`). **Form actions only**: a credential can never mint or widen a token. Administrators (`users.manage`) can list and revoke any user's tokens — `GET`/`DELETE /api/users/[id]/tokens` and `DELETE /api/users/[id]/tokens/[tokenId]` — but never create one (`POST` is removed). A service identity is a separate user with only the needed grants; a superuser signs in as it and makes the token on its profile.
- **Revocation.** A password change revokes all of a user's tokens and OAuth grants.

## The editor: levels per area

The screens (New token, a group's grants and ceiling, a user's extra grants) edit permissions as one row per area with a level — None / View / Edit / Full — or Custom, which shows a switch per leaf (`components/permissions/AccessEditor.svelte`). **Stored data did not change**: a level is only a quicker way to pick leaves, and any set that is not exactly a level reads as Custom (Data Entry's `records.create` without `records.read`).

- `src/lib/permissions/describe.ts`: `levelsFor` (levels worth offering — a level equal to a cheaper one is dropped, so Reports and Dashboard offer None/View and Settings None/View/Edit), `levelOf` (the level a set stands for, or `custom`), `describeArea` (the sentence under an area, "Can see, add, change and send invoices. Cannot delete or void."), `summarizeAccess` (per-area level + extras for the token list).
- Tiers come from `leafTier` in `catalog.ts`: `read` → View, `write` → Edit, `full` → Full. Default is `read` for `read`, `full` for `delete`, `write` otherwise; `contacts.merge` and `invoices.void` set `tier: "full"`. **Explicit leaves (`records.adjust`) are in no level** and always have their own switch.
- The sentences come from the catalog: each leaf carries `verb` ("send") or a free-standing `phrase` ("make adjustments"), and each root a `noun` ("invoices").

## Groups

- **Administrators is protected** (`PROTECTED_GROUP`, `admin/access.ts`): never renamed, changed or deleted, and the name is reserved. **Every other group can be changed** — Bookkeeper, Data Entry and Reviewer included: renamed, re-permissioned, deleted when empty.
- **Someone must still be able to manage users.** Protecting the group does not protect its members, so `keepsASuperuser` refuses to demote a superuser group, replace a user's groups, or delete a user when no user would be left in a superuser group. The group PATCH, membership PATCH and user DELETE routes check it.
- **Default groups are seeded once** (`admin/seed-groups.ts`, flag `groups.seeded`). A book with no groups gets them; a book with any groups is only marked. A deleted default group used to be re-created by name at every boot.
- **Fixed by design:** `users.manage` belongs to superuser groups only (it can grant anything, so the Superuser switch is the way to give it). A group hands on only what it grants. A user's extra permissions add to their groups' grants and cannot take any away.

## OAuth

Scopes stay coarse on the wire (`<area>:read|write|delete`, `$lib/permissions/oauth-scopes.ts`). This keeps scope strings stable for clients and existing grants, and the consent page short. On every request `expandScopes` turns them into catalog leaves (`SCOPE_PERMISSIONS`), and those are intersected like a token's permissions. There are no scopes for dashboard, settings or users: an OAuth token's audience is `/mcp` only.

`records:correction` is an opt-in, fixed allowlist of `records.correctAllocations`,
`records.correctPaymentRecipient`, `records.correctDate` and
`records.correctReimbursementAmount`. All four leaves are explicit and sensitive;
ordinary root/Full grants and default delegation ceilings do not acquire them.
The narrow date and reimbursement-amount scopes remain supported. Read/write
co-requirements still apply. Neither the new scope nor these leaves grants
permanent deletion or arbitrary adjustments.

Allocation and payee operations accept the new explicit leaves or their original
delete-based permission route. This preserves existing session, PAT and OAuth
behavior without rewriting any grants or running a data migration. MCP requirements
model complete alternatives (scopes AND permissions), shared by discovery,
invocation and grantable step-up selection. Existing grants do not gain new
corrections. Reimbursement-group reversal remains on its original create/delete
route and is outside the grouped scope.

- **Advertised scopes.** Protected-resource metadata advertises **reads only** in `scopes_supported`, the minimal set the MCP spec recommends. Write and delete scopes come by step-up: a 403 `insufficient_scope` naming them. The challenge is sent only when the user could actually grant those scopes (`allowedScopes(role)`), so a client never loops through consent it cannot complete.
- **Consent page.** It offers only scopes whose expansion intersects the user's delegable set. A scope the role could use but the ceiling blocks shows "Your administrator does not allow apps to do this". Reads are pre-ticked; write and delete never are.

## Adding a leaf

Answer each on purpose (see the comment at the top of `catalog.ts`):

1. **`explicit`?** Otherwise every group holding the root gets it immediately.
2. **`sensitive`?** Left out of default ceilings.
3. **`delegable: false`?**
4. **Does an OAuth scope expand to it?** If so, add it to `SCOPE_PERMISSIONS`.
5. **Tier and wording.** Set `tier` if the default (read/delete/other) is wrong, and `verb` or `phrase` for the summary sentence.
6. **Migration.** Grant it in a data migration to whoever should keep today's behaviour.
