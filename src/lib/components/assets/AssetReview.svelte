<script lang="ts">
  import { Dialog } from "bits-ui";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { assetDetailsSchema } from "$lib/fixed-assets.js";
  import { formatDate, formatMinor } from "$lib/format.js";
  import type {
    AssetRegister,
    RegisteredAsset,
  } from "$lib/server/queries/fixed-assets.js";

  let {
    asset,
    accounts,
    canChange,
    disabled = false,
    onsaved,
  }: {
    asset: RegisteredAsset;
    accounts: AssetRegister["accounts"];
    canChange: boolean;
    disabled?: boolean;
    onsaved: () => Promise<void>;
  } = $props();
  let open = $state(false);
  let preview = $state<RegisteredAsset | null>(null);
  let reason = $state("");
  let saving = $state(false);
  let error = $state("");
  let stale = $state(false);
  const shown = $derived(preview ?? asset);
  const comparison = $derived([
    {
      label: "Cost",
      before: formatMinor(shown.costMinor),
      after: shown.source
        ? formatMinor(shown.source.amountMinor)
        : "Unavailable",
      changed: shown.costMinor !== shown.source?.amountMinor,
    },
    {
      label: "Purchase date",
      before: formatDate(shown.acquisitionDate),
      after: shown.source ? formatDate(shown.source.recordDate) : "Unavailable",
      changed: shown.acquisitionDate !== shown.source?.recordDate,
    },
    {
      label: "Asset account",
      before:
        accounts.find((account) => account.id === shown.assetAccountId)?.name ??
        "Missing account",
      after: shown.source?.accountName ?? "Unavailable",
      changed: shown.assetAccountId !== shown.source?.accountId,
    },
  ]);
  function beginReview() {
    preview = asset;
    reason = "";
    error = "";
    stale = false;
    open = true;
  }
  async function accept() {
    if (
      !preview ||
      !reason.trim() ||
      !preview.canAcceptSource ||
      saving ||
      stale ||
      disabled
    )
      return;
    saving = true;
    error = "";
    try {
      const response = await fetch(`/api/fixed-assets/${preview.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...assetDetailsSchema.parse(preview),
          expectedVersion: preview.version,
          expectedSourceVersion: preview.sourceVersion,
          acknowledgeSource: true,
          reason: reason.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "Could not accept purchase changes.";
        stale = response.status === 409 || body.code === "CONFLICT";
        if (stale) await onsaved();
        return;
      }
      open = false;
      preview = null;
      await onsaved();
    } catch {
      error =
        "The result could not be confirmed. Close and refresh before reviewing again.";
      stale = true;
    } finally {
      saving = false;
    }
  }
</script>

{#snippet compare()}
  <div
    class="review-comparison"
    role="region"
    aria-label="Registered and current purchase values"
  >
    <table>
      <thead
        ><tr
          ><th scope="col">Field</th><th scope="col">Registered</th><th
            scope="col">Current purchase</th
          ></tr
        ></thead
      >
      <tbody
        >{#each comparison as row (row.label)}
          <tr class:changed={row.changed}
            ><th scope="row"
              >{row.label}{#if row.changed}<span class="sr-only">
                  (changed)</span
                >{/if}</th
            ><td>{row.before}</td><td
              >{row.after}{#if row.changed}<span class="change-label"
                  >Changed</span
                >{/if}</td
            ></tr
          >
        {/each}</tbody
      >
    </table>
  </div>
{/snippet}

<section
  class="detail-card"
  id="asset-review"
  aria-labelledby="asset-review-title"
>
  <div class="detail-card-head">
    <h2 class="detail-card-title" id="asset-review-title">Asset review</h2>
  </div>
  {#each asset.reviewIssues as issue, index (`${issue.kind}-${index}`)}
    <div class="review-issue">
      <p class="hint">{issue.message}</p>
      {#if issue.kind === "cost-account"}<a
          class="detail-card-action"
          href={resolve("/(app)/accounts/[id]", {
            id: String(asset.assetAccountId),
          })}>Review account mapping</a
        >
      {:else if issue.kind === "depreciation-account"}<a
          class="detail-card-action"
          href="#asset-accumulated">Review depreciation account mapping</a
        >
      {:else if issue.kind === "opening" && asset.openingRecordId}<a
          class="detail-card-action"
          href={resolve("/(app)/records/[id]", {
            id: String(asset.openingRecordId),
          })}>Open evidence record to resolve</a
        >{/if}
    </div>
  {/each}
  {#if asset.sourceRecordId}
    {#if asset.reviewIssues.some((issue) => issue.kind === "purchase")}{@render compare()}{/if}
    <div class="review-actions">
      <Button
        size="sm"
        variant="outline"
        href={resolve("/(app)/records/[id]", {
          id: String(asset.sourceRecordId),
        })}
        >Open purchase{asset.canAcceptSource
          ? " and documents"
          : " to resolve"}</Button
      >
      {#if canChange && asset.canAcceptSource}<Button
          size="sm"
          disabled={disabled || saving}
          onclick={beginReview}>Accept purchase changes</Button
        >{/if}
    </div>
    {#if disabled && asset.canAcceptSource}<p class="hint">
        Save or discard detail edits before reviewing purchase changes.
      </p>{/if}
  {/if}
</section>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!saving) {
      open = next;
      if (!next) preview = null;
    }
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/35" />
    <Dialog.Content
      class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(95vw,600px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-lg"
      onEscapeKeydown={(event) => {
        if (saving) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (saving) event.preventDefault();
      }}
    >
      <Dialog.Title class="text-base font-semibold"
        >Accept purchase changes</Dialog.Title
      >
      <Dialog.Description class="hint"
        >Confirm the current saved purchase values. This updates the asset
        register only and creates no accounting entry.</Dialog.Description
      >
      {@render compare()}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void accept();
        }}
      >
        <div class="field">
          <label class="field-label" for="asset-review-reason"
            >Reason for accepting changes *</label
          ><Textarea
            id="asset-review-reason"
            bind:value={reason}
            required
            maxlength={1000}
            disabled={saving}
          />
        </div>
        {#if error}<p class="text-destructive text-sm" role="alert">
            {error}{stale
              ? " Close and review the latest values before trying again."
              : ""}
          </p>{/if}
        <div class="review-actions justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onclick={() => {
              open = false;
              preview = null;
            }}>Cancel</Button
          >
          <Button
            size="sm"
            type="submit"
            disabled={saving || stale || !reason.trim() || disabled}
            >{saving ? "Saving…" : "Confirm purchase changes"}</Button
          >
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .review-issue + .review-issue {
    margin-top: 8px;
  }
  .review-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .review-comparison {
    overflow-x: auto;
    margin: 14px 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  th,
  td {
    padding: 9px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  thead th {
    color: var(--muted-foreground);
    font-weight: 500;
  }
  .changed {
    background: var(--amber-soft);
  }
  .change-label {
    display: block;
    margin-top: 3px;
    color: var(--muted-foreground);
    font-size: 11px;
  }
</style>
