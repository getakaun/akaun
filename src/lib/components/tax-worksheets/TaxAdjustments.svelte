<script lang="ts">
  import ListExpand, {
    visibleItems,
  } from "$lib/components/ui/ListExpand.svelte";
  import { formatAuditTime } from "$lib/components/audit/audit-format.js";
  import {
    formatTaxMinor,
    taxAdjustmentLabels,
    type TaxAdjustment,
  } from "$lib/tax-worksheet.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import type { TaxWorksheetDetail } from "$lib/server/queries/tax-worksheets.js";
  import "./tax-worksheets.css";
  let {
    adjustments,
    lines,
    currency,
    canChange,
    disabled = false,
    onadd,
    onwithdraw,
  }: {
    adjustments: TaxAdjustment[];
    lines: TaxWorksheetDetail["totals"]["lines"];
    currency: string;
    canChange: boolean;
    disabled?: boolean;
    onadd: () => void;
    onwithdraw: (id: number) => void;
  } = $props();
  let expanded = $state(false);
  let historyExpanded = $state(false);
  const active = $derived(adjustments.filter((a) => a.withdrawnAt === null));
  const withdrawn = $derived(adjustments.filter((a) => a.withdrawnAt !== null));
  const money = (n: number) => formatTaxMinor(n, currency);
</script>

{#snippet entry(a: TaxAdjustment)}
  {@const source =
    a.kind === "source"
      ? lines.find((l) => l.movementId === a.sourceMovementId)
      : null}
  <article class="tax-item tax-stack">
    <div class="tax-item-head">
      <div>
        <h3 class="tax-item-title">
          {a.kind === "source"
            ? (source?.label ??
              source?.description ??
              "Annual expense treatment")
            : taxAdjustmentLabels[a.kind]}
        </h3>
        <p class="field-hint">
          {a.kind === "source"
            ? `${a.percentageBps! / 100}% deductible · ${TaxTreatmentLabels[a.treatment!]}`
            : a.originYa
              ? `Origin YA ${a.originYa}`
              : a.direction === "increase"
                ? "Increase to tax result"
                : "Decrease to tax result"}
        </p>
      </div>
      <span class="tax-amount"
        >{a.amountMinor === 0
          ? "No amount change"
          : `${a.direction === "increase" ? "+" : "−"} ${money(a.amountMinor)}`}</span
      >
    </div>
    <p class="tax-item-note">{a.reason}</p>
    {#if a.originYa}<dl class="detail-list tax-summary">
        <div class="detail-row">
          <dt class="detail-key">Brought-forward balance</dt>
          <dd class="detail-val tax-amount">{money(a.balanceMinor)}</dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Utilised this year</dt>
          <dd class="detail-val tax-amount">{money(a.amountMinor)}</dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Remaining balance</dt>
          <dd class="detail-val tax-amount">
            {money(a.balanceMinor - a.amountMinor)}
          </dd>
        </div>
      </dl>{/if}
    <div>
      <p class="field-hint">Reference: {a.evidence}</p>
      <p class="field-hint">{a.actorName} · {formatAuditTime(a.createdAt)}</p>
    </div>
    {#if a.withdrawnAt}<p class="hint">
        Withdrawn {formatAuditTime(a.withdrawnAt)} · {a.withdrawalReason}
      </p>{:else if canChange}<div class="tax-actions">
        <button
          type="button"
          class="detail-card-action"
          {disabled}
          onclick={() => onwithdraw(a.id)}>Withdraw adjustment</button
        >
      </div>{/if}
  </article>
{/snippet}

<section class="detail-card" aria-labelledby="tax-adjustments-title">
  <div class="detail-card-head tax-card-head">
    <h2 id="tax-adjustments-title" class="detail-card-title">
      Annual adjustments
    </h2>
    {#if canChange}<button
        type="button"
        class="detail-card-action"
        {disabled}
        onclick={onadd}>Add adjustment</button
      >{/if}
  </div>
  <div class="tax-stack">
    {#if active.length === 0}<p class="card-empty">
        {canChange
          ? "No annual adjustments. Add one to record a tax-only correction or a reviewed claim."
          : "No annual adjustments recorded."}
      </p>{/if}
    {#each visibleItems(active, expanded) as a (a.id)}{@render entry(a)}{/each}
    <ListExpand total={active.length} bind:expanded />
    {#if withdrawn.length}<details class="tax-disclosure">
        <summary>Withdrawn and replaced ({withdrawn.length})</summary>
        <div class="tax-disclosure-body">
          {#each visibleItems(withdrawn, historyExpanded) as a (a.id)}{@render entry(
              a,
            )}{/each}<ListExpand
            total={withdrawn.length}
            bind:expanded={historyExpanded}
          />
        </div>
      </details>{/if}
  </div>
</section>
