<script lang="ts">
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button/index.js";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import { formatTaxMinor } from "$lib/tax-worksheet.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import CapitalAllowanceSheet, {
    type CapitalSheetMode,
  } from "./CapitalAllowanceSheet.svelte";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import "$lib/components/reports/reports.css";
  let {
    detail,
    editable,
    canReadAssets,
    onsaved,
  }: {
    detail: Detail;
    editable: boolean;
    canReadAssets: boolean;
    onsaved: (detail: Detail) => Promise<void>;
  } = $props();
  const c = $derived(detail.capital);
  const screen = useIsMobile();
  const money = (n: number | null | undefined) =>
    n == null
      ? "Needs review"
      : formatTaxMinor(
          n,
          c.schedule?.currency ?? detail.revision.snapshot.currency,
        );
  const jurisdiction = $derived(
    c.schedule?.jurisdiction ??
      (c.schedule?.calculationVersion === 1 ? "MY" : null),
  );
  let mode = $state<CapitalSheetMode | null>(null);
  let assetId = $state<number | null>(null);
  const stale = $derived(
    c.assetsStale || c.predecessorStale || c.currencyMismatch,
  );
  function openRow(id: number) {
    assetId = id;
    mode = editable && c.active && !stale ? "row" : "view";
  }
</script>

<section class="detail-card" aria-labelledby="capital-allowances-title">
  <div class="detail-card-head tax-card-head">
    <h2 id="capital-allowances-title" class="detail-card-title">
      Asset tax deductions
    </h2>
    {#if c.active && editable}<button
        type="button"
        class="detail-card-action"
        disabled={stale}
        onclick={() => (mode = "settings")}>Deductions used and evidence</button
      >{/if}
  </div>
  <div class="tax-stack">
    {#if !c.active}<p class="hint">
        Manual allowance totals are active. Prepare an asset-linked schedule to
        retain reviewed tax workings alongside this worksheet.
      </p>{:else}<p class="hint">
        Book depreciation stays separate. Review each asset, confirm allowance
        use, then review the annual worksheet once.
      </p>{/if}
    <div class="tax-actions">
      <a class="detail-card-action" href={resolve("/(app)/settings/tax")}
        >Scheme settings</a
      >
    </div>
    {#if c.schedule}<p class="field-hint">
        Tax jurisdiction: {taxJurisdictionLabel(jurisdiction)} · Book currency: {detail
          .revision.snapshot.currency}. Custom schemes are not
        jurisdiction-verified.
      </p>{/if}
    {#if editable}<div class="tax-actions">
        {#if !c.active}<Button
            size="sm"
            variant="outline"
            onclick={() => (mode = "prepare")}
            >{c.schedule
              ? "Use retained schedule"
              : "Prepare tax schedule"}</Button
          >{/if}{#if c.rollover}<button
            type="button"
            class="detail-card-action"
            onclick={() => (mode = "rollover")}
            >Bring forward YA {c.rollover.predecessor?.ya}</button
          >{/if}{#if c.schedule && c.assetsStale}<Button
            size="sm"
            variant="outline"
            onclick={() => (mode = "refresh-assets")}
            >Review updated asset evidence</Button
          >{/if}{#if c.active}<button
            type="button"
            class="detail-card-action"
            onclick={() => (mode = "manual")}>Use manual totals</button
          >{/if}
      </div>{/if}
    {#if c.active && stale}<ReportNotes
        notes={[
          c.currencyMismatch
            ? `The retained schedule uses ${c.schedule?.currency}, which differs from this worksheet. It is excluded from the annual result. Use manual totals or a confirmed matching-currency rollover; amounts are not converted here.`
            : c.assetsStale
              ? "Asset register or purchase evidence changed. Refresh the asset evidence and review affected workings."
              : "The preceding tax year was amended. Bring forward its latest finalised schedule and review again. Finalised figures here remain fixed.",
        ]}
        firstIsWarning
      />{/if}
    {#if c.schedule && c.totals}
      {#if !c.active}<p class="field-hint">
          The schedule below is retained for reference and is excluded from the
          current tax result.
        </p>{/if}
      <dl class="detail-list tax-summary">
        <div class="detail-row">
          <dt class="detail-key">Current-year allowances available</dt>
          <dd class="detail-val tax-amount">
            {money(c.totals.allowanceMinor)}
          </dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Allowances used this year (all origins)</dt>
          <dd class="detail-val tax-amount">{money(c.totals.usedMinor)}</dd>
        </div>
        <div class="detail-row">
          <dt class="detail-key">Unabsorbed allowances carried forward</dt>
          <dd class="detail-val tax-amount">
            {money(c.totals.carryForwardMinor)}
          </dd>
        </div>
        {#if c.totals.balancingChargeMinor}<div class="detail-row">
            <dt class="detail-key">Balancing charges</dt>
            <dd class="detail-val tax-amount">
              {money(c.totals.balancingChargeMinor)}
            </dd>
          </div>{/if}
      </dl>
      {#if c.active && c.totals.allowanceMinor > 0 && c.totals.usedMinor === 0}<ReportNotes
          notes={[
            "Deductions are available, but none are selected for use. Open Deductions used and evidence, confirm the amount used, and save to change the annual tax result.",
          ]}
        />{/if}
      {#if c.totals.rows.length}
        {#if screen.current}{#each c.totals.rows as row (row.assetId)}<article
              class="tax-item tax-stack"
            >
              <div class="tax-item-head">
                <strong>{row.asset.name}</strong><button
                  type="button"
                  class="detail-card-action"
                  onclick={() => openRow(row.assetId)}
                  >{editable && c.active && !stale
                    ? "Open workings"
                    : "View workings"}</button
                >
              </div>
              <dl class="detail-list tax-summary">
                <div class="detail-row">
                  <dt class="detail-key">Opening tax residual</dt>
                  <dd class="detail-val tax-amount">
                    {row.treatment === "claim"
                      ? money(row.openingResidualMinor)
                      : "—"}
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">First-year / regular</dt>
                  <dd class="detail-val tax-amount">
                    {row.treatment === "claim"
                      ? money(row.allowanceMinor)
                      : "—"}
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">Closing tax residual</dt>
                  <dd class="detail-val tax-amount">
                    {row.treatment === "claim"
                      ? money(row.closingResidualMinor)
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p class="field-hint">
                {row.issues.length
                  ? "Needs review"
                  : row.treatment === "exclude"
                    ? "Excluded"
                    : row.disposal
                      ? "Tax disposed · book accounting separate"
                      : "Complete"}
              </p>
            </article>{/each}
        {:else}<div class="tax-table-wrap">
            <table class="rep-table">
              <thead
                ><tr
                  ><th>Asset</th><th class="rep-amount">Opening tax residual</th
                  ><th class="rep-amount">First-year / regular</th><th
                    class="rep-amount">Closing tax residual</th
                  ><th>Status</th></tr
                ></thead
              ><tbody
                >{#each c.totals.rows as row (row.assetId)}<tr
                    ><td
                      ><button
                        type="button"
                        class="detail-card-action"
                        onclick={() => openRow(row.assetId)}
                        >{row.asset.name}</button
                      >{#if canReadAssets}<p class="field-hint">
                          <a
                            class="tax-record-link"
                            href={resolve("/(app)/assets/[id]", {
                              id: String(row.assetId),
                            })}>Open asset</a
                          >
                        </p>{/if}</td
                    ><td class="rep-amount"
                      >{row.treatment === "claim"
                        ? money(row.openingResidualMinor)
                        : "—"}</td
                    ><td class="rep-amount"
                      >{row.treatment === "claim"
                        ? money(row.allowanceMinor)
                        : "—"}</td
                    ><td class="rep-amount"
                      >{row.treatment === "claim"
                        ? money(row.closingResidualMinor)
                        : "—"}</td
                    ><td
                      >{row.issues.length
                        ? "Needs review"
                        : row.treatment === "exclude"
                          ? "Excluded"
                          : row.disposal
                            ? "Tax disposed"
                            : "Complete"}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>{/if}
      {:else}<p class="card-empty">
          No registered assets for this period. You can retain reviewed
          brought-forward allowances under Allowance use and evidence.
        </p>{/if}
      {#if c.active && c.totals.problems.length}<details class="tax-disclosure">
          <summary>Needs review ({c.totals.problems.length})</summary>
          <ul class="tax-support-list tax-disclosure-body">
            {#each c.totals.problems as problem, index (index)}<li>
                {problem}
              </li>{/each}
          </ul>
        </details>{/if}
      {#if c.schedule.evidence}<p class="field-hint">
          Working paper: {c.schedule.evidence}
        </p>{/if}
      {#if c.totals.groups.length}<details class="tax-disclosure">
          <summary>Utilisation by business source</summary>
          <div class="tax-disclosure-body">
            {#each c.totals.groups as group (group.businessSource)}<div
                class="tax-item"
              >
                <strong>{group.businessSource || "Unconfirmed source"}</strong>
                <p class="field-hint">
                  Brought forward {money(group.broughtForwardMinor)} · Current year
                  {money(group.availableMinor)} · Used {money(group.usedMinor)} ·
                  Unabsorbed {money(group.carryForwardMinor)}
                </p>
              </div>{/each}
          </div>
        </details>{/if}
      {#if c.totals.rows.some((r) => r.disposal)}<ReportNotes
          notes={[
            "Tax disposals do not remove assets from the balance sheet or stop book depreciation. Complete the separate accounting work with your accountant.",
          ]}
          firstIsWarning
        />{/if}
    {/if}
  </div>
</section>
{#if mode}<CapitalAllowanceSheet
    {mode}
    {detail}
    {assetId}
    onclose={() => {
      mode = null;
      assetId = null;
    }}
    {onsaved}
  />{/if}
