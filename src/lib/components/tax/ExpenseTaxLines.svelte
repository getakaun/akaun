<script lang="ts" module>
  import type { ExpenseTaxSnapshot, TaxTreatment } from "$lib/expense-tax.js";
  export type TaxLineDraft = {
    enabled: boolean;
    percentage: string;
    treatment: string;
    reason: string;
  };
  export type ExpenseTaxLine = {
    key: string;
    account: { id: number; name: string };
    side: { label: string };
    occurrence: number;
    saved?: ExpenseTaxSnapshot | null;
    savedLine?: unknown;
    percentageBps: number | null;
    treatment: TaxTreatment;
  };
</script>

<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { TaxTreatmentLabels, needsTaxReview } from "$lib/expense-tax.js";
  import TaxValuesFields from "./TaxValuesFields.svelte";
  let {
    lines,
    drafts = $bindable({}),
    readOnly = false,
    reviewExempt = false,
  }: {
    lines: ExpenseTaxLine[];
    drafts?: Record<string, TaxLineDraft>;
    readOnly?: boolean;
    reviewExempt?: boolean;
  } = $props();
</script>

{#if lines.length > 0}
  <section class="detail-card">
    <div class="detail-card-head">
      <span class="detail-card-title">Expense tax classification</span>
    </div>
    <p class="field-hint" style="padding: 0 1rem;">
      Potential deductions are estimates for review. Saved values stay unchanged
      when account defaults change. Historical and unconfigured lines remain
      unreviewed.
    </p>
    {#if reviewExempt}<p class="field-hint" style="padding: 0 1rem;">
        This record is voided or reverses a voided record. No tax review is
        required.
      </p>{/if}
    {#each lines as line (line.key)}
      <div style="padding: 1rem; border-top: 1px solid var(--border);">
        <strong
          >{line.account.name}{line.side.label ? ` · ${line.side.label}` : ""} · line
          {line.occurrence + 1}</strong
        >
        {#if needsTaxReview(line) && !reviewExempt}<p
            class="review-badge"
            role="status"
          >
            Needs tax review
          </p>{/if}
        <p class="field-hint">
          {line.treatment === "requires_review" && line.percentageBps !== null
            ? `Tentative ${(line.percentageBps / 100).toFixed(2)}% — excluded from estimates`
            : line.percentageBps === null
              ? "Unreviewed"
              : `${(line.percentageBps / 100).toFixed(2)}%`} · {TaxTreatmentLabels[
            line.treatment
          ]} · {line.savedLine
            ? line.saved?.source === "override"
              ? "Saved override"
              : line.saved?.source === "account_default"
                ? "Saved account default"
                : "Unreviewed"
            : "Current account default"}
        </p>
        {#if line.saved?.reason}<p class="field-hint">
            Reason: {line.saved.reason}
          </p>{/if}
        {#if line.saved}<p class="field-hint">
            Captured {line.saved.classifiedAt} · {line.saved.classifiedBy ===
            null
              ? "System"
              : `User #${line.saved.classifiedBy}`} · {line.saved.provenance ===
            "record_creation"
              ? "Record creation"
              : "Line classification"}
          </p>{/if}
        <label class="field-label">
          <input
            type="checkbox"
            checked={drafts[line.key]?.enabled ?? false}
            disabled={readOnly}
            onchange={(event) => {
              drafts[line.key] = {
                enabled: event.currentTarget.checked,
                percentage:
                  line.percentageBps === null
                    ? ""
                    : (line.percentageBps / 100).toFixed(2),
                treatment: line.treatment,
                reason: "",
              };
            }}
          /> Override this line
        </label>
        {#if drafts[line.key]?.enabled}
          <TaxValuesFields
            id={`tax-${line.key}`}
            bind:percentage={drafts[line.key].percentage}
            bind:treatment={drafts[line.key].treatment}
            disabled={readOnly}
          />
          <label class="field-label" for={`tax-reason-${line.key}`}
            >Override reason *</label
          >
          <Input
            id={`tax-reason-${line.key}`}
            bind:value={drafts[line.key].reason}
            maxlength={500}
            required
            disabled={readOnly}
          />
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .review-badge {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    background: var(--orange-soft, var(--muted));
    color: var(--foreground);
    font-size: 0.8rem;
    font-weight: 600;
  }
</style>
