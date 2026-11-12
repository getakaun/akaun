<script lang="ts">
  import { untrack } from "svelte";
  import TaxWorkingsDrawer from "./TaxWorkingsDrawer.svelte";
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  let {
    detail,
    onclose,
    onsaved,
  }: { detail: Detail; onclose: () => void; onsaved: () => Promise<void> } =
    $props();
  const initial = untrack(() => detail);
  const requestKey = crypto.randomUUID();
  let saving = $state(false),
    error = $state("");
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    error = "";
    try {
      const response = await fetch(
        `/api/tax/${initial.worksheet.id}/capital-allowances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "rollover",
            expectedVersion: initial.revision.version,
            requestKey,
            reason: "Use matching-currency prior-year asset balances",
            liveAssetHash: initial.capital.liveAssetHash,
            rolloverHash: initial.capital.rolloverHash,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        error = result.error ?? "Could not bring forward asset balances.";
        return;
      }
      await onsaved();
    } catch {
      error =
        "The result could not be confirmed. Retry to check the same request.";
    } finally {
      saving = false;
    }
  }
</script>

<TaxWorkingsDrawer
  title="Use matching prior-year balances"
  {saving}
  {error}
  {onclose}
  onsubmit={submit}
  submitLabel="Use these balances"
  disabled={!initial.capital.rollover}
>
  <p class="hint">
    Replace this worksheet's asset workings with balances from finalised tax
    year {initial.capital.rollover?.predecessor?.ya}.
  </p>
  <p class="field-hint">
    {taxJurisdictionLabel(initial.capital.rollover?.jurisdiction)} · {initial
      .capital.rollover?.currency}. Review the asset deductions in the worksheet
    before finalising.
  </p>
</TaxWorkingsDrawer>
