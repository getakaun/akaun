<script lang="ts">
  import { formatAuditTime } from "$lib/components/audit/audit-format.js";
  import { untrack } from "svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import TaxWorkingsDrawer from "./TaxWorkingsDrawer.svelte";
  import TaxJurisdictionField from "./TaxJurisdictionField.svelte";
  import { percentageToBps } from "$lib/expense-tax.js";
  import {
    taxJurisdictionLabel,
    type AssetTaxSchemeDefinition,
  } from "$lib/asset-tax-scheme.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  let {
    detail,
    onclose,
    onsaved,
  }: { detail: Detail; onclose: () => void; onsaved: () => Promise<void> } =
    $props();
  const initial = untrack(() => structuredClone($state.snapshot(detail)));
  const versions = initial.capital.schemes;
  const latest = [...new Map(versions.map((s) => [s.familyKey, s])).values()];
  let family = $state("new");
  let name = $state("");
  let jurisdiction = $state<string | null>(
    initial.capital.schedule?.jurisdiction ??
      (initial.capital.schedule?.calculationVersion === 1 ? "MY" : null),
  );
  let yearFrom = $state(String(initial.worksheet.ya));
  let yearTo = $state("");
  let method = $state<AssetTaxSchemeDefinition["method"]>("original_cost");
  let firstRate = $state("");
  let regularRate = $state("");
  let reference = $state("");
  let conditions = $state("");
  let reason = $state("");
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
      reference,
      conditions,
      reason,
    ]);
  let baseline = $state(untrack(snapshot));
  const dirty = $derived(snapshot() !== baseline);
  const current = $derived(latest.find((s) => s.familyKey === family));
  function choose(key: string) {
    family = key;
    const s = latest.find((s) => s.familyKey === key)?.definition;
    name = s?.name ?? "";
    jurisdiction = s?.jurisdiction ?? null;
    yearFrom = String(s?.yearFrom ?? initial.worksheet.ya);
    yearTo = s?.yearTo ? String(s.yearTo) : "";
    method = s?.method ?? "original_cost";
    firstRate = s ? String(s.firstYearRateBps / 100) : "";
    regularRate = s ? String(s.regularRateBps / 100) : "";
    reference = s?.reference ?? "";
    conditions = s?.conditions ?? "";
    reason = "";
    baseline = snapshot();
  }
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
      reason,
      definition: {
        name,
        jurisdiction,
        yearFrom: Number(yearFrom),
        yearTo: yearTo.trim() ? Number(yearTo) : null,
        method,
        firstYearRateBps,
        regularRateBps,
        reference,
        conditions,
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
  title="Reusable tax schemes"
  {saving}
  dirty={dirty && !savedSuccessfully}
  {error}
  submitLabel={current ? "Save new version" : "Create custom scheme"}
  {onclose}
  onsubmit={submit}
>
  <ReportNotes
    notes={[
      "These are your custom calculation schemes, not verified country rules. No Malaysian rates or approved presets are supplied. You can verify your Malaysian scheme after testing the workflow.",
    ]}
  />
  <div class="field">
    <label class="field-label" for="scheme-family">Scheme</label><Select.Root
      type="single"
      value={family}
      disabled={saving || dirty}
      onValueChange={choose}
      ><Select.Trigger id="scheme-family" class="w-full justify-between"
        >{current
          ? `${current.definition.name} · v${current.version}`
          : "Create a new scheme"}</Select.Trigger
      ><Select.Content
        ><Select.Item
          value="new"
          label="Create a new scheme"
        />{#each latest as scheme (scheme.id)}<Select.Item
            value={scheme.familyKey}
            label={`${scheme.definition.name} · ${taxJurisdictionLabel(scheme.definition.jurisdiction)} · v${scheme.version}`}
          />{/each}</Select.Content
      ></Select.Root
    >{#if dirty}<p class="field-hint">
        Save or discard the current edits before choosing another scheme.
      </p>{/if}
  </div>
  <div class="field">
    <label class="field-label" for="scheme-name">Scheme name</label><Input
      id="scheme-name"
      bind:value={name}
      maxlength={120}
      required
      disabled={saving}
      placeholder="e.g. Equipment — custom draft"
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
      First-year deduction uses eligible this-year additions when explicitly
      selected. Regular deduction uses the chosen basis. Both are capped by
      remaining tax residual; no proration, pooling, MACRS or legal eligibility
      is inferred.
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
    <label class="field-label" for="scheme-reference"
      >Source / working-paper reference</label
    ><Textarea
      id="scheme-reference"
      bind:value={reference}
      maxlength={2000}
      required
      disabled={saving}
    />
  </div>
  <div class="field">
    <label class="field-label" for="scheme-conditions"
      >Conditions and exclusions</label
    ><Textarea
      id="scheme-conditions"
      bind:value={conditions}
      maxlength={2000}
      disabled={saving}
    />
  </div>
  <div class="field">
    <label class="field-label" for="scheme-reason"
      >Reason for this version</label
    ><Textarea
      id="scheme-reason"
      bind:value={reason}
      minlength={10}
      maxlength={2000}
      required
      disabled={saving}
    />
  </div>
  {#if current}<p class="field-hint">
      This creates version {current.version + 1}. Existing asset applications
      and finalised schedules keep their saved definition and amounts.
    </p>
    <details class="tax-disclosure">
      <summary>Retained versions</summary>
      <ul class="tax-support-list tax-disclosure-body">
        {#each versions.filter((s) => s.familyKey === family) as version (version.id)}<li
          >
            Version {version.version} · {version.actorName} · {formatAuditTime(
              version.createdAt,
            )}
            · {version.definition.reference}
          </li>{/each}
      </ul>
    </details>{/if}
</TaxWorkingsDrawer>
