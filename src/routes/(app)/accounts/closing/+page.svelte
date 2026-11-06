<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invalidate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { toast } from "svelte-sonner";
  import {
    ChevronRight,
    CircleAlert,
    CircleCheck,
    Info,
    LockKeyhole,
    RefreshCw,
    RotateCcw,
    X,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import MonthPicker from "$lib/components/ui/month-picker/MonthPicker.svelte";
  import DetailPage from "$lib/components/ui/DetailPage.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import ListExpand, {
    visibleItems,
  } from "$lib/components/ui/ListExpand.svelte";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { createResourceStream } from "$lib/sse.js";
  import { addDaysISO } from "$lib/local-date.js";
  import { formatDate, formatMinor } from "$lib/format.js";
  import {
    monthEndFor,
    type ClosingItem,
    type ClosingItemRef,
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
  let reopenError = $state("");
  let confirmClose = $state(false);
  let confirmReopen = $state(false);
  let reopenOpen = $state(false);
  let expandedHistory = $state(false);
  // One fold per item list, keyed by check, so opening one leaves the rest.
  let expandedItems = $state<Record<string, boolean>>({});
  let knownBoundary = untrack(() => data.closedThrough);
  let reviewRequest = 0;

  const screen = useIsMobile();
  const isMobile = $derived(screen.current);

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
      review?.integrity.ok === true &&
      review?.taxReview.ok === true,
  );
  const notices = $derived(
    review?.warnings.filter(
      (warning) =>
        warning.id !== "first-close" && warning.id !== "completeness",
    ) ?? [],
  );
  const history = $derived(visibleItems(data.history, expandedHistory));
  // The month still in progress: the one that cannot be closed yet.
  const currentMonth = $derived(addDaysISO(data.latestMonthEnd, 1).slice(0, 7));
  const reopenValid = $derived(
    !!data.closedThrough &&
      reason.trim().length >= 10 &&
      monthEndFor(fromMonth) !== null &&
      fromMonth <= data.closedThrough.slice(0, 7),
  );
  const reviewFrom = $derived(review?.dateFrom ?? `${month}-01`);
  const reports = $derived(
    review
      ? [
          {
            name: "Profit & Loss",
            period: `${formatDate(reviewFrom)} – ${formatDate(review.monthEnd)}`,
            href: resolve(
              `/(app)/reports/[view]?from=${reviewFrom}&to=${review.monthEnd}`,
              { view: "profit-loss" },
            ),
          },
          {
            name: "Balance Sheet",
            period: `As at ${formatDate(review.monthEnd)}`,
            href: resolve(`/(app)/reports/[view]?asAt=${review.monthEnd}`, {
              view: "balance-sheet",
            }),
          },
          {
            name: "Cash Flow Statement",
            period: `${formatDate(reviewFrom)} – ${formatDate(review.monthEnd)}`,
            href: resolve(
              `/(app)/reports/[view]?from=${reviewFrom}&to=${review.monthEnd}`,
              { view: "cash-flow" },
            ),
          },
        ]
      : [],
  );

  const monthNames = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  function monthLabel(value: string): string {
    return monthNames.format(new Date(`${value}-01T00:00:00Z`));
  }

  /** Where each kind of item is fixed. Ids come from the server; routes stay here. */
  function itemHref(ref: ClosingItemRef): string {
    switch (ref.kind) {
      case "record":
        return resolve("/(app)/records/[id]", { id: String(ref.id) });
      case "account":
        return resolve("/(app)/accounts/[id]", { id: String(ref.id) });
      case "invoice":
        return resolve("/(app)/invoices/[id]", { id: String(ref.id) });
      case "import-group":
        return resolve("/(app)/import/[id]", { id: ref.id });
      case "import-queue":
        return resolve("/(app)/import");
      case "statement":
        return resolve("/(app)/accounts/[id]/reconcile/[statementId]", {
          id: String(ref.accountId),
          statementId: String(ref.statementId),
        });
      case "statements":
        return resolve("/(app)/accounts/[id]/reconcile", {
          id: String(ref.accountId),
        });
    }
  }

  /** The full list behind a check that holds more than its first items. */
  const fullListHref: Record<string, string> = {
    "pending-imports": resolve("/(app)/import"),
    "draft-invoices": resolve("/(app)/invoices"),
    classification: resolve("/(app)/accounts"),
  };

  function clearReview() {
    reviewRequest++;
    expandedItems = {};
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
    void prepareReview(value);
  }

  async function refreshWorkspace() {
    await invalidate("app:closing");
    month = data.defaultMonth;
    fromMonth = data.closedThrough?.slice(0, 7) ?? data.defaultMonth;
    await prepareReview(month);
  }

  function openReopen() {
    fromMonth = data.closedThrough?.slice(0, 7) ?? data.defaultMonth;
    reason = "";
    reopenError = "";
    reopenOpen = true;
  }

  onMount(() => {
    void prepareReview();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = data.canReadRecords
      ? new EventSource("/api/records/stream")
      : null;
    const refreshChecks = () => {
      clearReview();
      clearTimeout(timer);
      timer = setTimeout(() => {
        void prepareReview();
      }, 80);
    };
    source?.addEventListener("record-update", refreshChecks);
    source?.addEventListener("record-deleted", refreshChecks);
    return () => {
      source?.close();
      clearTimeout(timer);
      reviewRequest++;
    };
  });
  createResourceStream<ClosingStatus>("/api/closing/stream", (status) => {
    if (status.closedThrough !== knownBoundary) {
      knownBoundary = status.closedThrough;
      // Another tab moved the boundary: a half-filled reopen form now names
      // a range that no longer exists.
      reopenOpen = false;
      confirmReopen = false;
      clearReview();
      void refreshWorkspace();
    }
  });

  async function close() {
    if (!review || !ready || saving) return;
    saving = true;
    error = "";
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
      toast.success(
        `Month closed. Accounting is closed through ${formatDate(body.closedThrough)}.`,
      );
      await refreshWorkspace();
    } catch {
      error =
        "Closing could not be confirmed. Refresh the page before trying again.";
    } finally {
      saving = false;
    }
  }

  async function reopen() {
    if (!data.closedThrough || saving) return;
    saving = true;
    reopenError = "";
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
        reopenError = body.error ?? "The months could not be reopened.";
        return;
      }
      knownBoundary = body.closedThrough;
      reopenOpen = false;
      reason = "";
      toast.success(
        body.closedThrough
          ? `Months reopened. Accounting is closed through ${formatDate(body.closedThrough)}.`
          : "Months reopened. No months are closed.",
      );
      await refreshWorkspace();
    } catch {
      reopenError =
        "Reopening could not be confirmed. Refresh the page before trying again.";
    } finally {
      saving = false;
    }
  }

  const historyTimeFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  function historyTime(value: string): string {
    return historyTimeFormat.format(new Date(`${value.replace(" ", "T")}Z`));
  }
</script>

<svelte:head><title>Month closing - Akaun</title></svelte:head>

<!-- The exact things behind a check. Each opens where it is fixed; a
     Cmd-click keeps this review open in its own tab. -->
{#snippet itemList(key: string, items: ClosingItem[], total: number)}
  {#if items.length > 0}
    <ul class="item-list">
      {#each visibleItems(items, expandedItems[key] ?? false) as item (item.key)}
        <li>
          {#if item.ref}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- itemHref() builds every href with resolve(). -->
            <a class="related-link item-row" href={itemHref(item.ref)}>
              {@render itemContent(item)}
              <ChevronRight size={14} class="item-chevron" />
            </a>
          {:else}
            <div class="item-row">{@render itemContent(item)}</div>
          {/if}
        </li>
      {/each}
    </ul>
    <!-- A function binding: a list nobody has opened is `undefined` in the map,
         and binding undefined to a prop with a fallback throws. -->
    <ListExpand
      total={items.length}
      bind:expanded={
        () => expandedItems[key] ?? false, (open) => (expandedItems[key] = open)
      }
    />
    {#if total > items.length}
      <span class="check-extra"
        >{total - items.length} more not shown.{#if fullListHref[key]}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- fullListHref holds resolve() results. -->
          <a class="detail-card-action" href={fullListHref[key]}>See all</a
          >{/if}</span
      >
    {/if}
  {/if}
{/snippet}

{#snippet itemContent(item: ClosingItem)}
  <span class="item-main">
    <span class="item-name">{item.label}</span>
    <span class="item-sub">{item.detail}</span>
  </span>
  {#if item.amountMinor !== undefined}
    <span class="item-amount num">{formatMinor(item.amountMinor)}</span>
  {/if}
{/snippet}

<DetailPage backHref={resolve("/(app)/accounts")} backLabel="Accounts">
  {#snippet actions()}
    {#if data.closedThrough}
      <Button
        variant="outline"
        size="sm"
        disabled={!data.canReopen || saving}
        title={data.canReopen
          ? undefined
          : "Reopening requires the Reopen accounting periods permission."}
        onclick={openReopen}
      >
        <RotateCcw size={14} /> <span class="btn-text">Reopen months</span>
      </Button>
    {/if}
  {/snippet}

  {#snippet hero()}
    <div class="detail-hero-eyebrow"><span>All accounts</span></div>
    <div class="hero-title-row">
      <h1 class="detail-hero-title">
        {data.closedThrough
          ? `Closed through ${formatDate(data.closedThrough)}`
          : "No months closed yet"}
      </h1>
      <StatusBadge status={data.closedThrough ? "closed" : "open"} />
    </div>
    <p class="detail-hero-note">
      {data.closedThrough
        ? "Entries dated on or before this date are read-only in every account. Later transactions stay open."
        : "Every entry can still be edited. Closing a month makes it and everything before it read-only."}
    </p>
    {#if error}<p class="hero-error" role="alert">{error}</p>{/if}
  {/snippet}

  {#snippet main()}
    <section class="detail-card" aria-labelledby="close-month-title">
      <div class="detail-card-head">
        <h2 class="detail-card-title" id="close-month-title">Close a month</h2>
        <div class="card-head-end">
          {#if canReviewAny && (error || (review && (!review.integrity.ok || !review.taxReview.ok || notices.length > 0)))}
            <button
              type="button"
              class="detail-card-action"
              disabled={checking || saving}
              onclick={() => prepareReview()}
              ><RefreshCw size={12} /> Run checks again</button
            >
          {/if}
          {#if checking}<StatusBadge
              status="checks-running"
            />{:else if review}<StatusBadge
              status={review.integrity.ok && review.taxReview.ok
                ? "checks-passed"
                : "failed"}
            />{/if}
        </div>
      </div>

      {#if canReviewAny}
        <div class="close-row">
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
          <Button
            disabled={!data.canClose || !ready || saving}
            title={data.canClose
              ? undefined
              : "Closing requires the Close accounting periods permission."}
            onclick={() => (confirmClose = true)}
            ><LockKeyhole size={14} /> Close month</Button
          >
        </div>

        {#if checking}
          <p class="card-empty" role="status">Checking recorded entries…</p>
        {:else if review}
          <ul class="check-list" aria-label="Automatic checks">
            <li class="check-row">
              <CircleCheck size={16} class="check-pass" />
              <div>
                <strong>Completed calendar month</strong>
                <span>Ends {formatDate(review.monthEnd)}.</span>
              </div>
            </li>
            <li class="check-row">
              {#if review.integrity.ok}<CircleCheck
                  size={16}
                  class="check-pass"
                />{:else}<CircleAlert size={16} class="check-fail" />{/if}
              <div class="check-body">
                <strong>Ledger integrity</strong>
                <span
                  >{review.integrity.ok
                    ? `${review.integrity.recordsChecked} records checked. Debits and credits balance.`
                    : `${review.integrity.problemCount} ${review.integrity.problemCount === 1 ? "problem blocks" : "problems block"} closing. Open each record and correct it.`}</span
                >
                {#if !review.integrity.ok}
                  {@render itemList(
                    "integrity",
                    review.integrity.problems,
                    review.integrity.problemCount -
                      (review.integrity.booksBalance ? 0 : 1),
                  )}
                  {#if !review.integrity.booksBalance}
                    <span class="check-extra"
                      >The book as a whole does not add up to zero, even after
                      the records above. This needs a closer look at the
                      database.</span
                    >
                  {/if}
                {/if}
              </div>
            </li>
            <li class="check-row">
              {#if review.taxReview.ok}<CircleCheck
                  size={16}
                  class="check-pass"
                />{:else}<CircleAlert size={16} class="check-fail" />{/if}
              <div class="check-body">
                <strong>Expense tax classification</strong>
                <span
                  >{review.taxReview.ok
                    ? "Every expense line being closed has a tax classification."
                    : `${review.taxReview.unresolvedLineCount} expense lines need tax review (${formatMinor(review.taxReview.unresolvedMinor)} net). Classify them before closing, even if their amounts net to zero.`}</span
                >
                {#if !review.taxReview.ok}
                  {@render itemList(
                    "tax-review",
                    review.taxReview.items,
                    review.taxReview.unresolvedLineCount,
                  )}
                  {#if data.canReadAccounts}
                    <a href={resolve("/(app)/accounts")}
                      >Review expense account defaults</a
                    >
                  {/if}
                  <span class="check-extra"
                    >Apply account defaults to unclassified entries, or correct
                    individual records above. This blocks closing. Tax figures
                    remain estimates.</span
                  >
                {/if}
              </div>
            </li>
            {#each notices as item (item.id)}
              <li class="check-row">
                <Info size={16} class="check-note" />
                <div class="check-body">
                  <strong>{item.message}</strong>
                  {#if item.hint}<span>{item.hint}</span>{/if}
                  {#if item.items}
                    {@render itemList(
                      item.id,
                      item.items,
                      item.total ?? item.items.length,
                    )}
                  {/if}
                  <span class="check-extra">This does not block closing.</span>
                </div>
              </li>
            {/each}
          </ul>

          <h3 class="sub-title">Review before closing</h3>
          <div class="review-list">
            {#each reports as report (report.name)}
              <a class="related-link review-row" href={report.href}>
                <span class="review-main">
                  <span class="review-name">{report.name}</span>
                  <span class="review-sub">{report.period}</span>
                </span>
                <ChevronRight size={14} class="review-chevron" />
              </a>
            {/each}
          </div>
        {/if}

        <p class="field-hint card-foot">
          Checks cover recorded entries. They cannot tell whether a receipt or
          bank statement is missing.
        </p>
      {:else}
        <p class="card-empty">
          Every completed month is closed. {monthLabel(currentMonth)} can be closed
          after {formatDate(monthEndFor(currentMonth) ?? "")}.
        </p>
      {/if}
    </section>
  {/snippet}

  {#snippet rail()}
    <section class="detail-card" aria-labelledby="closing-history-title">
      <div class="detail-card-head">
        <h2 class="detail-card-title" id="closing-history-title">History</h2>
      </div>
      {#if history.length === 0}
        <p class="card-empty">No months have been closed or reopened yet.</p>
      {:else}
        <ol class="history-list">
          {#each history as entry (entry.id)}
            <li class="history-entry">
              <div class="history-line">
                <strong
                  >{entry.action === "close" ? "Closed" : "Reopened"}</strong
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
            </li>
          {/each}
        </ol>
        <ListExpand
          total={data.history.length}
          bind:expanded={expandedHistory}
        />
        {#if data.history.length === 50}<p class="field-hint">
            The latest 50 actions are shown. Earlier entries are in the audit
            log.
          </p>{/if}
      {/if}
    </section>
  {/snippet}
</DetailPage>

<Sheet.Root
  open={reopenOpen}
  onOpenChange={(o) => {
    if (!o && !saving) reopenOpen = false;
  }}
>
  <Sheet.Content
    side={isMobile ? "bottom" : "right"}
    style={isMobile
      ? "height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;"
      : "width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;"}
  >
    <div class="sheet-head">
      <div>
        <div class="sheet-eyebrow">All accounts</div>
        <div class="sheet-title-text">Reopen months</div>
      </div>
      <Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
    </div>

    <form
      class="sheet-form"
      onsubmit={(event) => {
        event.preventDefault();
        if (reopenValid && !saving) confirmReopen = true;
      }}
    >
      <div class="sheet-body">
        {#if reopenError}<p class="sheet-error" role="alert">
            {reopenError}
          </p>{/if}
        <div class="field">
          <span class="field-label" id="reopen-month-label">Reopen from</span>
          {#if data.closedThrough}
            <MonthPicker
              bind:value={fromMonth}
              max={data.closedThrough.slice(0, 7)}
              disabled={saving}
              labelledBy="reopen-month-label"
            />
          {/if}
          <p class="field-hint">
            This month and every later closed month reopen.
          </p>
        </div>
        <div class="field">
          <label class="field-label" for="reopen-reason">Reason</label>
          <Textarea
            id="reopen-reason"
            rows={4}
            minlength={10}
            maxlength={2000}
            bind:value={reason}
            disabled={saving}
            placeholder="What needs correcting?"
          />
          <p class="field-hint">
            At least 10 characters. Kept in the closing history.
          </p>
        </div>
      </div>

      <div class="sheet-foot">
        {#if data.closedThrough}
          <div class="sheet-foot-note">
            Opens {formatDate(`${fromMonth}-01`)} – {formatDate(
              data.closedThrough,
            )} in every account.
          </div>
        {/if}
        <div class="sheet-foot-actions">
          <button
            type="button"
            class="sheet-btn"
            disabled={saving}
            onclick={() => (reopenOpen = false)}>Cancel</button
          >
          <button
            type="submit"
            class="sheet-btn sheet-btn-primary"
            disabled={!reopenValid || saving}>Reopen months</button
          >
        </div>
      </div>
    </form>
  </Sheet.Content>
</Sheet.Root>

<ConfirmDialog
  bind:open={confirmClose}
  title="Close accounting period?"
  description={review
    ? `Entries in every account dated on or before ${formatDate(review.monthEnd)}${data.closedThrough ? "" : ", including all earlier history,"} will become read-only. Later transactions stay open.`
    : "Entries in every account up to the selected month end will become read-only."}
  confirmLabel="Close month"
  onConfirm={close}
/>
<ConfirmDialog
  bind:open={confirmReopen}
  title="Reopen accounting periods?"
  description={`This opens ${formatDate(`${fromMonth}-01`)} through ${data.closedThrough ? formatDate(data.closedThrough) : "the closed-through date"} in every account. Later closed months reopen too.`}
  confirmLabel="Reopen months"
  danger
  onConfirm={reopen}
/>

<style>
  .hero-title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .hero-error {
    margin: 8px 0 0;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--red-soft);
    color: var(--red);
    font-size: 13px;
  }
  .card-head-end {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .card-head-end .detail-card-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .close-row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .close-row .month-field {
    width: 260px;
    max-width: 100%;
    margin-bottom: 0;
  }
  .close-row :global(button[data-slot="button"]) {
    flex-shrink: 0;
  }
  .check-list {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 16px 0 0;
    list-style: none;
  }
  .check-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
  }
  .check-row :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }
  .check-row :global(.check-pass) {
    color: var(--green);
  }
  .check-row :global(.check-fail) {
    color: var(--red);
  }
  .check-row :global(.check-note) {
    color: var(--amber);
  }
  .check-row strong {
    display: block;
    font-weight: 500;
    line-height: 1.45;
  }
  .check-row span {
    display: block;
    margin-top: 2px;
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.5;
  }
  .sub-title {
    margin: 20px 0 8px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .review-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .review-row {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--card);
    color: inherit;
    text-decoration: none;
  }
  .review-row:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .review-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .review-name {
    font-size: 13px;
    font-weight: 500;
  }
  .review-sub {
    color: var(--muted-foreground);
    font-size: 11.5px;
  }
  .review-row :global(.review-chevron) {
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  .check-body {
    flex: 1;
    min-width: 0;
  }
  .check-row .check-extra {
    margin-top: 8px;
  }
  .item-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
  }
  .item-row {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--card);
    color: inherit;
    text-decoration: none;
  }
  .item-row:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  /* Beats `.check-row span`, which would otherwise make this a block. */
  .check-row .item-main {
    margin: 0;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .check-row .item-name {
    margin: 0;
    color: var(--foreground);
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .check-row .item-sub {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 11.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .check-row .item-amount {
    flex-shrink: 0;
    margin: 0;
    color: var(--red);
    font-size: 12.5px;
  }
  .item-row :global(.item-chevron) {
    flex-shrink: 0;
    margin: 0;
    color: var(--muted-foreground);
  }
  .card-foot {
    margin-top: 16px;
    line-height: 1.5;
  }
  .history-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .history-entry {
    padding-block: 11px;
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
    gap: 4px 12px;
  }
  .history-line strong {
    font-weight: 500;
  }
  .history-entry p {
    margin: 3px 0 0;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .history-entry .history-reason {
    margin-top: 6px;
    color: var(--foreground);
    line-height: 1.5;
  }
  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
  }
  .sheet-form {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .sheet-error {
    margin: 0 0 16px;
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--red-soft);
    color: var(--red);
    font-size: 13px;
  }
  @media (max-width: 600px) {
    .close-row .month-field {
      width: 100%;
    }
    .close-row :global(button[data-slot="button"]) {
      flex: 1;
    }
  }
</style>
