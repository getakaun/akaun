# Scheme calculations and worksheet coordination

## Responsibilities

| Module                                                               | Responsibility                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `asset-tax-scheme.ts`                                                | Validated custom definitions, effective-year selection and precise rate arithmetic  |
| `capital-allowance.ts`                                               | Scheme-only row/schedule validation, residuals, utilisation and readiness issues    |
| `first-year-allowance.ts`                                            | Shared automatic first-year policy and prior-claim protection                       |
| `application/asset-tax-schemes.ts`                                   | Immutable scheme versions, permissions, audit and retry receipts                    |
| `application/capital-allowances.ts`                                  | Prepare, rollover, refresh and save; canonical definitions and server recalculation |
| `application/tax-worksheet-save.ts`                                  | One atomic save across worksheet sections and combined completion                   |
| `application/tax-worksheet-boundary.ts`                              | Authority, version, transaction and deferred audit/SSE boundary                     |
| `queries/capital-allowances.ts`                                      | Asset evidence, prior-year balances and live draft projections                      |
| `asset-tax-export.ts`                                                | Saved CSV/print workings without live accounting dependencies                       |
| `capital-editor.ts` / `worksheet-draft.ts`                           | Pure preview, staging and live-input reconciliation                                 |
| `CapitalInlineEditor` / `CapitalAssetFields` / `CapitalClaimSummary` | Inline choices, basis details and utilisation                                       |
| `CapitalRolloverSheet`                                               | Matching-currency recovery only                                                     |

## Calculation and evidence contract

- A claimed asset requires a scheme that matches the worksheet's jurisdiction and tax year. The server retains its canonical version and recalculates the submitted amounts.
- Tax jurisdiction is explicit and independent of book currency. Automatic prior-year balances require matching jurisdiction and currency; amounts are never silently relabelled or converted.
- Business use adjusts qualifying expenditure once. Opening residual, qualifying additions and residual basis corrections reconcile to that eligible basis. Schemes calculate first-year and regular deductions and cap them at the remaining residual.
- First-year policy uses asset dates, linked purchase provenance and prior claims. Previously recorded initial allowances count even when unused; an unfinished amendment cannot erase the last finalised claim. Missing decision metadata does not bypass server policy.
- Selecting a scheme previews immediately. Saving confirms all included first-year treatments together; there is no per-asset approval step.
- Current-year allowances and earlier-origin balances retain separate utilisation. Availability does not automatically allocate a claim or assert statutory eligibility.
- No manual total mode, deduction override, disposal/balancing input, version-1 evidence reader, row reference or row effective-year field remains. The worksheet and scheme already supply the relevant years.

## Save and update contract

Reads project editable drafts without writing. SSE brings accounting, asset and scheme changes into the page. One master payload carries staged expense decisions, adjustment changes and asset inputs. Optimistic versions and source/asset/predecessor hashes are verified in the same transaction; nested commands share deferred audit and SSE publication. A failed save leaves no partial evidence or notifications. Stable request keys allow an uncertain save result to be checked safely.

Finalised and retained revisions use saved snapshots. Later changes create amendments. Readiness and completion respect independent update/review/finalise permissions and signed-session requirements.

## Storage and validation

Migration 0049 removes the unreleased manual storage state and clears old workings rather than translating them. It resets affected latest worksheet revisions, records the reset, and preserves financial data and reusable schemes. Tests must verify this intentional reset and rejection of removed inputs rather than maintaining historical manual fixtures.

Final verification must cover scheme arithmetic, unsupported-input rejection, automated first-year history, country/currency separation, prior-year changes, incomplete drafts, atomic rollback, retry identity, permissions and unchanged financial rows. Browser and mobile checks remain owner-run.
