<script lang="ts">
	import { tick } from 'svelte';
	import {
		CalendarDays,
		Banknote,
		ChevronDown,
		Trash2,
		UserRoundPen
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

	let {
		canCorrectContact = false,
		canCorrectDate = false,
		canCorrectAmount = false,
		amountBlockedReason = null,
		canDelete = false,
		deleteBlockedReason = null,
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
		dirty?: boolean;
		saving?: boolean;
		dialogOpen?: boolean;
		onaction: (action: 'contact' | 'date' | 'amount' | 'delete') => void;
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let pendingAction: 'contact' | 'date' | 'amount' | 'delete' | null = null;
	// Keep the closing menu from stealing focus from the dialog it opens.
	let handingOff = false;
	let hadDialog = false;

	function selectAction(action: 'contact' | 'date' | 'amount' | 'delete') {
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

{#if canCorrectContact || canCorrectDate || canCorrectAmount || canDelete}
	<DropdownMenu.Root
		bind:open
		onOpenChange={(isOpen) => {
			if (isOpen) handingOff = false;
		}}
		onOpenChangeComplete={afterOpenChange}
	>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					bind:ref={trigger}
					variant="outline"
					disabled={saving}
				>
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
					disabled={dirty || saving || amountBlockedReason !== null}
					onSelect={() => selectAction('amount')}
				>
					<Banknote aria-hidden="true" /> Correct reimbursement amount…
				</DropdownMenu.Item>
				{#if amountBlockedReason}<p
						class="text-muted-foreground px-2 py-1.5 text-xs"
					>
						{amountBlockedReason}
					</p>{/if}
			{/if}
			{#if canCorrectContact}
				<DropdownMenu.Item
					disabled={dirty || saving}
					onSelect={() => selectAction('contact')}
				>
					<UserRoundPen aria-hidden="true" /> Correct contact…
				</DropdownMenu.Item>
			{/if}
			{#if canCorrectDate}
				<DropdownMenu.Item
					disabled={dirty || saving}
					onSelect={() => selectAction('date')}
				>
					<CalendarDays aria-hidden="true" /> Correct date…
				</DropdownMenu.Item>
			{/if}
			{#if dirty && (canCorrectContact || canCorrectDate || canCorrectAmount)}
				<p class="text-muted-foreground px-2 py-1.5 text-xs">
					Save or discard your changes before correcting this record.
				</p>
			{/if}
			{#if canDelete}
				{#if canCorrectContact || canCorrectDate || canCorrectAmount}<DropdownMenu.Separator
					/>{/if}
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
