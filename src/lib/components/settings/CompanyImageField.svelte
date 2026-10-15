<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Upload, Trash2, Image as ImageIcon } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * One company image (the logo or the letterhead) on the Company form, staged
	 * locally until the form's single Save: a picked file stays in the file input
	 * and a removal in the hidden flag. The page owns `change` for its dirty check;
	 * setting it back to 'none' (after a save, or on discard) drops whatever was
	 * staged and shows `savedUrl` again.
	 */
	let {
		fileName,
		removeName,
		savedUrl,
		alt,
		wide = false,
		change = $bindable('none')
	}: {
		fileName: string;
		removeName: string;
		savedUrl: string | null;
		alt: string;
		/** A letterhead is a banner; give it a banner-shaped preview. */
		wide?: boolean;
		change?: 'none' | 'replace' | 'remove';
	} = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let pendingUrl = $state<string | null>(null);

	const previewUrl = $derived(
		change === 'replace' ? pendingUrl : change === 'remove' ? null : savedUrl
	);

	function dropPending() {
		if (pendingUrl) URL.revokeObjectURL(pendingUrl);
		pendingUrl = null;
		if (fileInput) fileInput.value = '';
	}

	$effect(() => {
		if (change === 'none') untrack(dropPending);
	});

	onDestroy(() => {
		if (pendingUrl) URL.revokeObjectURL(pendingUrl);
	});

	function handleFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (pendingUrl) URL.revokeObjectURL(pendingUrl);
		pendingUrl = URL.createObjectURL(file);
		change = 'replace';
	}

	function handleRemove() {
		dropPending();
		change = 'remove';
	}
</script>

<div class="image-field">
	<div class="image-thumb" class:image-thumb-wide={wide} class:image-thumb-empty={!previewUrl}>
		{#if previewUrl}
			<img src={previewUrl} {alt} />
		{:else}
			<ImageIcon size={22} />
		{/if}
	</div>
	<div class="image-actions">
		<Button type="button" variant="outline" size="sm" onclick={() => fileInput?.click()}>
			<Upload size={13} /> {previewUrl ? 'Replace' : 'Upload'}
		</Button>
		{#if previewUrl}
			<Button type="button" variant="outline" size="sm" onclick={handleRemove}>
				<Trash2 size={13} /> Remove
			</Button>
		{/if}
	</div>
	<input
		type="file"
		name={fileName}
		accept="image/jpeg,image/png"
		bind:this={fileInput}
		onchange={handleFileChange}
		style="display:none"
	/>
	<input type="hidden" name={removeName} value={change === 'remove' ? 'true' : 'false'} />
</div>

<style>
	.image-field {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.image-thumb {
		width: 88px;
		height: 88px;
		flex-shrink: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.image-thumb-wide {
		width: 240px;
		max-width: 100%;
		flex-shrink: 1;
	}

	.image-thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.image-thumb-empty {
		border-style: dashed;
		color: var(--muted-foreground);
	}

	.image-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
