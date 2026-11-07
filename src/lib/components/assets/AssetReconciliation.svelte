<script lang="ts">
  import { resolve } from "$app/paths";
  import { formatDate, formatMinor } from "$lib/format.js";
  import { assetNumber } from "$lib/fixed-assets.js";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import "$lib/components/reports/reports.css";
  import type { AssetRegister } from "$lib/server/queries/fixed-assets.js";
  let {
    register,
    accountId,
  }: { register: AssetRegister; accountId: number | null } = $props();
  const rows = $derived(
    register.costReconciliation.filter(
      (row) => !accountId || row.accountId === accountId,
    ),
  );
</script>

<div class="asset-reconciliation">
  <section class="rep-block">
    <header class="rep-block-head">
      <div>
        <h2 class="rep-block-title">Gross cost reconciliation</h2>
        <p class="rep-block-sub">
          Ledger balance minus registered cost · {formatDate(register.asAt)}
        </p>
      </div>
    </header>
    <table class="rep-table">
      <thead
        ><tr
          ><th>Account</th><th class="rep-amount">Ledger cost</th><th
            class="rep-amount">Register cost</th
          ><th class="rep-amount">Difference</th><th>Exceptions</th></tr
        ></thead
      ><tbody
        >{#each rows as row (row.accountId)}<tr
            ><td
              ><a
                class="rep-open related-link"
                href={resolve("/(app)/accounts/[id]", {
                  id: String(row.accountId),
                })}>{row.accountName}</a
              ></td
            ><td class="rep-amount">{formatMinor(row.ledgerMinor)}</td><td
              class="rep-amount">{formatMinor(row.registerMinor)}</td
            ><td class="rep-amount" class:rep-neg={row.differenceMinor !== 0}
              >{formatMinor(row.differenceMinor)}</td
            ><td
              >{row.unregisteredCount} unregistered · {row.reviewCount} source reviews</td
            ></tr
          >{/each}{#if rows.length === 0}<tr
            ><td colspan="5"
              ><EmptyState
                title="No fixed-asset cost accounts"
                sub="Add a fixed-asset account in Accounts to track capital purchases."
              /></td
            ></tr
          >{/if}</tbody
      >
    </table>
  </section>
  {#each rows.filter((row) => row.exceptions.length > 0) as row (row.accountId)}<details
      class="detail-card"
    >
      <summary class="text-sm font-medium"
        >{row.accountName} · {row.exceptions.length} movements without a purchase
        link</summary
      >
      <div class="detail-list">
        {#each row.exceptions as line (line.movementId)}<div class="detail-row">
            <a
              class="detail-val"
              href={resolve("/(app)/records/[id]", {
                id: String(line.recordId),
              })}
              >{formatDate(line.recordDate)} · {line.recordNumber} · {line.label ??
                line.description}{line.voided ? " · Void pair" : ""}</a
            ><span class="text-sm">{formatMinor(line.amountMinor)}</span>
          </div>{/each}
      </div>
      <p class="field-hint">
        Check legacy opening references before registering these movements
        again.
      </p>
    </details>{/each}
  {#each register.assets.filter((asset) => asset.reviewReason && (!accountId || asset.assetAccountId === accountId)) as asset (asset.id)}<ReportNotes
      notes={[
        `${assetNumber(asset.id)} · ${asset.name}: ${asset.reviewReason}`,
      ]}
      firstIsWarning
    /><a
      class="link-btn text-sm"
      href={resolve("/(app)/assets/[id]", { id: String(asset.id) })}
      >Review {assetNumber(asset.id)}</a
    >{/each}
  <section class="rep-block">
    <header class="rep-block-head">
      <div>
        <h2 class="rep-block-title">Accumulated depreciation reconciliation</h2>
        <p class="rep-block-sub">
          All mapped accounts · credit balances shown as positive depreciation
        </p>
      </div>
    </header>
    <table class="rep-table">
      <thead
        ><tr
          ><th>Mapped account</th><th class="rep-amount">Ledger depreciation</th
          ><th class="rep-amount">Brought forward</th><th class="rep-amount"
            >Unallocated difference</th
          ></tr
        ></thead
      ><tbody
        >{#each register.depreciationReconciliation as row (row.accountId)}<tr
            ><td
              ><a
                class="rep-open related-link"
                href={resolve("/(app)/accounts/[id]", {
                  id: String(row.accountId),
                })}>{row.accountName}</a
              ></td
            ><td class="rep-amount">{formatMinor(row.ledgerMinor)}</td><td
              class="rep-amount">{formatMinor(row.registerMinor)}</td
            ><td class="rep-amount" class:rep-neg={row.differenceMinor !== 0}
              >{formatMinor(row.differenceMinor)}</td
            ></tr
          >{/each}{#if register.depreciationReconciliation.length === 0}<tr
            ><td colspan="4"
              ><EmptyState
                title="No depreciation accounts mapped"
                sub="Map an accumulated depreciation account when registering opening depreciation."
              /></td
            ></tr
          >{/if}</tbody
      >
    </table>
  </section>
  <ReportNotes
    notes={[
      "Registration does not change ledger balances. Review missing openings, source changes and unregistered purchases to explain differences.",
      "Brought-forward depreciation is recorded at each asset’s opening date. Later manual depreciation remains unallocated; this register does not calculate current depreciation or current net book value.",
    ]}
  />
</div>

<style>
  .asset-reconciliation {
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 24px;
  }
  summary {
    cursor: pointer;
  }
</style>
