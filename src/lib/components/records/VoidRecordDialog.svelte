<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { RecordView } from '$lib/server/ledger/types.js';

	/**
	 * Voids one record: the server posts a Reversal that negates it on the same
	 * date, so every report reads as if it never happened.
	 *
	 * The same two steps as the date and reimbursement-amount corrections — a
	 * reason, then a review the user confirms — because a void is as final as
	 * they are and more so: there is no undo. The version comes from the GET, so
	 * a record changed in another tab is refused rather than voided unseen.
	 */
	let {
		recordId,
		onclose,
		ondone
	}: {
		recordId: number;
		onclose: () => void;
		ondone: (result: { record: RecordView; reversal: RecordView }) => void;
	} = $props();

	const REASON_MIN = 10;
	const REASON_MAX = 2000;

	let snapshot = $state<{
		record: RecordView;
		version: string;
		blockedReason: string | null;
	} | null>(null);
	let reason = $state('');
	let reviewing = $state(false);
	let loading = $state(true);
	let sending = $state(false);
	let error = $state('');
	let stale = $state(false);
	let alive = true;
	const reasonLength = $derived(reason.trim().length);
	const reasonValid = $derived(reasonLength >= REASON_MIN && reasonLength <= REASON_MAX);

	async function load() {
		loading = true;
		error = '';
		snapshot = null;
		reviewing = false;
		stale = false;
		try {
			const res = await fetch(`/api/records/${recordId}/void`, { cache: 'no-store' });
			const body = await res.json();
			if (!alive) return;
			if (!res.ok) {
				error = body.error ?? 'This record cannot be voided.';
				return;
			}
			snapshot = body;
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
		if (!snapshot || snapshot.blockedReason || !reasonValid) return;
		reason = reason.trim();
		error = '';
		reviewing = true;
	}

	async function confirm() {
		if (!snapshot || sending || stale) return;
		sending = true;
		error = '';
		try {
			const res = await fetch(`/api/records/${recordId}/void`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason, expectedVersion: snapshot.version })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.error ?? 'The record could not be voided.';
				stale = res.status === 409;
				return;
			}
			ondone({ record: body.record, reversal: body.reversal });
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
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] max-h-[90vh] w-[min(92vw,500px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg p-5 outline-none"
			style="box-shadow: 0 0 32px 6px var(--red-soft), 0 20px 50px rgb(0 0 0 / 0.2);"
		>
			<Dialog.Title class="text-base font-semibold">Void this record</Dialog.Title>
			<Dialog.Description class="text-muted-foreground mt-2 text-sm">
				{#if snapshot}
					This posts a reversal dated {formatDate(snapshot.record.date)} so every report reads as if
					this record never happened. A void cannot be undone.
				{:else}
					This posts a reversal on the record's own date so every report reads as if this record
					never happened. A void cannot be undone.
				{/if}
			</Dialog.Description>
			{#if loading}
				<p class="mt-4 text-sm" role="status">Loading current record…</p>
			{:else if snapshot}
				<p class="mt-4 text-sm font-medium">
					{snapshot.record.recordNumber ?? 'Record'} · {snapshot.record.description} · {formatMinor(
						snapshot.record.amountMinor
					)}
				</p>
				{#if snapshot.blockedReason}
					<p class="mt-4 rounded bg-[var(--red-soft)] p-3 text-sm" role="alert">
						{snapshot.blockedReason}
					</p>
				{:else if reviewing}
					<dl class="mt-4 space-y-2 text-sm">
						<div>
							<dt class="text-muted-foreground">Reversal date</dt>
							<dd>{formatDate(snapshot.record.date)}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Reason</dt>
							<dd class="break-words whitespace-pre-wrap">{reason}</dd>
						</div>
					</dl>
					<p class="mt-4 rounded bg-[var(--red-soft)] p-3 text-sm font-medium">
						Both this record and its reversal become read-only. To bring it back, enter it again as a
						new record.
					</p>
				{:else}
					<form id="void-record-form" class="mt-4 space-y-4" onsubmit={review}>
						<div>
							<label for="void-record-reason" class="block text-sm">Reason for voiding</label>
							<Textarea
								id="void-record-reason"
								name="reason"
								class="mt-1"
								rows={3}
								required
								minlength={REASON_MIN}
								maxlength={REASON_MAX}
								bind:value={reason}
								aria-describedby="void-record-reason-help"
							/>
							<p
								id="void-record-reason-help"
								class="text-muted-foreground mt-1 flex justify-between gap-3 text-xs"
							>
								<span
									>Enter {REASON_MIN}–{REASON_MAX} characters. Your reason is saved on the reversal and
									in the record history.</span
								>
								<span aria-live="polite" class="shrink-0 tabular-nums"
									>{reasonLength}/{REASON_MAX}</span
								>
							</p>
						</div>
					</form>
				{/if}
			{/if}
			{#if error}<p class="text-destructive mt-4 text-sm" role="alert">
					{error}
				</p>{/if}
			<div class="mt-5 flex flex-wrap justify-end gap-2">
				<Button variant="outline" size="sm" disabled={sending} onclick={onclose}>Cancel</Button>
				{#if stale}
					<Button size="sm" onclick={() => void load()}>Reload record and review again</Button>
				{:else if snapshot && !snapshot.blockedReason && reviewing}
					<Button
						variant="outline"
						size="sm"
						disabled={sending}
						onclick={() => {
							reviewing = false;
						}}>Back</Button
					>
					<Button variant="destructive" size="sm" disabled={sending} onclick={confirm}
						>{sending ? 'Voiding…' : 'Confirm void'}</Button
					>
				{:else if snapshot && !snapshot.blockedReason}
					<Button size="sm" type="submit" form="void-record-form" disabled={!reasonValid}
						>Review void</Button
					>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
