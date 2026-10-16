<script lang="ts">
	import { Paperclip, Plus, X } from '@lucide/svelte';
	import ListExpand, { visibleItems } from './ListExpand.svelte';

	export type Attachment = { id: number; filename: string; displayName: string; addedDate: string };

	let {
		apiBase,
		attachments = $bindable(),
		canDelete = true
	}: {
		/** Base URL of the owning record, e.g. `/api/records/123`. */
		apiBase: string;
		attachments: Attachment[];
		/** Removing a file needs the delete ability for records, not only change. */
		canDelete?: boolean;
	} = $props();

	let drag = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let error = $state('');
	let expanded = $state(false);
	const shown = $derived(visibleItems(attachments, expanded));

	async function upload(files: FileList) {
		for (const file of Array.from(files)) {
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch(`${apiBase}/attachments`, { method: 'POST', body: fd });
			if (res.ok) {
				const att: Attachment = await res.json();
				attachments = [...attachments, att];
			}
		}
	}

	async function remove(attachmentId: number) {
		error = '';
		const res = await fetch(`${apiBase}/attachments/${attachmentId}`, { method: 'DELETE' });
		if (res.ok) {
			attachments = attachments.filter((a) => a.id !== attachmentId);
		} else {
			const body = await res.json().catch(() => null);
			error = body?.error ?? 'Failed to delete attachment';
		}
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		drag = false;
		if (e.dataTransfer?.files) upload(e.dataTransfer.files);
	}
	function onFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) upload(input.files);
		input.value = '';
	}
</script>

<div class="detail-card-head">
	<span class="detail-card-title">Attachments</span>
	<button type="button" class="attach-add-btn" onclick={() => fileInput?.click()}>
		<Plus size={11} /> Add
	</button>
</div>
{#if error}
	<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:8px 12px; font-size:12.5px; margin-bottom:8px;">{error}</div>
{/if}
<div
	class="attach-drop-area"
	class:drag
	role="group"
	aria-label="Attachments"
	ondragover={(e) => { e.preventDefault(); drag = true; }}
	ondragleave={() => (drag = false)}
	ondrop={onDrop}
>
	{#if attachments.length > 0}
		<div class="attach-list">
			{#each shown as att (att.id)}
				<div class="attach-item related-link">
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an API endpoint under apiBase that serves the file, not an app page. -->
					<a href="{apiBase}/attachments/{att.id}"
						target="_blank"
						rel="noopener"
						class="attach-link-area"
						aria-label="Open {att.displayName}"
					>
						<div class="attach-thumb"><Paperclip size={16} /></div>
						<div class="attach-meta">
							<div class="attach-name">{att.displayName}</div>
							<div class="attach-sub">{att.addedDate}</div>
						</div>
					</a>
					<button
						type="button"
						class="attach-del"
						disabled={!canDelete}
						title={canDelete ? undefined : 'You do not have permission to delete records'}
						onclick={() => remove(att.id)}
					>
						<X size={14} />
					</button>
				</div>
			{/each}
		</div>
		<ListExpand total={attachments.length} bind:expanded />
	{:else}
		<div
			class="attach-empty attach-empty-drop"
			role="button"
			tabindex="0"
			onclick={() => fileInput?.click()}
			onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); } }}
		>
			<Paperclip size={14} /> Drop files here or click to add
		</div>
	{/if}
</div>
<input bind:this={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png" multiple style="display:none" onchange={onFileInput} />
