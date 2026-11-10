<script lang="ts">
  import "./depreciation.css";
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { Dialog } from "bits-ui";
  import { resolve } from "$app/paths";
  import { invalidateAll, goto } from "$app/navigation";
  import MonthPicker from "$lib/components/ui/month-picker/MonthPicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import "$lib/components/reports/reports.css";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { shiftMonth, depreciationMonth } from "$lib/depreciation.js";
  import { localToday } from "$lib/local-date.js";
  import { formatMinor } from "$lib/format.js";
  import { createResourceStream } from "$lib/sse.js";
  import type { previewDepreciationMonth } from "$lib/server/application/depreciation.js";
  type Preview = Extract<
    ReturnType<typeof previewDepreciationMonth>,
    { ok: true }
  >["value"];
  let month = $state(
    untrack(() => {
      const requested = page.url.searchParams.get("month");
      return depreciationMonth.safeParse(requested).success
        ? requested!
        : shiftMonth(localToday().slice(0, 7), -1);
    }),
  );
  let data = $state<Preview | null>(null);
  let error = $state("");
  let notice = $state("");
  let loading = $state(false);
  let saving = $state(false);
  let refresh = $state(0);
  let confirmOpen = $state(false);
  let pending = $state<Preview | null>(null);
  let reverseRunId = $state<number | null>(null);
  let correctionMonth = $state(
    untrack(() => shiftMonth(localToday().slice(0, 7), -1)),
  );
  let reason = $state("");
  let reversalError = $state("");
  $effect(() => {
    const selected = month;
    void refresh;
    const controller = new AbortController();
    data = null;
    loading = true;
    error = "";
    void fetch(
      `/api/fixed-assets/depreciation?month=${encodeURIComponent(selected)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw Error(body.error ?? "Could not load depreciation.");
        if (!controller.signal.aborted) data = body;
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          error =
            cause instanceof Error
              ? cause.message
              : "Could not load depreciation.";
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort();
  });
  createResourceStream("/api/fixed-assets/stream", () => {
    refresh += 1;
  });
  const due = $derived(
    data?.rows.filter(
      (row) => row.amountMinor > 0 && row.status === "Unposted",
    ) ?? [],
  );
  const runs = $derived([
    ...new Map(
      (data?.rows ?? [])
        .filter((row) => row.runId)
        .map((row) => [
          row.runId!,
          {
            runId: row.runId!,
            recordId: row.recordId!,
            reversed: !!row.reversalRecordId,
          },
        ]),
    ).values(),
  ]);
  async function post() {
    if (!pending || saving) return;
    saving = true;
    error = "";
    notice = "";
    try {
      const response = await fetch("/api/fixed-assets/depreciation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: pending.month,
          expectedVersion: pending.version,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "Could not post depreciation.";
        return;
      }
      notice = body.posted
        ? `Posted depreciation for ${body.posted} assets. Open the journal below to inspect it.`
        : "This month's depreciation is already posted.";
      await invalidateAll();
    } catch {
      error =
        "The result could not be confirmed. Refresh the month before retrying.";
    } finally {
      saving = false;
      refresh += 1;
      pending = null;
    }
  }
  async function reverse() {
    if (!reverseRunId || saving) return;
    saving = true;
    reversalError = "";
    try {
      const response = await fetch(
        `/api/fixed-assets/depreciation/${reverseRunId}/reverse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ month: correctionMonth, reason }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        reversalError = body.error ?? "Could not reverse this run.";
        return;
      }
      reverseRunId = null;
      notice =
        "Run reversed. Future charges for its assets are stopped; review and approve new schedules before resuming.";
      refresh += 1;
      await invalidateAll();
    } catch {
      reversalError =
        "The result could not be confirmed. Refresh before retrying.";
    } finally {
      saving = false;
    }
  }
</script>

<div class="depreciation-workspace">
  <section class="rep-block" aria-labelledby="monthly-depreciation-title">
    <header class="rep-block-head">
      <div>
        <h2 id="monthly-depreciation-title" class="rep-block-title">
          Monthly depreciation
        </h2>
        <p class="rep-block-sub">
          Review completed months and post earlier due charges first.
        </p>
      </div>
      <div class="depreciation-month-filter">
        <span class="field-label" id="depreciation-month-label">Month</span
        ><MonthPicker
          bind:value={month}
          labelledBy="depreciation-month-label"
          disabled={saving}
          onchange={() => {
            notice = "";
          }}
          max={shiftMonth(localToday().slice(0, 7), -1)}
        />
      </div>
    </header>
    <div class="rep-toolbar depreciation-toolbar">
      <span class="rep-block-sub"
        >{data
          ? `${due.length} unposted · Ready to post ${formatMinor(data.totalMinor)}`
          : "Reviewing depreciation"}</span
      >
      <span class="rep-toolbar-spacer"></span>
      {#if data?.canPost}<Button
          size="sm"
          disabled={saving || !due.length || due.some((row) => !!row.blocked)}
          onclick={() => {
            pending = data;
            confirmOpen = true;
          }}>Post depreciation</Button
        >{/if}
    </div>
    {#if error}<div class="depreciation-feedback" role="alert">
        <ReportNotes notes={[error]} firstIsWarning /><Button
          size="sm"
          variant="outline"
          onclick={() => (refresh += 1)}>Refresh month</Button
        >
      </div>{/if}
    {#if notice}<div class="depreciation-feedback" role="status">
        <ReportNotes notes={[notice]} />
      </div>{/if}
    {#if data?.unpostedMonths.length}<div class="depreciation-feedback">
        <p class="rep-block-sub">
          {data.unpostedMonths.length} completed months have unposted charges.
        </p>
        {#if data.unpostedMonths[0] !== month}<Button
            size="sm"
            variant="outline"
            disabled={saving}
            onclick={() => {
              notice = "";
              if (data) month = data.unpostedMonths[0];
            }}>Review earliest month · {data.unpostedMonths[0]}</Button
          >{/if}
      </div>{/if}
    {#if loading}<div class="depreciation-feedback">
        <p class="depreciation-loading" role="status">Loading depreciation…</p>
      </div>
    {:else if data}
      <div class="depreciation-table-scroll">
        <table class="exp-table">
          <thead
            ><tr
              ><th>Asset</th><th class="ta-right">Depreciation</th><th
                >Status</th
              ><th>Review</th></tr
            ></thead
          >
          <tbody
            >{#each data.rows as row (row.assetId)}
              <tr
                class="exp-row"
                onclick={(event) => {
                  if (!(event.target as HTMLElement).closest("a,button"))
                    void goto(
                      resolve("/(app)/assets/[id]", {
                        id: String(row.assetId),
                      }),
                    );
                }}
              >
                <td class="td-primary" data-label="Asset"
                  ><a
                    class="cell-item row-link"
                    href={resolve("/(app)/assets/[id]", {
                      id: String(row.assetId),
                    })}><span class="cell-itemname">{row.name}</span></a
                  ></td
                >
                <td class="td-amount" data-label="Depreciation"
                  ><span class="amount-num">{formatMinor(row.amountMinor)}</span
                  ></td
                ><td class="row-break"></td>
                <td data-label="Status"
                  ><StatusBadge
                    status={row.blocked
                      ? "asset-review"
                      : `depreciation-${row.status.toLowerCase().replaceAll(" ", "-")}`}
                  /></td
                >
                <td class="depreciation-review" data-label="Review"
                  >{#if row.blocked}<span class="depreciation-warning"
                      >{row.blocked}</span
                    >{:else if row.recordId}<a
                      class="detail-card-action"
                      href={resolve("/(app)/records/[id]", {
                        id: String(row.recordId),
                      })}>View journal</a
                    >{:else if row.amountMinor === 0}No charge due{:else}{row.automationWarning ??
                      "Ready"}{/if}</td
                >
              </tr>
            {:else}<tr class="empty-row"
                ><td colspan="4"
                  ><EmptyState
                    title="No approved charges"
                    sub="Open an asset to set up its depreciation schedule, or choose a month with unposted charges."
                  /></td
                ></tr
              >{/each}</tbody
          >
        </table>
      </div>
      <div class="depreciation-table-foot">
        <span
          >{data.rows.length} scheduled {data.rows.length === 1
            ? "asset"
            : "assets"} · {month}</span
        ><span>This run includes all configured assets in the book.</span>
      </div>
    {/if}
  </section>
  {#if data && runs.length}<section class="detail-card">
      <div class="detail-card-head">
        <span class="detail-card-title">Posted runs</span>
      </div>
      <div class="detail-list">
        {#each runs as run (run.runId)}<div class="detail-row depreciation-run">
            <a
              class="detail-card-action"
              href={resolve("/(app)/records/[id]", {
                id: String(run.recordId),
              })}
              >Depreciation journal #{run.recordId}{run.reversed
                ? " · Reversed"
                : ""}</a
            >{#if data.canReverse && !run.reversed}<Button
                size="sm"
                variant="outline"
                disabled={saving}
                onclick={() => {
                  reverseRunId = run.runId;
                  reason = "";
                  reversalError = "";
                  correctionMonth = month;
                }}>Reverse whole run</Button
              >{/if}
          </div>{/each}
      </div>
    </section>{/if}
</div>
<ConfirmDialog
  bind:open={confirmOpen}
  title="Post monthly depreciation?"
  description={`Post ${formatMinor(pending?.totalMinor ?? 0)} for ${pending?.month ?? month}? This creates a balanced accounting journal. Posted schedules cannot be freely edited.`}
  confirmLabel="Post depreciation"
  onConfirm={() => {
    void post();
  }}
/>
<Dialog.Root
  open={reverseRunId !== null}
  onOpenChange={(open) => {
    if (!open && !saving) reverseRunId = null;
  }}
  ><Dialog.Portal
    ><Dialog.Overlay class="fixed inset-0 z-50 bg-black/35" /><Dialog.Content
      class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(95vw,500px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-lg"
      onEscapeKeydown={(e) => {
        if (saving) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (saving) e.preventDefault();
      }}
      ><Dialog.Title class="text-base font-semibold"
        >Reverse depreciation run</Dialog.Title
      ><Dialog.Description class="hint"
        >Reverse the entire run in a completed open month. Original entries stay
        unchanged. Future charges for the affected assets will stop until a new
        schedule is approved.</Dialog.Description
      >
      <form
        class="depreciation-reversal-form depreciation-fields"
        aria-busy={saving}
        onsubmit={(e) => {
          e.preventDefault();
          void reverse();
        }}
      >
        <div class="field">
          <span id="dep-reversal-month" class="field-label"
            >Correction month *</span
          ><MonthPicker
            bind:value={correctionMonth}
            labelledBy="dep-reversal-month"
            disabled={saving}
          />
        </div>
        <div class="field">
          <label for="dep-reversal-reason" class="field-label">Reason *</label
          ><Textarea
            id="dep-reversal-reason"
            bind:value={reason}
            required
            minlength={10}
            maxlength={1000}
            disabled={saving}
          />
        </div>
        {#if reversalError}<div role="alert">
            <ReportNotes notes={[reversalError]} firstIsWarning />
          </div>{/if}
        <div class="depreciation-reversal-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onclick={() => (reverseRunId = null)}>Cancel</Button
          ><Button
            size="sm"
            type="submit"
            disabled={saving || reason.trim().length < 10}
            >{saving ? "Saving…" : "Reverse run"}</Button
          >
        </div>
      </form></Dialog.Content
    ></Dialog.Portal
  ></Dialog.Root
>

<style>
  .depreciation-workspace {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 24px;
  }
  .depreciation-workspace > section {
    flex-shrink: 0;
  }
  .depreciation-month-filter {
    width: 180px;
    flex: 0 0 auto;
  }
  .depreciation-toolbar {
    padding: 12px 16px;
  }
  .depreciation-toolbar > .rep-block-sub {
    margin: 0;
  }
  .depreciation-feedback {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
  }
  .depreciation-feedback :global(.rep-notes) {
    flex: 1 1 260px;
    min-width: 0;
  }
  .depreciation-loading {
    font-size: 12.5px;
    color: var(--muted-foreground);
    margin: 0;
  }
  .depreciation-table-scroll {
    overflow-x: auto;
    min-width: 0;
  }
  .depreciation-table-foot {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px 16px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-foreground);
  }
  .depreciation-review {
    min-width: 180px;
    max-width: 360px;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .depreciation-warning {
    color: var(--amber);
  }
  .depreciation-run {
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .depreciation-run > a {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .depreciation-reversal-form {
    margin-top: 16px;
  }
  .depreciation-reversal-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 767px) {
    /* Match the list pages: the main page owns mobile scrolling. */
    .depreciation-workspace {
      flex: none;
      overflow: visible;
    }
    .depreciation-table-scroll {
      padding: 12px 12px 2px;
    }
    .depreciation-review {
      min-width: 0;
      max-width: 100%;
      margin-top: 6px;
    }
  }
  @media (max-width: 600px) {
    .rep-block-head {
      flex-wrap: wrap;
    }
    .depreciation-month-filter {
      width: 100%;
    }
    .depreciation-run {
      align-items: flex-start;
    }
  }
</style>
