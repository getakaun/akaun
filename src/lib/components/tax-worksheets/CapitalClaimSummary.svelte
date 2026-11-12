<script lang="ts">
  import { untrack } from "svelte";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
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
  const groups = $derived(totals.groups.filter((g) => g.businessSource));
  const earlierCount = $derived(uses.filter((u) => u.earlier).length);
  const needsIncomeReview = $derived(
    !!policy &&
      groups.some(
        (g) =>
          evidence?.groups.find((b) => b.businessSource === g.businessSource)
            ?.capacityMinor == null,
      ),
  );
  const needsOverrideReview = $derived(
    policy?.overrides.some(
      (o) => o.usedMinor < 0 || o.reason.trim().length < 10,
    ) ?? false,
  );
</script>

<section class="claim-section tax-stack" aria-label="Allowance summary">
  <h3 class="inline-section-title">Allowance summary</h3>
  {#if unavailable}<p class="claim-note" role="status">
      Showing last saved values. Resolve the input errors to update the preview.
    </p>{/if}
  {#each groups as group (group.businessSource)}
    {@const basis = evidence?.groups.find(
      (g) => g.businessSource === group.businessSource,
    )}
    <div class="tax-item tax-stack claim-group">
      <div class="claim-group-head">
        <h4 class="claim-source">{group.businessSource}</h4>
        <span class="claim-mode"
          >{policy
            ? basis?.capacityMinor == null
              ? "Needs review"
              : basis.overrideReason
                ? "Manual override"
                : "Automatic"
            : "Saved manual claim"}</span
        >
      </div>
      <dl class="detail-list tax-summary claim-figures">
        <div class="detail-row">
          <dt class="detail-key">Allowance available</dt>
          <dd class="detail-val claim-amount">
            {money(
              safeTaxSum([group.availableMinor, group.broughtForwardMinor]),
            )}
          </dd>
        </div>
        {#if policy}<div class="detail-row">
            <dt class="detail-key">Eligible business income</dt>
            <dd class="detail-val claim-amount">
              {money(basis?.capacityMinor)}
            </dd>
          </div>{/if}
        <div class="detail-row tax-result">
          <dt class="detail-key">Used this year</dt>
          <dd class="detail-val claim-amount">
            {policy && basis?.capacityMinor == null
              ? "Needs review"
              : money(group.usedMinor)}
          </dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Unabsorbed balance carried forward</dt>
          <dd class="detail-val claim-amount">
            {policy && basis?.capacityMinor == null
              ? "Needs review"
              : money(group.carryForwardMinor)}
          </dd>
        </div>
        {#if group.restrictedMinor}<div class="detail-row">
            <dt class="detail-key">Not claimed</dt>
            <dd class="detail-val claim-amount">
              {money(group.restrictedMinor)}
            </dd>
          </div>{/if}
      </dl>
      {#if basis?.overrideReason}<p class="claim-note">
          Override reason: {basis.overrideReason}
        </p>{/if}
      {#if group.restrictedMinor}<p class="claim-note">
          The amount not claimed is separate from unabsorbed carry-forward.
        </p>{/if}
    </div>
  {/each}
  {#if !groups.length}<p class="claim-note">
      Choose an asset scheme or add an earlier balance to calculate available
      allowances.
    </p>
  {:else if policy}<p class="claim-note">
      Allowances are used automatically up to eligible business income.
      Unabsorbed balances carry forward.
    </p>
  {:else}<p class="claim-note">
      Saved manual utilisation is retained. You can switch to automatic
      calculation in the advanced options.
    </p>{/if}
  {#if groups.length}
    <dl class="detail-list tax-summary claim-figures claim-totals">
      {#if groups.length > 1}<div class="detail-row">
          <dt class="detail-key">Total claim this year</dt>
          <dd class="detail-val claim-amount">
            {needsIncomeReview ? "Needs review" : money(totals.usedMinor)}
          </dd>
        </div>{/if}
      <div class="detail-row">
        <dt class="detail-key">Preview tax result</dt>
        <dd class="detail-val claim-amount">
          {needsIncomeReview ? "Needs review" : money(result)}
        </dd>
      </div>
    </dl>
  {/if}
</section>

{#if canEdit}
  <Disclosure
    label="Advanced allowance options"
    forceOpen={needsIncomeReview || needsOverrideReview}
  >
    <div class="tax-stack claim-options">
      {#if !policy}
        <p class="claim-note">
          Automatic calculation uses allowances up to eligible business income
          and calculates unabsorbed carry-forward.
        </p>
        <div class="tax-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => (policy = automaticUtilisation())}
            >Use automatic calculation</Button
          >
        </div>
      {:else}
        <div class="claim-basis">
          <div class="claim-basis-toggle">
            <Checkbox
              id="allowance-single-business"
              bind:checked={policy.singleBusiness}
            /><label for="allowance-single-business"
              >This book has one business income source</label
            >
          </div>
          <p class="claim-note">
            The calculated basis assumes operating income and expenses belong to
            one business. For mixed income or multiple businesses, review each
            business's income limit below.
          </p>
        </div>
        {#each groups as group, index (group.businessSource)}
          {@const basis = evidence?.groups.find(
            (g) => g.businessSource === group.businessSource,
          )}
          {@const reviewed = policy.income.find(
            (i) => i.businessSource === group.businessSource,
          )}
          {@const override = policy.overrides.find(
            (i) => i.businessSource === group.businessSource,
          )}
          <div class="tax-item tax-stack claim-group">
            <h4 class="claim-source">{group.businessSource}</h4>
            <section
              class="claim-option"
              aria-labelledby={`income-heading-${index}`}
            >
              <h5 id={`income-heading-${index}`} class="claim-option-title">
                Income basis
              </h5>
              {#if reviewed}
                <div class="claim-fields">
                  <div class="field">
                    <label class="field-label" for={`income-limit-${index}`}
                      >Eligible income ({currency})</label
                    ><Input
                      id={`income-limit-${index}`}
                      value={incomeText[group.businessSource] ??
                        amountInput(reviewed.capacityMinor)}
                      inputmode="decimal"
                      aria-invalid={reviewed.capacityMinor < 0}
                      oninput={(e) => {
                        incomeText[group.businessSource] =
                          e.currentTarget.value;
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
                      aria-describedby={`income-hint-${index}`}
                    />
                  </div>
                </div>
                <p id={`income-hint-${index}`} class="claim-note">
                  Use this business's eligible income before capital allowances
                  and brought-forward losses, including applicable balancing
                  charges. Record the basis for mixed income, shared expenses or
                  other adjustments. Give a reason of at least 10 characters.
                </p>
                <div class="tax-actions">
                  {#if context && (reviewed.basisHash !== context.hash || reviewed.adjustmentKey !== utilisationAdjustmentKey(context))}<Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={reviewed.reason.trim().length < 10 ||
                        reviewed.capacityMinor < 0}
                      onclick={() => confirmIncome(group.businessSource)}
                      >Confirm updated income basis</Button
                    >{/if}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onclick={() => removeIncome(group.businessSource)}
                    >Use calculated income basis</Button
                  >
                </div>
              {:else}
                <p class="claim-note">
                  {basis?.capacityMinor == null
                    ? "Review the income available for allowances. It cannot be assigned automatically for this business."
                    : "Eligible income is calculated from bookkeeping and annual tax corrections."}
                </p>
                <div class="tax-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!context}
                    onclick={() =>
                      reviewIncome(group.businessSource, basis?.capacityMinor)}
                    >Review income limit</Button
                  >
                </div>
              {/if}
            </section>
            <section
              class="claim-option"
              aria-labelledby={`override-heading-${index}`}
            >
              <h5 id={`override-heading-${index}`} class="claim-option-title">
                Utilisation override
              </h5>
              {#if override}
                <div class="claim-fields">
                  <div class="field">
                    <label class="field-label" for={`claim-override-${index}`}
                      >Claim this year ({currency})</label
                    ><Input
                      id={`claim-override-${index}`}
                      value={claimText[group.businessSource] ??
                        amountInput(override.usedMinor)}
                      inputmode="decimal"
                      aria-invalid={override.usedMinor < 0}
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
                      aria-describedby={`override-hint-${index}`}
                    />
                  </div>
                </div>
                <p id={`override-hint-${index}`} class="claim-note">
                  A reduction below the usable allowance is recorded as not
                  claimed and is not automatically carried forward. Give a
                  reason of at least 10 characters.
                </p>
                <div class="tax-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onclick={() => removeOverride(group.businessSource)}
                    >Return to automatic utilisation</Button
                  >
                </div>
              {:else}
                <p class="claim-note">
                  The maximum usable allowance is applied automatically. Reduce
                  the claim only when needed.
                </p>
                <div class="tax-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onclick={() =>
                      overrideClaim(group.businessSource, group.usedMinor)}
                    >Adjust utilisation</Button
                  >
                </div>
              {/if}
            </section>
          </div>
        {/each}
      {/if}
    </div>
  </Disclosure>
{/if}

<Disclosure
  label={`Earlier allowance balances${earlierCount ? ` (${earlierCount})` : ""}`}
>
  <div class="tax-stack claim-options">
    {#if !earlierCount}<p class="claim-note">
        No earlier allowance balances recorded.
      </p>{/if}
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
                  >Reviewed balance ({currency})</label
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
                  {money(taxMoneyMinor(use.balance))}
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
  .claim-group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .claim-source {
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .claim-mode {
    color: var(--muted-foreground);
    font-size: 12px;
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
  .claim-totals {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .claim-options {
    padding: 4px 0;
  }
  .claim-basis {
    display: grid;
    gap: 8px;
  }
  .claim-basis-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .claim-basis-toggle label {
    font-size: 13px;
    cursor: pointer;
  }
  .claim-option {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .claim-option + .claim-option {
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  .claim-option-title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
  }
  .claim-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: 12px;
    align-items: start;
  }
  .claim-balance-fields {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.5fr);
    gap: 12px;
    align-items: start;
  }
  .claim-fields > .field,
  .claim-balance-fields > .field {
    margin-bottom: 0;
    min-width: 0;
  }
  @media (max-width: 767px) {
    .claim-fields,
    .claim-balance-fields {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
