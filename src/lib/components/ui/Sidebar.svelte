<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		Settings,
		Sun,
		Moon,
		LogOut,
		ChevronLeft,
		ChevronRight,
		Users,
		User,
		MoreHorizontal,
		History
	} from '@lucide/svelte';
	import { onMount, onDestroy } from 'svelte';
	import { appState } from '$lib/state/app.svelte.js';
	import { mode, setMode } from 'mode-watcher';
	import { NAV_ICONS_BY_ID, type SerializableNavItem } from '$lib/nav-config.js';
	import { APP_VERSION_LABEL } from '$lib/version.js';

	let {
		user,
		activePage,
		unpaidCount = 0,
		canManageUsers = false,
		canSeeSettings = false,
		canReadAudit = false,
		navItems = []
	}: {
		user: { username: string; name?: string | null; email?: string } | null;
		activePage: string;
		unpaidCount?: number;
		canManageUsers?: boolean;
		canSeeSettings?: boolean;
		canReadAudit?: boolean;
		navItems?: SerializableNavItem[];
	} = $props();

	const collapsed = $derived(appState.sidebarCollapsed);

	function badgeFor(item: SerializableNavItem): number | undefined {
		return item.id === 'records' ? unpaidCount : undefined;
	}

	function isActive(href: string) {
		return activePage === href || activePage.startsWith(href + '/');
	}

	function getInitials(displayName: string) {
		return displayName
			.split(/[\s._-]/)
			.map((p) => p[0])
			.join('')
			.toUpperCase()
			.slice(0, 2);
	}

	function toggleTheme() {
		setMode(mode.current === 'dark' ? 'light' : 'dark');
	}

	const isDark = $derived(mode.current === 'dark');
	const themeLabel = $derived(isDark ? 'Dark' : 'Light');
	const displayName = $derived(user?.name || user?.username || 'User');

	let menuOpen = $state(false);

	let tabletQuery: MediaQueryList | undefined;

	function handleTabletChange(e: MediaQueryListEvent) {
		if (e.matches) appState.sidebarCollapsed = true;
	}

	onMount(() => {
		tabletQuery = window.matchMedia('(max-width: 1023px)');
		if (tabletQuery.matches) appState.sidebarCollapsed = true;
		tabletQuery.addEventListener('change', handleTabletChange);
	});

	onDestroy(() => {
		tabletQuery?.removeEventListener('change', handleTabletChange);
	});

	function toggleMenu(e: MouseEvent) {
		e.stopPropagation();
		menuOpen = !menuOpen;
	}

	function closeMenu() {
		menuOpen = false;
	}
</script>

<svelte:window onclick={closeMenu} />

<aside class="sidebar" class:collapsed style="position:relative">
	<div class="sb-brand">
		<img class="sb-logo" src="/icons/icon-192.png" alt="Akaun" />
		{#if !collapsed}
			<div class="sb-brand-name">Akaun</div>
		{/if}
	</div>

	<div class="sb-section">
		{#if !collapsed}<div class="sb-section-label">Workspace</div>{/if}
		<nav class="sb-nav">
			{#each navItems as item}
				{@const Icon = NAV_ICONS_BY_ID[item.id]}
				<a
					href={item.href}
					class="sb-item"
					class:active={isActive(item.href)}
					title={collapsed ? item.label : undefined}
				>
					<Icon size={18} />
					{#if !collapsed}
						<span class="sb-item-label">{item.label}</span>
						{#if badgeFor(item)}
							<span class="sb-item-badge">{badgeFor(item)}</span>
						{/if}
					{/if}
				</a>
			{/each}
		</nav>
	</div>

	<div class="sb-spacer"></div>

	{#if canManageUsers || canReadAudit}
		<div class="sb-section">
			{#if !collapsed}<div class="sb-section-label">Administration</div>{/if}
			<nav class="sb-nav">
				{#if canManageUsers}
					<a
						href="/users-groups"
						class="sb-item"
						class:active={isActive('/users-groups')}
						title={collapsed ? 'Users & Groups' : undefined}
					>
						<Users size={18} />
						{#if !collapsed}
							<span class="sb-item-label">Users &amp; Groups</span>
						{/if}
					</a>
				{/if}
				{#if canReadAudit}
					<a
						href={resolve('/(app)/audit')}
						class="sb-item"
						class:active={isActive('/audit')}
						title={collapsed ? 'Audit log' : undefined}
					>
						<History size={18} />
						{#if !collapsed}
							<span class="sb-item-label">Audit log</span>
						{/if}
					</a>
				{/if}
			</nav>
		</div>
	{/if}

	<div class="sb-section">
		<nav class="sb-nav">
			{#if canSeeSettings}
				<a
					href="/settings"
					class="sb-item"
					class:active={isActive('/settings')}
					title={collapsed ? 'Settings' : undefined}
				>
					<Settings size={18} />
					{#if !collapsed}<span class="sb-item-label">Settings</span>{/if}
				</a>
			{/if}
			<button class="sb-item sb-theme" title="Toggle theme" onclick={toggleTheme}>
				{#if isDark}
					<Moon size={18} />
				{:else}
					<Sun size={18} />
				{/if}
				{#if !collapsed}<span class="sb-item-label">{themeLabel}</span>{/if}
			</button>
			<button
				class="sb-item"
				title={collapsed ? 'Toggle sidebar' : undefined}
				onclick={() => (appState.sidebarCollapsed = !appState.sidebarCollapsed)}
			>
				{#if collapsed}
					<ChevronRight size={18} />
				{:else}
					<ChevronLeft size={18} />
					<span class="sb-item-label">Collapse</span>
				{/if}
			</button>
		</nav>
	</div>

	<!-- User card -->
	<div class="sb-user">
		<div class="sb-avatar">{user ? getInitials(displayName) : '?'}</div>
		{#if !collapsed}
			<div class="sb-user-text">
				<div class="sb-user-name">{displayName}</div>
				{#if user?.email}
					<div class="sb-user-mail">{user.email}</div>
				{/if}
			</div>
		{/if}
		<button
			class="sb-user-trigger"
			onclick={toggleMenu}
			aria-label="User menu"
			aria-expanded={menuOpen}
			title="User menu"
		>
			<MoreHorizontal size={15} />
		</button>
	</div>

	{#if !collapsed}
		<div class="sb-version" title={APP_VERSION_LABEL}>{APP_VERSION_LABEL}</div>
	{/if}

	<!-- Popup menu — anchored to the aside, opens to the right -->
	{#if menuOpen}
		<div class="sb-user-menu" role="none" onclick={(e) => e.stopPropagation()}>
			<div class="sb-menu-header">
				<div class="sb-menu-avatar">{user ? getInitials(displayName) : '?'}</div>
				<div class="sb-menu-userinfo">
					<div class="sb-menu-name">{displayName}</div>
					{#if user?.email}<div class="sb-menu-email">{user.email}</div>{/if}
				</div>
			</div>
			<div class="sb-menu-sep"></div>
			<a href="/profile" class="sb-menu-item" onclick={closeMenu}>
				<User size={14} />
				<span>Profile</span>
			</a>
			<div class="sb-menu-sep"></div>
			<form method="POST" action="/logout">
				<button type="submit" class="sb-menu-item danger">
					<LogOut size={14} />
					<span>Sign out</span>
				</button>
			</form>
		</div>
	{/if}
</aside>

<style>
	.sb-user {
		display: flex;
		align-items: center;
		gap: 8px;
		/* Asymmetric on purpose: the version line sits directly below, so the card only needs
		   enough room under the email to clear it, not a full 9px. Collapsed overrides this. */
		padding: 9px 8px 2px;
		margin-top: 4px;
		border-top: 1px solid var(--sidebar-border);
	}

	.sb-user-text {
		flex: 1;
		min-width: 0;
	}

	.sb-user-mail {
		font-size: 11px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Sits under the user card, inside the border-top .sb-user already draws, and one step
	   quieter than the email above it. Hidden when collapsed — the rail is too narrow. */
	.sb-version {
		/* 2px card padding + the sidebar's 6px flex gap sit above; 3px here plus 3px on the
		   container sit below. Roughly even, with the bottom still tight. */
		padding: 0 8px 3px;
		font-size: 10.5px;
		color: var(--muted-foreground);
		text-align: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* .sidebar in layout.css pads 14px all round, which is most of the gap under the version.
	   Only trim it when the version is the last child — collapsed hides the version, so the
	   avatar keeps the original breathing room. */
	.sidebar:not(.collapsed) {
		padding-bottom: 3px;
	}

	.sb-user-trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		border-radius: 6px;
		border: none;
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
		margin-left: auto;
	}

	.sb-user-trigger:hover {
		background: var(--accent);
		color: var(--foreground);
	}

	/* Menu pops out to the right of the aside */
	.sb-user-menu {
		position: absolute;
		left: calc(100% + 8px);
		bottom: 8px;
		width: 240px;
		background: var(--popover);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		overflow: hidden;
		z-index: 100;
	}

	.sb-menu-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
	}

	.sb-menu-avatar {
		width: 36px;
		height: 36px;
		border-radius: 9px;
		flex-shrink: 0;
		background: var(--accent);
		color: var(--foreground);
		display: grid;
		place-items: center;
		font-weight: 600;
		font-size: 13px;
		border: 1px solid var(--border);
	}

	.sb-menu-userinfo {
		min-width: 0;
	}

	.sb-menu-name {
		font-size: 13px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sb-menu-email {
		font-size: 11.5px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sb-menu-sep {
		height: 1px;
		background: var(--border);
	}

	.sb-menu-item {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 9px 14px;
		font-size: 13px;
		width: 100%;
		text-align: left;
		text-decoration: none;
		color: var(--foreground);
		cursor: pointer;
		background: none;
		border: none;
		font-family: inherit;
		transition: background 0.1s;
	}

	.sb-menu-item:hover {
		background: var(--accent);
	}

	.sb-menu-item.danger {
		color: var(--red);
	}

	/* Reset form default to allow button to fill width */
	form {
		display: contents;
	}

	/* Collapsed: center the avatar and trigger vertically */
	:global(.collapsed) .sb-user {
		flex-direction: column;
		gap: 4px;
		padding: 8px 4px;
	}

	:global(.collapsed) .sb-user-trigger {
		margin-left: 0;
	}
</style>
