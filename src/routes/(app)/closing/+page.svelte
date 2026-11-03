<script lang="ts">
  import { untrack } from "svelte";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { LockKeyhole, RotateCcw } from "@lucide/svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { createResourceStream } from "$lib/sse.js";
  import {
    monthEndFor,
    type ClosingChecks,
    type ClosingPreview,
    type ClosingStatus,
  } from "$lib/closing.js";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
  let month = $state(untrack(() => data.defaultMonth));
  let fromMonth = $state(
    untrack(() => data.closedThrough?.slice(0, 7) ?? data.defaultMonth),
  );
  let reason = $state("");
  let review = $state<ClosingPreview | null>(null);
  let checks = $state<ClosingChecks>({
    transactions: false,
    bank: false,
    adjustments: false,
    reports: false,
  });
  let acknowledgedWarnings = $state<string[]>([]);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let confirmClose = $state(false);
  let confirmReopen = $state(false);
  let reviewRequest = 0;
  const monthEnd = $derived(monthEndFor(month));
  const reviewChecks = [
    {
      key: "transactions",
      label: "Transactions complete",
      detail:
        "Receipts, invoices, expenses and payments for the period have been recorded.",
    },
    {
      key: "bank",
      label: "Bank differences reviewed",
      detail:
        "Bank statements are complete and missing entries or timing differences have been checked.",
    },
    {
      key: "adjustments",
      label: "Adjustments reviewed",
      detail:
        "Required accruals, depreciation, tax and currency adjustments have been considered.",
    },
    {
      key: "reports",
      label: "Financial reports reviewed",
      detail:
        "Profit & Loss, Balance Sheet and Cash Flow Statement have been reviewed.",
    },
  ] as const;
  const ready = $derived(
    review !== null &&
      review.monthEnd === monthEnd &&
      review.integrity.ok &&
      Object.values(checks).every(Boolean) &&
      review.warnings.every((w) => acknowledgedWarnings.includes(w.id)),
  );
  const canReview = $derived(
    monthEnd !== null &&
      (data.closedThrough === null || monthEnd > data.closedThrough) &&
      monthEnd <= data.latestMonthEnd,
  );

  function resetReview() {
    reviewRequest += 1;
    review = null;
    checks = {
      transactions: false,
      bank: false,
      adjustments: false,
      reports: false,
    };
    acknowledgedWarnings = [];
    error = "";
    notice = "";
  }

  createResourceStream<ClosingStatus & { type: string }>(
    "/api/closing/stream",
    (status) => {
      if (status.closedThrough !== data.closedThrough) {
        resetReview();
        invalidate("app:closing");
      }
    },
  );

  async function prepareReview() {
    resetReview();
    if (!monthEnd) return;
    busy = true;
    const requestId = reviewRequest;
    const requestedMonthEnd = monthEnd;
    try {
      const response = await fetch(
        `/api/closing/preview?monthEnd=${encodeURIComponent(requestedMonthEnd)}`,
      );
      const body = await response.json();
      if (requestId !== reviewRequest || requestedMonthEnd !== monthEnd) return;
      if (!response.ok) {
        error = body.error ?? "The closing review could not be prepared.";
        return;
      }
      review = body;
    } catch {
      error = "The closing review could not be loaded. Try again.";
    } finally {
      busy = false;
    }
  }

  async function close() {
    if (!review || !ready || busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const response = await fetch("/api/closing/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthEnd: review.monthEnd,
          revision: review.revision,
          checks,
          acknowledgedWarnings,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "The month could not be closed.";
        if (body.code === "CONFLICT") review = null;
        return;
      }
      resetReview();
      notice = `Accounting is closed through ${body.closedThrough}.`;
      await invalidate("app:closing");
    } catch {
      error =
        "Closing could not be confirmed. Refresh the status before trying again.";
    } finally {
      busy = false;
    }
  }

  async function reopen() {
    if (!data.closedThrough || busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const response = await fetch("/api/closing/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromMonth,
          expectedClosedThrough: data.closedThrough,
          reason,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "The months could not be reopened.";
        return;
      }
      resetReview();
      reason = "";
      notice = body.closedThrough
        ? `Months reopened. Accounting remains closed through ${body.closedThrough}.`
        : "All recorded accounting history is open.";
      await invalidate("app:closing");
    } catch {
      error =
        "Reopening could not be confirmed. Refresh the status before trying again.";
    } finally {
      busy = false;
    }
  }

  function historyTime(value: string): string {
    return new Date(`${value.replace(" ", "T")}Z`).toLocaleString();
  }
</script>

<svelte:head><title>Month closing - Akaun</title></svelte:head>

<div class="screen">
  <header class="topbar">
    <div class="topbar-left">
      <h1 class="page-title">Month closing</h1>
      <p class="page-sub">
        Review completed months and protect their accounting entries.
      </p>
    </div>
    <div class="topbar-right">
      <a class="sheet-btn" href={resolve("/(app)/reports")}>Reports</a>
    </div>
  </header>
  <div class="closing-body">
    <section class="closing-card boundary" aria-label="Accounting status">
      <LockKeyhole size={19} />
      <div>
        <h2>Closed through: {data.closedThrough ?? "No months closed"}</h2>
        <p>
          Entries through this date are protected. Later transactions can
          continue, including payments against earlier invoices.
        </p>
      </div>
    </section>
    {#if error}<p class="closing-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="closing-notice" role="status">{notice}</p>{/if}
    <section class="closing-card">
      <h2>Review and close</h2>
      <p>
        Closing protects accounting entries. Current paid and bank-matched
        statuses can still change. Export reports if you need a copy of what you
        approved.
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          prepareReview();
        }}
        class="month-row"
      >
        <label class="field"
          ><span class="field-label">Month</span><input
            class="closing-input"
            type="month"
            bind:value={month}
            max={data.latestMonthEnd.slice(0, 7)}
            onchange={resetReview}
            disabled={busy}
            required
          /></label
        >
        <button type="submit" class="sheet-btn" disabled={busy || !canReview}
          >{busy ? "Working…" : "Prepare review"}</button
        >
      </form>
      {#if !canReview}<p class="muted">
          Choose a completed month after the closed-through date.
        </p>{/if}
      {#if review}
        <div class="review-period">
          <strong>Close through {review.monthEnd}</strong><span class="muted"
            >{review.dateFrom
              ? `Newly protected history begins ${review.dateFrom}.`
              : "All earlier accounting history is included."}</span
          >
        </div>
        <p
          class:closing-error={!review.integrity.ok}
          class:closing-notice={review.integrity.ok}
        >
          {review.integrity.ok
            ? `Ledger integrity check passed (${review.integrity.recordsChecked} records checked).`
            : `Ledger integrity check failed (${review.integrity.problemCount} problems). Resolve the accounting errors before closing.`}
        </p>
        <div class="report-links">
          <a
            href={resolve(
              `/(app)/reports/[view]?from=${review.dateFrom ?? `${month}-01`}&to=${review.monthEnd}`,
              { view: "profit-loss" },
            )}>Profit & Loss</a
          >
          <a
            href={resolve(`/(app)/reports/[view]?asAt=${review.monthEnd}`, {
              view: "balance-sheet",
            })}>Balance Sheet</a
          >
          <a
            href={resolve(
              `/(app)/reports/[view]?from=${review.dateFrom ?? `${month}-01`}&to=${review.monthEnd}`,
              { view: "cash-flow" },
            )}>Cash Flow Statement</a
          >
          <a href={resolve("/(app)/accounts")}>Bank accounts</a>
          <a href={resolve("/(app)/import")}>Auto Import</a>
        </div>
        <fieldset disabled={busy || !data.canClose} class="closing-checks">
          <legend>Confirm your review</legend>
          {#each reviewChecks as item (item.key)}
            <label class="check-row"
              ><input type="checkbox" bind:checked={checks[item.key]} /><span
                ><strong>{item.label}</strong><small>{item.detail}</small></span
              ></label
            >
          {/each}
          <h3>Warnings to acknowledge</h3>
          {#each review.warnings as warning (warning.id)}
            <label class="check-row warning"
              ><input
                type="checkbox"
                bind:group={acknowledgedWarnings}
                value={warning.id}
              /><span>{warning.message}</span></label
            >
          {/each}
        </fieldset>
        <div class="closing-actions">
          <button
            type="button"
            class="sheet-btn-primary"
            disabled={!data.canClose || !ready || busy}
            onclick={() => (confirmClose = true)}
            >Close through {review.monthEnd}</button
          >
        </div>
      {/if}
      {#if !data.canClose}<p class="muted">
          You can review this book. Closing requires the explicit Close
          accounting periods permission.
        </p>{/if}
    </section>
    {#if data.closedThrough}
      <section class="closing-card">
        <h2>Reopen for corrections</h2>
        <p>
          Reopening an earlier month also opens every later closed month.
          Existing payment, reconciliation and document restrictions still
          apply.
        </p>
        <div class="month-row">
          <label class="field"
            ><span class="field-label">Reopen from</span><input
              class="closing-input"
              type="month"
              bind:value={fromMonth}
              max={data.closedThrough.slice(0, 7)}
              disabled={!data.canReopen || busy}
            /></label
          >
        </div>
        <label class="field"
          ><span class="field-label">Reason</span><textarea
            class="closing-input"
            rows="3"
            minlength="10"
            maxlength="2000"
            bind:value={reason}
            disabled={!data.canReopen || busy}
            placeholder="Explain which correction is needed."
          ></textarea></label
        >
        <p class="muted">
          This will reopen {fromMonth}-01 through {data.closedThrough}. Review
          those months again before closing them.
        </p>
        <div class="closing-actions">
          <button
            type="button"
            class="sheet-btn"
            disabled={!data.canReopen ||
              busy ||
              reason.trim().length < 10 ||
              !monthEndFor(fromMonth) ||
              fromMonth > data.closedThrough.slice(0, 7)}
            onclick={() => (confirmReopen = true)}
            ><RotateCcw size={14} /> Reopen months</button
          >
        </div>
        {#if !data.canReopen}<p class="muted">
            Reopening requires the explicit Reopen accounting periods
            permission.
          </p>{/if}
      </section>
    {/if}
    <section class="closing-card">
      <h2>Closing history</h2>
      <p class="muted">
        The most recent 50 close and reopen actions. Earlier actions remain in
        the audit log.
      </p>
      {#if data.history.length === 0}<p class="muted">
          No months have been closed or reopened yet.
        </p>{/if}
      {#each data.history as entry (entry.id)}
        <article class="history-entry">
          <div>
            <strong>{entry.action === "close" ? "Closed" : "Reopened"}</strong
            ><span>{entry.before ?? "Open"} → {entry.after ?? "Open"}</span>
          </div>
          <p>
            {entry.actorName ?? "Deleted user"} · {historyTime(entry.createdAt)}
          </p>
          {#if entry.reason}<p>{entry.reason}</p>{/if}
        </article>
      {/each}
    </section>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmClose}
  title="Close accounting periods?"
  description={`Accounting entries dated on or before ${review?.monthEnd ?? monthEnd} will be protected. Later transactions remain available.`}
  confirmLabel="Close periods"
  onConfirm={close}
/>
<ConfirmDialog
  bind:open={confirmReopen}
  title="Reopen accounting periods?"
  description={`This opens ${fromMonth}-01 through ${data.closedThrough}. Changes can affect the balances in all those months.`}
  confirmLabel="Reopen periods"
  danger
  onConfirm={reopen}
/>

<style>
  .closing-body {
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    padding: 24px;
    display: grid;
    gap: 20px;
    align-content: start;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .closing-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 22px;
    background: var(--card);
    min-width: 0;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  h3,
  legend {
    font-size: 13px;
    font-weight: 600;
    margin: 10px 0;
  }
  p {
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0;
  }
  .boundary {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .boundary :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .muted,
  small {
    color: var(--muted-foreground);
  }
  .month-row {
    display: flex;
    align-items: end;
    gap: 12px;
    margin: 18px 0;
    flex-wrap: wrap;
  }
  .month-row .field {
    max-width: 240px;
    margin: 0;
    flex: 1;
    min-width: 180px;
  }
  .closing-input {
    display: block;
    width: 100%;
    padding: 9px 11px;
    border: 1px solid var(--input);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    font: inherit;
    font-size: 13px;
  }
  .closing-checks {
    border: 0;
    padding: 0;
    margin: 16px 0;
  }
  .check-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 14px 0;
    font-size: 13px;
    line-height: 1.5;
  }
  .check-row input {
    margin-top: 3px;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    accent-color: var(--primary);
  }
  .check-row small {
    display: block;
    margin-top: 3px;
    font-size: 12px;
  }
  .warning {
    background: var(--accent);
    padding: 12px;
    border-radius: 6px;
  }
  .review-period {
    display: grid;
    gap: 5px;
    font-size: 13px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .closing-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
  }
  .closing-actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .closing-error {
    padding: 12px;
    color: var(--destructive);
    border: 1px solid var(--destructive);
    border-radius: 6px;
  }
  .closing-notice {
    padding: 12px;
    background: var(--accent);
    border-radius: 6px;
  }
  .report-links {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    margin: 15px 0;
  }
  .report-links a {
    color: var(--primary);
    text-decoration: underline;
  }
  .history-entry {
    border-top: 1px solid var(--border);
    padding: 14px 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .history-entry > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .history-entry p {
    color: var(--muted-foreground);
    margin: 4px 0;
  }
  @media (max-width: 767px) {
    .closing-body {
      overflow: visible;
      flex: none;
    }
  }
  @media (max-width: 600px) {
    .closing-body {
      padding: 16px;
    }
    .closing-card {
      padding: 16px;
    }
    .closing-actions button {
      width: 100%;
      justify-content: center;
    }
  }
</style>
