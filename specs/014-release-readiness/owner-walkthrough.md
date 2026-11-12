# Owner acceptance — disposable book only

Record the candidate commit, application version, configured business timezone,
browser/device and grant assignments. Do not run this against the only copy of
real books. No UI acceptance or screenshot is claimed by automated tests.

1. **Historical upgrade:** obtain a stopped-application database/storage backup
   and restore to an isolated location. Run the preflight against that copy.
   If 0049 has affected evidence, expect a refusal and retain the old version.
   Confirm that no schema, finalisation state or evidence changed on refusal.
2. **Classification:** create a RM1,000 expense at 50%, plus split lines and a
   refund. Confirm the first expense contributes RM500 add-back. Unclassified
   and Requires review lines block month close, even when signed totals net
   to zero. An account-default change affects new entries only.
3. **Cleanup:** apply a saved default to untouched unclassified entries with a
   reason. Confirm counts, explicit decision protection and 200-line batching.
   An old confirmation refuses after another session changes the account,
   records or close boundary. Import/API attempts cannot change closed sources.
4. **Assets:** capitalise RM12,000 and register the linked asset. There is no
   additional purchase/cash journal. Register/GL cost reconciles. Legacy opening
   exceptions are visible rather than silently filled in.
5. **Depreciation:** approve a zero-residual 36-month schedule, preview January,
   post and retry. Ordinary months charge RM333.33, final month RM333.45.
   Verify debit expense/credit contra asset and one 0% tax add-back. Close the
   month and attempt another posting. Due-but-unposted depreciation is a warning.
6. **Audited corrections:** reopen with a reason, correct and re-close. Try a
   depreciation reversal in an open correction month; original history stays.
   Stopping depreciation must not be described as a disposal.
7. **Annual tax:** change the annual treatment of the closed RM1,000 expense
   from 50% to 100%. Expected add-back reduces by RM500; original January source,
   P&L, balance sheet, cash flow and bank reconciliation remain unchanged.
8. **Asset deductions:** create a clearly labelled custom test scheme and
   select it inline. A _synthetic_ 20% first-year + 10% original-cost scheme on
   RM12,000 at 100% business use calculates RM3,600 allowances and RM8,400 tax
   residual. With RM1,000 eligible trading income (after expense add-backs),
   RM1,000 is used automatically and RM2,600 is unabsorbed. With sufficient income,
   all RM3,600 is used; in a loss year none is used. No **Use available** click is
   required. Revenue without a subtype must calculate as operating income, and
   signed annual adjustments must update usage automatically. No income-limit,
   reason or override form is required. Multiple businesses or non-operating
   income show one limitation and block completion. Saved manual settings need
   an explicit switch to automatic; finalised evidence stays fixed. These rates are
   arithmetic fixtures, not recommended Malaysian tax rates.
9. **Completion and rollover:** save/finalise a completed YA with the required
   authority. Next YA carries residual and unused allowance independently;
   initial allowance is not newly granted because utilisation was zero. Change
   a scheme, source, jurisdiction or prior-year amendment in another session.
   Draft inputs retain local edits or require refreshed evidence; finalised
   exports stay fixed. Amendments retain predecessors. Future periods cannot
   be finalised.
10. **Roles:** test reader, preparer, reviewer and finaliser independently.
    Missing authority gives a clear refusal. PAT/OAuth cannot finalise/amend.
    Tax evidence is unavailable with report/record access alone. Test a second
    separate book containing the same numeric IDs.
11. **Mobile/accessibility:** at phone widths, zoom and keyboard-only operation,
    complete inline edits and drawers; verify labels, errors, unsaved-change
    prompts, tab order, focus return and focus visibility above sticky controls.
    Review 24 CSS px target sizing or applicable spacing exceptions. Live updates
    must not discard typed amounts. Confirm financial submissions can be checked
    and corrected. This is scoped WCAG QA, not full certification.
12. **Exports and restore:** save the draft before exporting. CSV/print totals
    match saved evidence and revision labels; long references do not hide values.
    Restore the coordinated backup into an isolated deployment with automation
    controlled. Compare statements, register, tax exports, audit, receipt files
    and integrity checks. Record elapsed time and any discrepancy.

Owner records PASS / FAIL / NOT RUN for every step, defect links and screenshots
where useful. An unexplained financial change, evidence loss, permission bypass
or duplicate posting blocks release. Tax disposal/balancing computations are not
part of this walkthrough because they remain unsupported.
