# Feature Specification: Standard Financial Statements on Dashboard and Reports

**Feature Branch**: `worktree-005-standard-financial-statements`

**Created**: 2026-08-22

**Status**: Draft

**Input**: User description: "Previously we've change the dashboard page, and i still feel abit weird, i think we need to revamp it again, maybe just replace those chart / blocks with standard indicator based on P&L, Balance Sheet, Cash Flow Statement etc.. Also the report module seems not really follow the standard right? I think we can remove others first, make it to have cash flow statement, so that report and dashboard value data is tally. Create a worktree before we work on this"

## Glossary

| Term | Plain meaning |
|---|---|
| Profit & Loss (P&L) | The statement of revenue earned and expenses incurred over a period, ending in net profit or loss. Also called the Income Statement. |
| Balance Sheet | What the business owns, owes, and is worth as at one date — assets, liabilities and equity. |
| Cash Flow Statement | The statement of where actual cash came from and went over a period, grouped into operating, investing and financing activities. |
| Statement of Changes in Equity | How each partner's stake changed over a period — contributions in, share of profit, drawings out. Shown today as the "Partners' Equity" report. |
| Cash and cash equivalents | The accounts that are literally cash, a bank account, an e-wallet or a prepaid card — money the business can spend right now, as opposed to money it is merely owed. |
| Account sub-type | A label on an asset account saying what it actually is — Cash, Bank, Wallet, Card, Accounts receivable, Inventory, Other current asset, or Equipment. Several accounts can share one sub-type (e.g. two different bank accounts are both "Bank"). |
| Needs review | The state of an existing account that has not yet been given a sub-type. It is excluded from "cash and cash equivalents" until someone confirms it, so nothing is counted as cash by accident. |
| Indicator (dashboard) | A single headline figure on the dashboard (e.g. net profit for the month) that is read straight off one of the statements above, not calculated separately. |
| Tally | Two screens showing the same figure for the same period agree to the cent, because they are computed the same way. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every money-holding account has a real sub-type (Priority: P1)

Today every asset account other than Equipment is treated the same internally, whether it is an
actual bank account, physical cash, or money a customer merely owes. This makes an accurate Cash
Flow Statement impossible: there is no way to add up "actual cash" separately from "what customers
owe us" or "stock on hand". A user must be able to say, for each asset account, what it actually
is — Cash, Bank, Wallet, Card, Accounts receivable, Inventory, Other current asset, or Equipment
(Equipment already exists) — and any number of accounts can share the same sub-type, the way a
business might have three different bank accounts.

**Why this priority**: Every other part of this feature depends on it. A Cash Flow Statement that
still blends receivables into "cash" would be wrong on day one and would need redoing, which is
the exact technical debt this feature exists to avoid.

**Independent Test**: Open an asset account (new or existing), set its sub-type, save, and confirm
a second account can be given the same sub-type. Can be verified on its own, before any report or
dashboard change exists.

**Acceptance Scenarios**:

1. **Given** a user is creating a new asset account, **When** they fill in the form, **Then**
   they are asked which sub-type it is, from the fixed list above, and cannot save without
   choosing one.
2. **Given** two different asset accounts, **When** a user sets both to the sub-type "Bank",
   **Then** both are saved successfully and both are treated as bank accounts for reporting.
3. **Given** an asset account already has a sub-type, **When** a user opens it, **Then** they can
   change the sub-type to a different one (correcting a past mistake), except where doing so is
   blocked by existing rules that already protect an account with history (e.g. a locked
   account).
4. **Given** the feature has just shipped, **When** a user looks at their existing accounts,
   **Then** each of the small number of accounts the system can recognize with confidence (the
   default Cash, Bank, Accounts Receivable and Inventory accounts every book starts with) already
   carries the matching sub-type, and every other existing asset account is visibly marked "needs
   review" rather than silently guessed.
5. **Given** an account is marked "needs review", **When** any statement totals "cash and cash
   equivalents", **Then** that account's movements are left out of the cash total and shown
   separately, so an unreviewed account can never be mistaken for real cash.

---

### User Story 2 - Reports module offers only the standard financial statements (Priority: P1)

A user opens Reports expecting the small set of statements an accountant would recognize.
Today the tabs are Profit & Loss, Balance Sheet, Partners' Equity, Receivables and Payables — the
last two are account-aging views, not financial statements, and there is no Cash Flow Statement
at all. Reports should offer the standard statements only — Profit & Loss, Balance Sheet, Cash
Flow Statement, and Partners' Equity (Statement of Changes in Equity, shown only when the
business has partner accounts) — and drop the two tabs that duplicate information already
available elsewhere.

**Why this priority**: This is the other half of the original complaint, and — together with
User Story 1 — is what makes a real Cash Flow Statement possible at all.

**Independent Test**: Open Reports, confirm the tab list is exactly the standard statements, open
the new Cash Flow Statement tab, and confirm its cash total matches the combined movement of the
accounts classified Cash, Bank, Wallet or Card for that period.

**Acceptance Scenarios**:

1. **Given** Reports is open, **When** the user looks at the tab list, **Then** they see Profit &
   Loss, Balance Sheet, Cash Flow Statement, and (only if the business has partner accounts)
   Partners' Equity — and nothing else.
2. **Given** a user opens the Cash Flow Statement tab, **When** it loads, **Then** it shows the
   period's activity grouped into operating, investing and financing, with the opening and closing
   cash figures they explain, and a separate line for any account still marked "needs review".
3. **Given** an invoice is issued but not yet paid, **When** the Cash Flow Statement for that
   period is viewed, **Then** the invoice does not appear as cash received — only the later
   payment does, because no cash account was touched when the invoice was raised.
4. **Given** a user previously relied on the Receivables or Payables report to see who owes what,
   **When** those tabs are removed, **Then** the same figures are still reachable from Contacts
   and from the Records list filtered by contact or account, so nothing is lost — only the
   duplicate copy in Reports goes away.
5. **Given** a user is viewing the Cash Flow Statement, **When** they choose to export it,
   **Then** they get a CSV with the same figures and structure they see on screen, matching how
   the other statements already export (FR-029 in `002-double-entry-ledger`).

---

### User Story 3 - Dashboard shows statement-based indicators instead of ad hoc charts (Priority: P1)

A user opens the Dashboard to get a quick read on the business's health. Today they see a
revenue-vs-expense bar chart, a spending-by-category donut chart, and a profit-trend chart,
alongside four KPI tiles computed their own way. Instead, they should see a small set of headline
indicators, each one a figure taken directly from the Profit & Loss, the Balance Sheet, or the
Cash Flow Statement for the period/date currently selected — so the dashboard reads like a summary
of the three statements rather than a separate set of charts with its own logic.

**Why this priority**: This is the original, most visible complaint — the dashboard currently
feels "off" because its charts do not map to any statement a reader could check it against.

**Independent Test**: Open the dashboard, note each indicator's figure and the period it covers,
open the matching statement in Reports for the same period, and confirm the figures match exactly.

**Acceptance Scenarios**:

1. **Given** the dashboard is open with a period selected, **When** the page loads, **Then** it
   shows a net profit indicator equal to the Profit & Loss net profit for that same period.
2. **Given** the dashboard is open, **When** the page loads, **Then** it shows a financial
   position indicator (assets, liabilities, equity) equal to the Balance Sheet as at today.
3. **Given** the dashboard is open with a period selected, **When** the page loads, **Then** it
   shows a cash flow indicator equal to the Cash Flow Statement's net cash movement for that same
   period.
4. **Given** a user is looking at a dashboard indicator, **When** they select it, **Then** they
   land on the matching Reports statement, already showing the same period and the same figure.

---

### User Story 4 - Dashboard and Reports never disagree (Priority: P2)

A user notices a figure on the dashboard and later looks at the same period in Reports. The two
must always show the same number, because right now the dashboard computes some figures its own
way rather than reading them from the statements shown in Reports.

**Why this priority**: This is the guarantee behind the other stories — it is what "tally" means,
and what stops the two screens from drifting apart again the next time either is edited.

**Independent Test**: Change a record that affects revenue, expenses, or a cash account, and
confirm the dashboard indicator and the corresponding Reports statement update to the same new
figure together (the SSE update already in place for both screens).

**Acceptance Scenarios**:

1. **Given** a new expense is recorded, **When** the dashboard and the Profit & Loss report are
   both open, **Then** both update to show the same new expense total for the period, with no
   manual refresh needed.
2. **Given** the ledger does not balance (an existing, rare data-integrity state), **When** the
   dashboard's financial-position indicator is shown, **Then** it displays the same "books do not
   balance" warning the Balance Sheet report shows, rather than silently displaying a number.

---

### Edge Cases

- What does a user see if every asset account is still "needs review" right after upgrading? The
  Cash Flow Statement and its dashboard indicator both show a prominent note that no accounts have
  been classified yet, with a way to get to the accounts that need it, rather than a confusing
  zero.
- What happens to a partner-less business (sole proprietor, no partner accounts)? The Partners'
  Equity statement and its dashboard indicator (if any) do not appear, matching how the report tab
  already hides itself today.
- What happens when the selected period starts before record-keeping began in this app (existing
  "history gap" case)? The Cash Flow indicator and statement both carry the same note explaining
  the gap, exactly as the existing funds panel does today.
- What happens to a saved link to a removed Receivables or Payables report URL? It redirects to
  the nearest still-existing equivalent (e.g. Contacts, or the Records list filtered the same way)
  rather than 404ing.
- What happens if a user tries to reclassify an account that already has movements against it
  (e.g. change a "Bank" account to "Inventory")? The change is allowed unless an existing rule
  already blocks editing that account (for example it is locked), because the sub-type describes
  what the account is, not a permanent fact fixed at creation — the same way its name can already
  be changed.
- What happens to an account sub-type on an account that later becomes Equipment, or vice versa?
  Not possible: Equipment is chosen on the everyday record form as what money was spent *on*, the
  same way a category is today, not set as one of these seven sub-types.

## Requirements *(mandatory)*

### Functional Requirements

**Account classification**

- **FR-001**: System MUST let a user set a **sub-type** on every asset account, chosen from: Cash,
  Bank, Wallet, Card, Accounts receivable, Inventory, Other current asset, or Equipment (Equipment
  already exists as today's "bought and kept" choice).
- **FR-002**: System MUST allow more than one account to share the same sub-type — a sub-type
  classifies a group of accounts, never a single one.
- **FR-003**: System MUST require a sub-type to be chosen when a new asset account is created, and
  MUST let a user change an existing account's sub-type later, subject to whatever rules already
  block editing that account (e.g. it is locked).
- **FR-004**: For the small number of default accounts every book starts with (Cash, Bank,
  Accounts Receivable, Inventory), the system MUST carry over the matching sub-type automatically
  when this feature ships. Every other existing asset account MUST be marked **needs review**
  rather than guessed.
- **FR-005**: An account marked "needs review" MUST be excluded from "cash and cash equivalents"
  in every statement and indicator until a user gives it a sub-type, and MUST be shown as its own,
  clearly labelled line wherever it would otherwise have counted, so it is never mistaken for
  either real cash or a confirmed non-cash account.
- **FR-006**: "Cash and cash equivalents" is defined as the combined accounts of sub-type Cash,
  Bank, Wallet or Card. Accounts of sub-type Accounts receivable, Inventory or Other current asset
  are current assets but are never part of "cash and cash equivalents".

**Reports module**

- **FR-007**: Reports MUST offer exactly these statements: Profit & Loss, Balance Sheet, Cash Flow
  Statement, and Partners' Equity (shown only when the business has partner accounts) — no other
  tab.
- **FR-008**: Reports MUST remove the Receivables ("owed-to-us") and Payables ("we-owe") tabs,
  because they are account-aging views rather than one of the standard financial statements, and
  the figures they show remain available via Contacts and the Records list filtered by contact or
  account.
- **FR-009**: A saved link to a removed report tab MUST redirect to a working screen (Reports'
  default statement, or the Contacts/Records equivalent) rather than error.
- **FR-010**: Reports MUST add a new Cash Flow Statement view, covering a selected period, that
  groups the period's cash movement into operating, investing and financing activities, shows the
  opening and closing cash figures they explain, and follows the same page structure, date
  controls and CSV export pattern as the existing Profit & Loss and Balance Sheet statements.
- **FR-011**: The Cash Flow Statement's cash total MUST equal the movement, over the selected
  period, of the accounts defined as "cash and cash equivalents" (FR-006) — read independently
  from the statement's own activity lines, the same way the existing Balance Sheet independently
  checks that it balances, so a mismatch is visible rather than assumed away.
- **FR-012**: A record that touches a current asset that is not "cash and cash equivalents" (a
  receivable or inventory movement) MUST appear on the Cash Flow Statement as its own operating
  line (e.g. "Change in receivables") when its other side is not itself a cash account, rather than
  being counted as cash.

**Dashboard**

- **FR-013**: The Dashboard MUST replace its revenue-vs-expense chart, spending-by-category chart,
  and profit-trend chart with headline indicators drawn from the Profit & Loss, Balance Sheet, and
  Cash Flow Statement for the period or as-at date currently selected on the dashboard.
  *Superseded by 007 FR-001: charts are allowed again when every value they plot is the
  statement's own calculation.*
- **FR-014**: Every figure a Dashboard indicator shows MUST be computed by the same calculation the
  matching Reports statement uses for the same period or date — never a second, separately written
  calculation — so the two screens cannot disagree.
- **FR-015**: Each Dashboard indicator MUST link to the matching Reports statement, opening it
  already set to the same period or date the indicator showed, so a user can verify the figure in
  one step.
- **FR-016**: When the ledger does not balance, the Dashboard's financial-position indicator MUST
  show the same warning the Balance Sheet report shows, rather than showing a number as if it were
  reliable.
- **FR-017**: The Dashboard MUST keep the "Recent activity" list and the period selector; these
  are unrelated to the chart-to-indicator change and remain as they are today.
  *Superseded by 007 FR-003 (period selector) and FR-012 (Recent activity).*

**Scope guard**

- **FR-018**: Removing a report tab or a dashboard chart MUST NOT remove any underlying capability
  the app has today (e.g. seeing who owes what) — only the duplicate presentation of that
  information goes away, and it remains reachable from where CLAUDE.md's "three ledgers" already
  put it (Contacts, and the Records list).
- **FR-019**: This feature classifies accounts so statements can separate real cash from other
  current assets; it MUST NOT introduce inventory tracking (quantities, cost of goods sold, stock
  valuation) or any other capability beyond that classification and its effect on the statements
  above.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can read the business's net profit, financial position, and net cash movement
  for a period straight off the dashboard, without opening Reports.
- **SC-002**: Every figure on the dashboard matches its corresponding statement in Reports exactly,
  for any period or date, with zero exceptions.
- **SC-003**: The Reports section contains only entries a user would recognize as one of the four
  standard financial statements — no tab a user has to investigate to understand why it is there.
- **SC-004**: The Cash Flow Statement's cash total never includes a receivable, inventory, or
  unreviewed account — only accounts a user has confirmed are cash, a bank, a wallet or a card.
- **SC-005**: A user who used to check who-owes-what on the Receivables or Payables report can
  still find the same figures elsewhere in the app in no more than two navigation steps.
- **SC-006**: Editing a record updates the dashboard indicator and the matching Reports statement
  together, with no reload required and no window where the two disagree.

## Assumptions

- Partners' Equity stays in Reports even though the user's request named only three statements,
  because it is the fourth standard financial statement (Statement of Changes in Equity) and
  already hides itself when there are no partner accounts — dropping it would remove a working,
  standard statement for no stated reason.
- The Dashboard's "Recent activity" list and period selector are kept: the request asked to
  replace "charts / blocks" that stand in for a statement, not to remove unrelated navigation aids.
- The existing CSV export pattern (one file per statement, same figures as on screen) extends to
  the new Cash Flow Statement unchanged.
- The dashboard's existing period control continues to govern which period the Profit & Loss and
  Cash Flow indicators cover, and "as at today" continues to govern the Balance Sheet indicator —
  matching how the dashboard already behaves.
- Classifying an asset account's sub-type is a one-time, low-friction choice on the existing
  account form (not a new screen or workflow), and reclassifying later follows the same edit rules
  an account already has today.
- "Other current asset" is included as a catch-all sub-type so a user is never blocked from
  classifying an account that is genuinely a current asset but not cash, a receivable, or
  inventory — it is deliberately chosen, unlike "needs review", which is a temporary,
  system-applied flag.
