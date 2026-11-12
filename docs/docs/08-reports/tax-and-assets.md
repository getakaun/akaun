---
title: Tax workings and fixed assets
sidebar_position: 7
---

Akaun separates accounting entries from annual tax preparation. Tax classifications
and custom asset schemes help prepare workings; they do not determine legal
eligibility, calculate final tax payable or file a return. Ask your accountant to
verify the treatment, scheme and applicable tax year before relying on the figures.

## Expense classifications

An Expense account can hold a default treatment and deductible percentage. New
expense lines save the effective values at creation. Changing the default does
not recalculate earlier entries. Individual record overrides retain their reason.

Unclassified and Requires review are unresolved states, not an approved deduction.
They block month close. On an account, **Apply default to unclassified entries**
previews eligible open entries and requires a reason and confirmation. It protects
closed entries and deliberate individual decisions; each confirmation covers up
to 200 eligible lines. Resolve individual exceptions on the record.

After month close, source classifications are read-only. Use audited accounting
reopening for source errors, or an annual tax-only correction for annual treatment.
The latter changes the worksheet without posting a journal or changing bank
reconciliation.

## Fixed assets and depreciation

Register an existing capital purchase in Assets. Registration links its evidence
and does not post the purchase again. Legacy assets need explicit opening evidence;
the register shows unexplained differences from the general ledger.

Approve a book depreciation setup before posting. Straight-line monthly charges
debit depreciation expense and credit a separate accumulated depreciation Asset
account. They use full months and final-period rounding. Review missed history
explicitly; future automatic authority does not approve all earlier months.
Automatic posting requires the application to be running and the approver's
current permissions. Due unposted depreciation warns at close; it does not prevent
closing. Closed months cannot receive depreciation without authorised reopening.

Generated journals have their own correction workflow. Reverse a whole run into
an appropriate open correction period; keep the original history. Stop future
depreciation when appropriate. Neither action records an asset disposal.

## Annual worksheets and asset deductions

In Tax, choose the YA and accounting dates explicitly. Settings → Tax holds the
jurisdiction and versioned custom schemes. Jurisdiction is independent of currency.
Selecting a country does not provide a certified national tax computation.

Choose a scheme for each claimed asset and confirm qualifying cost, business use
and first-year treatment. Scheme deductions are separate from book depreciation
and do not post journals. Opening tax residual is the remaining expenditure basis;
unabsorbed allowances are a different carry-forward balance. New schedules use
available allowances automatically, capped at eligible income from the same
business before brought-forward losses. Insufficient income or a loss year leaves
an unabsorbed balance to carry forward; there is no routine **Use available** step.
An initial allowance recorded but unused still counts as prior history.

The automatic Malaysian calculation assumes one business, using operating income
(including revenue with no subtype, as on the P&L), expenses, tax add-backs and
signed annual adjustments. Brought-forward losses apply after allowances. The
summary shows allowance available, used this year and carried forward; there is
no income-limit form or utilisation override to complete.

Other revenue, such as bank interest, stays in accounting profit and the overall
worksheet result. For this simple calculation, its signed net amount is excluded
from the business income available to absorb capital allowances. It does not block
automatic usage. If there is only Other revenue or the business has a loss,
allowances remain unabsorbed and carry forward. The book's expenses and tax
add-backs remain attributed to the single business; allocation of expenses to
separate income sources is not inferred. Classifications and eligibility still
require accountant verification.

Separate businesses and other jurisdictions are outside this simple automatic
flow. Akaun identifies the business-source labels or jurisdiction involved and
blocks completion instead of inventing an allocation. Resolve incomplete expense
tax treatments in the worksheet before completing it.

Previously saved manual schedules and overrides remain retained. A draft can be
switched to automatic calculation with one action; finalised evidence stays fixed.
Previously restricted amounts remain separate from unabsorbed carry-forward.
Ordinary balances are used oldest-origin first as an Akaun convention; special
legal ordering and eligibility still require accountant review.

Save draft retains incomplete work. Finalise worksheet requires the applicable
update/review/finalise permissions and a signed-in session. Independent reviewers
and finalisers keep their own authority. Live draft figures follow bookkeeping
changes while protecting local edits; changed evidence may require another review.

Finalised evidence is fixed. Later corrections use an amendment. Scheme edits do
not recalculate saved deductions. CSV and printable HTML use saved evidence: save
a draft before exporting current changes. Accounting reopening does not rewrite a
finalised worksheet.

Disposal/balancing tax calculations, special incentives, special statutory utilisation
limits/order and currency conversion are unsupported. There is no complete book
disposal workflow. See [Backups and upgrades](../09-administration/backups-and-upgrades.md)
before upgrading a book with earlier allowance workings.
