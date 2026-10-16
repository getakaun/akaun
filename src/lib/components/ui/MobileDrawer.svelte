<script lang="ts">
	import { resolve } from '$app/paths';
	import { Settings, Sun, Moon, LogOut, User, Users, History } from '@lucide/svelte';
	import { page } from '$app/stores';
	import { mode, setMode } from 'mode-watcher';
	import { MAX_MOBILE_NAV_ITEMS, NAV_ICONS_BY_ID, type SerializableNavItem } from '$lib/nav-config.js';
	import { APP_VERSION_LABEL } from '$lib/version.js';

	let {
		open = $bindable(false),
		user,
		canManageUsers = false,
		canSeeSettings = false,
		canReadAudit = false,
		navItems = []
	}: {
		open?: boolean;
		user: { username: string; name?: string | null; email?: string } | null;
		canManageUsers?: boolean;
		canSeeSettings?: boolean;
		canReadAudit?: boolean;
		navItems?: (SerializableNavItem & { showOnMobile: boolean })[];
	} = $props();

	const overflowItems = $derived.by(() => {
		const bottomNavIds = new Set(
			navItems.filter((item) => item.showOnMobile).slice(0, MAX_MOBILE_NAV_ITEMS).map((i) => i.id)
		);
		return navItems.filter((item) => !bottomNavIds.has(item.id));
	});

	let closing = $state(false);
	let panelEl: HTMLDivElement | undefined = $state();

	const displayName = $derived(user?.name || user?.username || 'User');
	const isDark = $derived(mode.current === 'dark');
	const activePage = $derived($page.url.pathname);

	function getInitials(name: string) {
		return name
			.split(/[\s._-]/)
			.map((p) => p[0])
			.join('')
			.toUpperCase()
			.slice(0, 2);
	}

	function isActive(href: string) {
		return activePage === href || activePage.startsWith(href + '/');
	}

	function close() {
		closing = true;
	}

	function onAnimationEnd() {
		if (closing) {
			open = false;
			closing = false;
		}
	}

	function toggleTheme() {
		setMode(isDark ? 'light' : 'dark');
	}

	$effect(() => {
		if (open) {
			document.body.style.overflow = 'hidden';
			return () => {
				document.body.style.overflow = '';
			};
		}
	});

	$effect(() => {
		if (open && panelEl) {
			panelEl.querySelector<HTMLElement>('a, button')?.focus();
		}
	});
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && open) close(); }} />

{#if open || closing}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
	<div class="drawer-backdrop" class:closing onclick={(e) => { if (!panelEl?.contains(e.target as Node)) close(); }} aria-hidden="true"></div>

	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
	<div
		class="drawer-panel"
		class:open={open && !closing}
		class:closing
		bind:this={panelEl}
		role="dialog"
		aria-modal="true"
		aria-label="Navigation menu"
		tabindex="-1"
		onanimationend={onAnimationEnd}
	>
		<!-- Brand -->
		<div class="drawer-brand">
			<img class="drawer-logo" src="/icons/icon-192.png" alt="Akaun" />
			<div class="drawer-brand-name">Akaun</div>
		</div>

		<!-- User card -->
		<div class="drawer-user">
			<div class="drawer-avatar">{user ? getInitials(displayName) : '?'}</div>
			<div class="drawer-user-text">
				<div class="drawer-user-name">{displayName}</div>
				{#if user?.email}<div class="drawer-user-mail">{user.email}</div>{/if}
			</div>
		</div>

		<!-- Nav groups -->
		<div class="drawer-groups">

			<!-- Overflow main-nav items not pinned to the mobile bottom nav -->
			{#if overflowItems.length > 0}
				<div class="drawer-group">
					<div class="drawer-group-label">More</div>
					{#each overflowItems as item}
						{@const Icon = NAV_ICONS_BY_ID[item.id]}
						<a href={item.href} class="drawer-item" class:active={isActive(item.href)} onclick={close}>
							<Icon size={17} /><span>{item.label}</span>
						</a>
					{/each}
				</div>
			{/if}

			<!-- Preferences -->
			<div class="drawer-group">
				{#if canSeeSettings}
					<a href="/settings" class="drawer-item" class:active={isActive('/settings')} onclick={close}>
						<Settings size={17} /><span>Settings</span>
					</a>
				{/if}
				<button class="drawer-item" onclick={toggleTheme}>
					{#if isDark}<Moon size={17} />{:else}<Sun size={17} />{/if}
					<span>{isDark ? 'Dark' : 'Light'} mode</span>
				</button>
			</div>

			<!-- Administration — users.manage or audit.read, each link its own -->
			{#if canManageUsers || canReadAudit}
				<div class="drawer-group">
					<div class="drawer-group-label">Administration</div>
					{#if canManageUsers}
						<a
							href="/users-groups"
							class="drawer-item"
							class:active={isActive('/users-groups')}
							onclick={close}
						>
							<Users size={17} /><span>Users &amp; Groups</span>
						</a>
					{/if}
					{#if canReadAudit}
						<a href={resolve('/(app)/audit')} class="drawer-item" class:active={isActive('/audit')} onclick={close}>
							<History size={17} /><span>Audit log</span>
						</a>
					{/if}
				</div>
			{/if}

			<!-- Account -->
			<div class="drawer-group">
				<div class="drawer-group-label">Account</div>
				<a href="/profile" class="drawer-item" class:active={isActive('/profile')} onclick={close}>
					<User size={17} /><span>Profile</span>
				</a>
				<form method="POST" action="/logout">
					<button type="submit" class="drawer-item danger">
						<LogOut size={17} /><span>Sign out</span>
					</button>
				</form>
			</div>

		</div>

		<div class="drawer-version" title={APP_VERSION_LABEL}>{APP_VERSION_LABEL}</div>
	</div>
{/if}

<style>
	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: oklch(0 0 0 / 0.4);
		animation: drawer-bg-in 0.2s ease forwards;
	}
	.drawer-backdrop.closing {
		animation: drawer-bg-out 0.25s ease forwards;
	}

	.drawer-panel {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		width: min(80vw, 280px);
		background: var(--sidebar);
		border-right: 1px solid var(--sidebar-border);
		z-index: 61;
		display: flex;
		flex-direction: column;
		transform: translateX(-100%);
		overflow-y: auto;
	}
	.drawer-panel.open {
		animation: drawer-in 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
	}
	.drawer-panel.closing {
		animation: drawer-out 0.22s cubic-bezier(0.4, 0, 1, 1) forwards;
	}

	@keyframes drawer-in  { to { transform: translateX(0); } }
	@keyframes drawer-out { to { transform: translateX(-100%); } }
	@keyframes drawer-bg-in  { from { opacity: 0; } to { opacity: 1; } }
	@keyframes drawer-bg-out { from { opacity: 1; } to { opacity: 0; } }

	/* Brand */
	.drawer-brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 20px 14px 16px;
		flex-shrink: 0;
	}


	.drawer-logo {
		width: 30px;
		height: 30px;
		border-radius: 8px;
		flex-shrink: 0;
		object-fit: contain;
		filter: drop-shadow(0 2px 6px oklch(0.646 0.187 41.6 / 0.3));
	}

	.drawer-brand-name {
		font-size: 14px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	/* User card */
	.drawer-user {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px 14px;
		border-bottom: 1px solid var(--sidebar-border);
	}

	.drawer-avatar {
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
		font-family: 'Geist', system-ui, sans-serif;
	}

	.drawer-user-text { min-width: 0; }

	.drawer-user-name {
		font-size: 13px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.drawer-user-mail {
		font-size: 11px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-top: 1px;
	}

	/* Groups */
	.drawer-groups {
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 8px 0 12px;
	}

	/* The drawer's user card is at the top under the brand, so the version reads as a footer
	   at the bottom instead. .drawer-groups is flex:1, which pushes this down on its own. */
	.drawer-version {
		padding: 5px 16px;
		border-top: 1px solid var(--sidebar-border);
		font-size: 11px;
		color: var(--muted-foreground);
		text-align: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.drawer-group {
		padding: 4px 0;
		display: flex;
		flex-direction: column;
	}

	.drawer-group + .drawer-group {
		border-top: 1px solid var(--sidebar-border);
		margin-top: 4px;
		padding-top: 8px;
	}

	.drawer-group-label {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		padding: 2px 14px 6px;
	}

	/* Nav items — match sidebar .sb-item style */
	.drawer-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 8px;
		margin: 1px 6px;
		font-size: 13.5px;
		font-weight: 500;
		text-decoration: none;
		color: var(--foreground);
		cursor: pointer;
		background: none;
		border: none;
		border-radius: 6px;
		font-family: 'Geist', system-ui, sans-serif;
		transition: background 0.1s, color 0.1s;
		-webkit-tap-highlight-color: transparent;
		position: relative;
	}

	.drawer-item:hover,
	.drawer-item:focus-visible {
		background: var(--accent);
		outline: none;
	}

	.drawer-item.active {
		color: var(--primary);
		background: color-mix(in oklch, var(--primary) 8%, transparent);
	}

	.drawer-item.active::before {
		content: '';
		position: absolute;
		left: -6px;
		top: 6px;
		bottom: 6px;
		width: 3px;
		border-radius: 0 2px 2px 0;
		background: var(--primary);
	}

	.drawer-item.danger { color: var(--red); }

	form { display: contents; }

	/* Safe-area vars are 0 in a browser tab and the real insets in a PWA, so the
	   brand clears the status bar and the footer clears the home indicator only
	   when installed. */
	.drawer-brand { padding-top: calc(20px + var(--safe-top)); }
	.drawer-version { padding-bottom: calc(5px + var(--safe-bottom)); }
</style>
