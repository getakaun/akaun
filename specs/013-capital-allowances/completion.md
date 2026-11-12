# Phase 6 — delivery report

**Branch:** `codex/capital-allowance-schedule` · **PR:** #72 · **Owner acceptance:** pending.

The tax worksheet now uses scheme-based asset deductions and one worksheet save flow. No release, deployment or real-book migration was performed during development.

## Resulting workflow

Settings → Tax holds the default jurisdiction and reusable schemes. The worksheet shows relevant registered assets automatically, including matching prior-year opening tax balances. Selecting a scheme shows its calculated allowance immediately. Expand an asset only to adjust necessary basis facts or an exceptional first-year treatment; rates and deduction amounts come from the scheme.

The claim summary separates available allowances from amounts actually used. **Use available** is explicit; opening tax residual and unused allowance balances are different quantities. Worksheet-level **Save draft** retains valid incomplete work and confirms included first-year treatments together. **Finalise worksheet** saves pending work, records review and locks a completed period in one action when the actor has all required permissions. Separate reviewers and finalisers retain their existing authority limits.

Editable draft figures update from bookkeeping and asset events. Untouched inputs refresh automatically; edited inputs are protected. Changed-source annual corrections remain unresolved until replaced or withdrawn, and source hashes protect unsaved corrections. Concurrent saves cause a version conflict rather than overwriting edits. Finalised figures remain fixed, and later changes require an amendment. CSV and printable HTML use saved evidence; save a draft before exporting current changes.

The asset section has no Manage schemes, Asset register or Create scheme hyperlinks, and no manual-totals switch. General tax adjustments and business losses remain available outside asset deductions.

## Upgrade impact

Migration **0049** deliberately clears all pre-release capital schedules and affected command receipts and removes manual current-year/brought-forward allowance adjustment rows. Affected latest tax worksheet revisions return to draft with an increased version and cleared review/finalisation markers; a system audit entry explains the reset. Owners must select asset schemes again.

The migration preserves scheme definitions, accounting records, movements, assets, depreciation, ordinary adjustments, business losses and existing audit history. It does not convert old manually entered amounts into scheme calculations. Older retained tax revisions are not made editable; unsupported pre-release deduction evidence is removed from them as part of the authorised cleanup. Do not roll back to an application expecting the removed manual schema; restore a development backup or use the updated application.

## Owner walkthrough

1. In Settings → Tax, select the jurisdiction and create an appropriate custom scheme. Confirm its rules separately before relying on it for filing.
2. Open a worksheet, select a scheme for each claimed asset and check qualifying cost, business use and first-year treatment.
3. Enter utilisation in the claim summary, save a draft, and confirm reopening retains the worksheet.
4. Change a bookkeeping record and check the draft updates while local edits remain protected.
5. Resolve readiness items and finalise. Change another record and confirm the completed figures stay fixed and an amendment is offered.

## Limits and verification

This is preparatory tax working software, not tax filing or a certified national tax engine. UK pools/AIA, US MACRS/Section 179/bonus, statutory utilisation limits/order, prorating, special incentives and disposal/balancing allowance or charge calculations are unsupported. Book asset disposal remains a separate accounting operation.

**228 tests passed across 15 files**, including migration 0049 reset/rollback, scheme arithmetic, first-year history, master saves, permissions, live staging, records and fixed assets. Type checking reports zero errors/warnings. Changed-file ESLint/format and isolated server rendering pass. Repository-wide lint still stops on its existing 231-file formatting backlog. No configured application, real book or deployment was opened; browser/mobile checks remain with the owner under repository policy.

See [schemes-completion.md](schemes-completion.md) for calculation and structure details.
