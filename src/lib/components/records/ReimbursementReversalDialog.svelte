<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import { formatMinor, formatDateShort } from '$lib/format.js';
	import type { ReimbursementReversalSummary } from '$lib/server/application/reimbursement-reversal.js';
	let {
		groupId,
		onclose,
		onreversed
	}: { groupId: number; onclose: () => void; onreversed: () => void } = $props();
	let version = $state('');
	let summary = $state<ReimbursementReversalSummary | null>(null);
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
				if (alive) {
					version = body.version;
					summary = body.summary;
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
			<Dialog.Title class="text-base font-semibold"
				>Reverse entire reimbursement #{groupId}</Dialog.Title
			>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm"
				>This removes all the expenses below from this reimbursement. The original bank payments and
				bank matches stay recorded. Released funding becomes available credit for this person.</Dialog.Description
			>
			{#if summary}
				<div class="mt-4 space-y-4 text-sm">
					<div class="flex justify-between gap-3 font-medium">
						<span>Reimbursement being reversed</span><span>{formatMinor(summary.amountMinor)}</span>
					</div>
					<div>
						<p class="font-medium">
							All affected expenses ({summary.items.length})
						</p>
						<ul class="mt-2 divide-y rounded-md border px-3">
							{#each summary.items as item (item.recordId)}
								<li class="flex justify-between gap-3 py-2">
									<span>#{item.recordId} · {item.description}</span><span
										class="shrink-0 tabular-nums">{formatMinor(item.amountMinor)}</span
									>
								</li>
							{/each}
						</ul>
						<p class="text-muted-foreground mt-2">
							These expenses will no longer be covered by this reimbursement. Any other payments
							applied to them remain in place.
						</p>
					</div>
					{#each summary.funding as payment (payment.recordId)}
						<div class="rounded-md border p-3">
							<p class="font-medium">
								#{payment.recordId} · {payment.description}
							</p>
							<dl class="mt-2 space-y-1">
								<div class="flex justify-between gap-3">
									<dt>Original funding amount</dt>
									<dd>{formatMinor(payment.amountMinor)}</dd>
								</div>
								<div class="flex justify-between gap-3">
									<dt>Available credit before</dt>
									<dd>{formatMinor(payment.availableCreditBeforeMinor)}</dd>
								</div>
								<div class="flex justify-between gap-3">
									<dt>Released by this reversal</dt>
									<dd>{formatMinor(payment.releasedMinor)}</dd>
								</div>
								<div class="flex justify-between gap-3 font-medium">
									<dt>Available credit after</dt>
									<dd>{formatMinor(payment.availableCreditAfterMinor)}</dd>
								</div>
							</dl>
						</div>
					{/each}
					{#if summary.unfundedMinor > 0}
						<p class="text-muted-foreground">
							{formatMinor(summary.unfundedMinor)} of this claim is unpaid. Reversing that amount creates
							no available credit.
						</p>
					{/if}
				</div>
			{:else if !error}
				<p class="text-muted-foreground mt-4 text-sm">
					Loading affected expenses and available credit…
				</p>
			{/if}
			{#if reviewing}
				<div class="mt-4 space-y-2 text-sm">
					<p>Reversal date: {formatDateShort(date)}</p>
					<p class="whitespace-pre-wrap">Reason: {reason}</p>
					<p class="text-muted-foreground">
						No replacement reimbursement is created automatically. You can create a new
						reimbursement for the appropriate expenses using the available credit.
					</p>
				</div>
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
			{#if error}<p class="mt-4 text-sm text-red-600" role="alert">
					{error}
				</p>{/if}
			<div class="mt-5 flex justify-end gap-2">
				{#if reviewing}<Button
						variant="outline"
						disabled={sending}
						onclick={() => (reviewing = false)}>Back</Button
					>{/if}
				<Button variant="outline" disabled={sending} onclick={onclose}>Cancel</Button>
				{#if reviewing}<Button variant="destructive" disabled={sending || stale} onclick={confirm}
						>{sending ? 'Reversing…' : 'Reverse entire reimbursement'}</Button
					>
				{:else}<Button
						disabled={!version ||
							!summary ||
							!date ||
							reason.trim().length < 10 ||
							reason.length > 2000 ||
							stale}
						onclick={() => (reviewing = true)}>Review reversal</Button
					>{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
