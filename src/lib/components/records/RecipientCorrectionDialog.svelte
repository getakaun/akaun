<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { formatMinor } from '$lib/format.js';
	let {
		recordId,
		contacts,
		onclose,
		oncorrected
	}: {
		recordId: number;
		contacts: { id: number; legalName: string }[];
		onclose: () => void;
		oncorrected: () => void;
	} = $props();
	let preview = $state<{
		version: string;
		record: { contactId: number | null; contactName: string | null; amountMinor: number };
		dependencies: { settlementId: number; recordId: number; reason: string }[];
	} | null>(null);
	let recipient = $state('');
	let reason = $state('');
	let error = $state('');
	let sending = $state(false);
	let reviewing = $state(false);
	let stale = $state(false);
	onMount(() => {
		let alive = true;
		void fetch(`/api/payments/${recordId}/recipient`)
			.then(async (res) => {
				const body = await res.json();
				if (!res.ok) throw new Error(body.error ?? 'The payee could not be loaded.');
				if (alive) {
					preview = body;
					recipient = body.record.contactId ? String(body.record.contactId) : '';
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
		if (!preview || sending || stale) return;
		sending = true;
		try {
			const res = await fetch(`/api/payments/${recordId}/recipient`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contactId: Number(recipient),
					reason,
					expectedVersion: preview.version
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'The payee correction could not be saved.';
				stale = body.code === 'CONFLICT';
				return;
			}
			oncorrected();
			onclose();
		} catch {
			error = 'The payee correction result could not be confirmed. Reload before trying again.';
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
			<Dialog.Title class="text-base font-semibold">Correct payee</Dialog.Title>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm"
				>Correct who received this payment. The bank transaction, payment amount and original
				expense suppliers stay recorded.</Dialog.Description
			>
			{#if preview}
				<p class="mt-4 text-sm">
					Current payee: {preview.record.contactName ?? 'Unassigned'} · {formatMinor(
						preview.record.amountMinor
					)}
				</p>
				{#if preview.dependencies.length}
					<p class="mt-4 text-sm">Reverse these dependent allocations first:</p>
					{#each preview.dependencies as d (d.settlementId)}<p class="mt-2 text-sm">
							Settlement #{d.settlementId}, record #{d.recordId}: {d.reason}
						</p>{/each}
				{:else}
					<label class="mt-4 block text-sm" for="correct-recipient">Payee</label>
					<Select.Root type="single" bind:value={recipient} disabled={reviewing || sending}>
						<Select.Trigger id="correct-recipient" class="mt-2 w-full"
							>{contacts.find((c) => String(c.id) === recipient)?.legalName ??
								'Select payee'}</Select.Trigger
						>
						<Select.Content
							>{#each contacts as contact (contact.id)}<Select.Item
									value={String(contact.id)}
									label={contact.legalName}
								/>{/each}</Select.Content
						>
					</Select.Root>
					<label class="mt-4 block text-sm" for="recipient-reason">Reason</label>
					<Textarea
						id="recipient-reason"
						bind:value={reason}
						minlength={10}
						maxlength={2000}
						disabled={reviewing || sending}
						class="mt-2"
					/>
					{#if reviewing}<p class="mt-4 text-sm">
							Change {preview.record.contactName ?? 'Unassigned'} to {contacts.find(
								(c) => String(c.id) === recipient
							)?.legalName}. Available payment credit will belong to this payee; expense suppliers,
							cash and bank matches stay the same.
						</p>{/if}
				{/if}
			{:else if !error}<p class="mt-4" role="status">Loading payee…</p>{/if}
			{#if error}<p class="mt-4 text-sm text-red-600" role="alert">{error}</p>{/if}
			<div class="mt-5 flex justify-end gap-2">
				{#if reviewing}<Button
						variant="outline"
						disabled={sending}
						onclick={() => (reviewing = false)}>Back</Button
					>{/if}
				<Button variant="outline" disabled={sending} onclick={onclose}>Cancel</Button>
				{#if preview && !preview.dependencies.length}
					{#if reviewing}<Button disabled={sending || stale} onclick={confirm}
							>{sending ? 'Saving…' : 'Confirm correction'}</Button
						>
					{:else}<Button
							disabled={!recipient || reason.trim().length < 10 || stale}
							onclick={() => (reviewing = true)}>Review correction</Button
						>{/if}
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
