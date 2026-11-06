<script lang="ts">
  import { Info } from "@lucide/svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import TaxLineEditor from "./TaxLineEditor.svelte";
  import type { ExpenseTaxLine, TaxLineDraft } from "./tax-line-state.js";

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
  function update(key: string, draft: TaxLineDraft | undefined) {
    if (draft) drafts[key] = draft;
    else delete drafts[key];
  }
</script>

{#if lines.length > 0}
  <section class="detail-card" aria-label="Tax Classification">
    <div class="detail-card-head">
      <span class="detail-card-title">Tax Classification</span>
      <Popover.Root>
        <Popover.Trigger
          type="button"
          class="tax-help"
          aria-label="About tax classification"
          ><Info size={15} /></Popover.Trigger
        >
        <Popover.Content
          class="max-w-xs text-sm"
          aria-label="About tax classification"
        >
          Potential deductions are estimates. Saved classifications stay
          unchanged when account defaults change. Capital allowances are
          separate.
        </Popover.Content>
      </Popover.Root>
    </div>
    {#if reviewExempt}<p class="void-note">
        Voided record — no tax review needed.
      </p>{/if}
    {#each lines as line (line.key)}
      <div class:split-line={lines.length > 1}>
        <TaxLineEditor
          {line}
          draft={drafts[line.key]}
          onchange={(draft) => update(line.key, draft)}
          {readOnly}
          {reviewExempt}
          showHeading={lines.length > 1}
        />
      </div>
    {/each}
  </section>
{/if}

<style>
  .split-line + .split-line {
    border-top: 1px solid var(--border);
    margin-top: 16px;
    padding-top: 16px;
  }
  .void-note {
    margin: 0 0 12px;
    color: var(--muted-foreground);
    font-size: 11.5px;
  }
  :global(.tax-help) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }
  :global(.tax-help:hover) {
    background: var(--accent);
    color: var(--foreground);
  }
  :global(.tax-help:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
</style>
