<script lang="ts">
  import { Dialog } from "bits-ui";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { formatMinor } from "$lib/format.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import type { AccountTaxPreview } from "$lib/account-tax-classification.js";
  let {
    accountId,
    onclose,
    onapplied,
  }: {
    accountId: number;
    onclose: () => void;
    onapplied: (result: {
      updatedLineCount: number;
      remainingCount: number;
    }) => void;
  } = $props();
  let reason = $state("");
  let busy = $state(false);
  let error = $state("");
  let stale = $state(false);
  let preview = $state<AccountTaxPreview | null>(null);
  let reviewedReason = $state("");
  const current = $derived(
    preview !== null && !stale && reason.trim() === reviewedReason,
  );
  async function review() {
    if (busy || !reason.trim()) return;
    busy = true;
    error = "";
    stale = true;
    const submittedReason = reason.trim();
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/tax-classification/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: submittedReason }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        error = body.error ?? "The confirmation could not be prepared.";
        return;
      }
      preview = body;
      reviewedReason = submittedReason;
      stale = false;
    } catch {
      error =
        "The confirmation could not be loaded. Check your connection and try again.";
    } finally {
      busy = false;
    }
  }
  async function apply() {
    if (!current || !preview || !preview.selectedCount || busy) return;
    busy = true;
    error = "";
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/tax-classification/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: reviewedReason,
            revision: preview.revision,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        stale = true;
        error =
          body.error ??
          "The entries could not be classified. Refresh the confirmation.";
        return;
      }
      onapplied(body);
    } catch {
      stale = true;
      error =
        "The result could not be confirmed. Refresh the account before trying again; the batch may already have completed.";
    } finally {
      busy = false;
    }
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
      class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(94vw,540px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-xl outline-none"
    >
      <Dialog.Title class="text-base font-semibold"
        >Apply account default</Dialog.Title
      >
      <Dialog.Description class="text-muted-foreground mt-2 text-sm"
        >Classify existing unclassified entries using this account’s saved tax
        default. Individual decisions and closed history stay protected.</Dialog.Description
      >
      <form
        class="mt-4 space-y-3"
        onsubmit={(event) => {
          event.preventDefault();
          void review();
        }}
      >
        <label class="block text-sm font-medium" for="account-tax-reason"
          >Reason *</label
        >
        <Textarea
          id="account-tax-reason"
          bind:value={reason}
          disabled={busy}
          required
          maxlength={500}
          placeholder="Why the account default applies to these entries"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !reason.trim()}>Review entries</Button
        >
      </form>
      {#if error}<p
          role="alert"
          class="mt-3 text-sm text-red-700 dark:text-red-400"
        >
          {error}
        </p>{/if}
      {#if preview}
        <section
          class="mt-4 space-y-3 rounded-md border p-3 text-sm"
          aria-label="Account default confirmation"
        >
          {#if !current}<p
              role="status"
              class="text-amber-700 dark:text-amber-400"
            >
              Refresh this confirmation before applying.
            </p>{/if}
          <p class="font-medium">
            {preview.accountName} · {TaxTreatmentLabels[
              preview.treatment.treatment
            ]} · {((preview.treatment.percentageBps ?? 0) / 100).toFixed(2)}%
          </p>
          <p>
            {preview.selectedCount} entries across {preview.recordCount} records will
            change{preview.dateFrom
              ? ` (${preview.dateFrom} to ${preview.dateTo})`
              : ""}.
          </p>
          {#if preview.remainingCount > 0}<p>
              This batch handles the next {preview.selectedCount} entries. {preview.remainingCount}
              eligible entries will remain for a subsequent confirmation.
            </p>{/if}
          <dl class="grid grid-cols-2 gap-2">
            <div>
              <dt class="text-muted-foreground">Expenses</dt>
              <dd>{formatMinor(preview.expenseMinor)}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Refunds</dt>
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
          <p class="text-muted-foreground">
            Protected: {preview.protected.resolved} already classified; {preview
              .protected.individual} individual decisions; {preview.protected
              .closed} closed-period entries; {preview.protected.voided} voided; {preview
              .protected.readOnly} read-only; {preview.protected.ambiguous} with unclear
            history.
          </p>
          <p class="text-muted-foreground">
            Financial postings and account defaults stay unchanged. Saved
            classifications are estimates. Unclassified and Requires review
            entries continue to block month closing.
          </p>
        </section>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onclick={onclose}
          >Cancel</Button
        >
        <Button
          disabled={busy || !current || !preview?.selectedCount}
          onclick={() => void apply()}
          >Apply to {preview?.selectedCount ?? 0} entries</Button
        >
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
