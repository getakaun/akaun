<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import {
    formatTaxMinor,
    taxMoneyMinor,
    safeTaxSum,
  } from "$lib/tax-worksheet.js";
  import {
    automaticUtilisation,
    type UtilisationPolicy,
    type UtilisationEvidence,
  } from "$lib/capital-utilisation-policy.js";
  import type { EditorUse } from "./capital-editor.js";
  import type { capitalTotals } from "$lib/capital-allowance.js";

  let {
    totals,
    uses = $bindable(),
    policy = $bindable(),
    evidence,
    year,
    currency,
    canEdit,
    unavailable = false,
  }: {
    totals: ReturnType<typeof capitalTotals>;
    uses: EditorUse[];
    policy: UtilisationPolicy | null;
    evidence?: UtilisationEvidence;
    year: number;
    currency: string;
    canEdit: boolean;
    unavailable?: boolean;
  } = $props();
  const money = (n: number) => formatTaxMinor(n, currency);
  const groups = $derived(totals.groups.filter((g) => g.businessSource));
  const earlierCount = $derived(uses.filter((u) => u.earlier).length);
  const savedManualSettings = $derived(
    !policy ||
      !policy.singleBusiness ||
      policy.income.length > 0 ||
      policy.overrides.length > 0,
  );
  const problems = $derived(evidence?.problems ?? []);
</script>

<section class="claim-section tax-stack" aria-label="Allowance summary">
  <h3 class="inline-section-title">Allowance summary</h3>
  {#if unavailable}<p class="claim-note" role="status">
      Showing last saved values. Resolve the input errors to update the preview.
    </p>{/if}
  {#if problems.length}<ReportNotes notes={problems} firstIsWarning />{/if}
  {#each groups as group (group.businessSource)}
    {@const calculated =
      !policy ||
      evidence?.groups.find((g) => g.businessSource === group.businessSource)
        ?.capacityMinor != null}
    <div class="tax-item tax-stack claim-group">
      {#if groups.length > 1}<h4 class="claim-source">
          {group.businessSource}
        </h4>{/if}
      <dl class="detail-list tax-summary claim-figures">
        <div class="detail-row">
          <dt class="detail-key">Allowance available</dt>
          <dd class="detail-val claim-amount">
            {money(
              safeTaxSum([group.availableMinor, group.broughtForwardMinor]),
            )}
          </dd>
        </div>
        {#if calculated}
          <div class="detail-row tax-result">
            <dt class="detail-key">Used this year</dt>
            <dd class="detail-val claim-amount">{money(group.usedMinor)}</dd>
          </div>
          <div class="detail-row">
            <dt class="detail-key">Carried forward</dt>
            <dd class="detail-val claim-amount">
              {money(group.carryForwardMinor)}
            </dd>
          </div>
        {/if}
        {#if group.restrictedMinor}<div class="detail-row">
            <dt class="detail-key">Saved amount not claimed</dt>
            <dd class="detail-val claim-amount">
              {money(group.restrictedMinor)}
            </dd>
          </div>{/if}
      </dl>
    </div>
  {/each}
  {#if !groups.length}<p class="claim-note">
      Choose an asset scheme to calculate available allowances.
    </p>
  {:else if !savedManualSettings && !problems.length}<p class="claim-note">
      Calculated automatically from business income.{evidence?.excludedIncome
        ?.length
        ? " Other revenue is kept separate."
        : ""} Unabsorbed allowances carry forward.
    </p>{/if}
  {#if savedManualSettings && groups.length}
    <p class="claim-note">
      Previously saved manual settings are retained.{canEdit
        ? " Switch to automatic calculation to replace them with the worksheet's calculated figures."
        : ""}
    </p>
    {#if canEdit}<div class="tax-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => (policy = automaticUtilisation())}
          >Use automatic calculation</Button
        >
      </div>{/if}
  {/if}
</section>

{#if canEdit || earlierCount}
  <Disclosure
    label={`Earlier allowance balances${earlierCount ? ` (${earlierCount})` : ""}`}
  >
    <div class="tax-stack">
      <p class="claim-note">
        Balances from the previous finalised year are brought forward
        automatically.{canEdit
          ? " Add a balance only when bringing earlier workings into Akaun."
          : ""}
      </p>
      {#each uses as use, index (index)}
        {#if use.earlier}
          <div class="tax-item tax-stack claim-group">
            {#if canEdit}
              <div class="claim-balance-fields">
                <div class="field">
                  <label class="field-label" for={`bf-source-${index}`}
                    >Business source</label
                  ><Input id={`bf-source-${index}`} bind:value={use.source} />
                </div>
                <div class="field">
                  <label class="field-label" for={`bf-year-${index}`}
                    >Origin tax year</label
                  ><Input
                    id={`bf-year-${index}`}
                    bind:value={use.origin}
                    inputmode="numeric"
                  />
                </div>
                <div class="field">
                  <label class="field-label" for={`bf-balance-${index}`}
                    >Opening balance ({currency})</label
                  ><Input
                    id={`bf-balance-${index}`}
                    bind:value={use.balance}
                    inputmode="decimal"
                  />
                </div>
              </div>
              <div class="tax-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${use.source || "business"} balance from YA ${use.origin}`}
                  onclick={() => (uses = uses.filter((_, i) => i !== index))}
                  >Remove balance</Button
                >
              </div>
            {:else}
              <dl class="detail-list tax-summary claim-figures">
                <div class="detail-row">
                  <dt class="detail-key">{use.source} · YA {use.origin}</dt>
                  <dd class="detail-val claim-amount">
                    {money(taxMoneyMinor(use.balance) ?? 0)}
                  </dd>
                </div>
              </dl>
            {/if}
          </div>
        {/if}
      {/each}
      {#if canEdit}<div class="tax-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() =>
              uses.push({
                source: "",
                earlier: true,
                origin: String(year - 1),
                balance: "",
                used: "0.00",
              })}>Add earlier balance</Button
          >
        </div>{/if}
    </div>
  </Disclosure>
{/if}

<style>
  .claim-section {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
  .inline-section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  .claim-group {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .claim-source {
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .claim-figures {
    margin: 0;
  }
  .claim-figures .detail-row {
    align-items: baseline;
    gap: 12px;
  }
  .claim-amount {
    font-family: "Geist Mono", monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .claim-note {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.5;
  }
  .claim-balance-fields {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.5fr);
    gap: 12px;
    align-items: start;
  }
  .claim-balance-fields > .field {
    margin-bottom: 0;
    min-width: 0;
  }
  @media (max-width: 767px) {
    .claim-balance-fields {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
