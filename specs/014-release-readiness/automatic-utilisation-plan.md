# Automatic allowance utilisation — simplified follow-up

The user requested a simpler automatic flow after the reviewed income-limit and
override options introduced too much work. The normal UI now shows only available
allowances, automatic usage and unabsorbed carry-forward. Remove the eligible
income row, single-business checkbox, income-limit/reason/confirmation forms,
utilisation override forms and duplicate tax-result preview. Earlier balances
continue to roll forward automatically, with opening balances available for
bringing external earlier workings into Akaun.

The ordinary Malaysian single-business calculation uses accounting profit, tax
add-backs/source corrections and signed Other tax adjustments. Brought-forward
losses apply after allowances. Revenue without a subtype is operating income,
consistent with P&L reporting; it no longer forces manual review. Same-business
income caps remain in the calculation. Other revenue, including bank interest,
is excluded from allowance absorption capacity using its signed net amount, while
remaining in accounting profit and the overall annual result. Contra-other revenue
and refunds use their signed amounts. Excluded accounts/amounts are retained in
utilisation evidence. The single-business basis continues to attribute the book's
expenses/add-backs to that business; allocation of shared/non-business expenses is
not inferred. This is a preparatory classification convention, not a determination
that all bank interest is legally non-business income. Multiple business sources
and other jurisdictions get an exact explanation and block completion.
Unresolved expense classifications/corrections still need resolution at source.

Existing version-1 manual income limits/overrides remain supported for retained
workings and API compatibility, with no new controls for entering them in the UI.
A draft offers one explicit switch to replace saved manual settings with automatic
calculation. No read or save silently discards manual instructions. Finalised
figures/exports stay fixed. A new YA starts automatic with annual settings cleared.

Ordinary balances use oldest-origin first as an Akaun bookkeeping convention,
not a universal statutory ordering rule. Only unabsorbed balances roll forward;
previously restricted/not-claimed amounts remain separate. Saves recalculate
against canonical sources in the atomic worksheet transaction. There are no new
GL postings, schema migrations, certified tax rates or real-book access.

## Comparison and authority

IRIS Business Tax calculates allowances by default and offers restrictions as an
exception ([FAQ](https://help-iris.co.uk/IRIS/ODL/Business_Tax_FAQs/Capital_Allowances_FAQ_s.htm),
[capital allowances](https://help-iris.co.uk/elements/tax/returns/corporation/subsection/trading-profits-capital-allowances.htm)).
[TaxCalc's guide](https://www.taxcalc.com/resources/getting-started-with-self-assessment)
describes allowance calculations and population of returns; [Superior](https://www.superior.my/)
advertises Malaysian automatic capital allowance calculations and rollover. These
support automatic defaults with reviewable exceptions; UK product behaviour does
not establish Malaysian tax treatment.

Malaysian constraints were checked against Schedule 3 paragraphs 68/69/75 of the
[Income Tax Act (November 2023 government-hosted text)](https://www.investmalaysia.gov.my/media/wg0bk4hy/income-tax-act-1967.pdf)
and section 9.1.3 / example 4 of
[LHDN Public Ruling 5/2022](https://www.maicsa.org.my/media/7560/technical_announcements_221213_3_1.pdf).
Same-business income can limit absorption; loss years and insufficient income are
ordinary carry-forward cases. Eligibility, business continuity and special regimes
still need accountant review. Balancing charges and mixed business income require
an explicit reviewed capacity here, because the app does not calculate them.
