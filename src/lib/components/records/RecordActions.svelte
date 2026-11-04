<script lang="ts">
	import { tick } from 'svelte';
	import { Ban, CalendarDays, Banknote, ChevronDown, Trash2, UserRoundPen } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

	type RecordAction = 'contact' | 'date' | 'amount' | 'void' | 'delete';

	let {
		canCorrectContact = false,
		canCorrectDate = false,
		canCorrectAmount = false,
		amountBlockedReason = null,
		canDelete = false,
		deleteBlockedReason = null,
		canVoid = false,
		voidBlockedReason = null,
		blockedReason = null,
		dirty = false,
		saving = false,
		dialogOpen = false,
		onaction
	}: {
		canCorrectContact?: boolean;
		canCorrectDate?: boolean;
		canCorrectAmount?: boolean;
		amountBlockedReason?: string | null;
		canDelete?: boolean;
		deleteBlockedReason?: string | null;
		canVoid?: boolean;
		/** Why the server would refuse a void (settled, reconciled, closed month, …). */
		voidBlockedReason?: string | null;
		/** A closed period blocks corrections without changing the original action eligibility. */
		blockedReason?: string | null;
		dirty?: boolean;
		saving?: boolean;
		dialogOpen?: boolean;
		onaction: (action: RecordAction) => void;
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let pendingAction: RecordAction | null = null;
	// Keep the closing menu from stealing focus from the dialog it opens.
	let handingOff = false;
	let hadDialog = false;

	function selectAction(action: RecordAction) {
		pendingAction = action;
		handingOff = true;
		open = false;
	}

	function afterOpenChange(isOpen: boolean) {
		if (isOpen || pendingAction === null) return;
		const action = pendingAction;
		pendingAction = null;
		onaction(action);
	}

	$effect(() => {
		const active = dialogOpen;
		if (hadDialog && !active) {
			void tick().then(() => trigger?.focus());
		}
		hadDialog = active;
	});
</script>

{#if canCorrectContact || canCorrectDate || canCorrectAmount || canVoid || canDelete}
	<DropdownMenu.Root
		bind:open
		onOpenChange={(isOpen) => {
			if (isOpen) handingOff = false;
		}}
		onOpenChangeComplete={afterOpenChange}
	>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} bind:ref={trigger} variant="outline" disabled={saving}>
					Actions <ChevronDown size={14} aria-hidden="true" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content
			align="end"
			class="w-64"
			onCloseAutoFocus={(event) => {
				if (handingOff) event.preventDefault();
			}}
		>
			{#if canCorrectAmount}
				<DropdownMenu.Item
					disabled={dirty || saving || blockedReason !== null || amountBlockedReason !== null}
					onSelect={() => selectAction('amount')}
				>
					<Banknote aria-hidden="true" /> Correct reimbursement amount…
				</DropdownMenu.Item>
				{#if amountBlockedReason}<p class="text-muted-foreground px-2 py-1.5 text-xs">
						{amountBlockedReason}
					</p>{/if}
			{/if}
			{#if canCorrectContact}
				<DropdownMenu.Item
					disabled={dirty || saving || blockedReason !== null}
					onSelect={() => selectAction('contact')}
				>
					<UserRoundPen aria-hidden="true" /> Correct contact…
				</DropdownMenu.Item>
			{/if}
			{#if canCorrectDate}
				<DropdownMenu.Item
					disabled={dirty || saving || blockedReason !== null}
					onSelect={() => selectAction('date')}
				>
					<CalendarDays aria-hidden="true" /> Correct date…
				</DropdownMenu.Item>
			{/if}
			{#if blockedReason && (canCorrectContact || canCorrectDate || canCorrectAmount)}
				<p class="text-muted-foreground px-2 py-1.5 text-xs">{blockedReason}</p>
			{:else if dirty && (canCorrectContact || canCorrectDate || canCorrectAmount)}
				<p class="text-muted-foreground px-2 py-1.5 text-xs">
					Save or discard your changes before correcting this record.
				</p>
			{/if}
			{#if canVoid || canDelete}
				{#if canCorrectContact || canCorrectDate || canCorrectAmount}<DropdownMenu.Separator />{/if}
			{/if}
			{#if canVoid}
				<DropdownMenu.Item
					variant="destructive"
					disabled={dirty || saving || voidBlockedReason !== null}
					onSelect={() => selectAction('void')}
				>
					<Ban aria-hidden="true" /> Void…
				</DropdownMenu.Item>
				{#if voidBlockedReason !== null}
					<p class="text-muted-foreground px-2 py-1.5 text-xs">{voidBlockedReason}</p>
				{:else if dirty && !(canCorrectContact || canCorrectDate || canCorrectAmount)}
					<p class="text-muted-foreground px-2 py-1.5 text-xs">
						Save or discard your changes before voiding this record.
					</p>
				{/if}
			{/if}
			{#if canDelete}
				<DropdownMenu.Item
					variant="destructive"
					disabled={saving || deleteBlockedReason !== null}
					onSelect={() => selectAction('delete')}
				>
					<Trash2 aria-hidden="true" /> Delete…
				</DropdownMenu.Item>
				{#if deleteBlockedReason !== null}
					<p class="text-muted-foreground px-2 py-1.5 text-xs">
						{deleteBlockedReason}
					</p>
				{/if}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
