<script lang="ts">
  import { formatMinor } from "$lib/format.js";
  import type { CashBridge } from "./types.js";

  /**
   * From net profit to the change in cash, as a waterfall (007 FR-007).
   *
   * Profit and cash part ways for three reasons, and each gets a step:
   * timing (sales not yet collected, bills not yet paid, stock), spending on
   * things the business keeps (a machine leaves the bank at once but is not an
   * expense), and financing (loans, owners' money). Every figure is read off
   * the period's Cash Flow Statement and Profit & Loss; this only lays them
   * end to end.
   */
  let { bridge }: { bridge: CashBridge } = $props();

  type Step = {
    label: string;
    hint: string;
    amountMinor: number;
    /** A running total rather than a change: drawn from zero, in a heavier tone. */
    total: boolean;
  };

  const steps: Step[] = $derived.by(() => {
    const out: Step[] = [
      {
        label: "Net profit",
        hint: "Revenue minus expenses",
        amountMinor: bridge.netProfitMinor,
        total: true,
      },
      {
        label: "Working capital changes",
        hint: "Changes in receivables, payables and inventory",
        amountMinor: bridge.operatingMinor - bridge.netProfitMinor,
        total: false,
      },
      {
        label: "Operating cash flow",
        hint: "Cash from operating activities",
        amountMinor: bridge.operatingMinor,
        total: true,
      },
      {
        label: "Capital expenditure",
        hint: "Purchases of equipment and other fixed assets",
        amountMinor: bridge.investingMinor,
        total: false,
      },
      {
        label: "Free cash flow",
        hint: "Operating cash flow minus capital expenditure",
        amountMinor: bridge.freeCashFlowMinor,
        total: true,
      },
      {
        label: "Financing activities",
        hint: "Loans, owner contributions and drawings",
        amountMinor: bridge.financingMinor,
        total: false,
      },
    ];
    if (bridge.needsReviewMinor !== 0) {
      out.push({
        label: "Unclassified accounts",
        hint: "Accounts that have no sub-type",
        amountMinor: -bridge.needsReviewMinor,
        total: false,
      });
    }
    out.push({
      label: "Net change in cash",
      hint: "Closing cash minus opening cash",
      amountMinor: bridge.netChangeMinor - bridge.needsReviewMinor,
      total: true,
    });
    return out;
  });

  /** Each step as a [from, to] span along one shared axis. */
  const spans = $derived.by(() => {
    let running = 0;
    return steps.map((step) => {
      if (step.total) {
        running = step.amountMinor;
        return { from: 0, to: step.amountMinor };
      }
      const from = running;
      running += step.amountMinor;
      return { from, to: running };
    });
  });

  const lo = $derived(Math.min(0, ...spans.flatMap((s) => [s.from, s.to])));
  const hi = $derived(Math.max(0, ...spans.flatMap((s) => [s.from, s.to])));
  const pos = (v: number) => (hi === lo ? 0 : ((v - lo) / (hi - lo)) * 100);
</script>

<ol class="bridge">
  {#each steps as step, i (step.label)}
    {@const span = spans[i]}
    {@const left = pos(Math.min(span.from, span.to))}
    {@const width = Math.abs(pos(span.to) - pos(span.from))}
    <li class:total={step.total}>
      <div class="label">
        <span class="name">{step.label}</span>
        <span class="hint">{step.hint}</span>
      </div>
      <div class="track" aria-hidden="true">
        <span class="zero" style="left:{pos(0)}%"></span>
        <span
          class="fill"
          class:neg={step.amountMinor < 0}
          style="left:{left}%; width:max({width}%, {step.amountMinor === 0 ? 0 : 2}px)"
        ></span>
      </div>
      <span class="num amount" class:neg={step.amountMinor < 0}>
        {step.amountMinor < 0 ? "−" : step.total ? "" : "+"}{formatMinor(Math.abs(step.amountMinor))}
      </span>
    </li>
  {/each}
</ol>

<style>
  .bridge {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: grid;
    grid-template-columns: minmax(120px, 1.1fr) 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 5px 0;
  }
  li.total {
    border-top: 1px solid var(--border);
    padding-top: 7px;
  }
  li:first-child {
    border-top: none;
  }
  .label {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: 12.5px;
    font-weight: 500;
  }
  li.total .name {
    font-weight: 600;
  }
  .hint {
    font-size: 11px;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .track {
    position: relative;
    height: 14px;
  }
  .zero {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 1px;
    background: var(--border-strong);
  }
  .fill {
    position: absolute;
    top: 2px;
    bottom: 2px;
    border-radius: 3px;
    background: var(--green);
    opacity: 0.55;
  }
  .fill.neg {
    background: var(--red);
  }
  li.total .fill {
    opacity: 1;
    background: var(--chart-1);
  }
  li.total .fill.neg {
    background: var(--red);
  }
  .amount {
    font-size: 12.5px;
    text-align: right;
    min-width: 92px;
  }
  .amount.neg {
    color: var(--red);
  }
  @media (max-width: 767px) {
    li {
      grid-template-columns: 1fr auto;
    }
    .track {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
