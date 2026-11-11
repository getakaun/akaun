<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import {
    formatTaxMinor,
    taxMoneyMinor,
    safeTaxSum,
  } from "$lib/tax-worksheet.js";
  import { amountInput } from "./asset-tax-form.js";
  import type { EditorUse } from "./capital-editor.js";
  import type { capitalTotals } from "$lib/capital-allowance.js";
  let {
    totals,
    uses = $bindable(),
    year,
    currency,
    result,
    canEdit,
    unavailable = false,
  }: {
    totals: ReturnType<typeof capitalTotals>;
    uses: EditorUse[];
    year: number;
    currency: string;
    result: number;
    canEdit: boolean;
    unavailable?: boolean;
  } = $props();
  const money = (n: number | null | undefined) =>
    n == null ? "Needs review" : formatTaxMinor(n, currency);
  function claim(
    source: string,
    origin: number,
    balance: number,
    amount: string,
  ) {
    const existing = uses.find(
      (u) =>
        !u.earlier && u.source.trim() === source && Number(u.origin) === origin,
    );
    if (existing) {
      existing.used = amount;
      existing.balance = amountInput(balance);
    } else
      uses.push({
        source,
        origin: String(origin),
        balance: amountInput(balance),
        used: amount,
      });
  }
  function used(source: string, origin: number) {
    return (
      uses.find(
        (u) => u.source.trim() === source && Number(u.origin) === origin,
      )?.used ?? "0.00"
    );
  }
</script>

<section class="tax-stack" aria-label="Claim summary">
  <h3 class="inline-section-title">
    Claim summary{unavailable ? " — last saved values" : ""}
  </h3>
  {#each totals.groups.filter((g) => g.businessSource) as group, groupIndex (group.businessSource)}
    <div class="tax-item tax-stack">
      <strong>{group.businessSource}</strong>
      <dl class="detail-list tax-summary">
        <div class="detail-row">
          <dt class="detail-key">Allowance available</dt>
          <dd class="detail-val">
            {money(
              safeTaxSum([group.availableMinor, group.broughtForwardMinor]),
            )}
          </dd>
        </div>
      </dl>
      <div class="field">
        <label class="field-label" for={`claim-${groupIndex}`}
          >{group.broughtForwardMinor
            ? "Claim from this year's allowances"
            : "Claim this year"}</label
        >
        <div class="inline-claim">
          <Input
            id={`claim-${groupIndex}`}
            value={used(group.businessSource, year)}
            oninput={(event) =>
              claim(
                group.businessSource,
                year,
                group.availableMinor,
                event.currentTarget.value,
              )}
            inputmode="decimal"
            disabled={!canEdit}
          /><Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || unavailable}
            onclick={() =>
              claim(
                group.businessSource,
                year,
                group.availableMinor,
                amountInput(group.availableMinor),
              )}>Use available</Button
          >
        </div>
      </div>
      {#each uses.filter((u) => u.source.trim() === group.businessSource && Number(u.origin) < year) as use, i (i)}<div
          class="field"
        >
          <label class="field-label" for={`claim-${groupIndex}-${use.origin}`}
            >Claim from YA {use.origin} · Available {money(
              taxMoneyMinor(use.balance),
            )}</label
          >
          <div class="inline-claim">
            <Input
              id={`claim-${groupIndex}-${use.origin}`}
              bind:value={use.used}
              inputmode="decimal"
              disabled={!canEdit}
            /><Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canEdit || unavailable}
              onclick={() => (use.used = use.balance)}>Use available</Button
            >
          </div>
        </div>{/each}
      <dl class="detail-list tax-summary">
        <div class="detail-row">
          <dt class="detail-key">Remaining allowance carried forward</dt>
          <dd class="detail-val">{money(group.carryForwardMinor)}</dd>
        </div>
      </dl>
    </div>
  {/each}
  {#if !totals.groups.some((g) => g.businessSource)}<p class="field-hint">
      Choose an asset scheme to calculate available allowances.
    </p>{/if}
  <p class="field-hint">
    Confirm how much can be claimed for each business. Available allowances are
    not automatically claimed.
  </p>
  <dl class="detail-list tax-summary">
    <div class="detail-row">
      <dt class="detail-key">Total claim this year</dt>
      <dd class="detail-val tax-amount">{money(totals.usedMinor)}</dd>
    </div>
    <div class="detail-row">
      <dt class="detail-key">Preview tax result</dt>
      <dd class="detail-val tax-amount">{money(result)}</dd>
    </div>
  </dl>
</section>
<Disclosure
  label="Earlier allowance balances"
  forceOpen={uses.some(
    (u) =>
      u.earlier &&
      (!u.source.trim() ||
        taxMoneyMinor(u.balance) === null ||
        !Number.isInteger(Number(u.origin)) ||
        Number(u.origin) < 2000 ||
        Number(u.origin) >= year),
  )}
>
  <div class="tax-stack">
    {#each uses as use, index (index)}{#if use.earlier}<div class="field-grid">
          <div class="field">
            <label class="field-label" for={`bf-source-${index}`}
              >Business source</label
            ><Input
              id={`bf-source-${index}`}
              bind:value={use.source}
              disabled={!canEdit}
            />
          </div>
          <div class="field">
            <label class="field-label" for={`bf-year-${index}`}
              >Origin tax year</label
            ><Input
              id={`bf-year-${index}`}
              bind:value={use.origin}
              disabled={!canEdit}
            />
          </div>
          <div class="field">
            <label class="field-label" for={`bf-balance-${index}`}
              >Reviewed balance</label
            ><Input
              id={`bf-balance-${index}`}
              bind:value={use.balance}
              disabled={!canEdit}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onclick={() => (uses = uses.filter((_, i) => i !== index))}
            >Remove balance</Button
          >
        </div>{/if}{/each}<Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!canEdit}
      onclick={() =>
        uses.push({
          source: "",
          earlier: true,
          origin: String(year - 1),
          balance: "",
          used: "0.00",
        })}>Add earlier balance</Button
    >
  </div>
</Disclosure>

<style>
  .inline-section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 4px 0 0;
  }
  .inline-claim {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  @media (max-width: 767px) {
    .inline-claim {
      flex-wrap: wrap;
    }
  }
</style>
