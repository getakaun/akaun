<script lang="ts" module>
	export type TokenRow = {
		id: number;
		name: string;
		lastFour: string;
		permissions: string[];
		expiresAt: number | null;
		lastUsedAt: number | null;
		createdAt: number;
	};
	export type TokenOutcome = { token?: string; error?: string };
</script>

<script lang="ts">
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { LEVEL_LABELS, summarizeAccess } from '$lib/permissions/describe.js';
	import { Check, Copy, KeyRound, Plus, RefreshCw, X } from '@lucide/svelte';

	/**
	 * A user's personal access tokens as a list, with regenerate and revoke.
	 * Making a token is a page of its own (`newHref`); this only lists. Where
	 * a change is saved is the caller's — the profile page posts its own form
	 * actions, Users & Groups calls the admin API — so this collects and shows.
	 */
	let {
		tokens,
		newHref = null,
		onregenerate = null,
		onrevoke,
		onrevokeall = null,
		emptySub = 'A token lets a script or an AI assistant use Akaun as you, with only what you choose.'
	}: {
		tokens: TokenRow[];
		/** Where "New token" goes; null hides it (an administrator never makes one). */
		newHref?: string | null;
		onregenerate?: ((id: number) => Promise<TokenOutcome>) | null;
		onrevoke: (id: number) => Promise<TokenOutcome>;
		onrevokeall?: (() => Promise<TokenOutcome>) | null;
		emptySub?: string;
	} = $props();

	let busy = $state(false);
	let error = $state('');
	let revealed = $state<{ name: string; token: string } | null>(null);
	let copied = $state(false);
	type Confirming = { kind: 'revoke' | 'regenerate'; token: TokenRow } | { kind: 'revoke-all' };
	let confirming = $state<Confirming | null>(null);
	let confirmOpen = $state(false);

	function ask(next: Confirming) {
		confirming = next;
		confirmOpen = true;
	}

	const now = Date.now();
	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
	const day = (ms: number) => dateFormat.format(ms);

	async function run(action: () => Promise<TokenOutcome>, name = '') {
		busy = true;
		error = '';
		try {
			const outcome = await action();
			if (outcome.error) error = outcome.error;
			if (outcome.token) {
				revealed = { name, token: outcome.token };
				copied = false;
			}
		} finally {
			busy = false;
		}
	}

	function confirm() {
		const c = confirming;
		confirmOpen = false;
		if (!c) return;
		if (c.kind === 'revoke-all') return run(() => onrevokeall!());
		if (c.kind === 'revoke') return run(() => onrevoke(c.token.id));
		return run(() => onregenerate!(c.token.id), c.token.name);
	}

	async function copy() {
		if (!revealed) return;
		await navigator.clipboard.writeText(revealed.token);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="tl">
	{#if revealed}
		<div class="tl-reveal" role="status">
			<div class="tl-reveal-head">
				<KeyRound size={14} />
				<span>New secret for <strong>{revealed.name}</strong>. Copy it now — it won't be shown again.</span>
			</div>
			<div class="tl-secret">
				<code>{revealed.token}</code>
				<Button variant="outline" size="sm" onclick={copy}>
					{#if copied}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy{/if}
				</Button>
			</div>
			<button type="button" class="tl-link" onclick={() => (revealed = null)}>Done</button>
		</div>
	{/if}

	{#if error}<p class="tl-error" role="alert">{error}</p>{/if}

	{#if tokens.length === 0}
		<EmptyState title="No access tokens yet" sub={emptySub}>
			{#snippet icon()}<KeyRound size={18} />{/snippet}
			{#snippet action()}
				{#if newHref}
					<Button href={newHref} size="sm" class="mt-3"><Plus size={14} /> New token</Button>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		{#if newHref}
			<div class="tl-bar">
				<Button href={newHref} size="sm"><Plus size={14} /> New token</Button>
			</div>
		{/if}
		<ul class="tl-list">
			{#each tokens as t (t.id)}
				{@const areas = summarizeAccess(t.permissions)}
				{@const expired = t.expiresAt !== null && t.expiresAt <= now}
				<li class="tl-row" class:expired>
					<div class="tl-main">
						<div class="tl-name">
							{t.name}
							<code class="tl-four">akp_…{t.lastFour}</code>
						</div>
						<div class="tl-can">
							{#if areas.length === 0}
								<span class="tl-none">No permissions</span>
							{/if}
							{#each areas as area (area.root)}
								<span class="tl-area" title={area.sentence}>
									{area.label}
									<span class="tl-level">
										{LEVEL_LABELS[area.level]}{area.extras.length ? ` + ${area.extras.join(', ')}` : ''}
									</span>
								</span>
							{/each}
						</div>
					</div>
					<dl class="tl-dates">
						<div>
							<dt>Expires</dt>
							<dd>
								{#if expired}<StatusBadge status="expired" />
								{:else if t.expiresAt === null}Never
								{:else}{day(t.expiresAt)}{/if}
							</dd>
						</div>
						<div>
							<dt>Last used</dt>
							<dd>{t.lastUsedAt === null ? 'Never' : day(t.lastUsedAt)}</dd>
						</div>
					</dl>
					<div class="tl-actions">
						{#if onregenerate && !expired}
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onclick={() => ask({ kind: 'regenerate', token: t })}
							>
								<RefreshCw size={13} /> Regenerate
							</Button>
						{/if}
						<Button
							variant="ghost"
							size="sm"
							class="text-destructive hover:bg-destructive/10"
							disabled={busy}
							onclick={() => ask({ kind: 'revoke', token: t })}
						>
							<X size={13} /> Revoke
						</Button>
					</div>
				</li>
			{/each}
		</ul>
		{#if onrevokeall && tokens.length > 1}
			<button
				type="button"
				class="tl-link tl-danger"
				disabled={busy}
				onclick={() => ask({ kind: 'revoke-all' })}
			>
				Revoke all {tokens.length} tokens
			</button>
		{/if}
	{/if}
</div>

<ConfirmDialog
	bind:open={confirmOpen}
	title={confirming?.kind === 'regenerate'
		? `Regenerate "${confirming.token.name}"?`
		: confirming?.kind === 'revoke'
			? `Revoke "${confirming.token.name}"?`
			: 'Revoke every token?'}
	description={confirming?.kind === 'regenerate'
		? 'You get a new secret. The old one stops working at once, so update everything that uses it. The permissions and expiry stay the same.'
		: confirming?.kind === 'revoke'
			? 'Anything using this token stops working at once. This cannot be undone.'
			: 'Anything using any of these tokens stops working at once. This cannot be undone.'}
	confirmLabel={confirming?.kind === 'regenerate'
		? 'Regenerate'
		: confirming?.kind === 'revoke'
			? 'Revoke'
			: 'Revoke all'}
	danger={confirming?.kind !== 'regenerate'}
	onConfirm={confirm}
/>

<style>
	.tl {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.tl-bar {
		display: flex;
		justify-content: flex-end;
	}
	.tl-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
	}
	.tl-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 20px;
		padding: 14px 16px;
		border-top: 1px solid var(--border);
	}
	.tl-row:first-child {
		border-top: none;
	}
	.tl-main {
		min-width: 0;
	}
	.tl-name {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 13.5px;
		font-weight: 600;
	}
	.tl-row.expired .tl-name {
		color: var(--muted-foreground);
	}
	.tl-four {
		font-size: 11.5px;
		font-weight: 400;
		color: var(--muted-foreground);
	}
	.tl-can {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-top: 4px;
		font-size: 12.5px;
	}
	.tl-area {
		color: var(--foreground);
		cursor: help;
	}
	.tl-level {
		color: var(--muted-foreground);
	}
	.tl-none {
		color: var(--muted-foreground);
	}
	.tl-dates {
		display: flex;
		gap: 20px;
		margin: 0;
	}
	.tl-dates div {
		min-width: 92px;
	}
	.tl-dates dt {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.tl-dates dd {
		margin: 2px 0 0;
		font-size: 12.5px;
		white-space: nowrap;
	}
	.tl-actions {
		display: flex;
		gap: 2px;
	}
	.tl-reveal {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 16px;
		border: 1px solid var(--primary);
		border-radius: var(--radius);
		background: var(--primary-soft);
	}
	.tl-reveal-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
	.tl-secret {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.tl-secret code {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--card);
		font-size: 12.5px;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.tl-link {
		align-self: flex-start;
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--muted-foreground);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.tl-link:hover {
		color: var(--foreground);
	}
	.tl-danger:hover {
		color: var(--destructive);
	}
	.tl-error {
		margin: 0;
		font-size: 13px;
		color: var(--destructive);
	}
	@media (max-width: 760px) {
		.tl-row {
			grid-template-columns: minmax(0, 1fr);
			gap: 10px;
		}
		.tl-actions {
			margin-left: -10px;
		}
	}
</style>
