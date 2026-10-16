<script lang="ts">
  type Tone = { label: string; tone: string };
  /**
   * A status, by its label.
   *
   * This used to accept an `ExpenseStatus` integer code as well, from the days
   * when a status was a stored column. Nothing stores one now — every status is
   * derived and named — so every caller passes a string and the numeric branch
   * was unreachable. `ExpenseStatus` itself goes with the tables it described
   * (FR-037).
   */
  let { status }: { status: string } = $props();
  const byLabel: Record<string, Tone> = {
    unpaid: { label: "Unpaid", tone: "red" },
    pending: { label: "Pending", tone: "amber" },
    paid: { label: "Paid", tone: "green" },
    received: { label: "Received", tone: "green" },
    // Ledger records: a record with no side on a shared owed account is paid the
    // moment it exists; one that owes somebody reads outstanding until
    // settlements cover it, and part-paid while they cover only some of it
    // (FR-012–FR-014). The key stays `owed` — it is the status code the server
    // and `record-status.ts` agree on, not a label.
    owed: { label: "Outstanding", tone: "red" },
    "part-paid": { label: "Partially paid", tone: "amber" },
    settled: { label: "Settled", tone: "green" },
    // Whether the bank agrees the money moved — a different question from
    // whether it is paid, so a different chip (FR-056).
    cleared: { label: "Reconciled", tone: "blue" },
    "not cleared": { label: "Unreconciled", tone: "" },
    // Quotation statuses (labels from QuotationStatusLabels in enums.ts)
    draft: { label: "Draft", tone: "" },
    sent: { label: "Sent", tone: "blue" },
    accepted: { label: "Accepted", tone: "green" },
    declined: { label: "Declined", tone: "red" },
    converted: { label: "Converted", tone: "blue" },
    superseded: { label: "Superseded", tone: "gray" },
    // Invoice-only
    cancelled: { label: "Cancelled", tone: "red" },
    // Derived statuses (never stored, computed at read time)
    expired: { label: "Expired", tone: "amber" },
    overdue: { label: "Overdue", tone: "red" },
    // Reconciliation statuses are passed by label because their integer codes
    // overlap the expense status codes above.
    open: { label: "Open", tone: "blue" },
    active: { label: "Active", tone: "amber" },
    extracting: { label: "Extracting", tone: "blue" },
    failed: { label: "Failed", tone: "red" },
    matched: { label: "Matched", tone: "green" },
    leftovers: { label: "Leftovers", tone: "amber" },
    "exact-match": { label: "Exact match", tone: "green" },
    "partial-match": { label: "Partial", tone: "amber" },
    "no-match": { label: "No match", tone: "gray" },
    // An item of an imported document read as several items (006 FR-017).
    // Keyed apart from the record statuses above: "confirmed" here means the
    // item became a record, not that a bill was paid.
    "import-ready": { label: "Ready", tone: "blue" },
    "import-attention": { label: "Needs attention", tone: "amber" },
    "import-confirmed": { label: "Confirmed", tone: "green" },
    "import-skipped": { label: "Skipped", tone: "gray" },
    // An import profile is on (offered under "Read as") or off (006 US6 AS12).
    "profile-enabled": { label: "Enabled", tone: "green" },
    "profile-disabled": { label: "Disabled", tone: "gray" },
  };

  const m = $derived(byLabel[status] ?? byLabel.unpaid);
</script>

<span class="statusbadge tone-{m.tone}">
  <span class="statusdot"></span>{m.label}
</span>
