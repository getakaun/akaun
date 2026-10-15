<script lang="ts">
	import { deserialize } from '$app/forms';
	import { goto } from '$app/navigation';
	import { getLocalTimeZone, today } from '@internationalized/date';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AccessEditor from './AccessEditor.svelte';
	import { summarizeAccess } from '$lib/permissions/describe.js';
	import type { LeafPermission } from '$lib/permissions/catalog.js';
	import { Check, Copy, KeyRound, ShieldCheck } from '@lucide/svelte';

	/**
	 * Make a personal access token: a name, when it stops working, and what it
	 * may do. Posts the route's `create` form action; on success the page turns
	 * into the one and only view of the secret. The secret is never put in a
	 * URL or carried through a redirect.
	 */
	let { delegable }: { delegable: LeafPermission[] } = $props();

	const HOME = '/profile?tab=token';
	/** Six months from today, in the user's own calendar. */
	const DEFAULT_EXPIRY = today(getLocalTimeZone()).add({ months: 6 }).toString();
	const TOMORROW = today(getLocalTimeZone()).add({ days: 1 }).toString();

	const available = $derived(new Set(delegable));

	let name = $state('');
	let expiresOn = $state(DEFAULT_EXPIRY);
	let permissions = $state<LeafPermission[]>([]);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let created = $state<{ name: string; token: string } | null>(null);
	let copied = $state(false);

	const dirty = $derived(
		created === null &&
			(name.trim() !== '' || permissions.length > 0 || expiresOn !== DEFAULT_EXPIRY)
	);
	const areas = $derived(summarizeAccess(permissions));
	const expiryLabel = $derived(
		expiresOn
			? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(
					Date.parse(`${expiresOn}T00:00:00Z`)
				)
			: null
	);

	async function save() {
		if (saving) return;
		saveError = null;
		if (!name.trim()) {
			saveError = 'Give the token a name, so you can tell it apart later.';
			return;
		}
		if (permissions.length === 0) {
			saveError = 'Choose at least one permission.';
			return;
		}
		saving = true;
		try {
			const body = new FormData();
			body.set('name', name.trim());
			body.set('permissions', JSON.stringify(permissions));
			body.set('expiresOn', expiresOn ?? '');
			const response = await fetch('?/create', {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await response.text());
			if (result.type === 'success') {
				const value = result.data as { token: string; name: string };
				created = { name: value.name, token: value.token };
				return;
			}
			saveError =
				result.type === 'failure'
					? ((result.data as { error?: string } | undefined)?.error ?? 'The token was not made.')
					: 'The token was not made. Try again.';
		} catch {
			saveError = 'The server did not get the request. Make sure that you are connected, then try again.';
		} finally {
			saving = false;
		}
	}

	/**
	 * Back to the list, in place of this page: Back from there should not land
	 * on a blank form for another token.
	 */
	function done() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- a fixed in-app path with the tab to open.
		void goto(HOME, { replaceState: true });
	}

	/** Discard: back to a blank form. Leaving is the Back link's job. */
	function revert() {
		name = '';
		expiresOn = DEFAULT_EXPIRY;
		permissions = [];
		saveError = null;
	}

	async function copy() {
		if (!created) return;
		await navigator.clipboard.writeText(created.token);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<svelte:head><title>New access token - Akaun</title></svelte:head>

<DetailPage
	backHref={HOME}
	backLabel="Access tokens"
	{dirty}
	{saving}
	saveLabel="Create token"
	dirtyNote="Not created yet"
	onsave={save}
	onrevert={revert}
>
	{#snippet hero()}
		<h1 class="detail-hero-title">{created ? created.name : 'New access token'}</h1>
		<p class="detail-hero-note">
			{created
				? 'Your token is ready.'
				: 'A token lets a script or an AI assistant use Akaun as you — with only what you choose here.'}
		</p>
		{#if saveError}<p class="hero-error" role="alert">{saveError}</p>{/if}
	{/snippet}

	{#snippet main()}
		{#if created}
			<section class="detail-card tc-secret" role="status">
				<div class="tc-secret-head">
					<KeyRound size={16} />
					<span>Copy the token now. It won't be shown again.</span>
				</div>
				<div class="tc-secret-row">
					<code>{created.token}</code>
					<Button variant="outline" size="sm" onclick={copy}>
						{#if copied}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy{/if}
					</Button>
				</div>
				<p class="tc-note">
					Send it in an <code>Authorization: Bearer</code> header. If you lose it, regenerate it from
					the list.
				</p>
				<div>
					<Button size="sm" onclick={done}>Done</Button>
				</div>
			</section>
		{:else}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Token</span></div>
				<div class="tc-fields">
					<label class="field">
						<span class="field-label">Name</span>
						<Input bind:value={name} maxlength={100} placeholder="e.g. Claude — bookkeeping" />
						<span class="field-hint">What uses this token, so you can tell it apart later.</span>
					</label>
					<div class="field">
						<span class="field-label">Expires</span>
						<div class="tc-expiry">
							<DatePicker
								bind:value={expiresOn}
								min={TOMORROW}
								clearable
								clearLabel="Remove the expiry date"
								placeholder="Never expires"
							/>
						</div>
						{#if expiresOn}
							<span class="field-hint">Works until the end of {expiryLabel}, then stops.</span>
						{:else}
							<span class="field-hint tc-warn">
								Anyone who gets this token can use it until you revoke it.
							</span>
						{/if}
					</div>
				</div>
			</section>

			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Permissions</span></div>
				{#if delegable.length === 0}
					<EmptyState
						title="Nothing to hand on yet"
						sub="An administrator chooses what each group may hand on to tokens and apps, on Users & Groups."
						style="padding:20px;"
					/>
				{:else}
					<p class="tc-intro">
						Pick a level for each area. Choose Custom to pick single abilities. Areas you
						can't hand on are greyed out.
					</p>
					<AccessEditor
						value={permissions}
						onchange={(next) => (permissions = next)}
						{available}
						unavailableNote="You can't hand this on."
					/>
				{/if}
			</section>
		{/if}
	{/snippet}

	{#snippet rail()}
		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">This token can</span></div>
			{#if areas.length === 0}
				<p class="tc-empty">Nothing yet. Pick a level for at least one area.</p>
			{:else}
				<ul class="tc-summary">
					{#each areas as area (area.root)}
						<li>
							<span class="tc-summary-area">{area.label}</span>
							<span class="tc-summary-text">{area.sentence}</span>
						</li>
					{/each}
				</ul>
			{/if}
			<p class="tc-limit">
				<ShieldCheck size={14} />
				<span>Never more than you can do yourself at the moment it is used.</span>
			</p>
		</section>
	{/snippet}
</DetailPage>

<style>
	.tc-fields {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.tc-expiry {
		max-width: 260px;
	}
	.tc-warn {
		color: var(--amber);
	}
	.tc-intro {
		margin: 0 0 12px;
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.tc-summary {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.tc-summary li {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.tc-summary-area {
		font-size: 13px;
		font-weight: 600;
	}
	.tc-summary-text,
	.tc-empty {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--muted-foreground);
	}
	.tc-limit {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 14px 0 0;
		padding-top: 12px;
		border-top: 1px solid var(--border);
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.tc-limit :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}
	.tc-secret {
		display: flex;
		flex-direction: column;
		gap: 12px;
		border-color: var(--primary);
	}
	.tc-secret-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		font-weight: 600;
	}
	.tc-secret-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.tc-secret-row code {
		flex: 1;
		min-width: 0;
		padding: 9px 11px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--muted);
		font-size: 13px;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.tc-note {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.hero-error {
		margin: 4px 0 0;
		font-size: 12.5px;
		color: var(--destructive);
	}
</style>
