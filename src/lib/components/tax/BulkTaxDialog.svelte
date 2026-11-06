<script lang="ts">
  import { Dialog } from "bits-ui";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { formatMinor } from "$lib/format.js";
  import {
    bulkTaxSchema,
    type BulkTaxInput,
    type BulkTaxPreview,
  } from "$lib/bulk-expense-tax.js";
  import { taxFormValues, TaxTreatmentLabels } from "$lib/expense-tax.js";
  import TaxValuesFields from "./TaxValuesFields.svelte";

  let {
    movementIds,
    dateFrom,
    dateTo,
    accountId,
    onclose,
    onapplied,
  }: {
    movementIds: number[];
    dateFrom: string;
    dateTo: string;
    accountId: number | null;
    onclose: () => void;
    onapplied: (result: {
      updatedLineCount: number;
      updatedRecordCount: number;
    }) => void;
  } = $props();
  let mode = $state("account-default");
  let treatment = $state("ordinary_deductible");
  let percentage = $state("100.00");
  let reason = $state("");
  let busy = $state(false);
  let error = $state("");
  let stale = $state(false);
  let preview = $state<BulkTaxPreview | null>(null);
  let previewInput = $state<BulkTaxInput | null>(null);
  let excludedIds = $state<number[]>([]);
  const request = $derived.by(() => {
    const tax = taxFormValues(treatment, percentage);
    const parsed = bulkTaxSchema.safeParse({
      movementIds: movementIds.filter((id) => !excludedIds.includes(id)),
      dateFrom,
      dateTo,
      accountId,
      reason,
      action:
        mode === "account-default"
          ? { kind: "account-default" }
          : {
              kind: "treatment",
              percentageBps: tax.percentageBps,
              treatment: tax.treatment,
            },
    });
    return parsed.success ? parsed.data : null;
  });
  const previewCurrent = $derived(
    preview !== null &&
      !stale &&
      JSON.stringify(request) === JSON.stringify(previewInput),
  );
  async function review() {
    if (!request || busy) return;
    const input = request;
    busy = true;
    error = "";
    stale = true;
    try {
      const response = await fetch("/api/records/tax-classification/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "The preview could not be prepared.";
        return;
      }
      previewInput = input;
      preview = body;
      stale = false;
    } catch {
      error =
        "The preview could not be loaded. Check your connection and try again.";
    } finally {
      busy = false;
    }
  }
  async function apply() {
    if (
      !preview ||
      !previewInput ||
      !previewCurrent ||
      busy ||
      preview.eligibleLineCount === 0
    )
      return;
    busy = true;
    error = "";
    try {
      const response = await fetch("/api/records/tax-classification/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...previewInput, revision: preview.revision }),
      });
      const body = await response.json();
      if (!response.ok) {
        stale = true;
        error =
          body.error ??
          "The batch could not be applied. Preview again before retrying.";
        return;
      }
      onapplied(body);
    } catch {
      stale = true;
      error =
        "The result could not be confirmed. Refresh the report before trying again; the batch may already have completed.";
    } finally {
      busy = false;
    }
  }
  function classification(tax: BulkTaxPreview["lines"][number]["after"]) {
    return tax
      ? `${TaxTreatmentLabels[tax.treatment]}${tax.percentageBps === null ? "" : ` · ${(tax.percentageBps / 100).toFixed(2)}%`}`
      : "Unreviewed";
  }
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open && !busy) onclose();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[60] bg-black/35" />
    <Dialog.Content
      class="bg-popover text-popover-foreground fixed inset-y-0 right-0 z-[60] w-full max-w-3xl overflow-y-auto border-l p-5 shadow-xl outline-none sm:p-7"
    >
      <Dialog.Title class="text-lg font-semibold"
        >Bulk tax classification</Dialog.Title
      >
      <Dialog.Description class="text-muted-foreground mt-2 text-sm">
        Review {movementIds.length - excludedIds.length} selected expense lines. Only
        eligible unresolved lines will change. Closed and already-classified lines
        are preserved. Tax figures remain estimates.
      </Dialog.Description>
      <form
        class="mt-5 space-y-4"
        onsubmit={(event) => {
          event.preventDefault();
          void review();
        }}
      >
        <fieldset disabled={busy} class="space-y-3">
          <legend class="mb-2 text-sm font-medium">Classification action</legend
          >
          <label class="flex items-center gap-2 text-sm"
            ><input
              type="radio"
              name="bulk-tax-mode"
              value="account-default"
              bind:group={mode}
            /> Apply each account’s current default</label
          >
          <label class="flex items-center gap-2 text-sm"
            ><input
              type="radio"
              name="bulk-tax-mode"
              value="treatment"
              bind:group={mode}
            /> Set one treatment for the selected lines</label
          >
          {#if mode === "treatment"}
            <TaxValuesFields
              id="bulk-tax"
              bind:treatment
              bind:percentage
              disabled={busy}
              popoverClass="z-[70]"
            />
            {#if treatment === "requires_review"}<p
                class="text-sm text-amber-700 dark:text-amber-400"
              >
                Choose a resolved treatment to complete this review.
              </p>{/if}
          {:else}<p class="text-muted-foreground text-sm">
              Accounts without a resolved default will be listed as excluded.
              This action does not change account defaults.
            </p>{/if}
          <label class="block text-sm font-medium" for="bulk-tax-reason"
            >Reason for classification *</label
          >
          <Textarea
            id="bulk-tax-reason"
            bind:value={reason}
            maxlength={500}
            required
            placeholder="Why this treatment applies to the selected receipts"
          />
        </fieldset>
        <Button type="submit" variant="outline" disabled={busy || !request}
          >{busy ? "Working…" : "Preview changes"}</Button
        >
        {#if excludedIds.length > 0}<Button
            variant="ghost"
            disabled={busy}
            onclick={() => {
              excludedIds = [];
            }}>Restore {excludedIds.length} excluded selections</Button
          >{/if}
      </form>
      {#if error}<p
          role="alert"
          class="mt-4 text-sm text-red-700 dark:text-red-400"
        >
          {error}
        </p>{/if}
      {#if preview}
        <section
          class="mt-6 space-y-4"
          aria-label="Bulk classification preview"
        >
          {#if !previewCurrent}<p
              role="status"
              class="text-sm text-amber-700 dark:text-amber-400"
            >
              This preview is no longer current. Preview again before applying.
            </p>{/if}
          <p class="text-sm font-medium">
            {preview.eligibleLineCount} lines across {preview.recordCount} records
            will change; {preview.skippedLineCount} lines excluded.
          </p>
          <dl class="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
            <div>
              <dt class="text-muted-foreground">Selected expenses</dt>
              <dd>{formatMinor(preview.expenseMinor)}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Selected refunds</dt>
              <dd>{formatMinor(preview.refundMinor)}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Potential deduction added</dt>
              <dd>{formatMinor(preview.deductibleMinor)}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Potential add-back added</dt>
              <dd>{formatMinor(preview.addBackMinor)}</dd>
            </div>
          </dl>
          <p class="text-sm">
            Unresolved lines in this account/date range: {preview.unresolvedBefore}
            → {preview.unresolvedAfter}. Month closing remains blocked until
            every eligible unresolved line in its period is classified.
          </p>
          <ul class="divide-y rounded-md border px-3">
            {#each preview.lines as line (line.movementId)}
              <li class="space-y-1 py-3 text-sm">
                <p class="font-medium">
                  {line.date} · {line.recordNumber ??
                    `Record #${line.recordId}`} · {line.accountName} · {formatMinor(
                    line.amountMinor,
                  )}
                </p>
                <p>{line.description}</p>
                <p class="text-muted-foreground">
                  {classification(line.before)}{line.before
                    ? ` · ${line.before.source === "override" ? "Override" : line.before.source === "account_default" ? "Saved account default" : "Unreviewed"}`
                    : ""}
                </p>
                {#if line.before?.reason}<p class="text-muted-foreground">
                    Saved reason: {line.before.reason}
                  </p>{/if}
                {#if line.blockedReason}<p
                    class="text-amber-700 dark:text-amber-400"
                  >
                    Excluded: {line.blockedReason}
                  </p>
                {:else}<p>
                    → {classification(line.after)} · {line.after?.source ===
                    "account_default"
                      ? "Current account default"
                      : "Bulk override"}
                  </p>
                  <p class="text-muted-foreground">
                    Deduction {formatMinor(line.deductibleMinor!)} · add-back {formatMinor(
                      line.addBackMinor!,
                    )}
                  </p>
                {/if}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || excludedIds.includes(line.movementId)}
                  onclick={() => {
                    excludedIds = [...excludedIds, line.movementId];
                  }}>Exclude from this batch</Button
                >
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <div class="mt-6 flex justify-end gap-2 border-t pt-4">
        <Button variant="outline" disabled={busy} onclick={onclose}
          >Cancel</Button
        >
        <Button
          disabled={busy || !previewCurrent || !preview?.eligibleLineCount}
          onclick={() => void apply()}
          >Apply {preview?.eligibleLineCount ?? 0} classifications</Button
        >
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
