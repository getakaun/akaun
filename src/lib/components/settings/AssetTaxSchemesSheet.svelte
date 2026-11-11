<script lang="ts">
  import { untrack } from "svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import TaxWorkingsDrawer from "../tax-worksheets/TaxWorkingsDrawer.svelte";
  import TaxJurisdictionField from "../tax-worksheets/TaxJurisdictionField.svelte";
  import { percentageToBps } from "$lib/expense-tax.js";
  import {
    assetTaxSchemeRemark,
    type AssetTaxSchemeDefinition,
  } from "$lib/asset-tax-scheme.js";
  import type { AssetTaxSchemeVersion } from "$lib/server/queries/asset-tax-schemes.js";
  let {
    schemes,
    initialFamilyKey = null,
    onclose,
    onsaved,
  }: {
    schemes: AssetTaxSchemeVersion[];
    initialFamilyKey?: string | null;
    onclose: () => void;
    onsaved: () => Promise<void>;
  } = $props();
  const versions = untrack(() => structuredClone($state.snapshot(schemes)));
  const latest = [...new Map(versions.map((s) => [s.familyKey, s])).values()];
  const initialFamily = untrack(() => initialFamilyKey);
  const selected = latest.find(
    (s) => s.familyKey === initialFamily,
  )?.definition;
  const family = initialFamily ?? "new";
  let name = $state(selected?.name ?? "");
  let jurisdiction = $state<string | null>(selected?.jurisdiction ?? null);
  let yearFrom = $state(selected ? String(selected.yearFrom) : "");
  let yearTo = $state(selected?.yearTo ? String(selected.yearTo) : "");
  let method = $state<AssetTaxSchemeDefinition["method"]>(
    selected?.method ?? "original_cost",
  );
  let firstRate = $state(
    selected ? String(selected.firstYearRateBps / 100) : "",
  );
  let regularRate = $state(
    selected ? String(selected.regularRateBps / 100) : "",
  );
  let remark = $state(selected ? assetTaxSchemeRemark(selected) : "");
  let saving = $state(false);
  let savedSuccessfully = $state(false);
  let error = $state("");
  let retryKey = "";
  let retryPayload = "";
  const newFamily = crypto.randomUUID();
  const snapshot = () =>
    JSON.stringify([
      name,
      jurisdiction,
      yearFrom,
      yearTo,
      method,
      firstRate,
      regularRate,
      remark,
    ]);
  let baseline = $state(untrack(snapshot));
  const dirty = $derived(snapshot() !== baseline);
  const current = $derived(latest.find((s) => s.familyKey === family));
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    error = "";
    const firstYearRateBps = percentageToBps(firstRate),
      regularRateBps = percentageToBps(regularRate);
    if (firstYearRateBps === null || regularRateBps === null) {
      error =
        "Enter rates from 0 to 100%, with at most two decimal places. Enter zero when a deduction does not apply.";
      return;
    }
    const payload = {
      familyKey: family === "new" ? newFamily : family,
      expectedVersion: current?.version ?? 0,
      definition: {
        name,
        jurisdiction,
        yearFrom: Number(yearFrom),
        yearTo: yearTo.trim() ? Number(yearTo) : null,
        method,
        firstYearRateBps,
        regularRateBps,
        remark,
      },
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint !== retryPayload) {
      retryPayload = fingerprint;
      retryKey = crypto.randomUUID();
    }
    saving = true;
    try {
      const response = await fetch("/api/tax/schemes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestKey: retryKey }),
      });
      const result = await response.json();
      if (!response.ok) {
        error =
          result.issues?.[0]?.message ??
          result.error ??
          "The scheme could not be saved.";
        return;
      }
      savedSuccessfully = true;
      await onsaved();
      onclose();
    } catch {
      error =
        "The result could not be confirmed. Retry to check the same request.";
    } finally {
      saving = false;
    }
  }
</script>

<TaxWorkingsDrawer
  title={current ? "Edit asset tax scheme" : "New asset tax scheme"}
  eyebrow="Tax settings"
  description="Configure a reusable asset tax calculation scheme."
  {saving}
  dirty={dirty && !savedSuccessfully}
  {error}
  submitLabel={current ? "Save changes" : "Create scheme"}
  {onclose}
  onsubmit={submit}
>
  <div class="field">
    <label class="field-label" for="scheme-name">Scheme name</label><Input
      id="scheme-name"
      bind:value={name}
      maxlength={120}
      required
      disabled={saving}
      placeholder="e.g. General plant and machinery"
    />
  </div>
  <TaxJurisdictionField
    id="scheme-jurisdiction"
    bind:value={jurisdiction}
    disabled={saving || !!current}
  />
  <div class="field">
    <label class="field-label" for="scheme-from">Effective from tax year</label
    ><Input
      id="scheme-from"
      type="number"
      value={yearFrom}
      oninput={(e) => (yearFrom = e.currentTarget.value)}
      min="2000"
      max="9999"
      required
      disabled={saving}
    />
    <p class="field-hint">First assessment year this scheme can be selected.</p>
  </div>
  <div class="field">
    <label class="field-label" for="scheme-to"
      >Effective through tax year (optional)</label
    ><Input
      id="scheme-to"
      type="number"
      value={yearTo}
      oninput={(e) => (yearTo = e.currentTarget.value)}
      min="2000"
      max="9999"
      disabled={saving}
    />
  </div>
  <div class="field">
    <label class="field-label" for="scheme-method"
      >Regular deduction basis</label
    ><Select.Root type="single" bind:value={method} disabled={saving}
      ><Select.Trigger id="scheme-method" class="w-full justify-between"
        >{method === "original_cost"
          ? "Business-use qualifying cost"
          : "Remaining tax residual"}</Select.Trigger
      ><Select.Content
        ><Select.Item
          value="original_cost"
          label="Business-use qualifying cost"
        /><Select.Item
          value="reducing_balance"
          label="Remaining tax residual"
        /></Select.Content
      ></Select.Root
    >
    <p class="field-hint">
      First-year allowance uses new qualifying additions. The regular allowance
      uses this basis; both are limited to the remaining tax residual.
    </p>
  </div>
  <div class="field">
    <label class="field-label" for="scheme-first">First-year rate (%)</label
    ><Input
      id="scheme-first"
      bind:value={firstRate}
      inputmode="decimal"
      required
      disabled={saving}
    />
  </div>
  <div class="field">
    <label class="field-label" for="scheme-regular">Regular rate (%)</label
    ><Input
      id="scheme-regular"
      bind:value={regularRate}
      inputmode="decimal"
      required
      disabled={saving}
    />
  </div>
  <div class="field">
    <label class="field-label" for="scheme-remark">Remark (optional)</label>
    <Textarea
      id="scheme-remark"
      bind:value={remark}
      maxlength={5000}
      disabled={saving}
      rows={3}
    />
  </div>
  <p class="field-hint">
    Confirm the scheme's rates and eligibility before use. Changes apply to
    future selections; saved asset workings keep their existing version.
  </p>
</TaxWorkingsDrawer>
