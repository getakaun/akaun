<script lang="ts">
	import { enhance } from '$app/forms';
	import { X } from '@lucide/svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import {
		AccountCodeRanges,
		AccountSubTypeDisplayLabels,
		AccountSubTypesByType,
		AccountType,
		AccountTypeDisplayLabels,
		type AccountSubTypeCode,
		type AccountTypeCode
	} from '$lib/enums.js';
	// Mirrors src/lib/server/ledger/account-type.ts's NEEDS_REVIEW_TYPES — an
	// account of one of these types has no safe default classification, so a
	// sub-type must be chosen at creation rather than left "needs review".
	const REQUIRES_SUB_TYPE: AccountTypeCode[] = [AccountType.Asset, AccountType.Liability];

	/**
	 * Adding an account to the chart.
	 *
	 * Create only. Editing an existing account happens in place on
	 * `/accounts/[id]` — a page can show what an account *is* (its balance, its
	 * movements, what it still has to reconcile) beside the three fields that
	 * name it, which a 500px panel never could.
	 */
	let {
		open = $bindable(false),
		error = '',
		onclose
	}: {
		open?: boolean;
		error?: string;
		onclose: () => void;
	} = $props();

	const screen = useIsMobile();
	const isMobile = $derived(screen.current);
	const panelSide = $derived(isMobile ? 'bottom' : 'right');

	const types = Object.values(AccountType).filter(
		(v): v is AccountTypeCode => typeof v === 'number'
	);

	let selectedType = $state<AccountTypeCode>(AccountType.Asset);
	let selectedSubType = $state<number | null>(null);

	const subTypes = $derived(AccountSubTypesByType[selectedType] ?? []);
	const subTypeRequired = $derived(REQUIRES_SUB_TYPE.includes(selectedType));

	// A sub-type from the previous type's list is meaningless once the type
	// itself changes — the native select used to lose it as a side effect of
	// its `<option>`s re-rendering; a controlled Select needs it done on purpose.
	// When a sub-type is required, the native select also always had *some*
	// option selected (the browser picks the first by default) — matched here
	// by defaulting to the first choice rather than leaving it unset.
	$effect(() => {
		if (selectedSubType != null && !subTypes.includes(selectedSubType as never)) {
			selectedSubType = null;
		}
		if (selectedSubType == null && subTypeRequired && subTypes.length > 0) {
			selectedSubType = subTypes[0];
		}
	});

	// bits-ui's Select treats an empty string as "no selection", so the "not
	// yet classified" item needs a real sentinel (mirrors ledger/AccountSelect.svelte's NONE_VALUE).
	const NONE_SUB_TYPE = '__none__';
</script>

<Sheet.Root
	{open}
	onOpenChange={(v) => {
		if (!v) onclose();
	}}
>
	<Sheet.Content
		side={panelSide}
		style={isMobile
			? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;'
			: 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}
	>
		<div class="sheet-head">
			<div>
				<div class="sheet-eyebrow">New</div>
				<div class="sheet-title-text">Add account</div>
			</div>
			<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
		</div>

		<form method="POST" action="?/create" use:enhance class="sheet-form">
			<div class="sheet-body">
				{#if error}
					<p class="form-error">{error}</p>
				{/if}

				<div class="field">
					<label class="field-label" for="account-name">Name *</label>
					<Input id="account-name" name="name" required maxlength={120} class="w-full" />
				</div>

				<div class="field">
					<label class="field-label" for="account-type">Account type *</label>
					<Select.Root
						type="single"
						value={String(selectedType)}
						onValueChange={(next) => next && (selectedType = Number(next) as AccountTypeCode)}
					>
						<Select.Trigger id="account-type" class="w-full justify-between">
							{AccountTypeDisplayLabels[selectedType]}
						</Select.Trigger>
						<Select.Content>
							{#each types as type (type)}
								<Select.Item value={String(type)} label={AccountTypeDisplayLabels[type]} />
							{/each}
						</Select.Content>
					</Select.Root>
					<input type="hidden" name="type" value={selectedType} />
					<p class="field-hint">
						The type decides which report the account appears on. You cannot change it after
						transactions are posted to it.
					</p>
				</div>

				<div class="field">
					<label class="field-label" for="account-code">Code</label>
					<Input
						id="account-code"
						name="code"
						type="number"
						step={1}
						min={AccountCodeRanges[selectedType].start}
						max={AccountCodeRanges[selectedType].end}
						aria-describedby="account-code-hint"
						placeholder="Automatic"
						class="w-full"
					/>
					<p id="account-code-hint" class="field-hint">
						{AccountCodeRanges[selectedType].start}–{AccountCodeRanges[selectedType].end} for
						{AccountTypeDisplayLabels[selectedType].toLowerCase()}. Leave blank to assign the lowest
						available code.
					</p>
				</div>

				{#if subTypes.length > 0}
					<div class="field">
						<label class="field-label" for="account-sub-type">
							Sub-type {subTypeRequired ? '*' : ''}
						</label>
						<Select.Root
							type="single"
							value={selectedSubType == null ? NONE_SUB_TYPE : String(selectedSubType)}
							onValueChange={(next) => {
								selectedSubType =
									next && next !== NONE_SUB_TYPE ? (Number(next) as AccountSubTypeCode) : null;
							}}
						>
							<Select.Trigger id="account-sub-type" class="w-full justify-between">
								{selectedSubType == null
									? 'Unclassified'
									: AccountSubTypeDisplayLabels[selectedSubType]}
							</Select.Trigger>
							<Select.Content>
								{#if !subTypeRequired}
									<Select.Item value={NONE_SUB_TYPE} label="Unclassified" />
								{/if}
								{#each subTypes as subType (subType)}
									<Select.Item
										value={String(subType)}
										label={AccountSubTypeDisplayLabels[subType]}
									/>
								{/each}
							</Select.Content>
						</Select.Root>
						<input type="hidden" name="subType" value={selectedSubType ?? ''} />
						<p class="field-hint">
							{#if subTypeRequired}
								What kind of {AccountTypeDisplayLabels[selectedType].toLowerCase()} this is.
							{:else}
								If you leave it unclassified, the reports show it as operating.
							{/if}
						</p>
					</div>
				{/if}
			</div>

			<footer class="sheet-foot">
				<div class="sheet-foot-actions">
					<button type="button" class="sheet-btn" onclick={onclose}>Cancel</button>
					<button type="submit" class="sheet-btn sheet-btn-primary">Create account</button>
				</div>
			</footer>
		</form>
	</Sheet.Content>
</Sheet.Root>

<style>
	.sheet-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 22px 22px 16px;
		border-bottom: 1px solid var(--border);
	}
	.sheet-form {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.sheet-body {
		flex: 1;
		overflow-y: auto;
		padding: 20px 22px;
	}
	.form-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 12px;
		font-size: 13px;
		margin: 0 0 14px;
	}
</style>
