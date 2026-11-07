<script lang="ts">
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { createResourceStream } from "$lib/sse.js";
  import { formatDate, formatMinor } from "$lib/format.js";
  import { assetNumber } from "$lib/fixed-assets.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import AssetSheet from "./AssetSheet.svelte";
  import type { loadFixedAssetsPage } from "$lib/server/loaders/fixed-assets.js";

  let { data }: { data: ReturnType<typeof loadFixedAssetsPage> } = $props();
  let tab = $state("registered");
  let search = $state("");
  let sheetOpen = $state(false);
  let assetId = $state<number | null>(null);
  let movementId = $state<number | null>(null);
  let openedKey = $state("");
  const accountId = $derived(
    Number(page.url.searchParams.get("account")) || null,
  );
  const assets = $derived(
    data.register.assets.filter(
      (asset) =>
        (!accountId || asset.assetAccountId === accountId) &&
        `${assetNumber(asset.id)} ${asset.name} ${asset.assetType} ${asset.serialNumber}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ),
  );
  const purchases = $derived(
    data.register.unregistered.filter(
      (line) =>
        (!accountId || line.accountId === accountId) &&
        `${line.description} ${line.label ?? ""} ${line.accountName}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ),
  );
  const costRows = $derived(
    data.register.costReconciliation.filter(
      (row) => !accountId || row.accountId === accountId,
    ),
  );
  const selectedAsset = $derived(
    data.register.assets.find((asset) => asset.id === assetId) ?? null,
  );
  const selectedSource = $derived(
    data.register.unregistered.find((line) => line.movementId === movementId) ??
      null,
  );
  $effect(() => {
    const key = `${page.url.searchParams.get("asset") ?? ""}:${page.url.searchParams.get("register") ?? ""}`;
    if (key !== openedKey) {
      openedKey = key;
      const id = Number(page.url.searchParams.get("asset"));
      const movement = Number(page.url.searchParams.get("register"));
      if (id || movement) {
        assetId = id || null;
        movementId = movement || null;
        sheetOpen = true;
      }
    }
  });
  createResourceStream<{ type: string }>("/api/fixed-assets/stream", () => {
    void invalidateAll();
  });
  function openAsset(id: number) {
    assetId = id;
    movementId = null;
    sheetOpen = true;
  }
  function registerPurchase(id: number) {
    movementId = id;
    assetId = null;
    sheetOpen = true;
  }
</script>

<div class="screen">
  <div class="page-topbar">
    <a href={resolve("/(app)/accounts")} class="text-muted-foreground text-sm"
      >Accounts</a
    >
  </div>
  <div class="page-content asset-page">
    <div class="asset-title">
      <div>
        <h1 class="page-title">Fixed assets</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Individual assets linked to your existing accounting records.
        </p>
      </div>
      {#if data.canChange}<button
          class="sheet-btn-primary"
          onclick={() => {
            assetId = null;
            movementId = null;
            sheetOpen = true;
          }}>Add existing asset</button
        >{/if}
    </div>
    <form method="GET" class="asset-filters">
      <label for="assets-as-at" class="text-sm">As at</label><Input
        id="assets-as-at"
        type="date"
        name="asAt"
        value={data.register.asAt}
        required
        class="w-auto"
      />
      {#if accountId}<input
          type="hidden"
          name="account"
          value={accountId}
        />{/if}
      <button class="sheet-btn" type="submit">Apply</button>
      {#if accountId}<span class="text-sm"
          >{data.register.accounts.find((account) => account.id === accountId)
            ?.name}</span
        ><a
          href={resolve(
            `/(app)/accounts/fixed-assets?asAt=${data.register.asAt}`,
          )}
          class="text-sm underline">All accounts</a
        >{/if}
    </form>
    <div class="asset-summary">
      <div>
        <span>Register cost · all accounts</span><strong
          >{formatMinor(data.register.totalCostMinor)}</strong
        >
      </div>
      <div>
        <span>Depreciation brought forward · all accounts</span><strong
          >{formatMinor(data.register.totalOpeningDepMinor)}</strong
        >
      </div>
    </div>
    <p class="text-muted-foreground mb-4 text-xs">
      Brought-forward depreciation is recorded at each asset's opening date.
      This register does not calculate current depreciation or current net book
      value. Disposal is not supported yet.
    </p>
    <div class="asset-toolbar">
      <div class="status-tabs">
        {#each [["registered", "Registered assets"], ["unregistered", "Unregistered purchases"], ["reconciliation", "Reconciliation"]] as [value, label] (value)}<button
            class="status-tab"
            class:active={tab === value}
            onclick={() => (tab = value)}>{label}</button
          >{/each}
      </div>
      <Input
        aria-label="Search assets or purchases"
        placeholder="Search assets or purchases"
        bind:value={search}
        class="max-w-xs"
      />
    </div>
    {#if tab === "registered"}
      <div class="asset-table">
        <table class="exp-table">
          <thead
            ><tr
              ><th>Asset</th><th>Type</th><th>Acquired</th><th>In service</th
              ><th>Cost account</th><th class="money">Cost</th><th>Review</th
              ></tr
            ></thead
          ><tbody>
            {#each assets as asset (asset.id)}<tr
                ><td
                  ><a
                    class="row-link"
                    href={resolve(
                      `/(app)/accounts/fixed-assets?asAt=${data.register.asAt}&asset=${asset.id}`,
                    )}
                    onclick={(event) => {
                      if (
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        event.button === 0
                      ) {
                        event.preventDefault();
                        openAsset(asset.id);
                      }
                    }}>{assetNumber(asset.id)} · {asset.name}</a
                  ></td
                ><td>{asset.assetType}</td><td
                  >{formatDate(asset.acquisitionDate)}</td
                ><td
                  >{asset.inServiceDate
                    ? formatDate(asset.inServiceDate)
                    : "Not yet in use"}</td
                ><td>{asset.accountName}</td><td class="money"
                  >{formatMinor(asset.costMinor)}</td
                ><td
                  >{asset.reviewReason
                    ? "Needs review"
                    : asset.openingAsAt
                      ? "Check opening reconciliation"
                      : "Source linked"}</td
                ></tr
              >{/each}
            {#if assets.length === 0}<tr
                ><td colspan="7" class="empty"
                  >No registered assets match this date and filter.</td
                ></tr
              >{/if}
          </tbody>
        </table>
      </div>
    {:else if tab === "unregistered"}
      <p class="text-muted-foreground my-3 text-sm">
        One individual asset per purchase line. Split multi-asset bundles in
        Records before registration. Opening entries, transfers and corrections
        are reviewed in Reconciliation.
      </p>
      <div class="asset-table">
        <table class="exp-table">
          <thead
            ><tr
              ><th>Date</th><th>Purchase</th><th>Account</th><th class="money"
                >Cost</th
              ><th></th></tr
            ></thead
          ><tbody>
            {#each purchases as line (line.movementId)}<tr
                ><td>{formatDate(line.recordDate)}</td><td
                  ><a
                    class="row-link"
                    href={resolve("/(app)/records/[id]", {
                      id: String(line.recordId),
                    })}
                    >{line.label ?? line.description} · {line.recordNumber}</a
                  ></td
                ><td>{line.accountName}</td><td class="money"
                  >{formatMinor(line.amountMinor)}</td
                ><td
                  >{#if data.canChange}<button
                      class="sheet-btn"
                      onclick={() => registerPurchase(line.movementId)}
                      >Register asset</button
                    >{/if}</td
                ></tr
              >{/each}
            {#if purchases.length === 0}<tr
                ><td colspan="5" class="empty"
                  >No unregistered purchases match this date and filter.</td
                ></tr
              >{/if}
          </tbody>
        </table>
      </div>
    {:else}
      <h2 class="mt-5 mb-2 font-semibold">Gross cost reconciliation</h2>
      <p class="text-muted-foreground mb-3 text-sm">
        Ledger balance minus registered cost, as at {formatDate(
          data.register.asAt,
        )}. Registration never fixes a ledger balance automatically.
      </p>
      <div class="asset-table">
        <table class="exp-table">
          <thead
            ><tr
              ><th>Account</th><th class="money">Ledger cost</th><th
                class="money">Register cost</th
              ><th class="money">Difference</th><th>Exceptions</th></tr
            ></thead
          ><tbody>
            {#each costRows as row (row.accountId)}<tr
                ><td
                  ><a
                    href={resolve("/(app)/accounts/[id]", {
                      id: String(row.accountId),
                    })}>{row.accountName}</a
                  ></td
                ><td class="money">{formatMinor(row.ledgerMinor)}</td><td
                  class="money">{formatMinor(row.registerMinor)}</td
                ><td class="money">{formatMinor(row.differenceMinor)}</td><td
                  >{row.unregisteredCount} unregistered · {row.reviewCount} source
                  reviews{#if row.differenceMinor !== 0}<p class="hint">
                      Review missing opening balances, source changes and other
                      movements below.
                    </p>{/if}</td
                ></tr
              >{/each}
            {#if costRows.length === 0}<tr
                ><td colspan="5" class="empty">No fixed-asset cost accounts.</td
                ></tr
              >{/if}
          </tbody>
        </table>
      </div>
      {#each costRows.filter((row) => row.exceptions.length > 0) as row (row.accountId)}<details
          class="asset-exceptions"
        >
          <summary
            >{row.accountName}: {row.exceptions.length} ledger movements without a
            registered source link</summary
          >{#each row.exceptions as line (line.movementId)}<p
              class="flex justify-between gap-3 py-2 text-sm"
            >
              <a
                href={resolve("/(app)/records/[id]", {
                  id: String(line.recordId),
                })}
                >{formatDate(line.recordDate)} · {line.recordNumber} · {line.label ??
                  line.description}{line.voided ? " · void pair" : ""}</a
              ><span>{formatMinor(line.amountMinor)}</span>
            </p>{/each}
          <p class="hint">
            Legacy opening values can represent these movements without a
            purchase-line link. Check the asset's opening reference before
            registering anything again.
          </p>
        </details>{/each}
      {#each assets.filter((asset) => asset.reviewReason) as asset (asset.id)}<p
          class="asset-warning"
        >
          <button class="underline" onclick={() => openAsset(asset.id)}
            >{assetNumber(asset.id)} · {asset.name}</button
          >: {asset.reviewReason}
        </p>{/each}
      <h2 class="mt-6 mb-2 font-semibold">
        Accumulated depreciation reconciliation
      </h2>
      <p class="text-muted-foreground mb-3 text-sm">
        Credit balances are shown as positive depreciation amounts. Differences
        can include depreciation posted manually after an asset's opening date.
      </p>
      <div class="asset-table">
        <table class="exp-table">
          <thead
            ><tr
              ><th>Mapped account</th><th class="money">Ledger depreciation</th
              ><th class="money">Brought forward in register</th><th
                class="money">Unallocated difference</th
              ></tr
            ></thead
          ><tbody
            >{#each data.register.depreciationReconciliation as row (row.accountId)}<tr
                ><td
                  ><a
                    href={resolve("/(app)/accounts/[id]", {
                      id: String(row.accountId),
                    })}>{row.accountName}</a
                  ></td
                ><td class="money">{formatMinor(row.ledgerMinor)}</td><td
                  class="money">{formatMinor(row.registerMinor)}</td
                ><td class="money">{formatMinor(row.differenceMinor)}</td></tr
              >{/each}{#if data.register.depreciationReconciliation.length === 0}<tr
                ><td colspan="4" class="empty"
                  >No accumulated depreciation accounts mapped. Map these when
                  registering legacy depreciation; unmapped accounts are not
                  reconciled here.</td
                ></tr
              >{/if}</tbody
          >
        </table>
      </div>
    {/if}
  </div>
</div>
{#if sheetOpen && (!assetId || selectedAsset) && (!movementId || selectedSource)}<AssetSheet
    asset={selectedAsset}
    source={selectedSource}
    accounts={data.register.accounts}
    canChange={data.canChange}
    onclose={() => (sheetOpen = false)}
    onsaved={invalidateAll}
  />{/if}

<style>
  .asset-page {
    padding: 24px;
    max-width: 1500px;
    margin: 0 auto;
  }
  .asset-title,
  .asset-filters,
  .asset-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .asset-title,
  .asset-toolbar {
    justify-content: space-between;
  }
  .asset-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    margin: 20px 0 12px;
  }
  .asset-summary > div {
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 220px;
  }
  .asset-summary span {
    display: block;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .asset-summary strong {
    display: block;
    margin-top: 8px;
    font-size: 22px;
  }
  .asset-table {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .money {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    padding: 24px;
    color: var(--muted-foreground);
  }
  .hint {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .asset-exceptions {
    padding: 14px;
    border-bottom: 1px solid var(--border);
  }
  .asset-exceptions summary {
    cursor: pointer;
    font-size: 13px;
  }
  .asset-warning {
    padding: 12px;
    margin-top: 12px;
    color: var(--red);
    background: var(--red-soft);
    border-radius: 6px;
    font-size: 13px;
  }
  @media (max-width: 767px) {
    .asset-page {
      padding: 16px;
    }
  }
</style>
