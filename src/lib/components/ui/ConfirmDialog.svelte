<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		danger = false,
		onConfirm
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onConfirm: () => void;
	} = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="fixed inset-0 z-[60] bg-black/35" />
		<AlertDialog.Content
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-[60] w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 shadow-lg [border:1px_solid_var(--border)]"
		>
			<AlertDialog.Title class="text-[15px] font-semibold">{title}</AlertDialog.Title>
			<AlertDialog.Description class="text-muted-foreground mt-2 text-[13px] leading-relaxed">
				{description}
			</AlertDialog.Description>
			<div class="mt-5 flex justify-end gap-2">
				<AlertDialog.Cancel>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm">{cancelLabel}</Button>
					{/snippet}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					onclick={() => {
						open = false;
						onConfirm();
					}}
				>
					{#snippet child({ props })}
						<Button {...props} variant={danger ? 'destructive' : 'default'} size="sm">
							{confirmLabel}
						</Button>
					{/snippet}
				</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
