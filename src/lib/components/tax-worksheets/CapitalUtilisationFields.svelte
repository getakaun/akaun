<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import TaxJurisdictionField from "./TaxJurisdictionField.svelte";
  import {
    formatTaxMinor,
    taxMoneyMinor,
    safeTaxSum,
  } from "$lib/tax-worksheet.js";
  import type { CapitalUseForm } from "./asset-tax-form.js";
  let {
    jurisdiction = $bindable(),
    evidence = $bindable(),
    uses = $bindable(),
    year,
    currency,
    saving = false,
    baseResult,
    balancingCharges,
  }: {
    jurisdiction: string | null;
    evidence: string;
    uses: CapitalUseForm[];
    year: number;
    currency: string;
    saving?: boolean;
    baseResult: number;
    balancingCharges: number;
  } = $props();
  const money = (n: number) => formatTaxMinor(n, currency);
  const preview = $derived.by(() => {
    try {
      const used = uses.map((u) => taxMoneyMinor(u.used));
      if (used.some((n) => n === null)) return null;
      const usedMinor = safeTaxSum(used as number[]);
      return {
        usedMinor,
        resultMinor: safeTaxSum([baseResult, balancingCharges, -usedMinor]),
      };
    } catch {
      return null;
    }
  });
</script>

<TaxJurisdictionField bind:value={jurisdiction} disabled={saving} />

<div class="field">
  <label class="field-label" for="ca-evidence"
    >Shared accountant working-paper reference</label
  ><Input
    id="ca-evidence"
    bind:value={evidence}
    maxlength={2000}
    disabled={saving}
    placeholder="e.g. Accountant capital allowance schedule, YA 2025"
    required
  />
</div>
<p class="field-hint">
  Confirm how much of each reviewed balance is used this year, including zero.
  Availability does not imply eligibility or statutory ordering. Tax residual
  expenditure is separate from these unabsorbed allowances.
</p>
{#each uses as use, index (index)}<div class="tax-item tax-stack">
    {#if Number(use.origin) === year}<strong>{use.source} · Current year</strong
      >
      <p class="field-hint">
        Available from asset workings: {money(taxMoneyMinor(use.balance) ?? 0)}
      </p>
    {:else}<div class="field">
        <label class="field-label" for={`ca-business-${index}`}
          >Business source</label
        ><Input
          id={`ca-business-${index}`}
          bind:value={use.source}
          maxlength={100}
          required
          disabled={saving}
        />
      </div>
      <div class="field">
        <label class="field-label" for={`ca-origin-${index}`}>Origin YA</label
        ><Input
          id={`ca-origin-${index}`}
          type="number"
          value={use.origin}
          oninput={(e) => (use.origin = e.currentTarget.value)}
          min="2000"
          max={year - 1}
          required
          disabled={saving}
        />
      </div>
      <div class="field">
        <label class="field-label" for={`ca-balance-${index}`}
          >Reviewed brought-forward balance</label
        ><Input
          id={`ca-balance-${index}`}
          bind:value={use.balance}
          inputmode="decimal"
          required
          disabled={saving}
        />
      </div>{/if}
    <button
      type="button"
      class="detail-card-action"
      disabled={saving}
      onclick={() => (use.used = use.balance)}>Use available amount</button
    >
    <div class="field">
      <label class="field-label" for={`ca-utilised-${index}`}
        >Amount used this year</label
      ><Input
        id={`ca-utilised-${index}`}
        bind:value={use.used}
        inputmode="decimal"
        required
        disabled={saving}
      />
    </div>
    {#if Number(use.origin) < year}<button
        type="button"
        class="detail-card-action"
        disabled={saving}
        onclick={() => (uses = uses.filter((_, i) => i !== index))}
        >Remove balance</button
      >{/if}
  </div>{/each}
<button
  type="button"
  class="detail-card-action"
  disabled={saving}
  onclick={() =>
    (uses = [
      ...uses,
      {
        source: "",
        origin: String(year - 1),
        balance: "",
        used: "0.00",
      },
    ])}>Add brought-forward balance</button
>

{#if preview}<dl class="detail-list tax-summary">
    <div class="detail-row">
      <dt class="detail-key">Deductions selected for this year</dt>
      <dd class="detail-val tax-amount">{money(preview.usedMinor)}</dd>
    </div>
    <div class="detail-row">
      <dt class="detail-key">Preview preparatory tax result</dt>
      <dd class="detail-val tax-amount">{money(preview.resultMinor)}</dd>
    </div>
  </dl>{/if}
<p class="field-hint">
  Only amounts used change the annual tax result. Available deductions alone do
  not. Changing jurisdiction clears applied schemes and returns assets to Needs
  review. Amounts remain in the book currency; no conversion to a filing
  currency is performed.
</p>
