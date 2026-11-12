# Release limitations and tax preparation notice

- Tax worksheets and custom schemes are preparatory workings, not a filing,
  tax payable calculation, certified national engine or determination of
  Malaysian tax eligibility. Scheme percentages, effective years, ownership/use
  conditions and business-use basis require accountant verification.
- Jurisdiction is explicit and independent of currency. UK/US selection does
  not implement UK pools/AIA or US MACRS/Section 179/bonus. Proration, incentives,
  special statutory utilisation limits/order and tax-currency conversion are unsupported.
- Tax disposal/balancing allowances or charges and a complete book disposal
  workflow are unsupported. Stop/reverse depreciation is not asset disposal.
- Initial allowance already recorded counts as history even if unused. Opening
  tax residual and unabsorbed allowance are separate. New schedules automatically
  use allowances up to eligible same-business income. The derived income basis is
  limited to an ordinary MY single-business book with operating revenue (including
  unclassified revenue, as on the P&L), tax add-backs and signed annual adjustments.
  Other revenue (such as bank interest) is excluded from allowance capacity but
  remains in accounting profit and the annual result. This uses the saved revenue
  classification; tax eligibility still needs verification. Expenses/add-backs
  remain on the single-business basis; source-specific expense allocation is not
  calculated. Multiple businesses and other jurisdictions remain outside the
  simple automatic flow; completion blocks with the exact cause.
  Reductions below usable allowances are not automatically carried forward.
  Earlier manual schedules and finalised evidence retain their saved figures;
  reviewed carry-forward eligibility remains the accountant's responsibility.
- Unclassified and Requires review expense lines block accounting month close.
  Unposted depreciation warns. Tax finalisation is separate from month close;
  accounting reopening does not rewrite finalised tax evidence.
- Depreciation is full-month straight line, integer minor units, final-period
  rounding. No daily proration or business-use multiplier. Unattended processing
  runs only while the application is running and under valid approver authority.
- A pending 0049 upgrade with earlier allowance evidence refuses conservatively.
  There is no destructive reset switch. Preservation/conversion of affected old
  workings requires a separate reviewed design. Already-deleted evidence needs
  a pre-upgrade backup; this patch cannot reconstruct it.
- Evidence snapshots grow with source lines and retained revisions. Performance
  results are synthetic and hardware-specific. See performance.md for measured
  limits; a passing small fixture does not establish million-line suitability.
- Owner real-copy upgrade/restore, UI/mobile/print accessibility QA and final
  release approval remain required. Existing repository lint debt is tracked
  separately. No live book or deployment was opened during implementation.
