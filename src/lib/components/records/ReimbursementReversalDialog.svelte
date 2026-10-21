<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	let {
		groupId,
		onclose,
		onreversed
	}: { groupId: number; onclose: () => void; onreversed: () => void } = $props();
	let version = $state('');
	let reason = $state('');
	let date = $state(new Date().toISOString().slice(0, 10));
	let error = $state('');
	let sending = $state(false);
	let reviewing = $state(false);
	let stale = $state(false);
	onMount(() => {
		let alive = true;
		void fetch(`/api/reimbursements/${groupId}/reversal`)
			.then(async (res) => {
				const body = await res.json();
				if (!res.ok) throw new Error(body.error);
				if (alive) version = body.version;
			})
			.catch((e) => {
				if (alive) error = e.message;
			});
		return () => {
			alive = false;
		};
	});
	async function confirm() {
		if (!version || sending || stale) return;
		sending = true;
		try {
			const res = await fetch(`/api/reimbursements/${groupId}/reversal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ date, reason, expectedVersion: version })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error;
				stale = body.code === 'CONFLICT';
				return;
			}
			onreversed();
			onclose();
		} catch {
			error = 'The result could not be confirmed. Reload before trying again.';
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
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-lg"
		>
			<Dialog.Title class="text-base font-semibold">Reverse reimbursement #{groupId}</Dialog.Title>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm"
				>Reopen the original supplier expenses and reverse this reimbursement's transfers. Cash
				payments and bank matches stay recorded; the released amount becomes available credit.</Dialog.Description
			>
			{#if reviewing}
				<p class="mt-4 text-sm">
					Post the reversal on {date}. You can then create a corrected reimbursement using the
					available credit. Reason: {reason}
				</p>
			{:else}
				<span id="reimbursement-reversal-date" class="mt-4 block text-sm">Reversal date</span>
				<DatePicker name="date" bind:value={date} labelledBy="reimbursement-reversal-date" />
				<label for="reimbursement-reversal-reason" class="mt-4 block text-sm">Reason</label>
				<Textarea
					id="reimbursement-reversal-reason"
					bind:value={reason}
					minlength={10}
					maxlength={2000}
					class="mt-2"
				/>
			{/if}
			{#if error}<p class="mt-4 text-sm text-red-600" role="alert">{error}</p>{/if}
			<div class="mt-5 flex justify-end gap-2">
				{#if reviewing}<Button
						variant="outline"
						disabled={sending}
						onclick={() => (reviewing = false)}>Back</Button
					>{/if}
				<Button variant="outline" disabled={sending} onclick={onclose}>Cancel</Button>
				{#if reviewing}<Button variant="destructive" disabled={sending || stale} onclick={confirm}
						>{sending ? 'Reversing…' : 'Confirm reversal'}</Button
					>
				{:else}<Button
						disabled={!version || !date || reason.trim().length < 10}
						onclick={() => (reviewing = true)}>Review reversal</Button
					>{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
