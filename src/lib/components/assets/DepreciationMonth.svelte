<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { Dialog } from "bits-ui";
  import { resolve } from "$app/paths";
  import { invalidateAll, goto } from "$app/navigation";
  import MonthPicker from "$lib/components/ui/month-picker/MonthPicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
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

<section aria-labelledby="monthly-depreciation-title">
  <div class="flex flex-wrap items-end justify-between gap-3 pb-3">
    <div>
      <h2 id="monthly-depreciation-title" class="text-base font-semibold">
        Monthly depreciation
      </h2>
      <p class="hint">
        This run covers all configured assets in the book. Post earlier due
        months first.
      </p>
    </div>
    <div class="w-[180px]">
      <span class="field-label" id="depreciation-month-label">Month</span
      ><MonthPicker
        bind:value={month}
        labelledBy="depreciation-month-label"
        disabled={saving}
        max={shiftMonth(localToday().slice(0, 7), -1)}
      />
    </div>
  </div>
  {#if error}<p role="alert" class="text-destructive mb-3 text-sm">{error}</p>
    <Button size="sm" variant="outline" onclick={() => (refresh += 1)}
      >Refresh month</Button
    >{/if}
  {#if notice}<p role="status" class="hint mb-3">{notice}</p>{/if}
  {#if loading}<p class="card-empty" role="status">Loading depreciation…</p>
  {:else if data}
    {#if data.unpostedMonths.length}<div
        class="mb-3 flex flex-wrap items-center gap-3"
      >
        <span class="hint"
          >{data.unpostedMonths.length} completed months have unposted charges.</span
        >{#if data.unpostedMonths[0] !== month}<Button
            size="sm"
            variant="outline"
            disabled={saving}
            onclick={() => {
              if (data) month = data.unpostedMonths[0];
            }}>Review earliest month · {data.unpostedMonths[0]}</Button
          >{/if}
      </div>{/if}
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <span class="text-sm"
        >{due.length} unposted · Ready to post {formatMinor(
          data.totalMinor,
        )}</span
      >{#if data.canPost}<Button
          size="sm"
          disabled={saving || !due.length || due.some((row) => !!row.blocked)}
          onclick={() => {
            pending = data;
            confirmOpen = true;
          }}>Post depreciation</Button
        >{/if}
    </div>
    <div class="table-card overflow-x-auto">
      <table class="exp-table">
        <thead
          ><tr
            ><th>Asset</th><th>Depreciation</th><th>Status</th><th>Review</th
            ></tr
          ></thead
        ><tbody>
          {#each data.rows as row (row.assetId)}<tr
              class="exp-row"
              onclick={(event) => {
                if (!(event.target as HTMLElement).closest("a,button"))
                  void goto(
                    resolve("/(app)/assets/[id]", { id: String(row.assetId) }),
                  );
              }}
              ><td class="td-primary" data-label="Asset"
                ><a
                  class="cell-item row-link"
                  href={resolve("/(app)/assets/[id]", {
                    id: String(row.assetId),
                  })}>{row.name}</a
                ></td
              ><td class="td-amount" data-label="Depreciation"
                ><span class="amount-num">{formatMinor(row.amountMinor)}</span
                ></td
              ><td class="row-break"></td><td data-label="Status"
                >{row.status}</td
              ><td data-label="Review"
                >{#if row.blocked}<span class="text-sm text-amber-700"
                    >{row.blocked}</span
                  >{:else if row.recordId}<a
                    class="detail-card-action"
                    href={resolve("/(app)/records/[id]", {
                      id: String(row.recordId),
                    })}>View journal</a
                  >{:else if row.amountMinor === 0}No charge due{:else}{row.automationWarning ??
                    "Ready"}{/if}</td
              ></tr
            >
          {:else}<tr
              ><td colspan="4"
                >No approved charges for this month. Open an asset to set up its
                schedule.</td
              ></tr
            >{/each}
        </tbody>
      </table>
    </div>
    {#if runs.length}<section class="detail-card mt-4">
        <div class="detail-card-head">
          <span class="detail-card-title">Posted runs</span>
        </div>
        <div class="flex flex-col gap-3">
          {#each runs as run (run.runId)}<div
              class="flex flex-wrap items-center justify-between gap-2"
            >
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
  {/if}
</section>
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
      class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 w-[min(95vw,500px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5 shadow-lg"
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
        onsubmit={(e) => {
          e.preventDefault();
          void reverse();
        }}
      >
        <div class="field mt-4">
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
        {#if reversalError}<p role="alert" class="text-destructive text-sm">
            {reversalError}
          </p>{/if}
        <div class="mt-4 flex justify-end gap-2">
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
