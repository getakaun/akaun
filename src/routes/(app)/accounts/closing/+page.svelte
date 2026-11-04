<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    CircleCheck,
    CircleAlert,
    Info,
    LockKeyhole,
    RefreshCw,
    RotateCcw,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import MonthPicker from "$lib/components/ui/month-picker/MonthPicker.svelte";
  import BackLink from "$lib/components/ui/BackLink.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import ListExpand, {
    visibleItems,
  } from "$lib/components/ui/ListExpand.svelte";
  import { createResourceStream } from "$lib/sse.js";
  import { addDaysISO } from "$lib/local-date.js";
  import { formatDate } from "$lib/format.js";
  import {
    monthEndFor,
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
  let checking = $state(false);
  let saving = $state(false);
  let error = $state("");
  let notice = $state("");
  let confirmClose = $state(false);
  let confirmReopen = $state(false);
  let expandedHistory = $state(false);
  let knownBoundary = untrack(() => data.closedThrough);
  let reviewRequest = 0;

  const monthEnd = $derived(monthEndFor(month));
  const firstOpenMonth = $derived(
    data.closedThrough
      ? addDaysISO(data.closedThrough, 1).slice(0, 7)
      : undefined,
  );
  const canReviewAny = $derived(
    !data.closedThrough || data.closedThrough < data.latestMonthEnd,
  );
  const canReview = $derived(
    monthEnd !== null &&
      (!data.closedThrough || monthEnd > data.closedThrough) &&
      monthEnd <= data.latestMonthEnd,
  );
  const ready = $derived(
    !checking &&
      canReview &&
      review?.monthEnd === monthEnd &&
      review?.integrity.ok === true,
  );
  const notices = $derived(
    review?.warnings.filter(
      (warning) =>
        warning.id !== "first-close" && warning.id !== "completeness",
    ) ?? [],
  );
  const history = $derived(visibleItems(data.history, expandedHistory));

  function clearReview() {
    reviewRequest++;
    review = null;
    checking = false;
    confirmClose = false;
  }

  async function prepareReview(selectedMonth = month) {
    clearReview();
    error = "";
    const selectedEnd = monthEndFor(selectedMonth);
    if (
      !selectedEnd ||
      !canReviewAny ||
      (data.closedThrough && selectedEnd <= data.closedThrough) ||
      selectedEnd > data.latestMonthEnd
    )
      return;
    const request = reviewRequest;
    checking = true;
    try {
      const response = await fetch(
        `/api/closing/preview?monthEnd=${encodeURIComponent(selectedEnd)}`,
      );
      const body = await response.json();
      if (request !== reviewRequest || selectedMonth !== month) return;
      if (!response.ok) {
        error = body.error ?? "The automatic checks could not be completed.";
        return;
      }
      review = body;
    } catch {
      if (request === reviewRequest)
        error = "The automatic checks could not be loaded. Try again.";
    } finally {
      if (request === reviewRequest) checking = false;
    }
  }

  function selectMonth(value: string) {
    month = value;
    notice = "";
    void prepareReview(value);
  }

  async function refreshWorkspace() {
    await invalidate("app:closing");
    month = data.defaultMonth;
    fromMonth = data.closedThrough?.slice(0, 7) ?? data.defaultMonth;
    await prepareReview(month);
  }

  onMount(() => {
    void prepareReview();
    return () => {
      reviewRequest++;
    };
  });
  createResourceStream<ClosingStatus>("/api/closing/stream", (status) => {
    if (status.closedThrough !== knownBoundary) {
      knownBoundary = status.closedThrough;
      clearReview();
      void refreshWorkspace();
    }
  });

  async function close() {
    if (!review || !ready || saving) return;
    saving = true;
    error = "";
    notice = "";
    try {
      const response = await fetch("/api/closing/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthEnd: review.monthEnd,
          revision: review.revision,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "CONFLICT") {
          await prepareReview();
          if (review)
            error =
              "The book changed. The checks have been refreshed; confirm the close again.";
          else if (!error)
            error = "The book changed. Run the checks again before closing.";
        } else error = body.error ?? "The month could not be closed.";
        return;
      }
      knownBoundary = body.closedThrough;
      notice = `Accounting is closed through ${formatDate(body.closedThrough)}.`;
      await refreshWorkspace();
    } catch {
      error =
        "Closing could not be confirmed. Refresh the status before trying again.";
    } finally {
      saving = false;
    }
  }

  async function reopen() {
    if (!data.closedThrough || saving) return;
    saving = true;
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
      knownBoundary = body.closedThrough;
      reason = "";
      notice = body.closedThrough
        ? `Months reopened. Accounting remains closed through ${formatDate(body.closedThrough)}.`
        : "All recorded accounting history is open.";
      await refreshWorkspace();
    } catch {
      error =
        "Reopening could not be confirmed. Refresh the status before trying again.";
    } finally {
      saving = false;
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
      <BackLink href={resolve("/(app)/accounts")} label="Accounts" />
      <h1 class="page-title">Month closing</h1>
      <p class="page-sub">
        All accounts · Protect a completed accounting month
      </p>
    </div>
  </header>
  <div class="page-scroll">
    <div class="page-inner closing-workspace">
      {#if error}<div class="closing-message error" role="alert">
          {error}
        </div>{/if}
      {#if notice}<div class="closing-message success" role="status">
          {notice}
        </div>{/if}
      <div class="closing-layout">
        <div class="closing-main">
          <section class="detail-card" aria-labelledby="close-period-title">
            <div class="detail-card-head">
              <h2 class="detail-card-title" id="close-period-title">
                Close period
              </h2>
              {#if checking}<StatusBadge
                  status="checks-running"
                />{:else if review}<StatusBadge
                  status={review.integrity.ok ? "checks-passed" : "failed"}
                />{/if}
            </div>
            {#if canReviewAny}
              <p class="section-note">
                Select a month. Checks run automatically before you confirm the
                close.
              </p>
              <div class="field month-field">
                <span class="field-label" id="close-month-label">Month</span>
                <MonthPicker
                  bind:value={month}
                  min={firstOpenMonth}
                  max={data.latestMonthEnd.slice(0, 7)}
                  disabled={saving}
                  labelledBy="close-month-label"
                  onchange={selectMonth}
                />
              </div>
              {#if checking}
                <p class="section-note" role="status">
                  Checking recorded entries…
                </p>
              {:else if review}
                <div class="check-results" aria-label="Automatic checks">
                  <div class="check-result">
                    <CircleCheck size={16} class="check-pass" />
                    <div>
                      <strong>Completed calendar month</strong><span
                        >Period ends {formatDate(review.monthEnd)}.</span
                      >
                    </div>
                  </div>
                  <div class="check-result">
                    {#if review.integrity.ok}<CircleCheck
                        size={16}
                        class="check-pass"
                      />{:else}<CircleAlert
                        size={16}
                        class="text-destructive"
                      />{/if}
                    <div>
                      <strong>Ledger integrity</strong><span
                        >{review.integrity.ok
                          ? `${review.integrity.recordsChecked} records checked. Debits and credits balance.`
                          : `${review.integrity.problemCount} problems found. Resolve the accounting errors before closing.`}</span
                      >
                    </div>
                  </div>
                </div>
                <p class="scope-note">
                  This protects entries across <strong>all accounts</strong> on
                  or before {formatDate(review.monthEnd)}{!data.closedThrough
                    ? ", including all earlier history"
                    : ""}.
                </p>
                <div class="report-links">
                  <a
                    class="detail-card-action"
                    href={resolve(
                      `/(app)/reports/[view]?from=${review.dateFrom ?? `${month}-01`}&to=${review.monthEnd}`,
                      { view: "profit-loss" },
                    )}>Profit & Loss</a
                  >
                  <a
                    class="detail-card-action"
                    href={resolve(
                      `/(app)/reports/[view]?asAt=${review.monthEnd}`,
                      { view: "balance-sheet" },
                    )}>Balance Sheet</a
                  >
                  <a
                    class="detail-card-action"
                    href={resolve(
                      `/(app)/reports/[view]?from=${review.dateFrom ?? `${month}-01`}&to=${review.monthEnd}`,
                      { view: "cash-flow" },
                    )}>Cash Flow Statement</a
                  >
                </div>
              {/if}
              <div class="period-actions">
                {#if error || (review && !review.integrity.ok)}<Button
                    variant="outline"
                    size="sm"
                    disabled={checking || saving}
                    onclick={() => prepareReview()}
                    ><RefreshCw size={14} /> Run checks again</Button
                  >{/if}
                <Button
                  size="sm"
                  disabled={!data.canClose || !ready || saving}
                  onclick={() => (confirmClose = true)}
                  ><LockKeyhole size={14} /> Close month</Button
                >
              </div>
              {#if !data.canClose}<p class="field-hint">
                  Closing requires the Close accounting periods permission.
                </p>{/if}
            {:else}
              <p class="section-note">
                All completed months are closed. You can continue entering the
                current month’s transactions.
              </p>
            {/if}
          </section>
          {#if notices.length > 0}
            <section class="detail-card" aria-labelledby="notices-title">
              <div class="detail-card-head">
                <h2 class="detail-card-title" id="notices-title">Notices</h2>
                <span class="hbadge">{notices.length}</span>
              </div>
              <p class="section-note">These items do not block closing.</p>
              <ul class="notice-list">
                {#each notices as item (item.id)}<li>
                    <Info size={15} /><span>{item.message}</span>
                  </li>{/each}
              </ul>
            </section>
          {/if}
          <section class="detail-card" aria-labelledby="closing-history-title">
            <div class="detail-card-head">
              <h2 class="detail-card-title" id="closing-history-title">
                Closing history
              </h2>
            </div>
            {#if history.length === 0}<p class="card-empty">
                No months have been closed or reopened yet.
              </p>{/if}
            <div class="history-list">
              {#each history as entry (entry.id)}
                <article class="history-entry">
                  <div class="history-line">
                    <strong
                      >{entry.action === "close"
                        ? "Closed"
                        : "Reopened"}</strong
                    ><span class="num"
                      >{entry.before ? formatDate(entry.before) : "Open"} → {entry.after
                        ? formatDate(entry.after)
                        : "Open"}</span
                    >
                  </div>
                  <p>
                    {entry.actorName ?? "Deleted user"} · {historyTime(
                      entry.createdAt,
                    )}
                  </p>
                  {#if entry.reason}<p class="history-reason">
                      {entry.reason}
                    </p>{/if}
                </article>
              {/each}
            </div>
            <ListExpand
              total={data.history.length}
              bind:expanded={expandedHistory}
            />
            {#if data.history.length === 50}<p class="field-hint">
                The latest 50 actions are shown. Earlier entries remain in the
                audit log.
              </p>{/if}
          </section>
        </div>
        <aside class="closing-rail">
          <section class="detail-card" aria-labelledby="closing-status-title">
            <div class="detail-card-head">
              <h2 class="detail-card-title" id="closing-status-title">
                Accounting status
              </h2>
              <StatusBadge status={data.closedThrough ? "closed" : "open"} />
            </div>
            <p class="boundary-value">
              {data.closedThrough
                ? formatDate(data.closedThrough)
                : "No months closed"}
            </p>
            <p class="section-note">
              {data.closedThrough
                ? "Entries through this date are protected across all accounts."
                : "Earlier accounting entries remain editable."}
            </p>
            <p class="field-hint">
              Later payments and non-financial notes remain available. Export
              reports when you need an approved copy.
            </p>
          </section>
          {#if data.closedThrough}
            <section class="detail-card" aria-labelledby="reopen-title">
              <div class="detail-card-head">
                <h2 class="detail-card-title" id="reopen-title">
                  Reopen for corrections
                </h2>
              </div>
              <p class="section-note">
                The selected month and every later closed month will reopen.
              </p>
              <div class="field">
                <span class="field-label" id="reopen-month-label"
                  >Reopen from</span
                ><MonthPicker
                  bind:value={fromMonth}
                  max={data.closedThrough.slice(0, 7)}
                  disabled={!data.canReopen || saving}
                  labelledBy="reopen-month-label"
                />
              </div>
              <div class="field">
                <label class="field-label" for="reopen-reason">Reason</label
                ><Textarea
                  id="reopen-reason"
                  rows={3}
                  minlength={10}
                  maxlength={2000}
                  bind:value={reason}
                  disabled={!data.canReopen || saving}
                  placeholder="Explain the correction needed."
                />
              </div>
              <p class="field-hint">
                Opens {formatDate(`${fromMonth}-01`)} through {formatDate(
                  data.closedThrough,
                )}.
              </p>
              <div class="period-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!data.canReopen ||
                    saving ||
                    reason.trim().length < 10 ||
                    !monthEndFor(fromMonth) ||
                    fromMonth > data.closedThrough.slice(0, 7)}
                  onclick={() => (confirmReopen = true)}
                  ><RotateCcw size={14} /> Reopen months</Button
                >
              </div>
              {#if !data.canReopen}<p class="field-hint">
                  Reopening requires the Reopen accounting periods permission.
                </p>{/if}
            </section>
          {/if}
          <p class="field-hint completeness-note">
            Automatic checks cover recorded entries. They cannot detect receipts
            or bank statements that have not been supplied.
          </p>
        </aside>
      </div>
    </div>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmClose}
  title="Close accounting period?"
  description={`Entries across all accounts dated on or before ${review ? formatDate(review.monthEnd) : "the selected month end"} will be protected. Later transactions remain available.`}
  confirmLabel="Close month"
  onConfirm={close}
/>
<ConfirmDialog
  bind:open={confirmReopen}
  title="Reopen accounting periods?"
  description={`This opens ${formatDate(`${fromMonth}-01`)} through ${data.closedThrough ? formatDate(data.closedThrough) : "the closed-through date"} across all accounts. Later closed months reopen too.`}
  confirmLabel="Reopen periods"
  danger
  onConfirm={reopen}
/>

<style>
  .page-sub {
    white-space: normal;
  }
  .closing-workspace {
    max-width: 1200px;
    margin-inline: auto;
  }
  .closing-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    align-items: start;
    gap: 20px;
  }
  .closing-main,
  .closing-rail {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  .section-note {
    margin: 0 0 16px;
    color: var(--muted-foreground);
    font-size: 12.5px;
    line-height: 1.6;
  }
  .month-field {
    max-width: 260px;
  }
  .check-results {
    display: grid;
    gap: 14px;
    padding-block: 4px 16px;
  }
  .check-result {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
  }
  .check-result :global(svg) {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .check-result :global(.check-pass) {
    color: var(--green);
  }
  .check-result strong {
    display: block;
    font-weight: 500;
  }
  .check-result span {
    display: block;
    margin-top: 2px;
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.5;
  }
  .scope-note {
    margin: 0;
    padding: 12px;
    background: var(--accent);
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    line-height: 1.6;
  }
  .report-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding-top: 12px;
  }
  .period-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .notice-list {
    display: grid;
    gap: 12px;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .notice-list li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 12.5px;
    line-height: 1.6;
  }
  .notice-list :global(svg) {
    color: var(--amber);
    flex-shrink: 0;
    margin-top: 3px;
  }
  .boundary-value {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .history-entry {
    padding-block: 12px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .history-entry:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .history-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px 12px;
  }
  .history-line strong {
    font-weight: 500;
  }
  .history-entry p {
    margin: 4px 0 0;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .history-entry .history-reason {
    color: var(--foreground);
  }
  .completeness-note {
    margin: 0;
    line-height: 1.6;
  }
  .closing-message {
    padding: 12px 14px;
    margin-bottom: 16px;
    border-radius: var(--radius);
    font-size: 13px;
    line-height: 1.5;
  }
  .closing-message.error {
    background: var(--red-soft);
    color: var(--red);
  }
  .closing-message.success {
    background: var(--green-soft);
    color: var(--green);
  }
  @media (max-width: 1050px) {
    .closing-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .closing-rail {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .completeness-note {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 600px) {
    .closing-rail {
      grid-template-columns: minmax(0, 1fr);
    }
    .month-field {
      max-width: none;
    }
    .period-actions :global(button) {
      flex: 1;
    }
    .history-line {
      flex-direction: column;
    }
  }
</style>
