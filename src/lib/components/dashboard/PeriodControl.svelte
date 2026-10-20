<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import * as Select from "$lib/components/ui/select/index.js";
  import type {
    CompareMode,
    DashboardPeriodId,
    ResolvedPeriod,
  } from "$lib/dashboard-periods.js";

  /**
   * The period and what it is compared against (007 FR-003, FR-004). Both
   * live in the address bar, so a dashboard someone sends is the dashboard
   * they saw. The periods are plain links; the comparison is a select.
   */
  let {
    period,
    periodOptions,
    compareOptions,
  }: {
    period: ResolvedPeriod;
    periodOptions: { id: DashboardPeriodId; label: string }[];
    compareOptions: { id: CompareMode; label: string }[];
  } = $props();

  function hrefFor(id: DashboardPeriodId, compare: CompareMode): string {
    return `${resolve("/(app)/dashboard")}?period=${id}&compare=${compare}`;
  }

  function onCompare(compare: CompareMode) {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
    goto(hrefFor(period.id, compare), {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }
</script>

<div class="period-bar">
  <nav class="seg" aria-label="Period">
    {#each periodOptions as option (option.id)}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
      <a href={hrefFor(option.id, period.compare)}
        class="seg-btn"
        class:active={period.id === option.id}
        aria-current={period.id === option.id ? "page" : undefined}
        data-sveltekit-replacestate
        data-sveltekit-noscroll
      >
        {option.label}
      </a>
    {/each}
  </nav>
  <div class="compare">
    <span class="range">{period.label}</span>
    <div class="compare-choice">
      <span id="dashboard-compare-label">compared with</span>
      {#if period.canComparePrevious}
        <Select.Root type="single" value={period.compare} onValueChange={(next) => next && onCompare(next as CompareMode)}>
          <Select.Trigger aria-labelledby="dashboard-compare-label" size="sm" class="compare-trigger">
            {compareOptions.find((option) => option.id === period.compare)?.label.toLowerCase() ?? period.compare}
          </Select.Trigger>
          <Select.Content>
            {#each compareOptions as option (option.id)}
              <Select.Item value={option.id} label={option.label.toLowerCase()} />
            {/each}
          </Select.Content>
        </Select.Root>
      {:else}
        <span class="fixed">the same period last year</span>
      {/if}
    </div>
    <span class="range muted">({period.comparisonLabel})</span>
  </div>
</div>

<style>
  .period-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
  }
  .seg-btn {
    text-decoration: none;
    white-space: nowrap;
  }
  .compare {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: 12.5px;
    color: var(--muted-foreground);
  }
  .range {
    font-weight: 600;
    color: var(--foreground);
  }
  .range.muted {
    font-weight: 400;
    color: var(--muted-foreground);
  }
  .compare-choice {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  :global(.compare-trigger) {
    font-size: inherit;
    color: var(--foreground);
  }
  .fixed {
    color: var(--foreground);
  }
  @media (max-width: 767px) {
    .seg {
      display: flex;
      width: 100%;
      overflow-x: auto;
    }
    .seg-btn {
      flex: 1;
      text-align: center;
      padding: 6px 8px;
    }
  }
</style>
