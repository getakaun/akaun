# Automatic allowance utilisation — approved follow-up

Default to maximum usable allowances, bounded by eligible income from the same
business. Use saved expense classifications and annual source corrections; do
not reduce the capacity by brought-forward losses. Derive the ordinary Malaysian
single-business case only when revenue is explicitly Operating/Contra Operating
and there are no ambiguous other tax adjustments. Multi-business, mixed income,
unsupported jurisdictions and complex adjustments require a reviewed per-business
income limit, reason and evidence confirmation in advanced options.

Introduce optional versioned policy/evidence inside existing capital-schedule
JSON, preserving existing migration SQL and finalised evidence. New schedules
default to automatic. Existing retained manual schedules remain readable and
require an explicit switch to change that saved schedule. A new YA rollover starts
in automatic mode while preserving its manual predecessor. Override amounts require reasons,
cannot exceed capacity/balances, and reductions below the usable amount are
separated as restricted/not claimed rather than silently carried forward.

Allocate ordinary pooled balances oldest-origin first as a deterministic Akaun
bookkeeping convention, retaining each origin; this is not asserted to be a
universal statutory ordering rule. Rollover brings forward only unabsorbed
balances and clears year-specific overrides/reviewed limits. Saving independently
recalculates utilisation against canonical source evidence in the existing atomic
worksheet transaction. Export/print use retained evidence only.

Impacted files: shared capital policy/calculation, capital query/application and
worksheet save schemas, inline editor/claim summary, retained exports, pure and
application regression suites, public guidance and this PR's completion report.
No GL postings, schema migration, deployment or real-book access.

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
