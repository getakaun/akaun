# Phase 6 — manual capital allowance schedules

Owner authorised implementation after reviewing the market comparison and simplified proposal. Base: current main `decc118` (phase 5 / PR #71). No statutory rate engine, filing, deployment or live migration.

## Design and implementation map

- Add `capital-allowance.ts` for strict inputs, integer cents/basis points, reproducible manual calculations and review issues. All entered allowance/residual amounts are business-use-adjusted MYR amounts; qualifying expenditure and business-use percentage explain the basis without multiplying an already adjusted claim twice. No defaults assert eligibility.
- Add revision-owned `tax_capital_schedules` retained JSON evidence and append-only command receipts via migration 0047, schema and Drizzle metadata. Snapshot rows include server-captured asset/purchase evidence. Existing phase 5 snapshots and exports retain their old format when no schedule exists. Copy evidence into amendments; protect finalised rows at the database boundary.
- Reuse the tax application transaction, permissions, optimistic version, audit and committed SSE signal. Prepare, update, explicit accounting-evidence refresh, manual-total replacement and reviewed prior-year rollover all use the same boundary. Separate hashes cover asset/predecessor evidence; review/finalisation revalidate them atomically.
- Integrate a schedule summary and row/settings drawers into the existing annual worksheet. No extra navigation, per-asset approval or purchase-registration fields. Asset details link to retained tax history only for tax readers.
- Current-year allowances and brought-forward utilisation remain separate. Attribute balances/utilisation to a named business source and origin YA; current-year utilisation is explicitly reviewed. Tax residual expenditure is distinct from unabsorbed allowances. No automatic statutory ordering or claim optimisation.
- Schedule activation explicitly withdraws overlapping manual `capital_allowance` / `allowance_brought_forward` entries with retained history and a reason. Block new overlapping entries while active. Losses and unrelated tax-only adjustments remain unchanged. Switching back is explicit and audited.
- Disposal captures manual balancing allowance/charge, date, proceeds and evidence. Full tax disposal removes the remaining asset tax residual; book disposal/depreciation remain separate and visibly require attention. Special/accelerated allowances, hire purchase, partial disposals and complex incentives remain deferred.

## Verification and rollback

Use the safe Bun preload and migrated in-memory/temporary fixtures only. Cover GL/report identity, exact sums and rounding, no duplicate claims, negative/unsafe values, source drift, stale writes, retries and rollback, finalised database guards, amendments, disposal and rollover, YA/source attribution, permissions and isolated books, old/new exports and migration preservation. Run the phase 5 regression manifest, type checking and lint, reporting pre-existing issues separately. Per CLAUDE.md, owner performs browser/mobile checks; do not start the configured application or open real books. Roll back application code while retaining additive evidence tables and audit; never delete finalised evidence.
