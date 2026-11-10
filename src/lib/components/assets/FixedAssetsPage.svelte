<script lang="ts">
  import { page } from "$app/state";
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { fly } from "svelte/transition";
  import { Package, Plus, Search, X } from "@lucide/svelte";
  import { createResourceStream } from "$lib/sse.js";
  import { formatDate, formatMinor } from "$lib/format.js";
  import { assetNumber } from "$lib/fixed-assets.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import AssetStatus from "./AssetStatus.svelte";
  import AssetSheet from "./AssetSheet.svelte";
  import DepreciationMonth from "./DepreciationMonth.svelte";
  import AssetReconciliation from "./AssetReconciliation.svelte";
  import type { loadFixedAssetsPage } from "$lib/server/loaders/fixed-assets.js";

  let { data }: { data: ReturnType<typeof loadFixedAssetsPage> } = $props();
  let tab = $state("registered");
  let search = $state("");
  let mobileSearchOpen = $state(false);
  let mobileSearchEl = $state<HTMLInputElement | null>(null);
  let sheetOpen = $state(false);
  let movementId = $state<number | null>(null);
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
  const shownCostMinor = $derived(
    Number(
      assets.reduce((total, asset) => total + BigInt(asset.costMinor), 0n),
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
  const selectedSource = $derived(
    data.register.unregistered.find((line) => line.movementId === movementId) ??
      null,
  );
  $effect(() => {
    if (mobileSearchOpen && mobileSearchEl) mobileSearchEl.focus();
  });
  $effect(() => {
    const requested = page.url.searchParams.get("view");
    if (
      requested === "registered" ||
      requested === "unregistered" ||
      requested === "reconciliation" ||
      requested === "depreciation"
    )
      tab = requested;
    const movement = Number(page.url.searchParams.get("register"));
    if (movement) {
      movementId = movement;
      sheetOpen = true;
    }
  });
  createResourceStream("/api/fixed-assets/stream", () => {
    void invalidateAll();
  });
  function create() {
    movementId = null;
    sheetOpen = true;
  }
  function registerPurchase(id: number) {
    movementId = id;
    sheetOpen = true;
  }
  function openAsset(id: number) {
    void goto(resolve("/(app)/assets/[id]", { id: String(id) }));
  }
  function clearSearch() {
    search = "";
  }
</script>

<div class="screen" style="position:relative;">
  <header class="topbar">
    <div class="topbar-left">
      <h1 class="page-title">Assets</h1>
      <p class="page-sub">
        {data.register.assets.length} registered · as at {formatDate(
          data.register.asAt,
        )}
      </p>
    </div>
    <div class="topbar-right">
      <div class="search-box">
        <div class="asset-search">
          <Search size={15} /><Input
            aria-label="Search assets or purchases"
            type="search"
            placeholder="Search assets or purchases…"
            bind:value={search}
            class="h-[34px] pl-8 text-[13px]"
          />
        </div>
      </div>
      {#if mobileSearchOpen}<div
          class="mobile-search-inline"
          transition:fly={{ x: 12, duration: 180 }}
        >
          <span class="mobile-search-inline-icon"><Search size={15} /></span
          ><input
            aria-label="Search assets or purchases on mobile"
            class="mobile-search-inline-input"
            type="search"
            placeholder="Search assets…"
            bind:value={search}
            bind:this={mobileSearchEl}
          />
        </div>{/if}
      <button
        type="button"
        class="mobile-search-toggle"
        class:active={mobileSearchOpen}
        aria-label={mobileSearchOpen ? "Close asset search" : "Search assets"}
        onclick={() => {
          mobileSearchOpen = !mobileSearchOpen;
          if (!mobileSearchOpen) clearSearch();
        }}
        >{#if mobileSearchOpen}<X size={16} />{:else}<Search
            size={16}
          />{/if}</button
      >
      {#if data.canChange}<Button size="sm" onclick={create}
          ><Plus size={15} /><span class="btn-text">Add existing asset</span
          ></Button
        >{/if}
    </div>
  </header>
  <div class="work">
    <div class="work-main layout-standard" style="padding-top:12px;">
      <div class="toolbar">
        <div class="status-tabs" style="max-width:100%;">
          {#each [["registered", "Registered", assets.length], ["unregistered", "Unregistered", purchases.length], ["reconciliation", "Reconciliation", null], ["depreciation", "Depreciation", null]] as [value, label, count] (value)}<button
              type="button"
              class="status-tab"
              class:active={tab === value}
              onclick={() => (tab = String(value))}
              >{label}{#if count !== null}<span class="tab-count">{count}</span
                >{/if}</button
            >{/each}
        </div>
      </div>
      {#if tab !== "depreciation"}<form method="GET" class="asset-filters">
          <span id="assets-as-at-label" class="mini-label">As at</span>
          <div class="w-[180px]">
            <DatePicker
              name="asAt"
              value={data.register.asAt}
              labelledBy="assets-as-at-label"
            />
          </div>
          <input type="hidden" name="view" value={tab} />{#if accountId}<input
              type="hidden"
              name="account"
              value={accountId}
            /><span class="mini-label"
              >{data.register.accounts.find(
                (account) => account.id === accountId,
              )?.name}</span
            ><a
              class="clear-filters"
              href={resolve(
                `/(app)/assets?asAt=${data.register.asAt}&view=${tab}`,
              )}>All accounts</a
            >{/if}<Button variant="outline" size="sm" type="submit"
            >Apply</Button
          >
        </form>{/if}
      {#if tab === "depreciation"}<DepreciationMonth />
      {:else if tab === "registered"}
        <div class="result-meta">
          <span
            >{assets.length}
            {assets.length === 1 ? "asset" : "assets"} shown</span
          ><span class="result-total"
            >Cost <span class="num">{formatMinor(shownCostMinor)}</span></span
          >
        </div>
        <div class="table-card">
          <table class="exp-table">
            <thead
              ><tr
                ><th scope="col">Asset</th><th scope="col">Type</th><th
                  scope="col">Asset cost account</th
                ><th scope="col" class="ta-right">Original cost</th><th
                  scope="col"
                  class="ta-right">Net book value</th
                ><th scope="col">Purchase date</th><th scope="col">Status</th
                ></tr
              ></thead
            ><tbody>
              {#each assets as asset (asset.id)}<tr
                  class="exp-row"
                  onclick={(event) => {
                    if (!(event.target as HTMLElement).closest("a,button"))
                      openAsset(asset.id);
                  }}
                >
                  <td class="td-primary" data-label="Asset"
                    ><a
                      class="cell-item row-link"
                      href={resolve("/(app)/assets/[id]", {
                        id: String(asset.id),
                      })}
                      ><span class="cell-itemname">{asset.name}</span><span
                        class="cell-itemnum"
                        >{assetNumber(asset.id)} · {asset.inServiceDate
                          ? `In service ${formatDate(asset.inServiceDate)}`
                          : `Purchased ${formatDate(asset.acquisitionDate)}`}</span
                      ></a
                    ></td
                  >
                  <td data-label="Type">{asset.assetType}</td><td
                    data-label="Asset cost account">{asset.accountName}</td
                  ><td class="td-amount" data-label="Original cost"
                    ><span class="amount-num"
                      >{formatMinor(asset.costMinor)}</span
                    ></td
                  ><td class="td-amount" data-label="Net book value"
                    >{formatMinor(asset.netBookValueMinor)}</td
                  ><td class="row-break"></td><td
                    class="td-date"
                    data-label="Purchase date"
                    >{formatDate(asset.acquisitionDate)}</td
                  ><td data-label="Status"
                    ><a
                      class="asset-status-link"
                      href={resolve("/(app)/assets/[id]", {
                        id: String(asset.id),
                      })}><AssetStatus overview={asset.depreciation} /></a
                    ></td
                  >
                </tr>{/each}
              {#if assets.length === 0}<tr class="empty-row"
                  ><td colspan="7"
                    ><EmptyState
                      title={search
                        ? "Nothing to show"
                        : "No assets registered"}
                      sub={search
                        ? "Try another name, type or serial number."
                        : "Register a saved purchase, or add an existing asset with opening values."}
                      >{#snippet icon()}<Package
                          size={20}
                        />{/snippet}{#snippet action()}{#if search}<button
                            class="link-btn"
                            onclick={clearSearch}>Clear search</button
                          >{:else if data.canChange}<button
                            class="link-btn"
                            onclick={create}>Add an existing asset</button
                          >{/if}{/snippet}</EmptyState
                    ></td
                  ></tr
                >{/if}
            </tbody>
          </table>
        </div>
        <div class="table-foot">
          <span
            >{assets.length} registered {assets.length === 1
              ? "asset"
              : "assets"} shown</span
          ><span class="hidden sm:inline"
            >Brought-forward depreciation, all accounts {formatMinor(
              data.register.totalOpeningDepMinor,
            )}</span
          >
        </div>
        <p class="field-hint">
          Status uses the current depreciation setup, with posting progress
          through the selected As at date. Open an asset to set up depreciation
          or review issues.
        </p>
      {:else if tab === "unregistered"}
        <div class="result-meta">
          <span
            >{purchases.length}
            {purchases.length === 1 ? "purchase" : "purchases"} shown</span
          >
        </div>
        <div class="table-card">
          <table class="exp-table">
            <thead
              ><tr
                ><th scope="col">Purchase</th><th scope="col">Account</th><th
                  scope="col">Date</th
                ><th scope="col" class="ta-right">Original cost</th><th
                  scope="col"
                ></th></tr
              ></thead
            ><tbody>
              {#each purchases as line (line.movementId)}<tr class="exp-row"
                  ><td class="td-primary" data-label="Purchase"
                    ><a
                      class="cell-item row-link"
                      href={resolve("/(app)/records/[id]", {
                        id: String(line.recordId),
                      })}
                      ><span class="cell-itemname"
                        >{line.label ?? line.description}</span
                      ><span class="cell-itemnum">{line.recordNumber}</span></a
                    ></td
                  ><td data-label="Account">{line.accountName}</td><td
                    class="td-date"
                    data-label="Date">{formatDate(line.recordDate)}</td
                  ><td class="td-amount" data-label="Original cost"
                    ><span class="amount-num"
                      >{formatMinor(line.amountMinor)}</span
                    ></td
                  ><td class="row-break"></td><td data-label="Registration"
                    >{#if data.canChange}<Button
                        variant="outline"
                        size="sm"
                        onclick={() => registerPurchase(line.movementId)}
                        >Register asset</Button
                      >{/if}</td
                  ></tr
                >{/each}
              {#if purchases.length === 0}<tr class="empty-row"
                  ><td colspan="5"
                    ><EmptyState
                      title="No unregistered purchases"
                      sub="No eligible purchase lines match this date and filter."
                    /></td
                  ></tr
                >{/if}
            </tbody>
          </table>
        </div>
        <div class="table-foot">
          <span>Split multi-asset bundles in Records before registration.</span>
        </div>
      {:else}<AssetReconciliation register={data.register} {accountId} />{/if}
    </div>
  </div>
</div>
{#if sheetOpen && (!movementId || selectedSource)}<AssetSheet
    source={selectedSource}
    accounts={data.register.accounts}
    canChange={data.canChange}
    onclose={() => (sheetOpen = false)}
    onsaved={invalidateAll}
  />{/if}

<style>
  .asset-status-link {
    display: block;
    color: inherit;
    text-decoration: none;
    min-width: 160px;
  }
  .asset-status-link:hover {
    text-decoration: underline;
  }
  .asset-search {
    position: relative;
    display: flex;
    align-items: center;
  }
  .asset-search :global(> svg) {
    position: absolute;
    left: 10px;
    color: var(--muted-foreground);
    pointer-events: none;
  }
  .asset-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-bottom: 12px;
  }
</style>
