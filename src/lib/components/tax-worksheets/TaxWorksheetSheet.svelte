<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import "./tax-worksheets.css";
  import { Input } from "$lib/components/ui/input/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import TaxValuesFields from "$lib/components/tax/TaxValuesFields.svelte";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import {
    formatTaxMinor,
    taxMoneyMinor,
    taxManualKinds,
    taxManualLabels,
    safeTaxSum,
    type TaxManualKind,
  } from "$lib/tax-worksheet.js";
  import {
    taxFormValues,
    deductionMinor,
    needsTaxReview,
    TaxTreatmentLabels,
  } from "$lib/expense-tax.js";
  import type { TaxWorksheetDetail } from "$lib/server/queries/tax-worksheets.js";

  let {
    mode,
    detail = null,
    line = null,
    adjustmentId = null,
    onclose,
    onsaved,
  }: {
    mode: "create" | "source" | "manual" | "refresh" | "amend" | "withdraw";
    detail?: TaxWorksheetDetail | null;
    line?: TaxWorksheetDetail["totals"]["lines"][number] | null;
    adjustmentId?: number | null;
    onclose: () => void;
    onsaved: (detail: TaxWorksheetDetail) => Promise<void>;
  } = $props();
  // Freeze confirmation evidence/version while another session may refresh the page.
  const initial = untrack(() => detail);
  const source = untrack(() => line);
  const money = (minor: number) =>
    formatTaxMinor(minor, initial?.revision.snapshot.currency ?? "MYR");
  const screen = useIsMobile();
  let saving = $state(false);
  let error = $state("");
  let ya = $state("");
  let dateFrom = $state("");
  let dateTo = $state("");
  let reason = $state("");
  let evidence = $state("");
  let treatment = $state(
    untrack(() => line?.effectiveTreatment ?? "unclassified"),
  );
  let percentage = $state(
    untrack(() =>
      line?.effectivePercentageBps == null
        ? ""
        : (line.effectivePercentageBps / 100).toFixed(2),
    ),
  );
  let kind = $state<TaxManualKind>("other");
  let direction = $state<"increase" | "decrease">("decrease");
  let amount = $state("");
  let balance = $state("");
  let originYa = $state("");
  let discardOpen = $state(false);
  let pendingHref: string | null = null;
  let leaving = false;
  let form: HTMLFormElement;
  let retryKey = "";
  let retryPayload = "";
  const initialForm = untrack(() =>
    JSON.stringify([
      ya,
      dateFrom,
      dateTo,
      reason,
      evidence,
      treatment,
      percentage,
      kind,
      direction,
      amount,
      balance,
      originYa,
    ]),
  );
  const dirty = $derived(
    JSON.stringify([
      ya,
      dateFrom,
      dateTo,
      reason,
      evidence,
      treatment,
      percentage,
      kind,
      direction,
      amount,
      balance,
      originYa,
    ]) !== initialForm,
  );
  const carry = $derived(
    kind === "allowance_brought_forward" || kind === "loss_brought_forward",
  );
  const values = $derived(taxFormValues(treatment, percentage));
  const nextAddBack = $derived(
    source &&
      values.percentageBps !== null &&
      !needsTaxReview({
        ...values,
        treatment: values.treatment ?? "unclassified",
      })
      ? safeTaxSum([
          source.expenseMinor,
          -deductionMinor(source.expenseMinor, values.percentageBps),
        ])
      : null,
  );
  const effect = $derived(
    nextAddBack !== null && source?.addBackMinor != null
      ? safeTaxSum([nextAddBack, -source.addBackMinor])
      : null,
  );
  const titles = {
    create: "New annual worksheet",
    source: "Change annual treatment",
    manual: "Add tax adjustment",
    refresh: "Refresh accounting figures",
    amend: "Create amendment",
    withdraw: "Withdraw adjustment",
  };
  function close() {
    if (saving) return;
    if (dirty) discardOpen = true;
    else onclose();
  }
  beforeNavigate((nav) => {
    if (leaving) {
      leaving = false;
      return;
    }
    if (!dirty || !nav.to || nav.willUnload) return;
    nav.cancel();
    pendingHref = nav.to.url.href;
    discardOpen = true;
  });
  function discard() {
    if (pendingHref) {
      leaving = true;
      const href = pendingHref;
      pendingHref = null;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit provided the destination.
      void goto(href);
    } else onclose();
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    error = "";
    let payload: Record<string, unknown>;
    let endpoint = initial ? `/api/tax/${initial.worksheet.id}` : "/api/tax";
    if (mode === "create") payload = { ya: Number(ya), dateFrom, dateTo };
    else if (mode === "source") {
      if (
        values.error ||
        needsTaxReview({
          ...values,
          treatment: values.treatment ?? "unclassified",
        })
      ) {
        error = values.error ?? "Choose a resolved annual treatment.";
        return;
      }
      payload = {
        kind: "source",
        sourceMovementId: source!.movementId,
        treatment: values.treatment,
        percentageBps: values.percentageBps,
        reason,
        evidence,
      };
      endpoint += "/adjustments";
    } else if (mode === "manual") {
      const minor = taxMoneyMinor(amount);
      const balanceMinor = carry ? taxMoneyMinor(balance) : 0;
      if (minor === null || balanceMinor === null) {
        error = "Enter amounts with at most two decimal places.";
        return;
      }
      payload = {
        kind,
        direction: kind === "other" ? direction : "decrease",
        amountMinor: minor,
        balanceMinor,
        originYa: carry ? Number(originYa) : null,
        reason,
        evidence,
      };
      endpoint += "/adjustments";
    } else
      payload = {
        action: mode,
        reason,
        ...(mode === "refresh" ? { liveHash: initial!.liveHash } : {}),
        ...(mode === "withdraw" ? { adjustmentId } : {}),
      };
    if (mode !== "create") payload.expectedVersion = initial!.revision.version;
    if (["create", "source", "manual", "amend"].includes(mode)) {
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== retryPayload) {
        retryPayload = fingerprint;
        retryKey = crypto.randomUUID();
      }
      payload.requestKey = retryKey;
    }
    saving = true;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        error =
          result.issues?.[0]?.message ??
          result.error ??
          "The worksheet could not be saved.";
        return;
      }
      leaving = true;
      await onsaved(result);
      onclose();
    } catch {
      error =
        "The result could not be confirmed. Retry to check the same request.";
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
      ? "height:100dvh;border-radius:0;border-top:none;display:flex;flex-direction:column;overflow:hidden;gap:0;"
      : "width:500px;max-width:95vw;display:flex;flex-direction:column;overflow:hidden;gap:0;"}
  >
    <div class="tax-sheet-head">
      <div>
        <div class="sheet-eyebrow">Annual tax</div>
        <Sheet.Title class="sheet-title-text">{titles[mode]}</Sheet.Title
        ><Sheet.Description class="sr-only"
          >Prepare tax figures independently of accounting records.</Sheet.Description
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
    <div class="tax-sheet-body">
      <form bind:this={form} onsubmit={submit} class="tax-form">
        {#if mode === "create"}
          <p class="field-hint">
            Confirm the YA and accounting dates with your accountant. The dates
            are not inferred from the YA.
          </p>
          <div class="field">
            <label class="field-label" for="tax-ya"
              >Year of assessment (YA)</label
            ><Input
              id="tax-ya"
              type="number"
              min="2000"
              max="9999"
              required
              value={ya}
              oninput={(e) => (ya = e.currentTarget.value)}
              disabled={saving}
            />
          </div>
          <div class="field">
            <span class="field-label" id="tax-from"
              >Accounting period starts</span
            ><DatePicker
              labelledBy="tax-from"
              bind:value={dateFrom}
              disabled={saving}
            />
          </div>
          <div class="field">
            <span class="field-label" id="tax-to">Accounting period ends</span
            ><DatePicker
              labelledBy="tax-to"
              bind:value={dateTo}
              disabled={saving}
            />
          </div>
          <p class="field-hint">
            The worksheet captures existing Profit & Loss and saved expense
            classifications in the book's main currency.
          </p>
        {:else if mode === "source" && source}
          <div class="tax-evidence">
            <strong>{source.label ?? source.description}</strong>
            <p>{money(source.expenseMinor)} · {source.accountName}</p>
            <p>
              Saved treatment: {TaxTreatmentLabels[
                source.classification?.treatment ?? "unclassified"
              ]}{source.classification?.percentageBps == null
                ? ""
                : ` (${source.classification.percentageBps / 100}%)`}
            </p>
          </div>
          <TaxValuesFields
            id="annual-treatment"
            bind:treatment
            bind:percentage
            disabled={saving}
          />
          {#if nextAddBack !== null}<p class="tax-evidence" aria-live="polite">
              Annual add-back: <strong>{money(nextAddBack)}</strong>. {effect ===
              null
                ? "This resolves the annual classification."
                : effect === 0
                  ? "The worksheet total stays the same."
                  : `This ${effect < 0 ? "reduces" : "increases"} the annual add-back by ${money(Math.abs(effect))}.`}
            </p>{/if}
        {:else if mode === "manual"}
          <div class="field">
            <label class="field-label" for="tax-kind">Adjustment category</label
            >
            <Select.Root
              type="single"
              value={kind}
              onValueChange={(value) => {
                if (taxManualKinds.includes(value as TaxManualKind))
                  kind = value as TaxManualKind;
              }}
              disabled={saving}
            >
              <Select.Trigger id="tax-kind" class="w-full justify-between"
                >{taxManualLabels[kind]}</Select.Trigger
              >
              <Select.Content
                >{#each taxManualKinds.filter((k) => !initial?.capital.active || !["capital_allowance", "allowance_brought_forward"].includes(k)) as k (k)}<Select.Item
                    value={k}
                    label={taxManualLabels[k]}
                  />{/each}</Select.Content
              >
            </Select.Root>
          </div>
          {#if kind === "other"}<div class="field">
              <label class="field-label" for="tax-direction"
                >Effect on tax result</label
              >
              <Select.Root
                type="single"
                value={direction}
                onValueChange={(value) => {
                  if (value === "increase" || value === "decrease")
                    direction = value;
                }}
                disabled={saving}
              >
                <Select.Trigger
                  id="tax-direction"
                  class="w-full justify-between"
                  >{direction === "increase"
                    ? "Increase"
                    : "Decrease"}</Select.Trigger
                >
                <Select.Content
                  ><Select.Item value="decrease" label="Decrease" /><Select.Item
                    value="increase"
                    label="Increase"
                  /></Select.Content
                >
              </Select.Root>
            </div>{/if}
          {#if carry}
            <div class="field">
              <label class="field-label" for="tax-origin">Origin YA</label
              ><Input
                id="tax-origin"
                type="number"
                min="2000"
                max={(initial?.worksheet.ya ?? 9999) - 1}
                required
                value={originYa}
                oninput={(e) => (originYa = e.currentTarget.value)}
                disabled={saving}
              />
            </div>
            <div class="field">
              <label class="field-label" for="tax-balance"
                >Reviewed brought-forward balance</label
              ><Input
                id="tax-balance"
                inputmode="decimal"
                required
                bind:value={balance}
                disabled={saving}
              />
            </div>
          {/if}
          <div class="field">
            <label class="field-label" for="tax-amount"
              >{carry ? "Amount utilised this YA" : "Amount"} ({initial
                ?.revision.snapshot.currency})</label
            ><Input
              id="tax-amount"
              inputmode="decimal"
              required
              bind:value={amount}
              disabled={saving}
            />
          </div>
          <p class="field-hint">
            {carry
              ? "Enter only the amount reviewed as eligible for use this year. The balance is not deducted automatically."
              : kind === "capital_allowance"
                ? "Enter the reviewed current-year claim. Book depreciation is already included in expense add-backs."
                : "Enter a positive amount. Akaun applies the direction you selected."}
          </p>
        {:else if mode === "refresh"}
          <p>
            Replace this draft's accounting figures with the changes shown on
            the worksheet. Existing source corrections on changed or removed
            lines must first be withdrawn.
          </p>
          <p class="field-hint">
            This clears reviewed status. Unchanged-line corrections and manual
            adjustments remain for review.
          </p>
        {:else if mode === "amend"}
          <p>
            Create revision {(initial?.revision.revision ?? 0) + 1} as a draft. The
            finalised revision remains available with its original figures and export.
          </p>
          <p class="field-hint">
            Active adjustments are copied for review. Any later accounting
            changes require an explicit refresh.
          </p>
        {:else if mode === "withdraw"}
          <p>
            Remove this adjustment's effect from the current revision. Its
            original entry and withdrawal reason remain in history.
          </p>
        {/if}
        {#if mode !== "create"}
          <div class="field">
            <label class="field-label" for="tax-reason">Reason</label><Textarea
              id="tax-reason"
              bind:value={reason}
              minlength={10}
              maxlength={2000}
              required
              rows={3}
              disabled={saving}
            />
          </div>
        {/if}
        {#if mode === "source" || mode === "manual"}
          <div class="field">
            <label class="field-label" for="tax-evidence"
              >Supporting document or review reference</label
            ><Input
              id="tax-evidence"
              bind:value={evidence}
              maxlength={1000}
              required
              disabled={saving}
              placeholder="Receipt, accountant memo or schedule reference"
            />
          </div>
        {/if}
        {#if error}<div role="alert">
            <ReportNotes notes={[error]} firstIsWarning />
          </div>{/if}
      </form>
    </div>
    <footer class="sheet-foot">
      <p class="sheet-foot-note">
        Tax preparation only. Accounting balances stay unchanged.
      </p>
      <div class="sheet-foot-actions tax-actions">
        <button
          type="button"
          class="sheet-btn"
          onclick={close}
          disabled={saving}>Cancel</button
        ><button
          type="button"
          class="sheet-btn sheet-btn-primary"
          onclick={() => form.requestSubmit()}
          disabled={saving}
          >{saving
            ? "Saving…"
            : mode === "create"
              ? "Create worksheet"
              : mode === "source"
                ? "Save annual treatment"
                : mode === "manual"
                  ? "Add adjustment"
                  : titles[mode]}</button
        >
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
  .tax-sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tax-sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .tax-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .tax-evidence {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    line-height: 1.6;
  }
  .tax-form .field,
  .tax-form > .field-hint {
    margin: 0;
  }
</style>
