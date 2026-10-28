<script lang="ts">
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { formatMinor } from "$lib/format.js";
  let {
    recordId,
    expense = false,
    contacts,
    onclose,
    oncorrected,
  }: {
    recordId: number;
    expense?: boolean;
    contacts: { id: number; legalName: string }[];
    onclose: () => void;
    oncorrected: () => void;
  } = $props();
  let preview = $state<{
    version: string;
    record: {
      contactId: number | null;
      contactName: string | null;
      amountMinor: number;
      outstandingMinor?: number;
    };
    fields?: {
      field: "supplier" | "paidBy";
      label: string;
      contactId: number | null;
      blockedReason: string | null;
    }[];
    personal?: boolean;
    dependencies?: { settlementId: number; recordId: number; reason: string }[];
  } | null>(null);
  let recipient = $state("");
  let field = $state<"supplier" | "paidBy">("supplier");
  const endpoint = $derived(
    expense
      ? `/api/records/${recordId}/contact-correction`
      : `/api/payments/${recordId}/recipient`,
  );
  const selectedField = $derived(
    preview?.fields?.find((f) => f.field === field),
  );
  const label = $derived(
    expense ? (selectedField?.label ?? "Supplier") : "Payee",
  );
  const currentId = $derived(
    expense ? selectedField?.contactId : preview?.record.contactId,
  );
  const currentName = $derived(
    contacts.find((c) => c.id === currentId)?.legalName ?? "Unassigned",
  );
  const blockedReason = $derived(selectedField?.blockedReason ?? null);
  function chooseField(value: "supplier" | "paidBy") {
    field = value;
    const id = preview?.fields?.find((f) => f.field === value)?.contactId;
    recipient = id ? String(id) : "";
    reviewing = false;
    error = "";
  }
  let reason = $state("");
  let error = $state("");
  let sending = $state(false);
  let reviewing = $state(false);
  let stale = $state(false);
  onMount(() => {
    let alive = true;
    void fetch(endpoint)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok)
          throw new Error(body.error ?? "The contact could not be loaded.");
        if (alive) {
          preview = body;
          const id = expense ? body.fields[0].contactId : body.record.contactId;
          recipient = id ? String(id) : "";
        }
      })
      .catch((e) => {
        if (alive) error = e.message;
      });
    return () => {
      alive = false;
    };
  });
  async function confirm() {
    if (
      !preview ||
      sending ||
      stale ||
      blockedReason ||
      Number(recipient) === currentId
    )
      return;
    sending = true;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(expense ? { field } : {}),
          contactId: Number(recipient),
          reason,
          expectedVersion: preview.version,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        error = body.error ?? "The contact correction could not be saved.";
        stale = body.code === "CONFLICT";
        return;
      }
      oncorrected();
      onclose();
    } catch {
      error =
        "The contact correction result could not be confirmed. Reload before trying again.";
      stale = true;
    } finally {
      sending = false;
    }
  }
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open && !sending) onclose();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[60] bg-black/35" />
    <Dialog.Content
      class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg p-5 outline-none"
      style="box-shadow: 0 0 32px 6px var(--red-soft), 0 20px 50px rgb(0 0 0 / 0.2);"
    >
      <Dialog.Title class="text-base font-semibold"
        >Correct contact</Dialog.Title
      >
      <Dialog.Description class="text-muted-foreground mt-2 text-sm"
        >{#if expense}Correct the supplier or person who paid for this expense.
          Payments, amounts, dates and bank matches stay recorded.
        {:else}Correct who received this payment. The bank transaction, payment
          amount and original expense suppliers stay recorded.{/if}</Dialog.Description
      >
      {#if preview}
        <p class="mt-4 text-sm">
          Current {label.toLowerCase()}: {currentName} · {formatMinor(
            preview.record.amountMinor,
          )}
        </p>
        {#if expense && preview.fields && preview.fields.length > 1}
          <label class="mt-4 block text-sm" for="contact-correction-field"
            >Contact to correct</label
          >
          <select
            id="contact-correction-field"
            class="border-input bg-background mt-2 w-full rounded-md border p-2 text-sm"
            value={field}
            disabled={reviewing || sending}
            onchange={(e) =>
              chooseField(e.currentTarget.value as "supplier" | "paidBy")}
          >
            {#each preview.fields as option (option.field)}<option
                value={option.field}>{option.label}</option
              >{/each}
          </select>
        {/if}
        {#if expense && preview.record.outstandingMinor !== undefined}
          <p class="mt-2 text-sm">
            Paid: {formatMinor(
              preview.record.amountMinor - preview.record.outstandingMinor,
            )} · Outstanding: {formatMinor(preview.record.outstandingMinor)}
          </p>
        {/if}
        {#if blockedReason}<p class="mt-4 text-sm" role="status">
            {blockedReason}
          </p>
        {:else if preview.dependencies?.length}
          <p class="mt-4 text-sm">Reverse these dependent allocations first:</p>
          {#each preview.dependencies as d (d.settlementId)}<p
              class="mt-2 text-sm"
            >
              Settlement #{d.settlementId}, record #{d.recordId}: {d.reason}
            </p>{/each}
        {:else}
          <label class="mt-4 block text-sm" for="correct-recipient"
            >{label}</label
          >
          <Select.Root
            type="single"
            bind:value={recipient}
            disabled={reviewing || sending}
          >
            <Select.Trigger id="correct-recipient" class="mt-2 w-full"
              >{contacts.find((c) => String(c.id) === recipient)?.legalName ??
                `Select ${label.toLowerCase()}`}</Select.Trigger
            >
            <Select.Content
              >{#each contacts as contact (contact.id)}<Select.Item
                  value={String(contact.id)}
                  label={contact.legalName}
                />{/each}</Select.Content
            >
          </Select.Root>
          <label class="mt-4 block text-sm" for="recipient-reason">Reason</label
          >
          <Textarea
            id="recipient-reason"
            bind:value={reason}
            minlength={10}
            maxlength={2000}
            disabled={reviewing || sending}
            class="mt-2"
          />
          {#if reviewing}<p class="mt-4 text-sm">
              Change {currentName} to {contacts.find(
                (c) => String(c.id) === recipient,
              )?.legalName}.
              {#if expense}
                {#if preview.personal && field === "supplier"}The person who
                  paid and their reimbursement balance stay the same.
                {:else}Any outstanding amount of {formatMinor(
                    preview.record.outstandingMinor ?? 0,
                  )} will belong to the corrected contact. Existing payment recipients
                  stay recorded.{/if}
                Payments, cash and bank matches stay the same.
              {:else}Available payment credit will belong to this payee; expense
                suppliers, cash and bank matches stay the same.{/if}
            </p>{/if}
        {/if}
      {:else if !error}<p class="mt-4" role="status">Loading contact…</p>{/if}
      {#if error}<p class="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>{/if}
      <div class="mt-5 flex justify-end gap-2">
        {#if reviewing}<Button
            variant="outline"
            disabled={sending}
            onclick={() => (reviewing = false)}>Back</Button
          >{/if}
        <Button variant="outline" disabled={sending} onclick={onclose}
          >Cancel</Button
        >
        {#if preview && !preview.dependencies?.length && !blockedReason}
          {#if reviewing}<Button disabled={sending || stale} onclick={confirm}
              >{sending ? "Saving…" : "Confirm correction"}</Button
            >
          {:else}<Button
              disabled={!recipient ||
                Number(recipient) === currentId ||
                reason.trim().length < 10 ||
                stale}
              onclick={() => (reviewing = true)}>Review correction</Button
            >{/if}
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
