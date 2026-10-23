<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { formatMinor } from '$lib/format.js';
	import {
		correctionAmountMinor,
		correctionPreview
	} from '$lib/reimbursement-amount-correction.js';
	import type { ReimbursementAmountCorrectionSnapshot } from '$lib/server/application/reimbursement-amount-correction.js';

	let {
		recordId,
		onclose,
		oncorrected
	}: {
		recordId: number;
		onclose: () => void;
		oncorrected: () => void;
	} = $props();
	let snapshot = $state<ReimbursementAmountCorrectionSnapshot | null>(null);
	let amount = $state('');
	let picked = $state<Record<number, string>>({});
	let reason = $state('');
	let error = $state('');
	let loading = $state(true);
	let sending = $state(false);
	let reviewing = $state(false);
	let stale = $state(false);
	let alive = true;
	const amountMinor = $derived(correctionAmountMinor(amount));
	const preview = $derived(
		correctionPreview(amountMinor, snapshot?.expenses ?? [], picked)
	);
	const valid = $derived(
		!!snapshot &&
			preview.valid &&
			amountMinor !== snapshot.record.amountMinor &&
			reason.trim().length >= 10 &&
			reason.trim().length <= 2000
	);

	onMount(() => {
		void (async () => {
			try {
				const res = await fetch(
					`/api/records/${recordId}/reimbursement-amount-correction`,
					{ cache: 'no-store' }
				);
				const body = await res.json();
				if (!alive) return;
				if (!res.ok)
					throw new Error(
						body.error ?? 'This reimbursement cannot be corrected.'
					);
				snapshot = body;
				amount = (body.record.amountMinor / 100).toFixed(2);
				picked = Object.fromEntries(
					body.expenses.map(
						(e: ReimbursementAmountCorrectionSnapshot['expenses'][number]) => [
							e.owedMovementId,
							(e.allocatedMinor / 100).toFixed(2)
						]
					)
				);
			} catch (e) {
				if (alive)
					error =
						e instanceof Error
							? e.message
							: 'The reimbursement could not be loaded.';
			} finally {
				if (alive) loading = false;
			}
		})();
		return () => {
			alive = false;
		};
	});

	async function confirm() {
		if (!snapshot || !valid || sending || stale) return;
		sending = true;
		error = '';
		try {
			const res = await fetch(
				`/api/records/${recordId}/reimbursement-amount-correction`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						amountMinor,
						allocations: preview.allocations,
						reason: reason.trim(),
						expectedVersion: snapshot.version
					})
				}
			);
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'The correction could not be saved.';
				stale = res.status === 409;
				return;
			}
			oncorrected();
			onclose();
		} catch {
			error =
				'The result could not be confirmed. Reload the record before trying again.';
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
				>Correct reimbursement amount</Dialog.Title
			>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm"
				>Correct the amount actually paid. Expense costs stay the same;
				remaining balances can be reimbursed later. This changes historical bank
				and payable balances.</Dialog.Description
			>
			{#if loading}<p role="status" class="mt-4">Loading reimbursement…</p>
			{:else if snapshot}
				<p class="mt-4 text-sm">
					{snapshot.record.recordNumber} · {snapshot.record.contactName} · Currently
					{formatMinor(snapshot.record.amountMinor)}
				</p>
				{#if !reviewing}
					<label for="correct-reimbursement-amount" class="mt-4 block text-sm"
						>Actual amount paid</label
					>
					<Input
						id="correct-reimbursement-amount"
						class="mt-1"
						inputmode="decimal"
						bind:value={amount}
						disabled={sending || stale}
					/>
					{#if snapshot.expenses.length > 1}
						<p class="mt-4 text-sm">
							Choose how much this payment reimbursed for each expense. Any
							excess remains available credit.
						</p>
						{#each snapshot.expenses as expense (expense.owedMovementId)}
							<label
								for={`correct-expense-${expense.owedMovementId}`}
								class="mt-3 block text-sm"
								>{expense.recordNumber} · {expense.description} · Available {formatMinor(
									expense.availableMinor
								)}</label
							>
							<Input
								id={`correct-expense-${expense.owedMovementId}`}
								class="mt-1"
								inputmode="decimal"
								bind:value={picked[expense.owedMovementId]}
								disabled={sending || stale}
							/>
						{/each}
					{/if}
					<label for="reimbursement-amount-reason" class="mt-4 block text-sm"
						>Reason</label
					>
					<Textarea
						id="reimbursement-amount-reason"
						class="mt-1"
						rows={3}
						minlength={10}
						maxlength={2000}
						bind:value={reason}
						disabled={sending || stale}
					/>
					<p class="text-muted-foreground mt-1 text-xs">
						Enter 10–2000 characters. Previous amounts and your reason stay in
						History.
					</p>
					{#if !preview.valid}<p class="mt-3 text-sm">
							Enter valid amounts with up to two decimal places. Expense
							allocations must fit their available balances and the actual
							payment.
						</p>{/if}
				{:else}
					<p class="mt-4 text-sm">
						Payment: {formatMinor(snapshot.record.amountMinor)} → {formatMinor(
							amountMinor ?? 0
						)}
					</p>
					<p class="mt-2 whitespace-pre-wrap text-sm">
						Reason: {reason.trim()}
					</p>
				{/if}
				{#if preview.valid}
					{#each snapshot.expenses as expense, index (expense.owedMovementId)}
						<p class="mt-3 text-sm">
							{expense.recordNumber} · {expense.description}<br />This payment: {formatMinor(
								expense.allocatedMinor
							)} → {formatMinor(preview.allocations[index].amountMinor)}<br
							/>Total reimbursed: {formatMinor(
								expense.otherPaidMinor + preview.allocations[index].amountMinor
							)} · Remaining: {formatMinor(
								expense.availableMinor - preview.allocations[index].amountMinor
							)}
						</p>
					{/each}
					<p class="mt-3 text-sm">
						Available credit: {formatMinor(snapshot.availableCreditMinor)} → {formatMinor(
							preview.creditMinor
						)}
					</p>
				{/if}
			{/if}
			{#if error}<p role="alert" class="mt-3 text-sm text-[var(--red)]">
					{error}
				</p>{/if}
			{#if stale}<p class="mt-2 text-sm">
					Close this dialog and reload the record before reviewing another
					correction.
				</p>{/if}
			<div class="mt-5 flex justify-end gap-2">
				<Button variant="outline" disabled={sending} onclick={onclose}
					>Close</Button
				>
				{#if reviewing}
					<Button
						variant="outline"
						disabled={sending || stale}
						onclick={() => {
							reviewing = false;
							error = '';
						}}>Back</Button
					>
					<Button disabled={!valid || sending || stale} onclick={confirm}
						>{sending ? 'Saving…' : 'Confirm correction'}</Button
					>
				{:else}<Button
						disabled={loading || !valid || sending || stale}
						onclick={() => {
							reviewing = true;
							error = '';
						}}>Review correction</Button
					>{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
