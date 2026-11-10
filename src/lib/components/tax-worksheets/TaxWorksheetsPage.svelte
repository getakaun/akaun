<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Plus, Receipt } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import { createResourceStream } from "$lib/sse.js";
  import { formatDate } from "$lib/format.js";
  import { TAX_PREPARATION_NOTE } from "$lib/tax-worksheet.js";
  import TaxWorksheetSheet from "./TaxWorksheetSheet.svelte";
  import type { loadTaxWorksheets } from "$lib/server/loaders/tax-worksheets.js";
  import "$lib/components/reports/reports.css";
  let { data }: { data: ReturnType<typeof loadTaxWorksheets> } = $props();
  let creating = $state(false);
  createResourceStream("/api/tax/stream", () => {
    void invalidateAll();
  });
</script>

<div class="screen">
  <header class="topbar">
    <div class="topbar-left">
      <h1 class="page-title">Annual tax</h1>
      <p class="page-sub">
        Prepare, review and retain each year's tax adjustments
      </p>
    </div>
    <div class="topbar-right">
      {#if data.canCreate}<Button onclick={() => (creating = true)}
          ><Plus size={15} />New worksheet</Button
        >{/if}
    </div>
  </header>
  <div class="rep-scroll">
    <p class="rep-block-sub">{TAX_PREPARATION_NOTE}</p>
    <section class="rep-block">
      {#if data.worksheets.length === 0}<EmptyState
          title="No annual worksheets yet"
          sub="Create a worksheet to review saved expense treatments and prepare annual tax adjustments."
          >{#snippet icon()}<Receipt size={22} />{/snippet}</EmptyState
        >
      {:else}<table class="rep-table">
          <thead
            ><tr
              ><th>Year of assessment</th><th>Accounting period</th><th
                >Revision</th
              ><th>Status</th></tr
            ></thead
          ><tbody
            >{#each data.worksheets as w (w.id)}<tr
                class="worksheet-row"
                onclick={(event) => {
                  if (!(event.target as HTMLElement).closest("a,button"))
                    void goto(resolve("/(app)/tax/[id]", { id: String(w.id) }));
                }}
                ><td
                  ><a
                    class="worksheet-link"
                    href={resolve("/(app)/tax/[id]", { id: String(w.id) })}
                    >YA {w.ya}</a
                  ></td
                ><td>{formatDate(w.dateFrom)} – {formatDate(w.dateTo)}</td><td
                  >{w.revision}</td
                ><td><StatusBadge status={`tax-${w.status}`} /></td></tr
              >{/each}</tbody
          >
        </table>{/if}
    </section>
  </div>
</div>
{#if creating}<TaxWorksheetSheet
    mode="create"
    onclose={() => (creating = false)}
    onsaved={async () => {
      await invalidateAll();
    }}
  />{/if}

<style>
  .worksheet-row {
    cursor: pointer;
  }
  .worksheet-row:hover,
  .worksheet-row:focus-within {
    background: var(--accent);
  }
  .worksheet-link {
    display: block;
    color: inherit;
    text-decoration: none;
  }
</style>
