<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { RecordView } from '$lib/server/ledger/types.js';

	let {
		recordId,
		onclose,
		oncorrected
	}: {
		recordId: number;
		onclose: () => void;
		oncorrected: () => void;
	} = $props();
	let snapshot = $state<{ record: RecordView; version: string } | null>(null);
	let date = $state('');
	let reason = $state('');
	let reviewing = $state(false);
	let acknowledged = $state(false);
	let loading = $state(true);
	let sending = $state(false);
	let error = $state('');
	let stale = $state(false);
	let alive = true;
	const crossesPeriod = $derived(
		!!snapshot && date.slice(0, 7) !== snapshot.record.date.slice(0, 7)
	);

	async function load() {
		loading = true;
		error = '';
		snapshot = null;
		reviewing = false;
		acknowledged = false;
		stale = false;
		try {
			const res = await fetch(`/api/records/${recordId}/date-correction`, {
				cache: 'no-store'
			});
			const body = await res.json();
			if (!alive) return;
			if (!res.ok) {
				error = body.error ?? 'This record cannot be corrected.';
				return;
			}
			snapshot = body;
			date = body.record.date;
		} catch {
			if (alive)
				error = 'The record could not be loaded. Check your connection and reopen this dialog.';
		} finally {
			if (alive) loading = false;
		}
	}

	onMount(() => {
		void load();
		return () => {
			alive = false;
		};
	});

	function review(event: SubmitEvent) {
		event.preventDefault();
		if (!snapshot || !date || date === snapshot.record.date || reason.trim().length < 10) return;
		reason = reason.trim();
		acknowledged = false;
		error = '';
		reviewing = true;
	}

	async function confirm() {
		if (!snapshot || sending || stale || (crossesPeriod && !acknowledged)) return;
		sending = true;
		error = '';
		try {
			const res = await fetch(`/api/records/${recordId}/date-correction`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					date,
					reason,
					expectedVersion: snapshot.version,
					acknowledgePeriodChange: acknowledged
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'The date could not be corrected.';
				stale = res.status === 409;
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
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(92vw,500px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg p-5 outline-none"
			style="box-shadow: 0 0 32px 6px var(--red-soft), 0 20px 50px rgb(0 0 0 / 0.2);"
		>
			<Dialog.Title class="text-base font-semibold">Correct settled record date</Dialog.Title>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm">
				This correction changes reports and historical balances. Linked payment dates and
				allocations stay unchanged.
			</Dialog.Description>
			<p class="mt-3 text-sm">
				Do not use this action for a finalized period without consulting the person responsible for
				your accounts.
			</p>
			{#if loading}
				<p class="mt-4 text-sm" role="status">Loading current record…</p>
			{:else if snapshot}
				<p class="mt-4 text-sm font-medium">
					{snapshot.record.recordNumber ?? 'Record'} · {snapshot.record.description} · {formatMinor(
						snapshot.record.amountMinor
					)}
				</p>
				{#if reviewing}
					<dl class="mt-4 space-y-2 text-sm">
						<div>
							<dt class="text-muted-foreground">Current date</dt>
							<dd>{formatDate(snapshot.record.date)}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Corrected date</dt>
							<dd>{formatDate(date)}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Reason</dt>
							<dd class="whitespace-pre-wrap break-words">{reason}</dd>
						</div>
					</dl>
					{#if crossesPeriod}
						<div class="mt-4 rounded bg-[var(--red-soft)] p-3 text-sm">
							<p class="font-medium">
								This moves the posting from {snapshot.record.date.slice(0, 7)} to
								{date.slice(0, 7)}{date.slice(0, 4) !== snapshot.record.date.slice(0, 4)
									? ', across calendar years'
									: ''}.
							</p>
							<label class="mt-3 flex items-start gap-2"
								><input type="checkbox" bind:checked={acknowledged} disabled={sending} /> I understand
								this changes reports for these periods.</label
							>
						</div>
					{/if}
				{:else}
					<form id="date-correction-form" class="mt-4 space-y-4" onsubmit={review}>
						<p class="text-sm">
							Current date: {formatDate(snapshot.record.date)}
						</p>
						<div class="text-sm">
							<span id="date-correction-date-label" class="mb-1 block">Corrected date</span>
							<DatePicker
								bind:value={date}
								labelledBy="date-correction-date-label"
								popoverClass="z-[70]"
							/>
						</div>
						<label class="block text-sm"
							>Reason for correction<textarea
								class="border-input bg-card mt-1 block w-full rounded border p-2 outline-none focus-visible:border-[var(--red)] focus-visible:shadow-[0_0_0_3px_var(--red-soft)]"
								rows="3"
								required
								minlength="10"
								maxlength="500"
								bind:value={reason}
							></textarea></label
						>
						<p class="text-muted-foreground text-xs">
							Enter 10–500 characters. Your reason and both dates will be saved in the record
							history.
						</p>
					</form>
				{/if}
			{/if}
			{#if error}<p class="mt-4 text-sm text-destructive" role="alert">
					{error}
				</p>{/if}
			<div class="mt-5 flex flex-wrap justify-end gap-2">
				<Button variant="outline" size="sm" disabled={sending} onclick={onclose}>Cancel</Button>
				{#if stale}
					<Button size="sm" onclick={() => void load()}>Reload record and review again</Button>
				{:else if snapshot && reviewing}
					<Button
						variant="outline"
						size="sm"
						disabled={sending}
						onclick={() => {
							reviewing = false;
							acknowledged = false;
						}}>Back</Button
					>
					<Button size="sm" disabled={sending || (crossesPeriod && !acknowledged)} onclick={confirm}
						>{sending ? 'Correcting…' : 'Confirm date correction'}</Button
					>
				{:else if snapshot}
					<Button
						size="sm"
						type="submit"
						form="date-correction-form"
						disabled={date === snapshot.record.date || !date || reason.trim().length < 10}
						>Review correction</Button
					>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
