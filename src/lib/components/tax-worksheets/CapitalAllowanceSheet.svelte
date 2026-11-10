<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { percentageToBps } from "$lib/expense-tax.js";
  import {
    formatTaxMinor,
    taxDecimal,
    taxMoneyMinor,
  } from "$lib/tax-worksheet.js";
  import {
    capitalTotals,
    type CapitalRowInput,
  } from "$lib/capital-allowance.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  export type CapitalSheetMode =
    | "row"
    | "view"
    | "settings"
    | "prepare"
    | "rollover"
    | "refresh-assets"
    | "manual";
  let {
    mode,
    detail,
    assetId = null,
    onclose,
    onsaved,
  }: {
    mode: CapitalSheetMode;
    detail: Detail;
    assetId?: number | null;
    onclose: () => void;
    onsaved: (detail: Detail) => Promise<void>;
  } = $props();
  const initial = untrack(() => structuredClone($state.snapshot(detail)));
  const selected = initial.capital.schedule?.rows.find(
    (r) => r.assetId === assetId,
  );
  const asset = initial.capital.schedule?.assets.find(
    (a) => a.assetId === assetId,
  );
  const screen = useIsMobile();
  const readonly = untrack(() => mode === "view");
  const money = (n: number) =>
    formatTaxMinor(n, initial.revision.snapshot.currency);
  const fieldDefinitions = [
    [
      "qualifyingMinor",
      "Qualifying expenditure before business-use adjustment",
    ],
    ["openingResidualMinor", "Opening tax residual expenditure"],
    ["additionsMinor", "This-year qualifying additions"],
    ["initialMinor", "Initial allowance (IA)"],
    ["annualMinor", "Annual allowance (AA)"],
  ] as const;
  const asInput = (n: number | null | undefined) =>
    n == null ? "" : taxDecimal(n);
  let treatment = $state<CapitalRowInput["treatment"]>(
    selected?.treatment ?? "pending",
  );
  let taxClass = $state(selected?.taxClass ?? "");
  let businessSource = $state(selected?.businessSource ?? "");
  let percentage = $state(
    selected?.businessUseBps == null
      ? ""
      : String(selected.businessUseBps / 100),
  );
  let amounts = $state(
    Object.fromEntries(
      fieldDefinitions.map(([key]) => [key, asInput(selected?.[key])]),
    ),
  );
  let residualAdjustment = $state(
    asInput(selected?.residualAdjustmentMinor ?? 0),
  );
  let note = $state(selected?.note ?? "");
  let ruleReference = $state(selected?.ruleReference ?? "");
  let disposed = $state(!!selected?.disposal);
  let disposalDate = $state(selected?.disposal?.date ?? "");
  let proceeds = $state(asInput(selected?.disposal?.proceedsMinor));
  let balancingAllowance = $state(
    asInput(selected?.disposal?.balancingAllowanceMinor ?? 0),
  );
  let balancingCharge = $state(
    asInput(selected?.disposal?.balancingChargeMinor ?? 0),
  );
  let disposalEvidence = $state(selected?.disposal?.evidence ?? "");
  let evidence = $state(initial.capital.schedule?.evidence ?? "");
  const groups = initial.capital.totals?.groups ?? [];
  let uses = $state([
    ...(
      initial.capital.schedule?.utilisation.filter(
        (u) => u.originYa < initial.worksheet.ya,
      ) ?? []
    ).map((u) => ({
      source: u.businessSource,
      origin: String(u.originYa),
      balance: asInput(u.balanceMinor),
      used: asInput(u.usedMinor),
    })),
    ...groups
      .filter((g) => g.businessSource)
      .map((g) => ({
        source: g.businessSource,
        origin: String(initial.worksheet.ya),
        balance: asInput(g.availableMinor),
        used: asInput(
          initial.capital.schedule?.utilisation.find(
            (u) =>
              u.originYa === initial.worksheet.ya &&
              u.businessSource === g.businessSource,
          )?.usedMinor ?? 0,
        ),
      })),
  ]);
  let reason = $state("");
  let replaceManual = $state(false);
  let saving = $state(false);
  let error = $state("");
  let discardOpen = $state(false);
  let leaving = false;
  let pendingHref: string | null = null;
  let form: HTMLFormElement;
  let retryKey = "";
  let retryPayload = "";
  const formSnapshot = () =>
    JSON.stringify([
      treatment,
      taxClass,
      businessSource,
      percentage,
      amounts,
      residualAdjustment,
      note,
      ruleReference,
      disposed,
      disposalDate,
      proceeds,
      balancingAllowance,
      balancingCharge,
      disposalEvidence,
      evidence,
      uses,
      reason,
      replaceManual,
    ]);
  const original = untrack(formSnapshot);
  const dirty = $derived(!readonly && formSnapshot() !== original);
  const overlaps = initial.adjustments.filter(
    (a) =>
      a.withdrawnAt === null &&
      ["capital_allowance", "allowance_brought_forward"].includes(a.kind),
  );
  const titles = {
    row: "Asset tax workings",
    view: "Retained asset tax workings",
    settings: "Allowance use and evidence",
    prepare: initial.capital.schedule
      ? "Use retained asset schedule"
      : "Prepare asset schedule",
    rollover: "Bring forward previous year",
    "refresh-assets": "Refresh asset evidence",
    manual: "Use manual allowance totals",
  };
  function close() {
    if (saving) return;
    if (dirty) discardOpen = true;
    else onclose();
  }
  beforeNavigate((nav) => {
    if (leaving) return;
    if (!dirty || !nav.to || nav.willUnload) return;
    nav.cancel();
    pendingHref = nav.to.url.href;
    discardOpen = true;
  });
  function discard() {
    leaving = true;
    if (pendingHref) {
      /* eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit supplied the destination. */ void goto(
        pendingHref,
      );
    } else onclose();
  }
  function parseAmount(
    raw: string,
    nullable = false,
    signed = false,
  ): number | null {
    if (nullable && !raw.trim()) return null;
    const negative = signed && raw.startsWith("-");
    const n = taxMoneyMinor(negative ? raw.slice(1) : raw);
    if (n === null)
      throw Error("Enter amounts with at most two decimal places.");
    return negative ? -n : n;
  }
  function rowInput(): CapitalRowInput {
    const row: CapitalRowInput = {
      ...selected!,
      treatment,
      taxClass,
      businessSource,
      note,
      ruleReference,
      effectiveYa: initial.worksheet.ya,
      businessUseBps: percentage.trim() ? percentageToBps(percentage) : null,
      ...Object.fromEntries(
        fieldDefinitions.map(([key]) => [key, parseAmount(amounts[key], true)]),
      ),
      residualAdjustmentMinor: parseAmount(residualAdjustment, false, true)!,
      disposal: disposed
        ? {
            date: disposalDate,
            proceedsMinor: parseAmount(proceeds)!,
            balancingAllowanceMinor: parseAmount(balancingAllowance)!,
            balancingChargeMinor: parseAmount(balancingCharge)!,
            evidence: disposalEvidence,
          }
        : null,
    };
    if (percentage.trim() && row.businessUseBps === null)
      throw Error(
        "Enter a business-use percentage between 0 and 100, with at most two decimal places.",
      );

    return row;
  }
  const rowPreview = $derived.by(() => {
    if (
      !selected ||
      !initial.capital.schedule ||
      (mode !== "row" && mode !== "view")
    )
      return null;
    try {
      const row = rowInput();
      const schedule = {
        ...initial.capital.schedule,
        rows: initial.capital.schedule.rows.map((r) =>
          r.assetId === row.assetId ? row : r,
        ),
      };
      return (
        capitalTotals(
          schedule,
          initial.worksheet.ya,
          initial.worksheet.dateFrom,
          initial.worksheet.dateTo,
        ).rows.find((r) => r.assetId === row.assetId) ?? null
      );
    } catch {
      return null;
    }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || readonly) return;
    error = "";
    let payload: Record<string, unknown>;
    try {
      payload = {
        action: mode,
        expectedVersion: initial.revision.version,
        reason,
      };
      if (mode !== "manual")
        payload.liveAssetHash = initial.capital.liveAssetHash;
      if (mode === "prepare" || mode === "rollover")
        payload.replaceManual = replaceManual;
      if (mode === "rollover")
        payload.rolloverHash = initial.capital.rolloverHash;
      if (mode === "row" || mode === "settings") {
        payload.action = "save";
        const input = structuredClone(initial.capital.schedule!);
        if (mode === "row") {
          const row = rowInput();
          input.rows = input.rows.map((r) =>
            r.assetId === row.assetId ? row : r,
          );
        } else {
          input.evidence = evidence;
          input.utilisation = uses.map((u) => ({
            businessSource: u.source,
            originYa: Number(u.origin),
            balanceMinor: parseAmount(u.balance)!,
            usedMinor: parseAmount(u.used)!,
          }));
        }
        payload.input = {
          evidence: input.evidence,
          rows: input.rows,
          utilisation: input.utilisation,
        };
      }
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== retryPayload) {
        retryPayload = fingerprint;
        retryKey = crypto.randomUUID();
      }
      payload.requestKey = retryKey;
      saving = true;
      const response = await fetch(
        `/api/tax/${initial.worksheet.id}/capital-allowances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        error =
          result.issues?.[0]?.message ??
          result.error ??
          "The capital allowance schedule could not be saved.";
        return;
      }
      leaving = true;
      await onsaved(result);
      onclose();
    } catch (err) {
      error =
        err instanceof Error && !saving
          ? err.message
          : "The result could not be confirmed. Retry to check the same request.";
    } finally {
      saving = false;
    }
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  }}
/>
<Sheet.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Sheet.Content
    side={screen.current ? "bottom" : "right"}
    style={screen.current
      ? "height:100dvh;border-radius:0;display:flex;flex-direction:column;overflow:hidden;gap:0;"
      : "width:520px;max-width:95vw;display:flex;flex-direction:column;overflow:hidden;gap:0;"}
  >
    <div class="ca-sheet-head">
      <div>
        <div class="sheet-eyebrow">
          YA {initial.worksheet.ya} · Capital allowances
        </div>
        <Sheet.Title class="sheet-title-text">{titles[mode]}</Sheet.Title
        ><Sheet.Description class="sr-only"
          >Manual tax preparation, separate from book depreciation.</Sheet.Description
        >
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="Close"
        onclick={close}
        disabled={saving}><X size={16} /></button
      >
    </div>
    <div class="ca-sheet-body">
      <form bind:this={form} onsubmit={submit} class="tax-stack">
        {#if mode === "row" || mode === "view"}
          <div>
            <strong>{asset?.name}</strong>
            <p class="field-hint">
              Purchased {asset?.acquisitionDate} · Book cost {money(
                asset?.costMinor ?? 0,
              )}
            </p>
          </div>
          {#if asset?.reviewReason}<ReportNotes
              notes={[asset.reviewReason]}
              firstIsWarning
            />{/if}
          <div class="field">
            <label class="field-label" for="ca-treatment">Tax treatment</label
            ><Select.Root
              type="single"
              bind:value={treatment}
              disabled={saving || readonly}
              ><Select.Trigger id="ca-treatment" class="w-full justify-between"
                >{treatment === "claim"
                  ? "Prepare allowance workings"
                  : treatment === "exclude"
                    ? "Exclude with reason"
                    : "Needs review"}</Select.Trigger
              ><Select.Content
                ><Select.Item
                  value="pending"
                  label="Needs review"
                /><Select.Item
                  value="claim"
                  label="Prepare allowance workings"
                /><Select.Item
                  value="exclude"
                  label="Exclude with reason"
                /></Select.Content
              ></Select.Root
            >
          </div>
          {#if treatment === "claim"}
            <p class="field-hint">
              Enter accountant-reviewed amounts. Qualifying expenditure is
              before business use; all residual, addition and allowance amounts
              below are already business-use adjusted. No statutory rate is
              assumed.
            </p>
            <div class="field">
              <label class="field-label" for="ca-class">Tax class</label><Input
                id="ca-class"
                bind:value={taxClass}
                placeholder="As confirmed by your accountant"
                maxlength={100}
                disabled={saving || readonly}
              />
            </div>
            <div class="field">
              <label class="field-label" for="ca-source">Business source</label
              ><Input
                id="ca-source"
                bind:value={businessSource}
                placeholder="e.g. Main trading business"
                maxlength={100}
                disabled={saving || readonly}
              />
            </div>
            {#each fieldDefinitions as [key, label] (key)}
              <div class="field">
                <label class="field-label" for={`ca-${key}`}>{label}</label
                ><Input
                  id={`ca-${key}`}
                  bind:value={amounts[key]}
                  inputmode="decimal"
                  disabled={saving || readonly}
                />
              </div>
              {#if key === "qualifyingMinor"}<div class="field">
                  <label class="field-label" for="ca-use"
                    >Business use (%)</label
                  ><Input
                    id="ca-use"
                    bind:value={percentage}
                    inputmode="decimal"
                    disabled={saving || readonly}
                  />
                </div>{/if}
            {/each}
            {#if rowPreview}<dl class="detail-list tax-summary">
                <div class="detail-row">
                  <dt class="detail-key">Entered IA + AA</dt>
                  <dd class="detail-val tax-amount">
                    {money(rowPreview.allowanceMinor)}
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">Closing tax residual</dt>
                  <dd class="detail-val tax-amount">
                    {rowPreview.closingResidualMinor === null
                      ? "Needs review"
                      : money(rowPreview.closingResidualMinor)}
                  </dd>
                </div>
              </dl>
              {#if rowPreview.issues.length}<ReportNotes
                  notes={rowPreview.issues}
                  firstIsWarning
                />{/if}{/if}
            <details
              class="tax-disclosure"
              open={!!selected?.residualAdjustmentMinor ||
                !!selected?.ruleReference ||
                disposed}
            >
              <summary>Adjustments, source notes and disposal</summary>
              <div class="tax-disclosure-body">
                <div class="field">
                  <label class="field-label" for="ca-residual-adjust"
                    >Tax residual adjustment (+ / −)</label
                  ><Input
                    id="ca-residual-adjust"
                    bind:value={residualAdjustment}
                    inputmode="decimal"
                    disabled={saving || readonly}
                  />
                </div>
                <div class="field">
                  <label class="field-label" for="ca-rule"
                    >Rule or individual working-paper reference</label
                  ><Textarea
                    id="ca-rule"
                    bind:value={ruleReference}
                    maxlength={2000}
                    disabled={saving || readonly}
                  />
                  <p class="field-hint">
                    Effective YA {initial.worksheet.ya}. A shared working-paper
                    reference can be entered under Allowance use and evidence.
                  </p>
                </div>
                <div class="tax-filter">
                  <Checkbox
                    id="ca-disposal"
                    bind:checked={disposed}
                    disabled={saving || readonly}
                  /><label for="ca-disposal"
                    >Full tax disposal in this period</label
                  >
                </div>
                {#if disposed}<ReportNotes
                    notes={[
                      "Tax disposal does not record the asset sale or stop book depreciation. Complete the separate accounting correction with your accountant. Partial disposals and hire purchase are not supported here.",
                    ]}
                    firstIsWarning
                  />
                  <div class="field">
                    <span class="field-label" id="ca-disposal-date"
                      >Disposal date</span
                    ><DatePicker
                      labelledBy="ca-disposal-date"
                      bind:value={disposalDate}
                      disabled={saving || readonly}
                    />
                  </div>
                  <div class="field">
                    <label class="field-label" for="ca-proceeds"
                      >Disposal proceeds</label
                    ><Input
                      id="ca-proceeds"
                      bind:value={proceeds}
                      inputmode="decimal"
                      disabled={saving || readonly}
                    />
                  </div>
                  <div class="field">
                    <label class="field-label" for="ca-ba"
                      >Reviewed balancing allowance</label
                    ><Input
                      id="ca-ba"
                      bind:value={balancingAllowance}
                      inputmode="decimal"
                      disabled={saving || readonly}
                    />
                  </div>
                  <div class="field">
                    <label class="field-label" for="ca-bc"
                      >Reviewed balancing charge</label
                    ><Input
                      id="ca-bc"
                      bind:value={balancingCharge}
                      inputmode="decimal"
                      disabled={saving || readonly}
                    />
                  </div>
                  <div class="field">
                    <label class="field-label" for="ca-disposal-evidence"
                      >Disposal evidence reference</label
                    ><Input
                      id="ca-disposal-evidence"
                      bind:value={disposalEvidence}
                      maxlength={2000}
                      disabled={saving || readonly}
                    />
                  </div>
                {/if}
              </div>
            </details>
          {/if}
          <div class="field">
            <label class="field-label" for="ca-note"
              >{treatment === "exclude"
                ? "Exclusion reason"
                : "Notes / adjustment explanation"}</label
            ><Textarea
              id="ca-note"
              bind:value={note}
              maxlength={2000}
              disabled={saving || readonly}
            />
          </div>
        {:else if mode === "settings"}
          <div class="field">
            <label class="field-label" for="ca-evidence"
              >Shared accountant working-paper reference</label
            ><Input
              id="ca-evidence"
              bind:value={evidence}
              maxlength={2000}
              disabled={saving}
              placeholder="e.g. Accountant capital allowance schedule, YA 2025"
              required
            />
          </div>
          <p class="field-hint">
            Confirm how much of each reviewed balance is used this year,
            including zero. Availability does not imply eligibility or statutory
            ordering. Tax residual expenditure is separate from these unabsorbed
            allowances.
          </p>
          {#each uses as use, index (index)}<div class="tax-item tax-stack">
              {#if Number(use.origin) === initial.worksheet.ya}<strong
                  >{use.source} · Current year</strong
                >
                <p class="field-hint">
                  Available from asset workings: {money(
                    taxMoneyMinor(use.balance) ?? 0,
                  )}
                </p>
              {:else}<div class="field">
                  <label class="field-label" for={`ca-business-${index}`}
                    >Business source</label
                  ><Input
                    id={`ca-business-${index}`}
                    bind:value={use.source}
                    maxlength={100}
                    required
                    disabled={saving}
                  />
                </div>
                <div class="field">
                  <label class="field-label" for={`ca-origin-${index}`}
                    >Origin YA</label
                  ><Input
                    id={`ca-origin-${index}`}
                    type="number"
                    value={use.origin}
                    oninput={(e) => (use.origin = e.currentTarget.value)}
                    min="2000"
                    max={initial.worksheet.ya - 1}
                    required
                    disabled={saving}
                  />
                </div>
                <div class="field">
                  <label class="field-label" for={`ca-balance-${index}`}
                    >Reviewed brought-forward balance</label
                  ><Input
                    id={`ca-balance-${index}`}
                    bind:value={use.balance}
                    inputmode="decimal"
                    required
                    disabled={saving}
                  />
                </div>{/if}
              <div class="field">
                <label class="field-label" for={`ca-utilised-${index}`}
                  >Amount used this year</label
                ><Input
                  id={`ca-utilised-${index}`}
                  bind:value={use.used}
                  inputmode="decimal"
                  required
                  disabled={saving}
                />
              </div>
              {#if Number(use.origin) < initial.worksheet.ya}<button
                  type="button"
                  class="detail-card-action"
                  disabled={saving}
                  onclick={() => (uses = uses.filter((_, i) => i !== index))}
                  >Remove balance</button
                >{/if}
            </div>{/each}
          <button
            type="button"
            class="detail-card-action"
            disabled={saving}
            onclick={() =>
              (uses = [
                ...uses,
                {
                  source: "",
                  origin: String(initial.worksheet.ya - 1),
                  balance: "",
                  used: "0.00",
                },
              ])}>Add brought-forward balance</button
          >
        {:else if mode === "manual"}
          <p class="hint">
            Stop using the asset schedule in this revision. Its evidence is
            retained, but its allowances and balancing charges will no longer
            affect the tax result. Enter reviewed replacement totals through tax
            adjustments.
          </p>
          <p class="field-hint">
            Current schedule effect to remove: {money(
              initial.totals.capitalMinor,
            )}.
          </p>
        {:else if mode === "refresh-assets"}
          <p class="hint">
            Capture the current register and purchase evidence. Changed or new
            assets return to Needs review; current-year utilisation must be
            confirmed again. Other tax workings are retained where the asset
            still exists.
          </p>
          <p class="field-hint">
            {initial.capital.candidates.length} asset(s) in the current register for
            this period.
          </p>
        {:else}
          {#if mode === "rollover"}<p class="hint">
              Replace this revision’s schedule with openings from finalised YA {initial
                .capital.rollover?.predecessor?.ya}. Annual allowances and
              current-year use require fresh review.
            </p>
            <details class="tax-disclosure" open>
              <summary>Opening preview</summary>
              <div class="tax-disclosure-body">
                {#each initial.capital.rollover?.rows ?? [] as row (row.assetId)}<div
                    class="tax-item"
                  >
                    <strong
                      >{initial.capital.rollover?.assets.find(
                        (a) => a.assetId === row.assetId,
                      )?.name}</strong
                    >
                    <p class="field-hint">
                      {row.treatment === "exclude"
                        ? row.note
                        : row.openingResidualMinor === null
                          ? "New asset · Needs review"
                          : `Opening tax residual ${money(row.openingResidualMinor)}`}
                    </p>
                  </div>{/each}{#each initial.capital.rollover?.utilisation ?? [] as u (JSON.stringify( [u.businessSource, u.originYa], ))}<p
                    class="field-hint"
                  >
                    {u.businessSource} · YA {u.originYa}: unabsorbed {money(
                      u.balanceMinor,
                    )}
                  </p>{/each}
              </div>
            </details>
          {:else}<p class="hint">
              {initial.capital.schedule
                ? "Reactivate the retained schedule. Its previous inputs will be preserved."
                : `Prepare ${initial.capital.candidates.length} registered asset(s) for review. Eligibility, business use and tax amounts remain unconfirmed.`}
            </p>{/if}
          {#if overlaps.length}<ReportNotes
              notes={[
                `${overlaps.length} active manual allowance entry/entries will be withdrawn with history. Other tax adjustments and losses remain.`,
              ]}
              firstIsWarning
            />
            <ul class="tax-support-list">
              {#each overlaps as a (a.id)}<li>
                  {a.kind === "capital_allowance"
                    ? "Current-year claim"
                    : `Brought-forward YA ${a.originYa}`} · {money(
                    a.amountMinor,
                  )} utilised{#if a.balanceMinor}
                    · balance {money(a.balanceMinor)}{/if}
                </li>{/each}
            </ul>
            <div class="tax-filter">
              <Checkbox
                id="ca-replace"
                bind:checked={replaceManual}
                disabled={saving}
              /><label for="ca-replace"
                >Replace these manual allowance entries</label
              >
            </div>{/if}
        {/if}
        {#if !readonly}<div class="field">
            <label class="field-label" for="ca-reason"
              >Reason for this change</label
            ><Textarea
              id="ca-reason"
              bind:value={reason}
              minlength={10}
              maxlength={2000}
              required
              disabled={saving}
            />
          </div>{/if}
        {#if error}<div role="alert">
            <ReportNotes notes={[error]} firstIsWarning />
          </div>{/if}
      </form>
    </div>
    <footer class="sheet-footer">
      <div class="sheet-foot-actions tax-actions">
        <button
          type="button"
          class="sheet-btn"
          onclick={close}
          disabled={saving}>{readonly ? "Close" : "Cancel"}</button
        >{#if !readonly}<button
            type="button"
            class="sheet-btn sheet-btn-primary"
            disabled={saving ||
              ((mode === "prepare" || mode === "rollover") &&
                overlaps.length > 0 &&
                !replaceManual)}
            onclick={() => form.requestSubmit()}
            >{saving
              ? "Saving…"
              : mode === "row" || mode === "settings"
                ? "Save workings"
                : titles[mode]}</button
          >{/if}
      </div>
    </footer>
  </Sheet.Content>
</Sheet.Root>
<ConfirmDialog
  bind:open={discardOpen}
  title="Discard unsaved changes?"
  description="The information in this drawer has not been saved."
  confirmLabel="Discard changes"
  onConfirm={discard}
/>

<style>
  .ca-sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 12px;
  }
  .ca-sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .ca-sheet-body .field {
    margin: 0;
  }
</style>
