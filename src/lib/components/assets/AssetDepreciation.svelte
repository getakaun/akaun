<script lang="ts">
  import { untrack } from "svelte";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
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
  import { shiftMonth, type DepreciationSettings } from "$lib/depreciation.js";
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
  let action = $state<"configure" | "stop">("configure");
  let saving = $state(false);
  let error = $state("");
  let showAll = $state(false);
  let preview = $state<{
    version: string;
    baseNbvMinor: number;
    schedule: {
      month: string;
      amountMinor: number;
      projectedNbvMinor: number;
    }[];
  } | null>(null);
  let approvedSettings = $state<DepreciationSettings | null>(null);
  let stopVersion = "";
  const expenseAccounts = $derived(
    accounts.filter((a) => a.active && a.type === AccountType.Expense),
  );
  const accumulatedAccounts = $derived(
    accounts.filter(
      (a) =>
        a.active &&
        a.type === AccountType.Asset &&
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
      .sort()
      .at(-1);
    return {
      startMonth: lastPosted
        ? shiftMonth(lastPosted, 1)
        : (last?.startMonth ??
          (data.asset.inServiceDate ?? data.asset.acquisitionDate).slice(0, 7)),
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
          expenseAccounts.find((a) => /depreciation/i.test(a.name))?.id ??
          "",
      ),
      accumulated: String(
        last?.accumulatedAccountId ??
          data.asset.accumulatedDepreciationAccountId ??
          accumulatedAccounts.find((a) =>
            /accumulated.*depreciation/i.test(a.name),
          )?.id ??
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
  function begin(next: "configure" | "stop") {
    fields = defaults();
    initial = JSON.stringify(fields);
    stopVersion = data.version;
    preview = null;
    approvedSettings = null;
    error = "";
    action = next;
    open = true;
  }
  function close() {
    if (saving) return;
    if (JSON.stringify(fields) !== initial) discardOpen = true;
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
  async function request(kind: "preview" | "approve" | "stop") {
    if (saving || disabled) return;
    error = "";
    const residualMinor = assetMoneyMinor(fields.residual);
    if (
      kind === "preview" &&
      (residualMinor === null || !fields.expense || !fields.accumulated)
    ) {
      error =
        "Enter a valid residual value and choose both depreciation accounts.";
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
            ? { settings: approvedSettings, expectedVersion: preview?.version }
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
        return;
      }
      if (kind === "preview") {
        preview = body;
        approvedSettings = settings;
      } else {
        open = false;
        preview = null;
        await onsaved();
      }
    } catch {
      error = "The result could not be confirmed. Refresh before trying again.";
    } finally {
      saving = false;
    }
  }
</script>

<section class="detail-card" aria-labelledby="depreciation-title">
  <div class="detail-card-head">
    <h2 id="depreciation-title" class="detail-card-title">Depreciation</h2>
  </div>
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
  {#if data.scheduleReviewReason}<p class="hint">
      {data.scheduleReviewReason}
    </p>{/if}
  {#if data.profiles.length}
    <p class="hint">
      Straight line · Full monthly charges · {data.profiles.at(-1)?.mode ===
      "auto"
        ? "Auto-post monthly after month end"
        : "Review before posting"}{data.profiles.at(-1)?.stoppedFrom
        ? ` · Stopped from ${data.profiles.at(-1)?.stoppedFrom}`
        : ""}
    </p>
    <div class="schedule-scroll">
      <table class="rep-table">
        <thead
          ><tr
            ><th>Month</th><th class="rep-amount">Charge</th><th
              class="rep-amount">Projected NBV</th
            ><th>Status</th></tr
          ></thead
        ><tbody>
          {#each showAll ? data.rows : data.rows.slice(0, 12) as row (`${row.profile.id}-${row.month}`)}<tr
              ><td>{row.month}</td><td class="rep-amount"
                >{formatMinor(row.amountMinor)}</td
              ><td class="rep-amount">{formatMinor(row.projectedNbvMinor)}</td
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
    <p class="hint">
      Register balances include opening values and linked posted runs. Manual
      adjustments appear in Reconciliation; projected values follow the
      schedule. Stopping depreciation does not record a disposal.
    </p>
  {:else}<p class="card-empty">
      Set up a straight-line schedule when the asset is ready for use.
    </p>{/if}
  <div class="depreciation-actions">
    {#if data.canConfigure}<Button
        size="sm"
        disabled={disabled || saving || !!data.asset.reviewReason}
        onclick={() => begin("configure")}
        >{data.profiles.length
          ? "Change future depreciation"
          : "Set up depreciation"}</Button
      >
      {#if data.profiles.length}<Button
          size="sm"
          variant="outline"
          disabled={disabled || saving}
          onclick={() => begin("stop")}>Stop future depreciation</Button
        >{/if}{/if}
    <Button
      size="sm"
      variant="outline"
      href={resolve("/(app)/assets?view=depreciation")}
      >Monthly depreciation</Button
    >
  </div>
  {#if disabled}<p class="hint">
      Save or discard asset detail edits before changing depreciation.
    </p>{/if}
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
      onsubmit={(event) => {
        event.preventDefault();
        void request(
          action === "stop" ? "stop" : preview ? "approve" : "preview",
        );
      }}
    >
      <div class="sheet-body">
        <p class="field-hint">
          {action === "stop"
            ? "This stops future scheduled charges. It does not dispose of the asset or reverse posted entries."
            : "Straight line, full monthly charges from the confirmed start month. Existing assets use their remaining balance and remaining useful life."}
        </p>
        {#if error}<div class="depreciation-error" role="alert">
            <ReportNotes notes={[error]} firstIsWarning />
          </div>{/if}
        <fieldset disabled={saving}>
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
          {:else if preview}
            <p class="hint">
              Remaining net book value: {formatMinor(preview.baseNbvMinor)} · Residual:
              {formatMinor(approvedSettings?.residualMinor ?? 0)} · {approvedSettings?.mode ===
              "auto"
                ? "Approve automatic posting, including completed open months shown below"
                : "Review before posting each monthly run"}.
            </p>
            <p class="hint">
              {accounts.find((a) => a.id === approvedSettings?.expenseAccountId)
                ?.name} → {accounts.find(
                (a) => a.id === approvedSettings?.accumulatedAccountId,
              )?.name}
            </p>
            <div class="schedule-scroll">
              <table class="rep-table">
                <thead
                  ><tr
                    ><th>Month</th><th class="rep-amount">Depreciation</th><th
                      >Projected NBV</th
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
                >Remaining useful life (months) *</label
              ><Input
                id="dep-life"
                bind:value={fields.months}
                inputmode="numeric"
                required
              />
            </div>
            <div class="field">
              <label class="field-label" for="dep-residual"
                >Residual value</label
              ><Input
                id="dep-residual"
                bind:value={fields.residual}
                inputmode="decimal"
                required
              />
            </div>
            <div class="field">
              <label class="field-label" for="dep-expense"
                >Depreciation expense account *</label
              ><Select.Root type="single" bind:value={fields.expense}
                ><Select.Trigger id="dep-expense" class="w-full justify-between"
                  >{expenseAccounts.find((a) => String(a.id) === fields.expense)
                    ?.name ?? "Choose expense account"}</Select.Trigger
                ><Select.Content
                  >{#each expenseAccounts as account (account.id)}<Select.Item
                      value={String(account.id)}
                      label={account.name}
                    />{/each}</Select.Content
                ></Select.Root
              >
            </div>
            <div class="field">
              <label class="field-label" for="dep-accum"
                >Accumulated depreciation account *</label
              ><Select.Root type="single" bind:value={fields.accumulated}
                ><Select.Trigger id="dep-accum" class="w-full justify-between"
                  >{accumulatedAccounts.find(
                    (a) => String(a.id) === fields.accumulated,
                  )?.name ?? "Choose separate Asset account"}</Select.Trigger
                ><Select.Content
                  >{#each accumulatedAccounts as account (account.id)}<Select.Item
                      value={String(account.id)}
                      label={account.name}
                    />{/each}</Select.Content
                ></Select.Root
              >
            </div>
            <div class="field">
              <label class="field-label" for="dep-mode">Posting</label
              ><Select.Root type="single" bind:value={fields.mode}
                ><Select.Trigger id="dep-mode" class="w-full justify-between"
                  >{fields.mode === "auto"
                    ? "Auto-post monthly"
                    : "Review before posting"}</Select.Trigger
                ><Select.Content
                  ><Select.Item
                    value="review"
                    label="Review before posting"
                  /><Select.Item
                    value="auto"
                    label="Auto-post monthly"
                  /></Select.Content
                ></Select.Root
              >
            </div>
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
        <div class="sheet-foot-actions">
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
              }}>Back to settings</button
            >{/if}<button
            class="sheet-btn sheet-btn-primary"
            type="submit"
            disabled={saving || disabled}
            >{saving
              ? "Saving…"
              : action === "stop"
                ? "Stop depreciation"
                : preview
                  ? "Approve schedule"
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

<style>
  fieldset {
    border: 0;
    padding: 0;
    margin: 16px 0 0;
    min-width: 0;
  }
  .depreciation-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  .schedule-scroll {
    overflow-x: auto;
    margin-top: 12px;
  }
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
    overflow: hidden;
  }
  .sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .depreciation-error {
    margin-top: 12px;
  }
  .sheet-foot-actions {
    flex-wrap: wrap;
  }
</style>
