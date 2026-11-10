<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { resolve } from "$app/paths";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { formatDate } from "$lib/format.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import { formatTaxMinor, safeTaxSum } from "$lib/tax-worksheet.js";
  import type { TaxWorksheetDetail } from "$lib/server/queries/tax-worksheets.js";
  import "$lib/components/reports/reports.css";
  import "./tax-worksheets.css";
  type Line = TaxWorksheetDetail["totals"]["lines"][number];
  let {
    lines,
    currency,
    canChange,
    canReadRecords,
    disabled = false,
    onchange,
  }: {
    lines: Line[];
    currency: string;
    canChange: boolean;
    canReadRecords: boolean;
    disabled?: boolean;
    onchange: (line: Line) => void;
  } = $props();
  const screen = useIsMobile();
  let onlyReview = $state(false);
  const unresolved = $derived(lines.filter((l) => l.unresolved).length);
  const money = (n: number) => formatTaxMinor(n, currency);
  const percentage = (n: number | null | undefined) =>
    n == null ? "Unclassified" : `${n / 100}%`;
  const groups = $derived.by(() => {
    const grouped = new SvelteMap<
      number,
      { id: number; name: string; expenseMinor: number; lines: Line[] }
    >();
    for (const line of lines) {
      if (onlyReview && !line.unresolved) continue;
      const group = grouped.get(line.accountId) ?? {
        id: line.accountId,
        name: line.accountName,
        expenseMinor: 0,
        lines: [],
      };
      group.lines.push(line);
      group.expenseMinor = safeTaxSum([group.expenseMinor, line.expenseMinor]);
      grouped.set(line.accountId, group);
    }
    return [...grouped.values()];
  });
</script>

{#snippet identity(line: Line)}
  {#if canReadRecords}<a
      class="tax-record-link tax-item-title"
      href={resolve("/(app)/records/[id]", { id: String(line.recordId) })}
      >{line.label ?? line.description}</a
    >
  {:else}<span class="tax-item-title">{line.label ?? line.description}</span
    >{/if}
  <p class="field-hint">
    {formatDate(line.date)} · {line.recordNumber ??
      `Record ${line.recordId}`}{line.voided ? " · Void pair" : ""}
  </p>
{/snippet}
{#snippet change(line: Line)}
  {#if canChange && !line.voided}<button
      type="button"
      class="detail-card-action"
      {disabled}
      onclick={() => onchange(line)}
      aria-label={`${line.unresolved ? "Review" : "Change"} annual treatment for ${line.label ?? line.description}`}
      >{line.unresolved ? "Review treatment" : "Change treatment"}</button
    >{/if}
{/snippet}

<section class="detail-card" aria-labelledby="tax-expenses-title">
  <div class="detail-card-head tax-card-head">
    <h2 id="tax-expenses-title" class="detail-card-title">
      Expense classifications
    </h2>
    <div class="tax-filter">
      <Checkbox id="tax-review-filter" bind:checked={onlyReview} /><label
        for="tax-review-filter">Needs review ({unresolved})</label
      >
    </div>
  </div>
  <div class="tax-stack">
    {#if lines.length}<p class="hint">
        {lines.length} expense line(s). Expand an account to compare saved and annual
        tax treatment.
      </p>{/if}
    {#if !groups.length}<p class="card-empty">
        {onlyReview
          ? "All expense lines have an annual classification. Clear the filter to see every expense."
          : "No expense lines in this accounting period."}
      </p>{/if}
    {#each groups as group (group.id)}
      <details class="tax-disclosure" open={onlyReview || groups.length === 1}>
        <summary
          ><span class="tax-group-heading"
            ><span
              >{group.name}<span class="field-hint"
                >{group.lines.length} line(s)</span
              ></span
            ><span class="tax-group-total">{money(group.expenseMinor)}</span
            ></span
          ></summary
        >
        <div class="tax-disclosure-body">
          {#if screen.current}
            {#each group.lines as line (line.movementId)}<article
                class="tax-item"
              >
                <div class="tax-item-head">
                  <div>{@render identity(line)}</div>
                  {@render change(line)}
                </div>
                <dl class="detail-list tax-summary">
                  <div class="detail-row">
                    <dt class="detail-key">Book expense</dt>
                    <dd class="detail-val tax-amount">
                      {money(line.expenseMinor)}
                    </dd>
                  </div>
                  <div class="detail-row">
                    <dt class="detail-key">Saved deduction</dt>
                    <dd class="detail-val">
                      {percentage(line.classification?.percentageBps)}
                    </dd>
                  </div>
                  <div class="detail-row">
                    <dt class="detail-key">Annual deduction</dt>
                    <dd class="detail-val">
                      {percentage(line.effectivePercentageBps)}
                      <p class="field-hint">
                        {TaxTreatmentLabels[line.effectiveTreatment]}
                      </p>
                    </dd>
                  </div>
                  <div class="detail-row">
                    <dt class="detail-key">Add-back</dt>
                    <dd class="detail-val tax-amount">
                      {line.addBackMinor === null
                        ? "Needs review"
                        : money(line.addBackMinor)}
                    </dd>
                  </div>
                </dl>
              </article>{/each}
          {:else}
            <div class="tax-table-wrap">
              <table class="rep-table">
                <caption class="sr-only"
                  >{group.name}: saved and annual expense classifications</caption
                >
                <thead
                  ><tr
                    ><th scope="col">Expense</th><th
                      scope="col"
                      class="rep-amount">Book expense</th
                    ><th scope="col" class="rep-amount">Saved %</th><th
                      scope="col"
                      class="rep-amount">Annual %</th
                    ><th scope="col" class="rep-amount">Add-back</th></tr
                  ></thead
                >
                <tbody
                  >{#each group.lines as line (line.movementId)}<tr>
                      <td
                        >{@render identity(
                          line,
                        )}{#if canChange && !line.voided}<div
                            class="tax-actions"
                          >
                            {@render change(line)}
                          </div>{/if}</td
                      ><td class="rep-amount">{money(line.expenseMinor)}</td><td
                        class="rep-amount"
                        >{percentage(line.classification?.percentageBps)}</td
                      ><td class="rep-amount"
                        >{percentage(line.effectivePercentageBps)}
                        <p class="field-hint">
                          {TaxTreatmentLabels[line.effectiveTreatment]}
                        </p></td
                      ><td class="rep-amount"
                        >{line.addBackMinor === null
                          ? "Needs review"
                          : money(line.addBackMinor)}</td
                      >
                    </tr>{/each}</tbody
                >
              </table>
            </div>
          {/if}
        </div>
      </details>
    {/each}
  </div>
</section>
