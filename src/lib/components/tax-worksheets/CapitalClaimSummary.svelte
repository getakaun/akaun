<script lang="ts">
  import { untrack } from "svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import {
    formatTaxMinor,
    taxMoneyMinor,
    safeTaxSum,
  } from "$lib/tax-worksheet.js";
  import { amountInput } from "./asset-tax-form.js";
  import {
    automaticUtilisation,
    type UtilisationPolicy,
    type UtilisationEvidence,
  } from "$lib/capital-utilisation-policy.js";
  import {
    utilisationAdjustmentKey,
    type UtilisationContext,
  } from "$lib/capital-utilisation.js";
  import type { EditorUse } from "./capital-editor.js";
  import type { capitalTotals } from "$lib/capital-allowance.js";
  let {
    totals,
    uses = $bindable(),
    policy = $bindable(),
    context,
    evidence,
    year,
    currency,
    result,
    canEdit,
    unavailable = false,
  }: {
    totals: ReturnType<typeof capitalTotals>;
    uses: EditorUse[];
    policy: UtilisationPolicy | null;
    context: UtilisationContext | null;
    evidence?: UtilisationEvidence;
    year: number;
    currency: string;
    result: number;
    canEdit: boolean;
    unavailable?: boolean;
  } = $props();
  const money = (n: number | null | undefined) =>
    n == null ? "Needs review" : formatTaxMinor(n, currency);
  let incomeText = $state<Record<string, string>>({});
  let claimText = $state<Record<string, string>>({});
  $effect(() => {
    const current = policy;
    untrack(() => {
      incomeText = {};
      claimText = {};
      // Track the policy object replacement, while preserving partially typed amounts.
      void current;
    });
  });
  function reviewIncome(source: string, capacity: number | null | undefined) {
    if (!policy || !context) return;
    policy.income.push({
      businessSource: source,
      capacityMinor: capacity ?? 0,
      reason: "",
      basisHash: context.hash,
      adjustmentKey: utilisationAdjustmentKey(context),
    });
    incomeText[source] = amountInput(capacity ?? 0);
  }
  function confirmIncome(source: string) {
    const row = policy?.income.find((i) => i.businessSource === source);
    if (row && context) {
      row.basisHash = context.hash;
      row.adjustmentKey = utilisationAdjustmentKey(context);
    }
  }
  function overrideClaim(source: string, used: number) {
    policy?.overrides.push({
      businessSource: source,
      usedMinor: used,
      reason: "",
    });
    claimText[source] = amountInput(used);
  }
  function removeIncome(source: string) {
    if (policy)
      policy.income = policy.income.filter((i) => i.businessSource !== source);
  }
  function removeOverride(source: string) {
    if (policy)
      policy.overrides = policy.overrides.filter(
        (i) => i.businessSource !== source,
      );
  }
</script>

<section class="tax-stack" aria-label="Claim summary">
  <h3 class="inline-section-title">
    Claim summary{unavailable ? " — last saved values" : ""}
  </h3>
  {#each totals.groups.filter((g) => g.businessSource) as group (group.businessSource)}
    {@const basis = evidence?.groups.find(
      (g) => g.businessSource === group.businessSource,
    )}
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
        {#if policy}<div class="detail-row">
            <dt class="detail-key">Income available for allowances</dt>
            <dd class="detail-val">{money(basis?.capacityMinor)}</dd>
          </div>{/if}
        <div class="detail-row">
          <dt class="detail-key">
            Used this year · {policy
              ? basis?.overrideReason
                ? "Manual override"
                : "Automatic"
              : "Saved manual claim"}
          </dt>
          <dd class="detail-val">
            {policy && basis?.capacityMinor == null
              ? "Needs review"
              : money(group.usedMinor)}
          </dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Unabsorbed allowance carried forward</dt>
          <dd class="detail-val">
            {policy && basis?.capacityMinor == null
              ? "Needs review"
              : money(group.carryForwardMinor)}
          </dd>
        </div>
        {#if group.restrictedMinor}<div class="detail-row">
            <dt class="detail-key">
              Not claimed · separate from carry-forward
            </dt>
            <dd class="detail-val">{money(group.restrictedMinor)}</dd>
          </div>{/if}
      </dl>
      {#if basis?.overrideReason}<p class="field-hint">
          {basis.overrideReason}
        </p>{/if}
    </div>
  {/each}
  {#if !totals.groups.some((g) => g.businessSource)}<p class="field-hint">
      Choose an asset scheme to calculate available allowances.
    </p>{/if}
  {#if policy}<p class="field-hint">
      {policy.singleBusiness
        ? "Single-business basis: operating income and expenses belong to this business. Review the income basis if the book contains other businesses or income sources."
        : "Income limits are reviewed separately for each business."} Allowances are
      used automatically up to the income limit; eligible unused balances carry forward.
    </p>
  {:else}<p class="field-hint">
      Previously saved manual utilisation is retained. Switch to automatic
      calculation to use income limits and automatic carry-forward.
    </p>{/if}
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

{#if canEdit}<Disclosure label="Advanced: income basis and utilisation">
    <div class="tax-stack">
      {#if !policy}<Button
          type="button"
          variant="outline"
          onclick={() => (policy = automaticUtilisation())}
          >Use automatic calculation</Button
        >
      {:else}
        <label class="field-label"
          ><input type="checkbox" bind:checked={policy.singleBusiness} /> This book
          has one business income source</label
        >
        {#each totals.groups.filter((g) => g.businessSource) as group, index (group.businessSource)}
          {@const basis = evidence?.groups.find(
            (g) => g.businessSource === group.businessSource,
          )}
          {@const reviewed = policy.income.find(
            (i) => i.businessSource === group.businessSource,
          )}
          {@const override = policy.overrides.find(
            (i) => i.businessSource === group.businessSource,
          )}
          <div class="tax-item tax-stack">
            <strong>{group.businessSource}</strong>
            {#if reviewed}
              <div class="field">
                <label class="field-label" for={`income-limit-${index}`}
                  >Reviewed income available for allowances</label
                ><Input
                  id={`income-limit-${index}`}
                  value={incomeText[group.businessSource] ??
                    amountInput(reviewed.capacityMinor)}
                  inputmode="decimal"
                  oninput={(e) => {
                    incomeText[group.businessSource] = e.currentTarget.value;
                    reviewed.capacityMinor =
                      taxMoneyMinor(e.currentTarget.value) ?? -1;
                  }}
                />
              </div>
              <div class="field">
                <label class="field-label" for={`income-reason-${index}`}
                  >Income basis and reason</label
                ><Textarea
                  id={`income-reason-${index}`}
                  bind:value={reviewed.reason}
                  maxlength={2000}
                  rows={2}
                />
              </div>
              <p class="field-hint">
                Use this business's eligible income before capital allowances
                and brought-forward losses, including applicable balancing
                charges. Explain mixed income, shared expenses or other
                adjustments.
              </p>
              {#if context && (reviewed.basisHash !== context.hash || reviewed.adjustmentKey !== utilisationAdjustmentKey(context))}<Button
                  type="button"
                  variant="outline"
                  disabled={reviewed.reason.trim().length < 10 ||
                    reviewed.capacityMinor < 0}
                  onclick={() => confirmIncome(group.businessSource)}
                  >Confirm updated income basis</Button
                >{/if}
              <Button
                type="button"
                variant="ghost"
                onclick={() => removeIncome(group.businessSource)}
                >Use calculated income basis</Button
              >
            {:else}<Button
                type="button"
                variant="outline"
                disabled={!context}
                onclick={() =>
                  reviewIncome(group.businessSource, basis?.capacityMinor)}
                >Review income limit</Button
              >{/if}
            {#if override}
              <div class="field">
                <label class="field-label" for={`claim-override-${index}`}
                  >Manual claim this year</label
                ><Input
                  id={`claim-override-${index}`}
                  value={claimText[group.businessSource] ??
                    amountInput(override.usedMinor)}
                  inputmode="decimal"
                  oninput={(e) => {
                    claimText[group.businessSource] = e.currentTarget.value;
                    override.usedMinor =
                      taxMoneyMinor(e.currentTarget.value) ?? -1;
                  }}
                />
              </div>
              <div class="field">
                <label class="field-label" for={`claim-reason-${index}`}
                  >Override reason</label
                ><Textarea
                  id={`claim-reason-${index}`}
                  bind:value={override.reason}
                  maxlength={2000}
                  rows={2}
                />
              </div>
              <p class="field-hint">
                A reduction below the usable allowance is recorded as not
                claimed, and is not automatically carried forward. Review its
                tax treatment.
              </p>
              <Button
                type="button"
                variant="ghost"
                onclick={() => removeOverride(group.businessSource)}
                >Return to automatic utilisation</Button
              >
            {:else}<Button
                type="button"
                variant="outline"
                onclick={() =>
                  overrideClaim(group.businessSource, group.usedMinor)}
                >Adjust utilisation</Button
              >{/if}
          </div>
        {/each}
      {/if}
    </div>
  </Disclosure>{/if}

<Disclosure label="Earlier allowance balances">
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
          {#if canEdit}<Button
              type="button"
              variant="outline"
              onclick={() => (uses = uses.filter((_, i) => i !== index))}
              >Remove balance</Button
            >{/if}
        </div>{/if}{/each}
    {#if canEdit}<Button
        type="button"
        variant="outline"
        onclick={() =>
          uses.push({
            source: "",
            earlier: true,
            origin: String(year - 1),
            balance: "",
            used: "0.00",
          })}>Add earlier balance</Button
      >{/if}
  </div>
</Disclosure>

<style>
  .inline-section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 4px 0 0;
  }
</style>
