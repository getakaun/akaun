<script lang="ts">
	import { enhance } from '$app/forms';
	import { X } from '@lucide/svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import { mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import type { AccountView } from '$lib/server/ledger/types.js';

	let {
		open = $bindable(false),
		account = null,
		existing = null,
		error = '',
		onclose
	}: {
		open?: boolean;
		account?: AccountView | null;
		/** The starting balance already set, so the form opens on it rather than blank. */
		existing?: { date: string; amountMinor: number } | null;
		error?: string;
		onclose: () => void;
	} = $props();

	const screen = useIsMobile();
	const isMobile = $derived(screen.current);
	const panelSide = $derived(isMobile ? 'bottom' : 'right');

	const today = new Date().toISOString().slice(0, 10);
	const startDate = $derived(existing?.date ?? today);
	const startAmount = $derived(
		existing ? (existing.amountMinor / 100).toFixed(2) : '0'
	);
</script>

<Sheet.Root
	{open}
	onOpenChange={(o) => {
		if (!o) onclose();
	}}
>
		<Sheet.Content
			side={panelSide}
			style={isMobile
				? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;'
				: 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}
		>
			<div
				style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);"
			>
				<div>
					<div class="sheet-eyebrow">{account?.name ?? 'Account'}</div>
					<div class="sheet-title-text">Opening balance</div>
				</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>

			<form
				method="POST"
				action="?/openingBalance"
				use:enhance
				style="flex:1; display:flex; flex-direction:column; overflow:hidden;"
			>
				<input type="hidden" name="id" value={account?.id ?? ''} />

				<div style="flex:1; overflow-y:auto; padding:20px 22px;">
					{#if error}
						<div
							style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;"
						>
							{error}
						</div>
					{/if}

					<p class="lead">
						The balance of this account on the start date of the books. Records after that date add
						to this balance.
					</p>

					<div class="field">
						<span class="field-label">As at date *</span>
						{#key `${account?.id ?? ''}-${startDate}-${open}`}
							<DatePicker name="date" value={startDate} />
						{/key}
					</div>

					<div class="field">
						<label class="field-label" for="ob-amount">
							Amount ({mainCurrencySymbol()}) *
						</label>
						<Input
							id="ob-amount"
							name="amount"
							type="number"
							step="0.01"
							required
							value={startAmount}
							class="w-full"
						/>
						<p class="hint">
							Enter a negative amount if the account was overdrawn. Enter zero to remove the opening
							balance.
						</p>
					</div>
				</div>

				<div class="sheet-foot">
					<div class="sheet-foot-note">
						An account has only one opening balance. Saving this replaces the earlier one.
					</div>
					<div class="sheet-foot-actions">
						<button type="button" class="sheet-btn" onclick={onclose}>Cancel</button>
						<button type="submit" class="sheet-btn sheet-btn-primary">Save opening balance</button>
					</div>
				</div>
			</form>
		</Sheet.Content>
</Sheet.Root>

<style>
	.lead {
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.55;
		margin: 0 0 18px;
	}
</style>
