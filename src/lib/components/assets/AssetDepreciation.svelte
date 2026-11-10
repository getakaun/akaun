<script lang="ts">
  import { toast } from "svelte-sonner";
  import { untrack } from "svelte";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import "./depreciation.css";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import "$lib/components/reports/reports.css";
  import { beforeNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import MonthPicker from "$lib/components/ui/month-picker/MonthPicker.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { AccountType } from "$lib/enums.js";
  import { assetMoneyInput, assetMoneyMinor } from "$lib/fixed-assets.js";
  import {
    isAccumulatedDepreciationAccount,
    shiftMonth,
    type DepreciationSettings,
  } from "$lib/depreciation.js";
  import { localToday } from "$lib/local-date.js";
  import { formatMinor } from "$lib/format.js";
  import type { readAssetDepreciation } from "$lib/server/application/depreciation.js";
  import type { AssetRegister } from "$lib/server/queries/fixed-assets.js";
  type State = Extract<
    ReturnType<typeof readAssetDepreciation>,
    { ok: true }
  >["value"];
  let {
    data,
    accounts,
    disabled = false,
    onsaved,
  }: {
    data: State;
    accounts: AssetRegister["accounts"];
    disabled?: boolean;
    onsaved: () => Promise<void>;
  } = $props();
  const screen = useIsMobile();
  let open = $state(false);
  let action = $state<"configure" | "stop" | "catch-up" | "manual">(
    "configure",
  );
  let saving = $state(false);
  let removeAllocation = $state<number | null>(null);
  let removeOpen = $state(false);
  let scheduleOpen = $state(false);
  let error = $state("");
  let showAll = $state(false);
  type Preview = Extract<
    ReturnType<
      typeof import("$lib/server/application/depreciation.js").previewDepreciationProfile
    >,
    { ok: true }
  >["value"];
  type CatchUp = Extract<
    ReturnType<
      typeof import("$lib/server/application/depreciation.js").previewAssetCatchUp
    >,
    { ok: true }
  >["value"];
  let preview = $state<Preview | null>(null);
  let catchUp = $state<CatchUp | null>(null);
  let postHistory = $state(false);
  let advanced = $state(false);
  let manualKey = $state("");
  let manualAmount = $state("");
  let manualFrom = $state("");
  let manualThrough = $state("");
  let manualReason = $state("");
  const manualCandidate = $derived(
    data.manualCandidates.find((c) => c.key === manualKey),
  );
  const latest = $derived(data.profiles.at(-1));
  const needsAttention = $derived(
    !!data.asset.reviewReason ||
      !!data.scheduleReviewReason ||
      !!data.reconciliation?.differenceMinor ||
      !!data.postingIssue,
  );
  const pending = $derived(
    data.rows.some((r) => r.status === "Unposted" && r.amountMinor > 0),
  );
  let approvedSettings = $state<DepreciationSettings | null>(null);
  let stopVersion = "";
  const expenseAccounts = $derived(
    accounts.filter((a) => a.active && a.type === AccountType.Expense),
  );
  const accumulatedAccounts = $derived(
    accounts.filter(
      (a) =>
        a.active &&
        isAccumulatedDepreciationAccount(a) &&
        a.id !== data.asset.assetAccountId,
    ),
  );
  function defaults() {
    const last = data.profiles.at(-1);
    const lastPosted = data.history
      .flatMap(({ posting, run }) => [
        posting.month,
        ...(run.reversedOn ? [run.reversedOn.slice(0, 7)] : []),
      ])
      .concat(
        data.allocations.flatMap((a) => [
          a.throughMonth,
          a.recordDate.slice(0, 7),
        ]),
      )
      .sort()
      .at(-1);
    return {
      startMonth: lastPosted
        ? shiftMonth(lastPosted, 1)
        : (last?.startMonth ??
          (data.asset.openingAsAt
            ? shiftMonth(data.asset.openingAsAt.slice(0, 7), 1)
            : (data.asset.inServiceDate ?? data.asset.acquisitionDate).slice(
                0,
                7,
              ))),
      months: last
        ? String(
            data.rows.filter(
              (row) =>
                row.profile.id === last.id &&
                row.status !== "Posted" &&
                row.status !== "Reversed",
            ).length || "",
          )
        : String(data.asset.usefulLifeMonths ?? 36),
      residual: assetMoneyInput(
        last?.residualMinor ?? data.asset.residualMinor ?? 0,
      ),
      expense: String(
        last?.expenseAccountId ??
          data.asset.depreciationExpenseAccountId ??
          data.defaults.expenseAccountId ??
          "",
      ),
      accumulated: String(
        last?.accumulatedAccountId ??
          data.asset.accumulatedDepreciationAccountId ??
          data.defaults.accumulatedAccountId ??
          "",
      ),
      mode: last?.mode ?? "review",
      reason: last ? "" : "Initial depreciation setup",
      stopMonth: localToday().slice(0, 7),
    };
  }
  let fields = $state(untrack(defaults));
  let initial = "";
  let discardOpen = $state(false);
  let pendingHref: string | null = null;
  let leaving = false;
  function begin(next: "configure" | "stop" | "catch-up" | "manual") {
    fields = defaults();

    stopVersion = data.version;
    preview = null;
    catchUp = null;
    postHistory = false;
    advanced = false;
    manualKey = "";
    manualAmount = "";
    manualFrom = "";
    manualThrough = "";
    manualReason = "";
    approvedSettings = null;
    initial = formSnapshot();
    error = "";
    action = next;
    open = true;
    if (next === "catch-up") void request("catch-up-preview");
  }
  function formSnapshot() {
    return JSON.stringify({
      fields,
      manualKey,
      manualAmount,
      manualFrom,
      manualThrough,
      manualReason,
      postHistory,
    });
  }
  function close() {
    if (saving) return;
    if (formSnapshot() !== initial) discardOpen = true;
    else open = false;
  }
  beforeNavigate((nav) => {
    if (leaving) {
      leaving = false;
      return;
    }
    if (!open || nav.willUnload || !nav.to) return;
    if (saving) {
      nav.cancel();
      return;
    }
    pendingHref = nav.to.url.href;
    nav.cancel();
    discardOpen = true;
  });
  function discard() {
    open = false;
    if (pendingHref) {
      const href = pendingHref;
      pendingHref = null;
      leaving = true;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- URL supplied by SvelteKit's navigation guard.
      void goto(href);
    }
  }
  async function request(
    kind:
      | "preview"
      | "approve"
      | "stop"
      | "catch-up-preview"
      | "catch-up"
      | "link-manual"
      | "unlink-manual",
    allocationId?: number,
  ) {
    if (saving || disabled) return;
    error = "";
    const residualMinor = assetMoneyMinor(fields.residual);
    if (
      kind === "preview" &&
      (residualMinor === null || !fields.expense || !fields.accumulated)
    ) {
      error =
        "Enter a valid residual value and choose existing depreciation expense and accumulated depreciation accounts.";
      return;
    }
    const settings: DepreciationSettings = {
      startMonth: fields.startMonth,
      months: Number(fields.months),
      residualMinor: residualMinor ?? 0,
      expenseAccountId: Number(fields.expense),
      accumulatedAccountId: Number(fields.accumulated),
      mode: fields.mode,
      reason: fields.reason,
    };
    saving = true;
    try {
      const input =
        kind === "preview"
          ? settings
          : kind === "approve"
            ? {
                settings: approvedSettings,
                expectedVersion: preview?.version,
                postHistory,
              }
            : kind === "catch-up"
              ? { expectedVersion: catchUp?.version }
              : kind === "link-manual"
                ? {
                    candidateKey: manualKey,
                    amountMinor: assetMoneyMinor(manualAmount),
                    fromMonth: manualFrom,
                    throughMonth: manualThrough,
                    reason: manualReason,
                    expectedVersion: data.version,
                  }
                : kind === "unlink-manual"
                  ? { allocationId, expectedVersion: data.version }
                  : {
                      month: fields.stopMonth,
                      reason: fields.reason,
                      expectedVersion: stopVersion,
                    };
      const response = await fetch(
        `/api/fixed-assets/${data.asset.id}/depreciation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: kind, input }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        error =
          body.issues?.[0]?.message ??
          body.error ??
          "Could not save depreciation.";
        toast.error(error);
        return;
      }
      if (kind === "catch-up-preview") {
        catchUp = body;
      } else if (kind === "preview") {
        preview = body;
        approvedSettings = settings;
      } else {
        open = false;
        preview = null;
        toast.success(
          kind === "link-manual"
            ? "Manual depreciation linked"
            : kind === "unlink-manual"
              ? "Manual link removed"
              : kind === "catch-up" || (kind === "approve" && postHistory)
                ? "Depreciation posted"
                : "Depreciation saved",
        );
        await onsaved();
      }
    } catch {
      error = "The result could not be confirmed. Refresh before trying again.";
      toast.error(error);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet expensePicker()}
  <div class="field">
    <label class="field-label" for="dep-expense"
      >Depreciation expense account *</label
    ><Select.Root type="single" bind:value={fields.expense} required
      ><Select.Trigger id="dep-expense" class="w-full justify-between"
        ><span class="truncate"
          >{expenseAccounts.find((a) => String(a.id) === fields.expense)
            ?.name ?? "Choose depreciation expense account"}</span
        ></Select.Trigger
      ><Select.Content
        >{#each expenseAccounts as account (account.id)}<Select.Item
            value={String(account.id)}
            label={account.name}
          />{/each}</Select.Content
      ></Select.Root
    >
  </div>
{/snippet}

<section class="detail-card" aria-labelledby="depreciation-title">
  <div class="detail-card-head depreciation-card-head">
    <h2 id="depreciation-title" class="detail-card-title">Depreciation</h2>
    <StatusBadge status={data.asset.depreciation.status} />
  </div>
  <div class="depreciation-card-body">
    <div class="detail-list">
      <div class="detail-row">
        <span class="detail-key">Original cost</span><span class="detail-val"
          >{formatMinor(data.asset.costMinor)}</span
        >
      </div>
      <div class="detail-row">
        <span class="detail-key">Accumulated depreciation</span><span
          class="detail-val">{formatMinor(data.accumulatedMinor)}</span
        >
      </div>
      <div class="detail-row">
        <span class="detail-key">Net book value · {data.asAt}</span><span
          class="detail-val">{formatMinor(data.nbvMinor)}</span
        >
      </div>
    </div>
    {#if data.asset.reviewReason}<p class="hint">
        Resolve the asset review before posting depreciation.
      </p>{/if}
    {#if data.postingIssue}<p class="hint">{data.postingIssue}</p>{/if}
    {#if data.scheduleReviewReason}<p class="hint">
        {data.scheduleReviewReason}
      </p>{/if}
    {#if data.reconciliation?.differenceMinor}
      <ReportNotes
        notes={[
          `${data.reconciliation.name}: ledger ${formatMinor(data.reconciliation.ledgerMinor)}, explained by assets ${formatMinor(data.reconciliation.explainedMinor)}, difference ${formatMinor(data.reconciliation.differenceMinor)}. Review existing journals and link the amount belonging to this asset before posting again.`,
        ]}
        firstIsWarning
      />
    {/if}
    {#if data.reconciliation?.differenceMinor}<a
        class="detail-card-action"
        href={resolve("/(app)/records")}>Review existing records</a
      >{/if}
    {#if data.allocations.length}
      <details class="depreciation-disclosure">
        <summary>Linked manual depreciation ({data.allocations.length})</summary
        >
        <div class="depreciation-disclosure-body depreciation-allocation-list">
          {#each data.allocations as allocation (allocation.id)}
            <div class="detail-row">
              <a
                class="detail-card-action"
                href={resolve("/(app)/records/[id]", {
                  id: String(allocation.recordId),
                })}
                >{allocation.fromMonth}–{allocation.throughMonth} · {formatMinor(
                  allocation.amountMinor,
                )}</a
              >
              {#if data.canConfigure && !data.history.length}<button
                  type="button"
                  class="detail-card-action"
                  disabled={disabled || saving}
                  onclick={() => {
                    removeAllocation = allocation.id;
                    removeOpen = true;
                  }}>Remove link</button
                >{/if}
            </div>
          {/each}
        </div>
      </details>
    {/if}
    {#if data.profiles.length}
      <p class="hint">
        Straight line · Full monthly charges · {data.profiles.at(-1)?.mode ===
        "auto"
          ? "Auto-post monthly after month end"
          : "Review before posting"}{data.profiles.at(-1)?.stoppedFrom
          ? ` · Stopped from ${data.profiles.at(-1)?.stoppedFrom}`
          : ""}
      </p>
      <details class="depreciation-disclosure" bind:open={scheduleOpen}>
        <summary>View schedule and posting history</summary>
        <div class="depreciation-disclosure-body">
          <div class="schedule-scroll">
            <table class="rep-table">
              <thead
                ><tr
                  ><th>Month</th><th class="rep-amount">Charge</th><th
                    class="rep-amount">Projected net book value</th
                  ><th>Status</th></tr
                ></thead
              ><tbody>
                {#each showAll ? data.rows : data.rows.slice(0, 12) as row (`${row.profile.id}-${row.month}`)}<tr
                    ><td>{row.month}</td><td class="rep-amount"
                      >{formatMinor(row.amountMinor)}</td
                    ><td class="rep-amount"
                      >{formatMinor(row.projectedNbvMinor)}</td
                    ><td
                      >{#if row.recordId}<a
                          class="detail-card-action"
                          href={resolve("/(app)/records/[id]", {
                            id: String(row.recordId),
                          })}
                          ><StatusBadge
                            status={`depreciation-${row.status.toLowerCase().replaceAll(" ", "-")}`}
                          /></a
                        >{:else}<StatusBadge
                          status={`depreciation-${row.status.toLowerCase().replaceAll(" ", "-")}`}
                        />{/if}</td
                    ></tr
                  >{/each}
              </tbody>
            </table>
          </div>
          {#if data.rows.length > 12}<button
              type="button"
              class="list-expand-btn"
              onclick={() => (showAll = !showAll)}
              >{showAll
                ? "Show fewer months"
                : `Show all ${data.rows.length} months`}</button
            >{/if}
        </div>
      </details>
      <p class="hint">
        Register balances include opening values, linked manual journals and
        posted runs. Projected values follow the schedule. Stopping depreciation
        does not record a disposal.
      </p>
    {:else}<p class="card-empty">
        Set up a straight-line schedule when the asset is ready for use.
      </p>{/if}
    <div class="depreciation-actions">
      {#if data.canConfigure}
        {#if data.asset.reviewReason}<Button
            size="sm"
            href="#asset-review"
            disabled={disabled || saving}>Review asset</Button
          >
        {:else if data.reconciliation?.differenceMinor && data.history.length}<Button
            size="sm"
            href={resolve("/(app)/records")}
            disabled={disabled || saving}>Review manual adjustments</Button
          >
        {:else if needsAttention}<Button
            size="sm"
            disabled={disabled || saving}
            onclick={() =>
              begin(
                data.reconciliation?.differenceMinor
                  ? "manual"
                  : data.postingIssue?.includes("closed") &&
                      !data.scheduleReviewReason
                    ? "catch-up"
                    : "configure",
              )}>Resolve depreciation</Button
          >
        {:else if !latest}<Button
            size="sm"
            disabled={disabled || saving}
            onclick={() => begin("configure")}>Set up depreciation</Button
          >
        {:else if data.historyReview.length}<Button
            size="sm"
            disabled={disabled || saving}
            onclick={() => begin("catch-up")}>Review missed months</Button
          >
        {:else if latest.stoppedFrom || !pending || !data.hasDue}<Button
            size="sm"
            variant="outline"
            onclick={() => {
              scheduleOpen = true;
              showAll = true;
            }}
            >{latest.stoppedFrom || !pending
              ? "View history"
              : "View schedule"}</Button
          >
        {:else if latest.mode === "review"}<Button
            size="sm"
            href={resolve("/(app)/assets?view=depreciation")}
            >Review monthly depreciation</Button
          >{/if}
      {/if}
      <a
        class="detail-card-action"
        href={resolve("/(app)/assets?view=depreciation")}>All monthly runs</a
      >
    </div>
    {#if data.canConfigure}<details class="depreciation-disclosure">
        <summary>Manage depreciation</summary>
        <div class="depreciation-disclosure-body">
          <div class="depreciation-actions">
            {#if data.profiles.length}<Button
                size="sm"
                variant="outline"
                disabled={disabled || saving || !!data.asset.reviewReason}
                onclick={() => begin("configure")}
                >Change remaining schedule</Button
              >
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || saving}
                onclick={() => begin("stop")}>Stop future depreciation</Button
              >{/if}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || saving || !!data.history.length}
              onclick={() => begin("manual")}
              >Link existing manual depreciation</Button
            >
            {#if data.rows.some((r) => r.status === "Unposted")}<Button
                size="sm"
                variant="outline"
                disabled={disabled || saving}
                onclick={() => begin("catch-up")}>Review missed months</Button
              >{/if}
          </div>
        </div>
      </details>{/if}
    {#if disabled}<p class="hint">
        Save or discard asset detail edits before changing depreciation.
      </p>{/if}
  </div>
</section>

<Sheet.Root
  {open}
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <Sheet.Content
    side={screen.current ? "bottom" : "right"}
    style={screen.current
      ? "height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;"
      : "width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;"}
    onEscapeKeydown={(event) => {
      event.preventDefault();
      close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      close();
    }}
  >
    <div class="sheet-head">
      <div>
        <div class="sheet-eyebrow">Depreciation</div>
        <Sheet.Title class="sheet-title-text"
          >{action === "stop"
            ? "Stop future depreciation"
            : action === "catch-up"
              ? "Review missed depreciation"
              : action === "manual"
                ? "Link manual depreciation"
                : preview
                  ? "Approve depreciation schedule"
                  : "Set up depreciation"}</Sheet.Title
        ><Sheet.Description class="sr-only"
          >Review the asset depreciation settings and schedule before approving.</Sheet.Description
        >
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="Close depreciation"
        onclick={close}
        disabled={saving}><X size={16} /></button
      >
    </div>
    <form
      class="depreciation-sheet-form"
      aria-busy={saving}
      onsubmit={(event) => {
        event.preventDefault();
        void request(
          action === "stop"
            ? "stop"
            : action === "catch-up"
              ? "catch-up"
              : action === "manual"
                ? "link-manual"
                : preview
                  ? "approve"
                  : "preview",
        );
      }}
    >
      <div class="sheet-body">
        <p class="depreciation-intro">
          {action === "stop"
            ? "This stops future scheduled charges. It does not dispose of the asset or reverse posted entries."
            : action === "catch-up"
              ? "Review completed months for this asset only. Charges keep their original month-end dates; closed months must be reopened first."
              : action === "manual"
                ? "Link a journal you already recorded. This updates the asset register without posting another charge. Then set up the remaining schedule after the linked months."
                : "Straight line, full monthly charges from the confirmed start month. Existing assets use their remaining balance and remaining useful life."}
        </p>
        {#if error}<div class="depreciation-error" role="alert">
            <ReportNotes notes={[error]} firstIsWarning />
          </div>{/if}
        <fieldset class="depreciation-fields" disabled={saving}>
          {#if action === "stop"}<div class="field">
              <span class="field-label" id="dep-stop-month"
                >Stop from month</span
              ><MonthPicker
                labelledBy="dep-stop-month"
                bind:value={fields.stopMonth}
              />
            </div>
            <div class="field">
              <label class="field-label" for="dep-stop-reason">Reason *</label
              ><Input
                id="dep-stop-reason"
                bind:value={fields.reason}
                required
                maxlength={1000}
              />
            </div>
          {:else if action === "catch-up"}
            {#if catchUp}
              <p class="hint">
                {catchUp.history.count} missed months · {catchUp.history.from ??
                  "—"} to {catchUp.history.through ?? "—"} · {formatMinor(
                  catchUp.history.totalMinor,
                )}
              </p>
              {#if catchUp.history.closedMonths.length}<ReportNotes
                  notes={[
                    `Closed months: ${catchUp.history.closedMonths.join(", ")}. Reopen these months in Accounting close before posting.`,
                  ]}
                  firstIsWarning
                />{/if}
              <div class="schedule-scroll">
                <table class="rep-table">
                  <thead
                    ><tr
                      ><th>Month</th><th class="rep-amount">Charge</th><th
                        >Review</th
                      ></tr
                    ></thead
                  ><tbody>
                    {#each catchUp.months as row (row.month)}<tr
                        ><td>{row.month}</td><td class="rep-amount"
                          >{formatMinor(row.amountMinor)}</td
                        ><td>{row.blocked ?? "Ready"}</td></tr
                      >{/each}
                  </tbody>
                </table>
              </div>
            {:else}<p class="hint">
                {saving
                  ? "Loading missed months…"
                  : "Could not load missed months. Close and try again."}
              </p>{/if}
          {:else if action === "manual"}
            <div class="field">
              <label class="field-label" for="dep-manual"
                >Existing journal *</label
              ><Select.Root
                type="single"
                bind:value={manualKey}
                onValueChange={(key) => {
                  const c = data.manualCandidates.find((c) => c.key === key);
                  manualAmount = c ? assetMoneyInput(c.availableMinor) : "";
                  manualThrough = c?.date.slice(0, 7) ?? "";
                }}
                ><Select.Trigger id="dep-manual" class="w-full justify-between"
                  ><span class="truncate"
                    >{manualCandidate
                      ? `${manualCandidate.date} · ${manualCandidate.description}`
                      : "Choose existing depreciation journal"}</span
                  ></Select.Trigger
                ><Select.Content
                  >{#each data.manualCandidates as c (c.key)}<Select.Item
                      value={c.key}
                      label={`${c.date} · ${c.description} · ${c.expenseName} → ${c.accumulatedName} · ${formatMinor(c.availableMinor)}`}
                    />{/each}</Select.Content
                ></Select.Root
              >
            </div>
            {#if !data.manualCandidates.length}<p class="hint">
                No unallocated journals available. Open Records to review the
                original depreciation entry and its accounts.
              </p>{/if}
            <a class="detail-card-action" href={resolve("/(app)/records")}
              >Review records</a
            >
            {#if manualCandidate}<p class="hint">
                {manualCandidate.expenseName} → {manualCandidate.accumulatedName}
                · Available {formatMinor(manualCandidate.availableMinor)}
              </p>
              <a
                class="detail-card-action"
                href={resolve("/(app)/records/[id]", {
                  id: String(manualCandidate.recordId),
                })}
                target="_blank"
                rel="noreferrer">Review selected journal in a new tab</a
              >{/if}
            <div class="field">
              <label class="field-label" for="dep-manual-amount"
                >Amount for this asset *</label
              ><Input
                id="dep-manual-amount"
                bind:value={manualAmount}
                inputmode="decimal"
                required
              />
            </div>
            <div class="field">
              <span id="dep-manual-from" class="field-label"
                >First covered month *</span
              ><MonthPicker
                labelledBy="dep-manual-from"
                bind:value={manualFrom}
              />
            </div>
            <div class="field">
              <span id="dep-manual-through" class="field-label"
                >Last covered month *</span
              ><MonthPicker
                labelledBy="dep-manual-through"
                bind:value={manualThrough}
              />
            </div>
            <div class="field">
              <label class="field-label" for="dep-manual-reason">Reason *</label
              ><Input
                id="dep-manual-reason"
                bind:value={manualReason}
                required
                maxlength={1000}
              />
            </div>
          {:else if preview}
            <dl class="detail-list depreciation-summary">
              <div class="detail-row">
                <dt class="detail-key">Remaining book value</dt>
                <dd class="detail-val">{formatMinor(preview.baseNbvMinor)}</dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Residual value</dt>
                <dd class="detail-val">
                  {formatMinor(approvedSettings?.residualMinor ?? 0)}
                </dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Monthly charge</dt>
                <dd class="detail-val">
                  {formatMinor(preview.schedule[0]?.amountMinor ?? 0)}
                </dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Final month</dt>
                <dd class="detail-val">{preview.schedule.at(-1)?.month}</dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Final book value</dt>
                <dd class="detail-val">
                  {formatMinor(preview.schedule.at(-1)?.projectedNbvMinor ?? 0)}
                </dd>
              </div>
            </dl>
            <p class="hint">
              {approvedSettings?.mode === "auto"
                ? "Future months will post automatically after month end."
                : "Review before posting each monthly run."}
            </p>
            <div class="depreciation-account-summary">
              <p class="field-label">Posting accounts</p>
              <dl class="detail-list">
                <div class="detail-row">
                  <dt class="detail-key">Depreciation expense account</dt>
                  <dd class="detail-val">
                    {accounts.find(
                      (a) => a.id === approvedSettings?.expenseAccountId,
                    )?.name}
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">Accumulated depreciation account</dt>
                  <dd class="detail-val">
                    {accounts.find(
                      (a) => a.id === approvedSettings?.accumulatedAccountId,
                    )?.name}
                  </dd>
                </div>
              </dl>
            </div>
            {#if preview.history.count}
              <div
                class="depreciation-choices"
                role="radiogroup"
                aria-labelledby="dep-history-label"
              >
                <p class="field-label" id="dep-history-label">
                  {preview.history.count} missed months · {preview.history
                    .from}–{preview.history.through} · {formatMinor(
                    preview.history.totalMinor,
                  )}
                </p>
                <label class="depreciation-choice"
                  ><input
                    type="radio"
                    name="dep-history"
                    checked={!postHistory}
                    onchange={() => (postHistory = false)}
                  /><span>Save setup; review missed months later</span></label
                >
                <label class="depreciation-choice"
                  ><input
                    type="radio"
                    name="dep-history"
                    checked={postHistory}
                    onchange={() => (postHistory = true)}
                    disabled={!!preview.history.closedMonths.length}
                  /><span>Approve and post missed months now</span></label
                >
                {#if preview.history.closedMonths.length}<ReportNotes
                    notes={[
                      `Closed months: ${preview.history.closedMonths.join(", ")}. You can save setup now and reopen these months before posting.`,
                    ]}
                    firstIsWarning
                  />{:else}<p class="hint">
                    Already recorded depreciation? Go back and link the existing
                    journals first.
                  </p>{/if}
                <p class="hint">
                  Automatic posting waits until earlier missed months are
                  resolved.
                </p>
              </div>
            {/if}
            <details class="depreciation-disclosure">
              <summary>View full schedule</summary>
              <div class="depreciation-disclosure-body">
                <div class="schedule-scroll">
                  <table class="rep-table">
                    <thead
                      ><tr
                        ><th>Month</th><th class="rep-amount">Depreciation</th
                        ><th class="rep-amount">Projected net book value</th
                        ></tr
                      ></thead
                    ><tbody
                      >{#each preview.schedule as row (row.month)}<tr
                          ><td>{row.month}</td><td class="rep-amount"
                            >{formatMinor(row.amountMinor)}</td
                          ><td class="rep-amount"
                            >{formatMinor(row.projectedNbvMinor)}</td
                          ></tr
                        >{/each}</tbody
                    >
                  </table>
                </div>
              </div>
            </details>
          {:else}
            <div class="field">
              <span id="dep-start-month" class="field-label"
                >Start depreciating from *</span
              ><MonthPicker
                labelledBy="dep-start-month"
                bind:value={fields.startMonth}
              />
            </div>
            <div class="field">
              <label class="field-label" for="dep-life"
                >{data.allocations.length ||
                data.history.length ||
                data.asset.openingAsAt
                  ? "Remaining useful life"
                  : "Useful life"} (months) *</label
              ><Input
                id="dep-life"
                bind:value={fields.months}
                inputmode="numeric"
                required
              />
            </div>
            {@render expensePicker()}
            <div class="field">
              <label class="field-label" for="dep-accum"
                >Accumulated depreciation account *</label
              >
              <Select.Root
                type="single"
                bind:value={fields.accumulated}
                required
              >
                <Select.Trigger id="dep-accum" class="w-full justify-between">
                  <span class="truncate"
                    >{accumulatedAccounts.find(
                      (a) => String(a.id) === fields.accumulated,
                    )?.name ?? "Choose accumulated depreciation account"}</span
                  >
                </Select.Trigger>
                <Select.Content>
                  {#each accumulatedAccounts as account (account.id)}
                    <Select.Item
                      value={String(account.id)}
                      label={account.name}
                    />
                  {/each}
                </Select.Content>
              </Select.Root>
              <p class="field-hint">
                Choose a separate non-current asset account. It keeps
                accumulated depreciation separate from the original cost.
              </p>
            </div>
            <p class="field-hint">
              Both posting accounts must already exist. <a
                class="detail-card-action"
                href={resolve("/(app)/accounts")}
                >Create missing accounts in Accounts</a
              >, then return to set up depreciation.
            </p>

            <div class="depreciation-toggle">
              <div>
                <label class="field-label" for="dep-auto"
                  >Auto-post monthly</label
                >
                <p class="field-hint">Post completed months automatically.</p>
              </div>
              <Switch
                id="dep-auto"
                checked={fields.mode === "auto"}
                onCheckedChange={(checked) =>
                  (fields.mode = checked ? "auto" : "review")}
                disabled={saving}
              />
            </div>
            <details class="depreciation-disclosure" bind:open={advanced}>
              <summary>More options</summary>
              <div class="depreciation-disclosure-body">
                <p class="hint">
                  Asset cost account: {accounts.find(
                    (a) => a.id === data.asset.assetAccountId,
                  )?.name} (from the purchase). Accumulated depreciation is kept separately
                  so the original asset cost stays visible.
                </p>
                <div class="field">
                  <label class="field-label" for="dep-residual"
                    >Residual value</label
                  ><Input
                    id="dep-residual"
                    bind:value={fields.residual}
                    inputmode="decimal"
                  />
                </div>
              </div>
            </details>
            {#if data.profiles.length}<div class="field">
                <label class="field-label" for="dep-reason"
                  >Reason for change *</label
                ><Input
                  id="dep-reason"
                  bind:value={fields.reason}
                  required
                  maxlength={1000}
                />
              </div>{/if}
          {/if}
        </fieldset>
      </div>
      <footer class="sheet-foot">
        <div class="sheet-foot-actions depreciation-footer-actions">
          <button
            type="button"
            class="sheet-btn"
            disabled={saving}
            onclick={close}>Cancel</button
          >{#if preview}<button
              type="button"
              class="sheet-btn"
              disabled={saving}
              onclick={() => {
                preview = null;
                approvedSettings = null;
              }}>Back</button
            >{/if}<button
            class="sheet-btn sheet-btn-primary"
            type="submit"
            disabled={saving ||
              disabled ||
              (action === "catch-up" &&
                (!catchUp?.history.count ||
                  !!catchUp.history.closedMonths.length)) ||
              (action === "manual" && !manualCandidate)}
            >{saving
              ? "Saving…"
              : action === "stop"
                ? "Stop depreciation"
                : action === "catch-up"
                  ? "Post missed months"
                  : action === "manual"
                    ? "Link existing journal"
                    : preview
                      ? postHistory
                        ? "Approve and post missed months"
                        : "Save setup"
                      : "Preview schedule"}</button
          >
        </div>
      </footer>
    </form>
  </Sheet.Content>
</Sheet.Root>
<ConfirmDialog
  bind:open={discardOpen}
  title="Discard depreciation changes?"
  description="The unsaved depreciation settings will be lost."
  confirmLabel="Discard changes"
  onConfirm={discard}
/>

<ConfirmDialog
  bind:open={removeOpen}
  title="Remove manual depreciation link?"
  description="The journal stays in Records. The remaining schedule will stop until you review and approve it again."
  confirmLabel="Remove link"
  onConfirm={() => {
    const id = removeAllocation;
    removeAllocation = null;
    if (id) void request("unlink-manual", id);
  }}
/>

<style>
  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .depreciation-sheet-form {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
