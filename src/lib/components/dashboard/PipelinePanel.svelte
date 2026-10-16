<script lang="ts">
  import { resolve } from "$app/paths";
  import { formatMinor } from "$lib/format.js";
  import type { PipelineSection } from "./types.js";

  /**
   * Sales still in motion (007 FR-010): quotations not yet decided or not yet
   * billed, invoices sent in the period, and what customers have not paid.
   * Each half shows only to a user who may read its screen.
   */
  let {
    pipeline,
    periodLabel,
  }: { pipeline: PipelineSection; periodLabel: string } = $props();

  function count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }
</script>

<section class="dash-panel">
  <header class="dash-panel-head">
    <div>
      <h2 class="dash-panel-title">Sales pipeline</h2>
      <p class="dash-panel-sub">Open quotations and invoices</p>
    </div>
  </header>
  <div class="stats">
    {#if pipeline.quotations}
      {@const q = pipeline.quotations}
      <a class="stat related-link" href={resolve("/(app)/quotations")}>
        <span class="k">Open quotations</span>
        <span class="num v">{formatMinor(q.openMinor)}</span>
        <span class="note">
          {count(q.openCount, "quotation", "quotations")}{#if q.expiringSoonCount > 0}
            · <span class="warn">{q.expiringSoonCount} expiring this week</span>{/if}
        </span>
      </a>
      <a class="stat related-link" href={resolve("/(app)/quotations")}>
        <span class="k">Accepted quotations</span>
        <span class="num v">{formatMinor(q.acceptedMinor)}</span>
        <span class="note">{count(q.acceptedCount, "quotation", "quotations")} not yet invoiced</span>
      </a>
    {/if}
    {#if pipeline.invoices}
      {@const inv = pipeline.invoices}
      <a class="stat related-link" href={resolve("/(app)/invoices")}>
        <span class="k">Invoiced sales · {periodLabel}</span>
        <span class="num v">{formatMinor(inv.issuedInPeriodMinor)}</span>
        <span class="note">{count(inv.issuedInPeriodCount, "invoice", "invoices")} sent</span>
      </a>
      <a class="stat related-link" href={resolve("/(app)/invoices")}>
        <span class="k">Outstanding invoices</span>
        <span class="num v">{formatMinor(inv.unpaidMinor)}</span>
        <span class="note">
          {count(inv.unpaidCount, "invoice", "invoices")}{#if inv.overdueCount > 0}
            · <span class="bad">{inv.overdueCount} overdue ({formatMinor(inv.overdueMinor)})</span>{/if}
        </span>
      </a>
    {/if}
  </div>
</section>

<style>
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .stat {
    display: block;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
  }
  .k {
    display: block;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .v {
    display: block;
    font-size: 16px;
    font-weight: 600;
    margin-top: 4px;
  }
  .note {
    display: block;
    font-size: 11.5px;
    color: var(--muted-foreground);
    margin-top: 2px;
  }
  .warn {
    color: var(--amber);
  }
  .bad {
    color: var(--red);
  }
</style>
