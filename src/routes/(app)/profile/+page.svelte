<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import TokenList, { type TokenOutcome } from '$lib/components/permissions/TokenList.svelte';
	import { GripVertical } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { toast } from 'svelte-sonner';
	import { flip } from 'svelte/animate';
	import { draggable, droppable } from '@thisux/sveltednd';
	import type { DragDropState } from '@thisux/sveltednd';
	import type { PageData, ActionData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'profile' | 'security' | 'token' | 'navigation' | 'apps';
	const TAB_IDS: Tab[] = ['profile', 'security', 'token', 'navigation', 'apps'];

	// The open tab is kept in the address (`?tab=token`), as on Settings, so the
	// New token page's way back lands on the list it came from.
	function tabFromUrl(): Tab {
		const asked = page.url.searchParams.get('tab') as Tab | null;
		return asked && TAB_IDS.includes(asked) ? asked : 'profile';
	}
	let activeTab = $state<Tab>(tabFromUrl());

	function showTab(id: Tab) {
		activeTab = id;
		const path = resolve('/(app)/profile');
		// A shallow replace: the tab is page state, not a new page to go back to.
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- route is resolved above; only the tab is appended.
		replaceState(id === 'profile' ? path : `${path}?tab=${id}`, page.state);
	}

	// Navigation tab state — local reorderable copy, synced from data
	type NavPrefItem = { id: string; label: string; showOnMobile: boolean };
	let navItems = $state<NavPrefItem[]>([]);

	$effect(() => {
		navItems = data.navItems.map((i) => ({ ...i }));
	});

	const mobileCount = $derived(navItems.filter((i) => i.showOnMobile).length);
	const MAX_MOBILE = 5;

	function reorderItems<T extends { id: string | number }>(
		arr: T[],
		draggedItem: T,
		targetElement: HTMLElement | null,
		dropPosition: 'before' | 'after' | null
	): T[] {
		if (!targetElement || !dropPosition) return arr;
		const targetId = targetElement.closest<HTMLElement>('[data-id]')?.dataset.id;
		if (!targetId || String(draggedItem.id) === targetId) return arr;
		const result = [...arr];
		const fromIndex = result.findIndex((i) => String(i.id) === String(draggedItem.id));
		if (fromIndex === -1) return arr;
		const [item] = result.splice(fromIndex, 1);
		const newTargetIdx = result.findIndex((i) => String(i.id) === targetId);
		if (newTargetIdx === -1) return arr;
		result.splice(dropPosition === 'after' ? newTargetIdx + 1 : newTargetIdx, 0, item);
		return result;
	}

	const reducedMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const flipDurationMs = reducedMotion ? 0 : 200;

	function handleDrop(state: DragDropState<NavPrefItem>) {
		if (!state.draggedItem) return;
		navItems = reorderItems(navItems, state.draggedItem, state.targetElement, state.dropPosition);
	}

	function navItemsJson() {
		return JSON.stringify(navItems.map((i) => ({ itemId: i.id, showOnMobile: i.showOnMobile })));
	}

	// Profile tab state — initialized empty, synced from data via $effect
	let profileName = $state('');
	let profileEmail = $state('');
	let profileUsername = $state('');

	// Keep form fields in sync with data (initial load + after successful saves)
	$effect(() => {
		profileName = data.name ?? '';
		profileEmail = data.email;
		profileUsername = data.username;
	});

	// Security tab state
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let passwordMismatch = $derived(confirmPassword.length > 0 && newPassword !== confirmPassword);

	/**
	 * Posts one of this page's token form actions and refreshes the page data.
	 * Form actions, not an API: they are reached only from a signed-in browser.
	 */
	async function tokenAction(action: string, fields: Record<string, string>): Promise<TokenOutcome> {
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		const response = await fetch(`?/${action}`, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		await invalidateAll();
		if (result.type === 'success') {
			const token = (result.data as { newToken?: string } | undefined)?.newToken;
			toast.success(token ? 'Token regenerated — copy the new secret now' : 'Token revoked');
			return { token };
		}
		if (result.type === 'failure')
			return { error: (result.data as { error?: string } | undefined)?.error ?? 'That did not work.' };
		return { error: 'That did not work.' };
	}

	$effect(() => {
		if (!form) return;
		if (form.action === 'profile' && form.success) {
			toast.success('Profile updated');
		} else if (form.action === 'security' && form.success) {
			toast.success('Password changed');
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
		} else if (form.action === 'apps' && form.success) {
			toast.success('App access revoked');
		} else if (form.action === 'navigation') {
			if (form.success) toast.success('Navigation order saved');
			else if (form.error) toast.error(form.error);
		}
	});

	const TABS: { id: Tab; label: string }[] = [
		{ id: 'profile', label: 'Profile' },
		{ id: 'security', label: 'Security' },
		{ id: 'token', label: 'Access tokens' },
		{ id: 'apps', label: 'Connected apps' },
		{ id: 'navigation', label: 'Navigation' }
	];
</script>

<svelte:head>
	<title>Profile - Akaun</title>
</svelte:head>

<div class="screen">
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">My Profile</h1>
			<p class="page-sub">Manage your account details and access</p>
		</div>
	</header>

	<div class="set-layout">
		<nav class="set-nav">
			{#each TABS as tab (tab.id)}
				<button
					class="set-nav-item"
					class:active={activeTab === tab.id}
					onclick={() => showTab(tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</nav>

		<div class="set-content">
			{#if activeTab === 'apps'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Connected apps</h2>
						<p class="set-section-sub">
							Apps allowed to read your Akaun data. Revoking access disconnects
							the app immediately.
						</p>
					</div>
					{#if !data.connectedApps.length}<p class="p-4 text-sm">
							No apps connected.
						</p>{/if}
					{#each data.connectedApps as app (app.id)}
						<div class="set-row">
							<div class="min-w-0">
								<h3 class="font-medium">{app.clientName}</h3>
								<p class="text-muted-foreground text-sm">
									{app.scopes.join(', ')}
								</p>
								<p class="text-muted-foreground text-xs">
									Connected {new Date(app.createdAt).toLocaleDateString()} · Expires
									{new Date(app.expiresAt).toLocaleDateString()}
								</p>
								<p class="text-muted-foreground text-xs">
									Last used: {app.lastUsedAt
										? new Date(app.lastUsedAt).toLocaleString()
										: 'Never'}
								</p>
							</div>
							<form method="POST" action="?/revokeApp" use:enhance>
								<input type="hidden" name="grantId" value={app.id} />
								<Button type="submit" variant="outline">Revoke access</Button>
							</form>
						</div>
					{/each}
				</div>
			{:else if activeTab === 'profile'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Profile</h2>
						<p class="set-section-sub">Update your display name, email, and username</p>
					</div>
					<form
						method="POST"
						action="?/updateProfile"
						use:enhance
					>
						<div class="set-rows">
							<div class="set-row">
								<div class="set-row-label">Display name</div>
								<Input
									class="set-input-right"
									type="text"
									name="name"
									placeholder="Your full name"
									bind:value={profileName}
								/>
							</div>
							<div class="set-row">
								<div class="set-row-label">Email</div>
								<Input
									class="set-input-right"
									type="email"
									name="email"
									required
									bind:value={profileEmail}
								/>
							</div>
							<div class="set-row">
								<div class="set-row-label">Username</div>
								<Input
									class="set-input-right"
									type="text"
									name="username"
									required
									bind:value={profileUsername}
								/>
							</div>
						</div>
						{#if form?.action === 'profile' && form?.error}
							<p class="form-error">{form.error}</p>
						{/if}
						<Button type="submit" class="mt-4">Save changes</Button>
					</form>
				</div>

			{:else if activeTab === 'security'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Change Password</h2>
						<p class="set-section-sub">Choose a strong password of at least 8 characters</p>
					</div>
					<form
						method="POST"
						action="?/changePassword"
						use:enhance
					>
						<div class="set-rows">
							<div class="set-row">
								<div class="set-row-label">Current password</div>
								<Input
									class="set-input-right"
									type="password"
									name="currentPassword"
									required
									bind:value={currentPassword}
									autocomplete="current-password"
								/>
							</div>
							<div class="set-row">
								<div class="set-row-label">New password</div>
								<Input
									class="set-input-right"
									type="password"
									name="newPassword"
									required
									minlength={8}
									bind:value={newPassword}
									autocomplete="new-password"
								/>
							</div>
							<div class="set-row">
								<div class="set-row-label">Confirm new password</div>
								<Input
									class="set-input-right"
									type="password"
									name="confirmPassword"
									required
									bind:value={confirmPassword}
									autocomplete="new-password"
									aria-invalid={passwordMismatch}
								/>
							</div>
							{#if passwordMismatch}
								<p class="form-error" style="margin:0 16px;">Passwords do not match.</p>
							{/if}
						</div>
						{#if form?.action === 'security' && form?.error}
							<p class="form-error">{form.error}</p>
						{/if}
						<Button type="submit" class="mt-4" disabled={passwordMismatch}>
							Change password
						</Button>
					</form>
				</div>

			{:else if activeTab === 'token'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Access tokens</h2>
						<p class="set-section-sub">
							Personal access tokens let a script or an AI assistant use Akaun as you, with only the
							permissions you give each one. Send one in an <code>Authorization: Bearer</code> header.
						</p>
					</div>
					<TokenList
						tokens={data.tokens}
						newHref={resolve('/(app)/profile/tokens/new')}
						onregenerate={(id) => tokenAction('regenerateToken', { tokenId: String(id) })}
						onrevoke={(id) => tokenAction('revokeToken', { tokenId: String(id) })}
						onrevokeall={() => tokenAction('revokeAllTokens', {})}
					/>
				</div>

			{:else if activeTab === 'navigation'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Navigation</h2>
						<p class="set-section-sub">
							Choose the order of your nav items and which ones appear in the mobile bottom nav
							(max {MAX_MOBILE}). Everything else is reachable from the menu drawer.
						</p>
					</div>

					<form method="POST" action="?/saveNavOrder" use:enhance>
						<input type="hidden" name="items" value={navItemsJson()} />
						<div class="nav-pref-list">
							{#each navItems as item (item.id)}
								<div
									class="nav-pref-row"
									data-id={item.id}
									animate:flip={{ duration: flipDurationMs }}
									use:draggable={{ container: 'nav-pref', dragData: item, handle: '.nav-pref-handle' }}
									use:droppable={{ container: 'nav-pref', callbacks: { onDrop: handleDrop } }}
								>
									<span class="nav-pref-handle" aria-label={`Drag to reorder ${item.label}`}>
										<GripVertical size={16} />
									</span>
									<span class="nav-pref-label">{item.label}</span>
									<label class="nav-pref-checkbox">
										<Checkbox
											bind:checked={item.showOnMobile}
											disabled={!item.showOnMobile && mobileCount >= MAX_MOBILE}
										/>
										<span>Show on mobile</span>
									</label>
								</div>
							{/each}
						</div>
						{#if form?.action === 'navigation' && form?.error}
							<p class="form-error">{form.error}</p>
						{/if}
						<Button type="submit" class="mt-4">Save changes</Button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.form-error {
		margin: 10px 16px 0;
		font-size: 12px;
		color: var(--red);
	}

	.nav-pref-list {
		display: flex;
		flex-direction: column;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}


	.nav-pref-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		transition: background 0.15s;
	}

	.nav-pref-row:global(.dragging) {
		background: var(--accent);
		opacity: 0.55;
	}

	.nav-pref-row:last-child {
		border-bottom: none;
	}

	.nav-pref-handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		flex-shrink: 0;
		color: var(--muted-foreground);
		cursor: grab;
		touch-action: none;
	}

	.nav-pref-row:active .nav-pref-handle {
		cursor: grabbing;
	}

	.nav-pref-label {
		flex: 1;
		font-size: 13.5px;
		font-weight: 500;
	}

	.nav-pref-checkbox {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--muted-foreground);
		cursor: pointer;
	}
</style>
