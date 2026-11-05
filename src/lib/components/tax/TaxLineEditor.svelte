<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { formatMinor } from "$lib/format.js";
  import { formatAuditTime } from "$lib/components/audit/audit-format.js";
  import {
    TaxTreatmentLabels,
    needsTaxReview,
    type TaxFormDraft,
  } from "$lib/expense-tax.js";
  import TaxValuesFields from "./TaxValuesFields.svelte";
  import {
    initialTaxDraft,
    editTaxLine,
    sameTaxClassification,
    taxLineChanged,
    taxLineIsOverride,
    taxLineRequest,
    useCurrentTaxDefault,
    type ExpenseTaxLine,
    type TaxLineDraft,
    type TaxClassification,
  } from "./tax-line-state.js";

  let {
    line,
    draft,
    onchange,
    readOnly = false,
    reviewExempt = false,
    showHeading = false,
  }: {
    line: ExpenseTaxLine;
    draft?: TaxLineDraft;
    onchange: (draft: TaxLineDraft | undefined) => void;
    readOnly?: boolean;
    reviewExempt?: boolean;
    showHeading?: boolean;
  } = $props();
  let controlRevision = $state(0);
  const activeDraft = $derived(taxLineChanged(line, draft) ? draft : undefined);
  const value = $derived(activeDraft ?? initialTaxDraft(line));
  const effective = $derived(activeDraft ? taxLineRequest(activeDraft) : line);
  const overridden = $derived(taxLineIsOverride(line, activeDraft));
  const canUseDefault = $derived(
    !readOnly &&
      line.persisted &&
      line.currentDefault !== null &&
      (line.saved?.source === "override" ||
        !sameTaxClassification(line, line.currentDefault)) &&
      (!activeDraft ||
        activeDraft.source !== "account_default" ||
        !sameTaxClassification(
          taxLineRequest(activeDraft),
          line.currentDefault,
        )),
  );

  function edit(values: TaxFormDraft) {
    onchange(editTaxLine(line, activeDraft, values));
  }
  function undo() {
    controlRevision++;
    onchange(undefined);
  }
  function applyDefault() {
    controlRevision++;
    onchange(useCurrentTaxDefault(line));
  }
  function describe(tax: TaxClassification) {
    const percentage =
      tax.percentageBps === null
        ? ""
        : ` · ${(tax.percentageBps / 100).toFixed(2)}%`;
    return (
      TaxTreatmentLabels[tax.treatment] +
      (tax.treatment === "requires_review" && percentage
        ? `${percentage} tentative`
        : percentage)
    );
  }
</script>

<div class="tax-line">
  {#if showHeading}
    <div class="line-heading">
      <strong
        >{line.account.name}{line.side.label
          ? ` · ${line.side.label}`
          : ""}</strong
      >{#if line.amountMinor !== undefined}<span class="line-amount"
          >{formatMinor(line.amountMinor)}</span
        >{/if}
    </div>
  {/if}
  {#if overridden || (needsTaxReview(effective) && !reviewExempt)}
    <div class="chips" aria-live="polite">
      {#if overridden}<span
          class="chip override-chip"
          title="Classification set on this record">Override</span
        >{/if}
      {#if needsTaxReview(effective) && !reviewExempt}<span
          class="chip review-chip">Needs tax review</span
        >{/if}
    </div>
  {/if}
  {#if readOnly}
    <p class="classification-value">{describe(effective)}</p>
  {:else}
    {#key `${controlRevision}:${line.saved?.classifiedAt ?? ""}`}
      <TaxValuesFields
        id={`tax-${line.key}`}
        treatment={value.treatment}
        percentage={value.percentage}
        compact
        onchange={edit}
      />
    {/key}
  {/if}
  {#if activeDraft && !readOnly}
    <div class="field reason-field">
      <label class="field-label" for={`tax-reason-${line.key}`}
        >Reason for change *</label
      >
      <Input
        id={`tax-reason-${line.key}`}
        value={activeDraft.reason}
        maxlength={500}
        required
        oninput={(event) =>
          onchange({ ...activeDraft, reason: event.currentTarget.value })}
      />
    </div>
  {/if}
  {#if !readOnly && (activeDraft || canUseDefault)}
    <div class="actions">
      {#if activeDraft}<button type="button" class="text-action" onclick={undo}
          >Undo change</button
        >{/if}
      {#if canUseDefault}<button
          type="button"
          class="text-action"
          onclick={applyDefault}
          title={line.currentDefault
            ? describe(line.currentDefault)
            : undefined}>Use current account default</button
        >{/if}
    </div>
  {/if}
  {#if line.persisted}
    <details class="tax-details">
      <summary>Details</summary>
      <dl>
        <dt>Saved source</dt>
        <dd>
          {line.saved?.source === "override"
            ? "Override"
            : line.saved?.source === "account_default"
              ? "Account default at capture"
              : "Unreviewed"}
        </dd>
        {#if line.saved?.reason}<dt>Saved reason</dt>
          <dd>{line.saved.reason}</dd>{/if}
        {#if line.saved}
          <dt>Recorded</dt>
          <dd>
            <time datetime={line.saved.classifiedAt}
              >{formatAuditTime(line.saved.classifiedAt)}</time
            >
          </dd>
          <dt>By</dt>
          <dd>
            {line.saved.classifiedBy === null
              ? "System"
              : `User #${line.saved.classifiedBy}`}
          </dd>
          <dt>Origin</dt>
          <dd>
            {{
              record_creation: "Record creation",
              account_change: "Account change",
              line_override: "Classification change",
              account_default_reset: "Current account default applied",
            }[line.saved.provenance]}
          </dd>
          {#if line.treatment === "requires_review" && line.percentageBps !== null}<dt
            >
              Saved tentative value
            </dt>
            <dd>
              {(line.percentageBps / 100).toFixed(2)}% · excluded from estimates
            </dd>{/if}
        {/if}
        {#if line.currentDefault && !sameTaxClassification(line, line.currentDefault)}<dt
          >
            Current account default
          </dt>
          <dd>{describe(line.currentDefault)}</dd>{/if}
      </dl>
    </details>
  {/if}
</div>

<style>
  .tax-line {
    padding: 1rem;
  }
  .line-heading {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    justify-content: space-between;
    margin-bottom: 0.65rem;
    font-size: 0.875rem;
  }
  .line-amount {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.65rem;
  }
  .chip {
    display: inline-flex;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .override-chip {
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .review-chip {
    background: var(--orange-soft, var(--muted));
    color: var(--foreground);
  }
  .classification-value {
    margin: 0;
    font-size: 0.875rem;
  }
  .reason-field {
    margin-top: 0.8rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.7rem;
  }
  .text-action {
    border: 0;
    background: transparent;
    padding: 0.2rem 0;
    color: var(--foreground);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .text-action:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 3px;
    border-radius: 0.2rem;
  }
  .tax-details {
    margin-top: 0.7rem;
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }
  summary {
    cursor: pointer;
    width: fit-content;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.35rem 0.8rem;
    margin-bottom: 0;
  }
  dt {
    font-weight: 500;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
