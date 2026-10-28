<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatMinor } from '$lib/format.js';
	import type { paymentAllocationSnapshot } from '$lib/server/application/payment-corrections.js';
	import type { OutstandingItem } from '$lib/server/ledger/types.js';
	let {
		settlementId,
		canReplace = true,
		onclose,
		oncorrected
	}: { settlementId: number; canReplace?: boolean; onclose: () => void; oncorrected: () => void } = $props();
	let snapshot = $state<NonNullable<ReturnType<typeof paymentAllocationSnapshot>> | null>(null);
	let selected = $state<number[]>([]);
	let picked = $state<Record<number, string>>({});
	let candidates = $state<OutstandingItem[]>([]);
	let reason = $state('');
	let error = $state('');
	let loading = $state(true);
	let sending = $state(false);
	let reviewing = $state(false);
	let stale = $state(false);
	let alive = true;
	const removedMinor = $derived(
		snapshot?.allocations
			.filter((a) => selected.includes(a.id))
			.reduce((n, a) => n + a.amountMinor, 0) ?? 0
	);
	const replacementCandidates = $derived.by(() => {
		const rows = new SvelteMap<
			number,
			{ movementId: number; description: string; outstandingMinor: number }
		>(candidates.map((i) => [i.movementId, { ...i }]));
		for (const allocation of snapshot?.allocations ?? []) {
			if (!selected.includes(allocation.id)) continue;
			const link = snapshot?.links.find((l) => l.settlementId === allocation.id);
			if (
				!link ||
				(!snapshot?.reimbursement &&
					snapshot?.payment.contactId !== null &&
					link.otherContactId !== snapshot?.payment.contactId)
			)
				continue;
			const existing = rows.get(allocation.owedMovementId);
			rows.set(allocation.owedMovementId, {
				movementId: allocation.owedMovementId,
				description: link.otherDescription || link.otherRecordNumber || 'Record',
				outstandingMinor: (existing?.outstandingMinor ?? 0) + allocation.amountMinor
			});
		}
		return [...rows.values()];
	});
	const invalidReplacement = $derived(
		Object.entries(picked).some(([id, raw]) => {
			const candidate = replacementCandidates.find((i) => i.movementId === Number(id));
			const amount = Number(raw);
			return (
				!candidate ||
				!Number.isFinite(amount) ||
				amount <= 0 ||
				Math.round(amount * 100) > candidate.outstandingMinor
			);
		})
	);
	const allocations = $derived(
		Object.entries(picked)
			.map(([id, amount]) => ({
				owedMovementId: Number(id),
				amountMinor: Math.round(Number(amount) * 100)
			}))
			.filter((a) => a.amountMinor > 0)
	);
	const replacementMinor = $derived(allocations.reduce((n, a) => n + a.amountMinor, 0));
	const remainingMinor = $derived(
		snapshot
			? Math.abs(snapshot.payment.amountMinor) -
					snapshot.payment.settledMinor +
					removedMinor -
					replacementMinor
			: 0
	);

	onMount(() => {
		void (async () => {
			try {
				const response = await fetch(`/api/settlements/${settlementId}`, {
					cache: 'no-store'
				});
				const body = await response.json();
				if (!response.ok) throw new Error(body.error ?? 'The allocation could not be loaded.');
				if (!alive) return;
				snapshot = body;
				selected = body.batch ? body.allocations.map((a: { id: number }) => a.id) : [settlementId];
				const direction = body.direction;
				const res = await fetch(
					body.reimbursement
						? `/api/reimbursements/candidates?contactId=${body.payment.contactId}`
						: `/api/settlements?direction=${direction}&settlementAccountId=${body.payment.accountId}${body.payment.contactId === null ? '' : `&contactId=${body.payment.contactId}`}`
				);
				if (!res.ok) throw new Error('Replacement items could not be loaded. Reopen this dialog.');
				const open = await res.json();
				if (alive)
					candidates = (open.items ?? []).filter(
						(i: OutstandingItem) =>
							i.signedAmountMinor &&
							Math.sign(i.signedAmountMinor) !== Math.sign(body.payment.amountMinor)
					);
			} catch (e) {
				if (alive) error = e instanceof Error ? e.message : 'Could not load allocations.';
			} finally {
				if (alive) loading = false;
			}
		})();
		return () => {
			alive = false;
		};
	});

	async function confirm() {
		if (!snapshot || sending || stale) return;
		sending = true;
		try {
			const res = await fetch(`/api/payments/${snapshot.payment.movementId}/allocations`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					reason,
					expectedVersion: snapshot.version,
					removeSettlementIds: selected,
					allocations
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'The allocations could not be corrected.';
				stale = body.code === 'CONFLICT';
				return;
			}
			oncorrected();
			onclose();
		} catch {
			error = 'The result could not be confirmed. Reload the record before trying again.';
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
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg p-5 shadow-lg [border:1px_solid_var(--border)] outline-none"
		>
			<Dialog.Title class="text-base font-semibold">Correct payment allocations</Dialog.Title>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm"
				>Review what this payment covers. The actual bank transaction stays recorded.</Dialog.Description
			>
			{#if loading}<p role="status" class="mt-4">Loading allocations…</p>
			{:else if snapshot}
				<p class="mt-4 text-sm">
					{snapshot.record.recordNumber} · {formatMinor(snapshot.record.amountMinor)}
				</p>
				{#if snapshot.batch}<p class="mt-3 text-sm">
						This batch names several contacts. Reversing one allocation reverses all {snapshot
							.allocations.length} allocations.
					</p>{/if}
				{#each snapshot.allocations as allocation (allocation.id)}
					{@const link = snapshot.links.find((l) => l.settlementId === allocation.id)}
					<label
						for={`reopen-allocation-${allocation.id}`}
						class="mt-3 flex items-start gap-2 text-sm"
						><Checkbox
							id={`reopen-allocation-${allocation.id}`}
							class="mt-0.5"
							checked={selected.includes(allocation.id)}
							disabled={reviewing || snapshot.batch || sending}
							onCheckedChange={(checked) => {
								selected = checked
									? [...new Set([...selected, allocation.id])]
									: selected.filter((id) => id !== allocation.id);
							}}
						/>
						Reopen {link?.otherRecordNumber ??
							link?.otherDescription ??
							`allocation ${allocation.id}`} · {formatMinor(allocation.amountMinor)}
					</label>
				{/each}
				{#if !reviewing}
					{#if canReplace && replacementCandidates.length > 0}
						<p class="mt-4 text-sm font-medium">Replacement allocations (optional)</p>
						{#each replacementCandidates as item (item.movementId)}
							<div class="mt-2 flex items-center gap-3 text-sm">
								<label
									for={`replacement-allocation-${item.movementId}`}
									class="flex min-w-0 flex-1 items-start gap-2 break-words"
								>
									<Checkbox
										id={`replacement-allocation-${item.movementId}`}
										class="mt-0.5"
										checked={item.movementId in picked}
										onCheckedChange={(checked) => {
											if (!checked) delete picked[item.movementId];
											else picked[item.movementId] = (item.outstandingMinor / 100).toFixed(2);
										}}
									/>
									{item.description} · {formatMinor(item.outstandingMinor)}
								</label>
								{#if item.movementId in picked}
									<Input
										class="w-24 shrink-0 text-right tabular-nums"
										type="number"
										inputmode="decimal"
										name={`replacementAmount-${item.movementId}`}
										min="0.01"
										max={item.outstandingMinor / 100}
										step="0.01"
										aria-label={`Replacement amount for ${item.description}`}
										bind:value={picked[item.movementId]}
									/>
								{/if}
							</div>
						{/each}
					{/if}
					<label class="mt-4 block text-sm" for="allocation-reason">Reason</label>
					<Textarea
						id="allocation-reason"
						name="reason"
						class="mt-1"
						aria-describedby="allocation-reason-help"
						minlength={10}
						maxlength={2000}
						bind:value={reason}
						rows={3}
					/>
					<p id="allocation-reason-help" class="text-muted-foreground mt-1 text-xs">
						Enter 10–2000 characters. The reason and allocation changes will be saved in the record
						history.
					</p>
				{:else}
					<p class="mt-4 whitespace-pre-wrap text-sm">Reason: {reason}</p>
					{#each allocations as replacement (replacement.owedMovementId)}<p class="mt-2 text-sm">
							Apply {formatMinor(replacement.amountMinor)} to {replacementCandidates.find(
								(i) => i.movementId === replacement.owedMovementId
							)?.description}
						</p>{/each}
				{/if}
				<p class="mt-4 text-sm">
					Reopened: {formatMinor(removedMinor)} · Reallocated: {formatMinor(replacementMinor)} · Unallocated
					afterward: {formatMinor(remainingMinor)}
				</p>
				{#if remainingMinor > 0}<p class="mt-2 text-sm">
						{#if snapshot.batch}This batch has no single contact. Reallocate its full amount to
							restore attribution.{:else}The unallocated amount remains on the contact balance,
							available for a later claim or refund.{/if}
					</p>{/if}
			{/if}
			{#if error}<p role="alert" class="mt-3 text-sm text-[var(--red)]">
					{error}
				</p>{/if}
			<div class="mt-5 flex justify-end gap-2">
				<Button variant="outline" disabled={sending} onclick={onclose}>Close</Button>
				{#if reviewing}<Button
						variant="outline"
						disabled={sending || stale}
						onclick={() => {
							reviewing = false;
							error = '';
						}}>Back</Button
					><Button disabled={sending || stale} onclick={confirm}
						>{sending ? 'Saving…' : 'Confirm correction'}</Button
					>
				{:else}<Button
						disabled={loading ||
							!!error ||
							!snapshot ||
							reason.trim().length < 10 ||
							selected.length === 0 ||
							remainingMinor < 0 ||
							invalidReplacement ||
							(snapshot?.batch && allocations.length > 0 && remainingMinor !== 0)}
						onclick={() => {
							reason = reason.trim();
							reviewing = true;
						}}>Review correction</Button
					>{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
