<script lang="ts">
  import { untrack } from "svelte";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import TaxWorkingsDrawer from "./TaxWorkingsDrawer.svelte";
  import CapitalUtilisationFields from "./CapitalUtilisationFields.svelte";
  import CapitalAssetFields from "./CapitalAssetFields.svelte";
  import TaxJurisdictionField from "./TaxJurisdictionField.svelte";
  import {
    createAssetTaxForm,
    assetTaxRowFromForm,
    amountInput,
    parseTaxAmount,
  } from "./asset-tax-form.js";
  import { formatTaxMinor, safeTaxSum } from "$lib/tax-worksheet.js";
  import {
    schemeApplies,
    taxJurisdictionLabel,
  } from "$lib/asset-tax-scheme.js";
  import { type CapitalRowInput } from "$lib/capital-allowance.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  export type CapitalSheetMode =
    | "row"
    | "view"
    | "jurisdiction"
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
  const readonly = untrack(() => mode === "view");
  const money = (n: number) =>
    formatTaxMinor(
      n,
      initial.capital.schedule?.currency ?? initial.revision.snapshot.currency,
    );
  let assetForm = $state(
    createAssetTaxForm(
      selected,
      asset,
      initial.worksheet.dateFrom,
      initial.worksheet.dateTo,
    ),
  );
  const asInput = amountInput;
  let jurisdiction = $state(
    initial.capital.schedule?.jurisdiction ??
      (initial.capital.schedule?.calculationVersion === 1 ? "MY" : null),
  );
  const schemeChoices = initial.capital.schemes.map((scheme) => ({
    id: scheme.id,
    familyKey: scheme.familyKey,
    version: scheme.version,
    definition: scheme.definition,
    verification: "custom_unverified" as const,
  }));
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
  let savedSuccessfully = $state(false);
  let error = $state("");
  let retryKey = "";
  let retryPayload = "";
  const formSnapshot = () =>
    JSON.stringify([
      assetForm,
      jurisdiction,
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
    jurisdiction: "Change tax jurisdiction",
    settings: "Deductions used and evidence",
    prepare: initial.capital.schedule
      ? "Use retained asset schedule"
      : "Prepare asset tax schedule",
    rollover: "Bring forward previous year",
    "refresh-assets": "Refresh asset evidence",
    manual: "Use manual allowance totals",
  };
  const parseAmount = parseTaxAmount;
  function rowInput(): CapitalRowInput {
    return assetTaxRowFromForm(
      selected!,
      assetForm,
      initial.worksheet.ya,
      schemeChoices,
      {
        context: initial.capital.firstYearContexts[selected!.assetId],
        asset,
        dateFrom: initial.worksheet.dateFrom,
        dateTo: initial.worksheet.dateTo,
      },
    );
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || readonly) return;
    error = "";
    let payload: Record<string, unknown>;
    try {
      payload = {
        action: mode,
        expectedVersion: initial.revision.version,
        reason:
          mode === "row"
            ? "Update asset tax workings"
            : mode === "jurisdiction"
              ? "Change asset tax jurisdiction"
              : reason,
      };
      if (mode !== "manual")
        payload.liveAssetHash = initial.capital.liveAssetHash;
      if (mode === "prepare" || mode === "rollover")
        payload.replaceManual = replaceManual;
      if (mode === "prepare") payload.jurisdiction = jurisdiction;
      if (mode === "rollover")
        payload.rolloverHash = initial.capital.rolloverHash;
      if (mode === "row" || mode === "settings" || mode === "jurisdiction") {
        payload.action = "save";
        const input = structuredClone(initial.capital.schedule!);
        if (mode === "row") {
          const row = rowInput();
          input.rows = input.rows.map((r) =>
            r.assetId === row.assetId ? row : r,
          );
        } else if (mode === "settings") {
          input.evidence = evidence;
          input.utilisation = uses.map((u) => ({
            businessSource: u.source,
            originYa: Number(u.origin),
            balanceMinor: parseAmount(u.balance)!,
            usedMinor: parseAmount(u.used)!,
          }));
        }
        payload.input = {
          jurisdiction,
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
      savedSuccessfully = true;
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

<TaxWorkingsDrawer
  title={titles[mode]}
  eyebrow={`Tax year ${initial.worksheet.ya} · Asset tax deductions`}
  {saving}
  dirty={dirty && !savedSuccessfully}
  {error}
  {readonly}
  submitLabel={mode === "row" || mode === "settings"
    ? "Save workings"
    : titles[mode]}
  disabled={((mode === "prepare" || mode === "rollover") &&
    overlaps.length > 0 &&
    !replaceManual) ||
    (mode === "row" &&
      assetForm.treatment === "claim" &&
      !schemeChoices.some(
        (s) =>
          String(s.id) === assetForm.schemeId &&
          schemeApplies(s.definition, jurisdiction, initial.worksheet.ya),
      ))}
  {onclose}
  onsubmit={submit}
>
  {#if mode === "row" || mode === "view"}
    <CapitalAssetFields
      bind:draft={assetForm}
      selected={selected!}
      {asset}
      schedule={initial.capital.schedule!}
      schemes={schemeChoices}
      {jurisdiction}
      year={initial.worksheet.ya}
      dateFrom={initial.worksheet.dateFrom}
      dateTo={initial.worksheet.dateTo}
      currency={initial.capital.schedule!.currency}
      {readonly}
      {saving}
      firstYearContext={initial.capital.firstYearContexts[selected!.assetId]}
    />
  {:else if mode === "jurisdiction"}
    <TaxJurisdictionField bind:value={jurisdiction} disabled={saving} />
    <p class="field-hint">
      Changing jurisdiction clears scheme selections and returns assets to
      review. Amounts are not converted.
    </p>
  {:else if mode === "settings"}
    <CapitalUtilisationFields
      bind:jurisdiction
      bind:evidence
      bind:uses
      year={initial.worksheet.ya}
      currency={initial.revision.snapshot.currency}
      {saving}
      baseResult={safeTaxSum([
        initial.totals.resultMinor,
        -initial.totals.capitalMinor,
      ])}
      balancingCharges={initial.capital.totals?.balancingChargeMinor ?? 0}
    />
  {:else if mode === "manual"}
    <p class="hint">
      Stop using the asset schedule in this revision. Its evidence is retained,
      but its allowances and balancing charges will no longer affect the tax
      result. Enter reviewed replacement totals through tax adjustments.
    </p>
    <p class="field-hint">
      Current schedule effect to remove: {money(initial.totals.capitalMinor)}.
    </p>
  {:else if mode === "refresh-assets"}
    <p class="hint">
      Capture the current register and purchase evidence. Changed or new assets
      return to Needs review; current-year utilisation must be confirmed again.
      Other tax workings are retained where the asset still exists.
    </p>
    <p class="field-hint">
      {initial.capital.candidates.length} asset(s) in the current register for this
      period.
    </p>
  {:else}
    {#if mode === "prepare"}<TaxJurisdictionField
        bind:value={jurisdiction}
        disabled={saving}
      />{/if}
    {#if mode === "rollover"}<p class="hint">
        Replace this revision’s schedule with openings from finalised YA {initial
          .capital.rollover?.predecessor?.ya}. Annual allowances and
        current-year use require fresh review.
      </p>
      <p class="field-hint">
        The preview uses {taxJurisdictionLabel(
          initial.capital.rollover?.jurisdiction,
        )} and {initial.capital.rollover?.currency}. Confirm these before
        replacing this revision’s schedule.
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
              : `Brought-forward YA ${a.originYa}`} · {money(a.amountMinor)} utilised{#if a.balanceMinor}
              · balance {money(a.balanceMinor)}{/if}
          </li>{/each}
      </ul>
      <div class="tax-filter">
        <Checkbox
          id="ca-replace"
          bind:checked={replaceManual}
          disabled={saving}
        /><label for="ca-replace">Replace these manual allowance entries</label>
      </div>{/if}
  {/if}
  {#if !readonly && mode !== "row" && mode !== "jurisdiction"}<div
      class="field"
    >
      <label class="field-label" for="ca-reason">Reason for this change</label
      ><Textarea
        id="ca-reason"
        bind:value={reason}
        minlength={10}
        maxlength={2000}
        required
        disabled={saving}
      />
    </div>{/if}
</TaxWorkingsDrawer>
