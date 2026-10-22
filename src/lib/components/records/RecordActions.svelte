<script lang="ts">
	import { tick } from 'svelte';
	import {
		CalendarDays,
		ChevronDown,
		Trash2,
		UserRoundPen
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

	let {
		canCorrectPayee = false,
		canCorrectDate = false,
		canDelete = false,
		deleteBlockedReason = null,
		dirty = false,
		saving = false,
		dialogOpen = false,
		onaction
	}: {
		canCorrectPayee?: boolean;
		canCorrectDate?: boolean;
		canDelete?: boolean;
		deleteBlockedReason?: string | null;
		dirty?: boolean;
		saving?: boolean;
		dialogOpen?: boolean;
		onaction: (action: 'payee' | 'date' | 'delete') => void;
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let pendingAction: 'payee' | 'date' | 'delete' | null = null;
	// Keep the closing menu from stealing focus from the dialog it opens.
	let handingOff = false;
	let hadDialog = false;

	function selectAction(action: 'payee' | 'date' | 'delete') {
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

{#if canCorrectPayee || canCorrectDate || canDelete}
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
			{#if canCorrectPayee}
				<DropdownMenu.Item
					disabled={dirty || saving}
					onSelect={() => selectAction('payee')}
				>
					<UserRoundPen aria-hidden="true" /> Correct payee…
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
			{#if dirty && (canCorrectPayee || canCorrectDate)}
				<p class="text-muted-foreground px-2 py-1.5 text-xs">
					Save or discard your changes before correcting this record.
				</p>
			{/if}
			{#if canDelete}
				{#if canCorrectPayee || canCorrectDate}<DropdownMenu.Separator />{/if}
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
