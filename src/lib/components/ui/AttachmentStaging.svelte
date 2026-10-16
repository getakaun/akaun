<script lang="ts">
	import { Paperclip, Plus, X } from '@lucide/svelte';

	/**
	 * Files staged before a record exists to attach them to.
	 *
	 * `record_attachments.record_id` is NOT NULL, so a file picked while creating
	 * a record cannot be uploaded yet. It waits here — kept in a plain `Map`,
	 * never `$state` (a Svelte 5 `File`/`Blob` rule) — until the caller has a
	 * saved id and calls `uploadAll`.
	 */
	let {
		// Write-only out-parameter: the frame around this component reads it to
		// decide whether staged-but-unattached files count as unsaved work.
		// eslint-disable-next-line no-useless-assignment
		count = $bindable(0),
		disabled = false
	}: {
		/** Metadata only (the staged-file count), so a caller can derive `dirty`
		 *  without ever touching a `File`/`Blob`. */
		count?: number;
		disabled?: boolean;
	} = $props();

	type StagedFile = { id: string; name: string; size: number; status: 'pending' | 'uploading' | 'error' };
	let stagedFiles = $state<StagedFile[]>([]);
	// A plain Map, never $state or SvelteMap: a Svelte 5 reactive container must
	// never hold a File/Blob (CLAUDE.md's client-mirror rule for this exact case).
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const stagedFileData = new Map<string, File>();
	let drag = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		count = stagedFiles.length;
	});

	function formatBytes(n: number) {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function addFiles(files: FileList) {
		for (const file of Array.from(files)) {
			const id = crypto.randomUUID();
			stagedFileData.set(id, file);
			stagedFiles = [...stagedFiles, { id, name: file.name, size: file.size, status: 'pending' }];
		}
	}
	function removeFile(id: string) {
		stagedFileData.delete(id);
		stagedFiles = stagedFiles.filter((f) => f.id !== id);
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		drag = false;
		if (disabled) return;
		if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
	}
	function onFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) addFiles(input.files);
		input.value = '';
	}

	/** Drops every staged file without uploading anything — "start over". */
	export function clear() {
		stagedFileData.clear();
		stagedFiles = [];
	}

	/** Uploads every staged file to the now-saved record, one at a time. */
	export async function uploadAll(recordId: number): Promise<{ failedCount: number }> {
		for (const staged of stagedFiles) {
			staged.status = 'uploading';
			const file = stagedFileData.get(staged.id);
			if (!file) continue;
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch(`/api/records/${recordId}/attachments`, { method: 'POST', body: fd });
			if (res.ok) {
				stagedFileData.delete(staged.id);
				stagedFiles = stagedFiles.filter((f) => f.id !== staged.id);
			} else {
				staged.status = 'error';
			}
		}
		return { failedCount: stagedFiles.filter((f) => f.status === 'error').length };
	}
</script>

<div class="detail-card-head">
	<span class="detail-card-title">Attachments</span>
	{#if !disabled}
		<button type="button" class="attach-add-btn" onclick={() => fileInput?.click()}>
			<Plus size={11} /> Add
		</button>
	{/if}
</div>
<div
	class="attach-drop-area"
	class:drag
	role="group"
	aria-label="Attachments"
	ondragover={(e) => {
		if (!disabled) {
			e.preventDefault();
			drag = true;
		}
	}}
	ondragleave={() => (drag = false)}
	ondrop={onDrop}
>
	{#if stagedFiles.length > 0}
		<div class="attach-list">
			{#each stagedFiles as staged (staged.id)}
				<div class="attach-item">
					<div class="attach-link-area">
						<div class="attach-thumb"><Paperclip size={16} /></div>
						<div class="attach-meta">
							<div class="attach-name">{staged.name}</div>
							<div class="attach-sub" style={staged.status === 'error' ? 'color:var(--red);' : ''}>
								{staged.status === 'error'
									? 'Failed to upload'
									: staged.status === 'uploading'
										? 'Uploading…'
										: formatBytes(staged.size)}
							</div>
						</div>
					</div>
					{#if staged.status !== 'uploading'}
						<button type="button" class="attach-del" onclick={() => removeFile(staged.id)}>
							<X size={14} />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{:else if !disabled}
		<div
			class="attach-empty attach-empty-drop"
			role="button"
			tabindex="0"
			onclick={() => fileInput?.click()}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					fileInput?.click();
				}
			}}
		>
			<Paperclip size={14} /> Drop files here or click to add
		</div>
	{/if}
</div>
<input
	bind:this={fileInput}
	type="file"
	accept=".pdf,.jpg,.jpeg,.png"
	multiple
	style="display:none"
	onchange={onFileInput}
/>
