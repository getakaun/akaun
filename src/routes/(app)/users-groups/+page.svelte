<script lang="ts">
	import { onMount } from 'svelte';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { toast } from 'svelte-sonner';
	import {
		Shield,
		ShieldCheck,
		AlertTriangle,
		Plus,
		Pencil,
		Key,
		Trash2,
		X,
		Lock,
		MoreHorizontal,
		UserPlus
	} from '@lucide/svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import AccessEditor from '$lib/components/permissions/AccessEditor.svelte';
	import TokenList, {
		type TokenOutcome,
		type TokenRow
	} from '$lib/components/permissions/TokenList.svelte';
	import {
		LEAF_PERMISSIONS,
		isDelegable,
		leafMeta,
		type LeafPermission
	} from '$lib/permissions/catalog.js';

	// ─── Types ───────────────────────────────────────────────────────────────────

	type GroupSummary = { id: number; name: string };
	type UserRow = {
		id: number;
		name: string | null;
		email: string;
		username: string;
		tokenCount: number;
		groups: GroupSummary[];
		isSuperuser: boolean;
		extraGrants: LeafPermission[];
		createdAt: string;
	};
	type GroupRow = {
		id: number;
		name: string;
		description: string;
		isSuperuser: boolean;
		grants: LeafPermission[];
		delegations: LeafPermission[];
		memberCount: number;
		/** Administrators: never renamed, changed or deleted. */
		locked: boolean;
	};
	type UserTokens = { tokens: TokenRow[] };

	/** Every leaf a non-superuser group could be granted. */
	const GRANTABLE = new Set(LEAF_PERMISSIONS.filter((leaf) => !leafMeta(leaf).superuserOnly));

	// ─── Mobile detection ─────────────────────────────────────────────────────────

	const screen = useIsMobile();
	const isMobile = $derived(screen.current);
	const panelSide = $derived(isMobile ? 'bottom' : 'right');

	// ─── State ───────────────────────────────────────────────────────────────────

	let activeTab = $state<'users' | 'groups'>('users');
	let userList = $state<UserRow[]>([]);
	let groupList = $state<GroupRow[]>([]);
	let loading = $state(true);

	// Users tab
	let editingUser = $state<Partial<UserRow> & { password?: string; groupIds?: number[] } | null>(null);
	let editingUserExtraGrants = $state<LeafPermission[]>([]);
	let userSheetOpen = $state(false);
	let userTokens = $state<UserTokens | null>(null);
	let savingUser = $state(false);

	// Groups tab
	let selectedGroupId = $state<number | null>(null);
	let groupSheetOpen = $state(false);
	let savingGroup = $state(false);

	const selectedGroup = $derived(groupList.find((g) => g.id === selectedGroupId) ?? null);
	const noGroupCount = $derived(userList.filter((u) => u.groups.length === 0).length);

	/** What the user being edited already has from their groups. */
	const editingInherited = $derived.by((): ReadonlySet<LeafPermission> => {
		const chosen = groupList.filter((g) => (editingUser?.groupIds ?? []).includes(g.id));
		if (chosen.some((g) => g.isSuperuser)) return new Set(LEAF_PERMISSIONS);
		return new Set(chosen.flatMap((g) => g.grants));
	});

	// ─── Data loading ─────────────────────────────────────────────────────────────

	async function loadAll() {
		loading = true;
		try {
			const [usersRes, groupsRes] = await Promise.all([fetch('/api/users'), fetch('/api/groups')]);
			userList = await usersRes.json();
			groupList = await groupsRes.json();
			if (!selectedGroupId && groupList.length > 0) selectedGroupId = groupList[0].id;
		} catch {
			toast.error('Failed to load data');
		} finally {
			loading = false;
		}
	}

	onMount(loadAll);

	// ─── User helpers ─────────────────────────────────────────────────────────────

	function userAccess(u: UserRow) {
		if (u.isSuperuser) return 'super';
		if (u.groups.length === 0) return 'none';
		return 'standard';
	}

	function initials(name: string | null, email: string) {
		const src = name || email;
		return src.split(/[\s@._-]/).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
	}

	function openNewUser() {
		editingUser = { name: '', email: '', username: '', password: '', groupIds: [], extraGrants: [] };
		editingUserExtraGrants = [];
		userTokens = null;
		userSheetOpen = true;
	}

	async function loadUserTokens(userId: number) {
		const res = await fetch(`/api/users/${userId}/tokens`);
		userTokens = res.ok ? await res.json() : null;
	}

	function openEditUser(u: UserRow) {
		editingUser = { ...u, password: '', groupIds: u.groups.map((g) => g.id) };
		editingUserExtraGrants = [...u.extraGrants];
		userTokens = null;
		userSheetOpen = true;
		loadUserTokens(u.id);
	}

	function closeUserSheet() {
		userSheetOpen = false;
		editingUser = null;
		editingUserExtraGrants = [];
		userTokens = null;
	}

	function toggleGroup(gid: number) {
		if (!editingUser) return;
		const ids = editingUser.groupIds ?? [];
		editingUser = {
			...editingUser,
			groupIds: ids.includes(gid) ? ids.filter((x) => x !== gid) : [...ids, gid]
		};
	}

	async function saveUserGrants(userId: number) {
		await fetch(`/api/users/${userId}/grants`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			// Only what the groups do not already give: a user grant only adds.
			body: JSON.stringify({
				grants: editingUserExtraGrants.filter((leaf) => !editingInherited.has(leaf))
			})
		});
	}

	async function saveUser() {
		if (!editingUser) return;
		savingUser = true;
		try {
			const isNew = !editingUser.id;
			if (isNew) {
				const res = await fetch('/api/users', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: editingUser.name || null,
						email: editingUser.email,
						username: editingUser.username,
						password: editingUser.password,
						groupIds: editingUser.groupIds
					})
				});
				if (!res.ok) {
					const err = await res.json();
					toast.error(err.error ?? 'Failed to create user');
					return;
				}
				const { id } = await res.json();
				await fetch(`/api/users/${id}/groups`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ groupIds: editingUser.groupIds })
				});
				await saveUserGrants(id);
				toast.success('User created');
			} else {
				const patch: Record<string, unknown> = {};
				if (editingUser.name !== undefined) patch.name = editingUser.name;
				if (editingUser.email) patch.email = editingUser.email;
				if (editingUser.username) patch.username = editingUser.username;
				if (editingUser.password) patch.password = editingUser.password;

				if (Object.keys(patch).length > 0) {
					await fetch(`/api/users/${editingUser.id}`, {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(patch)
					});
				}
				const groupsRes = await fetch(`/api/users/${editingUser.id}/groups`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ groupIds: editingUser.groupIds })
				});
				if (!groupsRes.ok) {
					// The last superuser cannot leave: the sheet stays open to fix it.
					const err = await groupsRes.json().catch(() => null);
					toast.error(err?.error ?? 'Could not save the groups');
					return;
				}
				await saveUserGrants(editingUser.id!);
				toast.success('User saved');
			}
			closeUserSheet();
			await loadAll();
		} finally {
			savingUser = false;
		}
	}

	async function deleteUser(u: UserRow): Promise<boolean> {
		if (!confirm(`Remove ${u.name || u.email}? This cannot be undone.`)) return false;
		const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
		if (!res.ok) {
			const err = await res.json();
			toast.error(err.error ?? 'Failed to delete user');
			return false;
		} else {
			toast.success('User removed');
			await loadAll();
			return true;
		}
	}

	// ─── Tokens (administrator) ───────────────────────────────────────────────────

	async function tokenRequest(url: string, init: RequestInit): Promise<TokenOutcome> {
		const res = await fetch(url, init);
		const body = res.status === 204 ? null : await res.json().catch(() => null);
		if (editingUser?.id) await loadUserTokens(editingUser.id);
		await loadAll();
		if (!res.ok) return { error: body?.error ?? body?.reason ?? 'That did not work.' };
		return {};
	}

	// ─── Group helpers ────────────────────────────────────────────────────────────

	type GroupDraft = {
		name: string;
		description: string;
		isSuperuser: boolean;
		grants: LeafPermission[];
		delegations: LeafPermission[];
	};

	function draftOf(g: GroupRow): GroupDraft {
		return {
			name: g.name,
			description: g.description,
			isSuperuser: g.isSuperuser,
			grants: [...g.grants],
			delegations: [...g.delegations]
		};
	}
	let groupDraft = $state<GroupDraft | null>(null);

	$effect(() => {
		groupDraft = selectedGroup ? draftOf(selectedGroup) : null;
	});

	const isDirty = $derived(
		groupDraft !== null &&
		selectedGroup !== null &&
		(
			groupDraft.name !== selectedGroup.name ||
			groupDraft.description !== selectedGroup.description ||
			groupDraft.isSuperuser !== selectedGroup.isSuperuser ||
			JSON.stringify(groupDraft.grants) !== JSON.stringify(selectedGroup.grants) ||
			JSON.stringify(groupDraft.delegations) !== JSON.stringify(selectedGroup.delegations)
		)
	);

	async function createGroup() {
		const res = await fetch('/api/groups', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'New group', description: '' })
		});
		if (!res.ok) { toast.error('Failed to create group'); return; }
		const { id } = await res.json();
		await loadAll();
		selectedGroupId = id;
	}

	async function saveGroupDraft() {
		if (!selectedGroup || !groupDraft) return;
		savingGroup = true;
		try {
			const metaPatch: Record<string, unknown> = {};
			if (groupDraft.name !== selectedGroup.name) metaPatch.name = groupDraft.name;
			if (groupDraft.description !== selectedGroup.description) metaPatch.description = groupDraft.description;
			if (groupDraft.isSuperuser !== selectedGroup.isSuperuser) metaPatch.isSuperuser = groupDraft.isSuperuser;

			if (Object.keys(metaPatch).length > 0) {
				const res = await fetch(`/api/groups/${selectedGroup.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(metaPatch)
				});
				if (!res.ok) {
					const err = await res.json();
					toast.error(err.error ?? 'Failed to save group');
					return;
				}
			}

			if (!groupDraft.isSuperuser) {
				const res = await fetch(`/api/groups/${selectedGroup.id}/access`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						grants: groupDraft.grants,
						delegations: groupDraft.delegations
					})
				});
				if (!res.ok) {
					const err = await res.json().catch(() => null);
					toast.error(err?.error ?? 'Failed to save permissions');
					return;
				}
			}

			await loadAll();
			toast.success('Group saved');
		} finally {
			savingGroup = false;
		}
	}

	function resetGroupDraft() {
		if (selectedGroup) groupDraft = draftOf(selectedGroup);
	}

	async function deleteGroup(g: GroupRow) {
		if (g.locked) return;
		if (g.memberCount > 0) { toast.error('Remove all members before deleting'); return; }
		if (!confirm(`Delete group "${g.name}"?`)) return;
		const res = await fetch(`/api/groups/${g.id}`, { method: 'DELETE' });
		if (!res.ok) { const e = await res.json(); toast.error(e.error ?? 'Failed'); return; }
		toast.success('Group deleted');
		await loadAll();
		selectedGroupId = groupList[0]?.id ?? null;
	}

	function grantCount(g: GroupRow) {
		return g.grants.length;
	}

	/** Changing the grants trims the ceiling: a group can only hand on what it has. */
	function setGrants(next: LeafPermission[]) {
		if (!groupDraft) return;
		const granted = new Set(next);
		groupDraft = {
			...groupDraft,
			grants: next,
			delegations: groupDraft.delegations.filter((leaf) => granted.has(leaf))
		};
	}

	function setDelegations(next: LeafPermission[]) {
		if (groupDraft) groupDraft = { ...groupDraft, delegations: next };
	}

	const delegableForDraft = $derived(
		new Set((groupDraft?.grants ?? []).filter((leaf) => isDelegable(leaf)))
	);
</script>

<svelte:head>
	<title>Users &amp; Groups - Akaun</title>
</svelte:head>

<div class="screen">
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Users &amp; Groups</h1>
			<p class="page-sub">Access control for the shared ledger · Superuser area</p>
		</div>
	</header>

	<div class="ax-tabsbar">
		<div class="status-tabs">
			<button
				class="status-tab"
				class:active={activeTab === 'users'}
				onclick={() => (activeTab = 'users')}
			>
				Users
				{#if !loading}<span class="tab-count">{userList.length}</span>{/if}
			</button>
			<button
				class="status-tab"
				class:active={activeTab === 'groups'}
				onclick={() => (activeTab = 'groups')}
			>
				Groups
				{#if !loading}<span class="tab-count">{groupList.length}</span>{/if}
			</button>
		</div>
		{#if activeTab === 'groups'}
			<span class="ax-hint">Superusers hold every permission · a user has everything any of their groups grants</span>
		{/if}
	</div>

	{#if loading}
		<div class="ax-loading"><span class="spinner"></span> Loading…</div>
	{:else if activeTab === 'users'}
		<!-- ═══ Users tab ═══ -->
		<div class="ax-body">
			<div class="result-meta">
				<div>
					<b>{userList.length}</b> user{userList.length !== 1 ? 's' : ''} ·
					<b>{noGroupCount}</b> without a group
				</div>
				<div class="ax-meta-actions">
					<Button size="sm" onclick={openNewUser}>
						<UserPlus size={15} /> Add user
					</Button>
				</div>
			</div>

			<div class="table-card">
				<table class="exp-table">
					<thead>
						<tr>
							<th>User</th>
							<th>Groups</th>
							<th>Access</th>
							<th>Tokens</th>
							<th>Created</th>
							<th style="width:44px"></th>
						</tr>
					</thead>
					<tbody>
						{#each userList as u (u.id)}
							<tr class="exp-row" onclick={() => openEditUser(u)}>
								<td class="td-primary">
									<div class="ax-usercell">
										<div class="ax-uavatar">{initials(u.name, u.email)}</div>
										<div class="cell-item">
											<span class="ax-uname">{u.name || 'Unnamed user'}</span>
											<span class="ax-umail">{u.email}</span>
										</div>
									</div>
								</td>
								<td data-label="Groups">
									{#if u.groups.length > 0}
										<div class="ax-chips">
											{#each u.groups as g (g.id)}
												<span class="chip" class:is-super={groupList.find((x) => x.id === g.id)?.isSuperuser}>
													{g.name}
												</span>
											{/each}
										</div>
									{:else}
										<span class="ax-warn"><AlertTriangle size={12} /> No groups</span>
									{/if}
								</td>
								<td data-label="Access">
									{#if userAccess(u) === 'super'}
										<span class="ax-super-badge"><ShieldCheck size={13} /> Superuser</span>
									{:else if userAccess(u) === 'none'}
										<span class="muted-sm">No access</span>
									{:else}
										<span class="ax-std-badge"><Shield size={12} /> Standard</span>
									{/if}
								</td>
								<td data-label="Token">
									{#if u.tokenCount > 0}
										<span class="ax-token"><Key size={13} /> {u.tokenCount} active</span>
									{:else}
										<span class="muted-sm">None</span>
									{/if}
								</td>
								<td class="td-date" data-label="Date">{u.createdAt.slice(0, 10)}</td>
								<td class="td-actions" onclick={(e) => e.stopPropagation()}>
									<div class="dropdown-wrap">
										<button class="btn-icon-sm" onclick={(e) => { e.currentTarget.nextElementSibling?.classList.toggle('open'); }}>
											<MoreHorizontal size={16} />
										</button>
										<div class="dropdown-menu">
											<button class="dd-item" onclick={() => openEditUser(u)}>
												<Pencil size={14} /> Edit user
											</button>
											<button class="dd-item danger" onclick={() => deleteUser(u)}>
												<Trash2 size={14} /> Remove user
											</button>
										</div>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- User edit sheet -->
		<Sheet.Root open={userSheetOpen} onOpenChange={(o) => { if (!o) closeUserSheet(); }}>
				<Sheet.Content side={panelSide} style={isMobile ? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden;' : 'width:440px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden;'}>
					{#if editingUser}
						<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);">
							<div>
								<div class="sheet-eyebrow">{editingUser.id ? 'Edit user' : 'New user'}</div>
								<div class="sheet-title-text">{editingUser.name || (editingUser.id ? 'Unnamed user' : 'Add a user')}</div>
							</div>
							<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
						</div>
						<div style="flex:1; overflow-y:auto; padding:20px 22px; display:flex; flex-direction:column; gap:16px;">
							<div class="field">
								<div class="field-label">Full name</div>
								<input
									class="form-input"
									type="text"
									placeholder="e.g. Mei Ling Tan"
									value={editingUser.name ?? ''}
									oninput={(e) => (editingUser = { ...editingUser!, name: (e.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="field">
								<div class="field-label">Email</div>
								<input
									class="form-input"
									type="email"
									placeholder="name@example.com"
									value={editingUser.email ?? ''}
									oninput={(e) => (editingUser = { ...editingUser!, email: (e.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="field">
								<div class="field-label">Username</div>
								<input
									class="form-input"
									type="text"
									placeholder="username"
									value={editingUser.username ?? ''}
									oninput={(e) => (editingUser = { ...editingUser!, username: (e.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="field">
								<div class="field-label">{editingUser.id ? 'Reset password' : 'Temporary password'}</div>
								<input
									class="form-input"
									type="text"
									placeholder={editingUser.id ? 'Leave blank to keep current' : 'Set an initial password'}
									value={editingUser.password ?? ''}
									oninput={(e) => (editingUser = { ...editingUser!, password: (e.target as HTMLInputElement).value })}
								/>
								{#if editingUser.id}
									<p class="field-hint">Leave blank to keep the current password.</p>
								{:else}
									<p class="field-hint">The user can change this after first sign-in.</p>
								{/if}
							</div>

							<div class="detail-section-label">Group membership</div>
							{#if (editingUser.groupIds ?? []).length === 0}
								<div class="ax-warn-block">
									<AlertTriangle size={14} /> With no groups this user can sign in but sees an empty app — every screen is hidden. A "deactivated, not deleted" state.
								</div>
							{/if}
							<div class="ax-grouppick">
								{#each groupList as g (g.id)}
									<label class="ax-pick" class:on={(editingUser.groupIds ?? []).includes(g.id)}>
										<input
											type="checkbox"
											class="ax-pick-cb"
											checked={(editingUser.groupIds ?? []).includes(g.id)}
											onchange={() => toggleGroup(g.id)}
										/>
										<span class="ax-pick-main">
											<span class="ax-pick-name">
												{g.name}
												{#if g.isSuperuser}
													<span class="ax-super-badge sm"><ShieldCheck size={11} /> Superuser</span>
												{/if}
											</span>
											<span class="ax-pick-desc">{g.description}</span>
										</span>
									</label>
								{/each}
							</div>

							{#if !editingUser.isSuperuser}
								<div class="detail-section-label">Extra permissions</div>
								<p class="field-hint" style="margin:0">
									What this user's groups grant is already on, and cannot be taken away here.
									Raise a level or switch on an ability to give this user alone more. Extra
									permissions are never handed on to the user's tokens or apps.
								</p>
								<AccessEditor
									value={editingUserExtraGrants}
									onchange={(next) => (editingUserExtraGrants = next)}
									available={GRANTABLE}
									inherited={editingInherited}
								/>
							{/if}

							{#if editingUser.id}
								<div class="detail-section-label">Personal access tokens</div>
								{#if userTokens}
									<p class="field-hint" style="margin:0">
										Only the user can make a token, signed in as themselves. You can revoke theirs.
									</p>
									<TokenList
										tokens={userTokens.tokens}
										emptySub="This user has not made any tokens."
										onrevoke={(id) =>
											tokenRequest(`/api/users/${editingUser!.id}/tokens/${id}`, { method: 'DELETE' })}
										onrevokeall={() =>
											tokenRequest(`/api/users/${editingUser!.id}/tokens`, { method: 'DELETE' })}
									/>
								{:else}
									<span class="muted-sm">Loading tokens…</span>
								{/if}
							{/if}
						</div>
						<div style="padding:14px 20px; border-top:1px solid var(--border); display:flex; justify-content:space-between; gap:8px;">
							{#if editingUser.id}
								<Button variant="ghost" size="sm" class="text-destructive hover:bg-destructive/10" onclick={async () => { if (editingUser?.id && await deleteUser(editingUser as UserRow)) closeUserSheet(); }}>
									<Trash2 size={14} /> Remove
								</Button>
							{/if}
							<div style="display:flex; gap:8px; margin-left:auto;">
								<Button variant="outline" size="sm" onclick={closeUserSheet}>Cancel</Button>
								<Button size="sm" onclick={saveUser} disabled={savingUser}>
									{#if savingUser}
										<span class="spinner xs"></span>
									{/if}
									{editingUser.id ? 'Save changes' : 'Create user'}
								</Button>
							</div>
						</div>
					{/if}
				</Sheet.Content>
		</Sheet.Root>

	{:else}
		<!-- ═══ Groups tab ═══ -->
		{#snippet groupBody(g: GroupRow)}
			<div class="ax-gdetail-content">
				<textarea
					class="form-input ax-detail-desc"
					rows={2}
					value={groupDraft?.description ?? ''}
					disabled={g.locked}
					placeholder="Describe what this group is for…"
					oninput={(e) => { if (groupDraft) groupDraft = { ...groupDraft, description: (e.target as HTMLTextAreaElement).value }; }}
				></textarea>

				<div class="set-card ax-superrow">
					<div class="set-row">
						<div class="set-text">
							<div class="set-title">Superuser</div>
							<div class="set-desc">Bypasses the permission grid entirely — full access to every area, plus user management, backup and reset.</div>
						</div>
						<div class="set-control">
							<button
								class="toggle-btn"
								aria-label="Superuser group"
								class:on={groupDraft?.isSuperuser}
								disabled={g.locked}
								onclick={() => {
									if (groupDraft && !g.locked) {
										groupDraft = { ...groupDraft, isSuperuser: !groupDraft.isSuperuser };
									}
								}}
								role="switch"
								aria-checked={groupDraft?.isSuperuser}
							>
								<span class="toggle-thumb"></span>
							</button>
						</div>
					</div>
				</div>

				<div class="ax-permhead">
					<div class="detail-section-label" style="margin: 4px 0 0">Members can</div>
					{#if !groupDraft?.isSuperuser}
						<span class="ax-permcount">{groupDraft?.grants.length ?? 0} of {GRANTABLE.size} granted</span>
					{/if}
				</div>

				{#if groupDraft?.isSuperuser}
					<div class="ax-bypass">
						<div class="ax-bypass-icon"><ShieldCheck size={20} /></div>
						<div>
							<div class="ax-bypass-title">Every permission</div>
							<div class="ax-bypass-desc">Superusers hold every permission, including managing users and groups, which no other group can be given. Their tokens and apps may be given anything except user management — and are still limited to what each token or app was granted.</div>
						</div>
					</div>
				{:else if groupDraft}
					<AccessEditor
						value={groupDraft.grants}
						onchange={setGrants}
						available={GRANTABLE}
						disabled={g.locked}
					/>
					<p class="ax-permnote">
						<Lock size={12} /> No level includes Adjustments. It has its own switch, so it is only ever
						given on purpose.
					</p>

					<div class="ax-permhead">
						<div class="detail-section-label" style="margin: 4px 0 0">Members may hand on to tokens &amp; apps</div>
						<span class="ax-permcount">{groupDraft.delegations.length} of {delegableForDraft.size}</span>
					</div>
					<p class="field-hint" style="margin:0">
						The most a member's personal access tokens and connected AI apps may do. Members choose less
						for each token or app; nothing outside this can ever be chosen. Only what the group grants
						above can be handed on.
					</p>
					<AccessEditor
						value={groupDraft.delegations}
						onchange={setDelegations}
						available={delegableForDraft}
						disabled={g.locked}
						unavailableNote="Not granted to this group."
					/>
				{/if}
			</div>
		{/snippet}

		<div class="ax-body" class:ax-split={!isMobile}>
			<!-- Left list -->
			<div class="ax-glist">
				<button class="ax-newgroup" onclick={createGroup}>
					<Plus size={15} /> New group
				</button>
				{#each groupList as g (g.id)}
					<button
						class="ax-gitem"
						class:active={g.id === selectedGroupId}
						onclick={() => { selectedGroupId = g.id; if (isMobile) groupSheetOpen = true; }}
					>
						<div class="ax-gitem-top">
							<span class="ax-gname">{g.name}</span>
							{#if g.isSuperuser}
								<ShieldCheck size={14} class="ax-icon-super" />
							{:else if g.locked}
								<Lock size={13} class="muted-icon" />
							{/if}
						</div>
						<span class="ax-gmeta">
							{g.memberCount} member{g.memberCount !== 1 ? 's' : ''} ·
							{g.isSuperuser ? 'Full access' : grantCount(g) + ' grants'}
						</span>
					</button>
				{/each}
			</div>

			<!-- Desktop: right detail panel -->
			{#if !isMobile && selectedGroup}
				<div class="ax-gdetail">
					<div class="ax-detail-head">
						<div class="ax-detail-titlewrap">
							<input
								class="ax-detail-name"
								value={groupDraft?.name ?? ''}
								disabled={selectedGroup.locked}
								oninput={(e) => { if (groupDraft) groupDraft = { ...groupDraft, name: (e.target as HTMLInputElement).value }; }}
							/>
							<div class="ax-detail-badges">
								{#if groupDraft?.isSuperuser}
									<span class="ax-super-badge"><ShieldCheck size={13} /> Superuser</span>
								{/if}
								{#if selectedGroup.locked}
									<span class="ax-meta-text"><Lock size={12} /> Protected</span>
								{/if}
								<span class="ax-meta-text">{selectedGroup.memberCount} member{selectedGroup.memberCount !== 1 ? 's' : ''}</span>
							</div>
						</div>
						<div class="dropdown-wrap">
							<button class="btn-outline-icon" onclick={(e) => { e.currentTarget.nextElementSibling?.classList.toggle('open'); }}>
								<MoreHorizontal size={16} />
							</button>
							<div class="dropdown-menu">
								<button
									class="dd-item danger"
									disabled={selectedGroup.locked || selectedGroup.memberCount > 0}
									onclick={() => deleteGroup(selectedGroup!)}
								>
									<Trash2 size={14} /> Delete group
								</button>
							</div>
						</div>
					</div>
					{@render groupBody(selectedGroup)}
					{#if isDirty}
						<div class="ax-gdetail-footer">
							<Button variant="outline" size="sm" onclick={resetGroupDraft}>Reset</Button>
							<Button size="sm" onclick={saveGroupDraft} disabled={savingGroup}>
								{#if savingGroup}<span class="spinner xs"></span>{/if}
								Save changes
							</Button>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Mobile: bottom sheet for group detail -->
		{#if isMobile}
		<Sheet.Root bind:open={groupSheetOpen}>
				<Sheet.Content side="bottom" style="height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden;">
					{#if selectedGroup}
						<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border); flex-shrink:0;">
							<div>
								<div class="sheet-eyebrow">Edit group</div>
								<div class="sheet-title-text">{selectedGroup.name}</div>
							</div>
							<div style="display:flex; align-items:center; gap:6px;">
								<div class="dropdown-wrap">
									<button class="btn-outline-icon" onclick={(e) => { e.currentTarget.nextElementSibling?.classList.toggle('open'); }}>
										<MoreHorizontal size={16} />
									</button>
									<div class="dropdown-menu">
										<button
											class="dd-item danger"
											disabled={selectedGroup.locked || selectedGroup.memberCount > 0}
											onclick={() => deleteGroup(selectedGroup!)}
										>
											<Trash2 size={14} /> Delete group
										</button>
									</div>
								</div>
								<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
							</div>
						</div>
						<div style="flex:1; overflow-y:auto; padding:20px 22px; display:flex; flex-direction:column; gap:16px;">
							<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
								{#if groupDraft?.isSuperuser}
									<span class="ax-super-badge"><ShieldCheck size={13} /> Superuser</span>
								{/if}
								{#if selectedGroup.locked}
									<span class="ax-meta-text"><Lock size={12} /> Protected</span>
								{/if}
								<span class="ax-meta-text">{selectedGroup.memberCount} member{selectedGroup.memberCount !== 1 ? 's' : ''}</span>
							</div>
							{@render groupBody(selectedGroup)}
						</div>
						{#if isDirty}
							<div style="padding:14px 20px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; gap:8px; flex-shrink:0;">
								<Button variant="outline" size="sm" onclick={resetGroupDraft}>Reset</Button>
								<Button size="sm" onclick={saveGroupDraft} disabled={savingGroup}>
									{#if savingGroup}<span class="spinner xs"></span>{/if}
									Save changes
								</Button>
							</div>
						{/if}
					{/if}
				</Sheet.Content>
		</Sheet.Root>
		{/if}
	{/if}
</div>

<style>
	/* ── Tab bar ── */
	.ax-tabsbar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 24px 8px;
	}
	.ax-hint {
		font-size: 12px;
		color: var(--muted-foreground);
		margin-left: auto;
	}


	.ax-meta-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	/* ── Body ── */
	.ax-body {
		padding: 4px 24px 20px;
		flex: 1;
		overflow: auto;
	}
	.ax-loading {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 40px 24px;
		color: var(--muted-foreground);
	}

	/* ── User table ── */
	.ax-usercell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.ax-uavatar {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--primary-soft, oklch(0.646 0.187 41.6 / 0.12));
		color: var(--primary);
		font-size: 11px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.ax-uname {
		display: block;
		font-weight: 500;
		font-size: 13.5px;
	}
	.ax-umail {
		display: block;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.ax-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		font-weight: 500;
		background: var(--accent);
		color: var(--foreground);
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid var(--border);
	}
	.chip.is-super {
		background: oklch(0.97 0.05 280 / 0.5);
		color: oklch(0.45 0.15 280);
		border-color: oklch(0.8 0.1 280);
	}
	:global(.dark) .chip.is-super {
		background: oklch(0.25 0.05 280 / 0.4);
		color: oklch(0.75 0.1 280);
	}
	.ax-warn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: oklch(0.55 0.15 50);
	}
	.ax-super-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--primary);
		background: var(--primary-soft);
		padding: 2px 8px;
		border-radius: 999px;
	}
	.ax-super-badge.sm { font-size: 10.5px; padding: 1px 6px; }
	.ax-std-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.ax-token {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono, monospace);
		font-size: 11.5px;
		color: var(--foreground);
		opacity: 0.7;
	}
	.muted-sm { font-size: 12.5px; color: var(--muted-foreground); }

	/* ── Dropdown ── */
	.dropdown-wrap { position: relative; display: inline-block; }
	.dropdown-menu {
		display: none;
		position: absolute;
		right: 0;
		top: 100%;
		margin-top: 4px;
		background: var(--popover, var(--card));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 4px 16px oklch(0 0 0 / 0.12);
		z-index: 50;
		min-width: 180px;
		padding: 4px;
	}
	.dropdown-menu:global(.open) { display: block; }
	.dd-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 10px;
		background: none;
		border: none;
		border-radius: calc(var(--radius) - 2px);
		font-size: 13px;
		color: var(--foreground);
		cursor: pointer;
		text-align: left;
	}
	.dd-item:hover { background: var(--accent); }
	.dd-item.danger { color: var(--red, oklch(0.55 0.2 25)); }
	.dd-item:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ── Sheet fields ── */
	.field { display: flex; flex-direction: column; gap: 6px; }
	.field-label { font-size: 13px; font-weight: 500; }
	.field-hint { font-size: 12px; color: var(--muted-foreground); margin: 2px 0 0; }

	/* ── Group picker in sheet ── */
	.ax-warn-block {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 12px;
		background: oklch(0.97 0.04 60 / 0.6);
		border: 1px solid oklch(0.85 0.1 60);
		border-radius: var(--radius);
		font-size: 12.5px;
		color: oklch(0.45 0.15 55);
	}
	:global(.dark) .ax-warn-block {
		background: oklch(0.22 0.04 60 / 0.5);
		border-color: oklch(0.4 0.1 60);
		color: oklch(0.75 0.1 60);
	}
	.ax-grouppick { display: flex; flex-direction: column; gap: 6px; }
	.ax-pick {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.ax-pick.on { border-color: var(--primary); background: var(--primary-soft, oklch(0.646 0.187 41.6 / 0.08)); }
	.ax-pick-cb { margin-top: 2px; accent-color: var(--primary); }
	.ax-pick-main { display: flex; flex-direction: column; gap: 2px; }
	.ax-pick-name { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
	.ax-pick-desc { font-size: 12px; color: var(--muted-foreground); }


	/* ── Buttons ── */
	.btn-outline-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		color: var(--muted-foreground);
	}
	.btn-outline-icon:hover { background: var(--muted); color: var(--foreground); }
	.btn-icon-sm {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		color: var(--muted-foreground);
	}
	.btn-icon-sm:hover { background: var(--muted); color: var(--foreground); }

	/* ── Groups split layout ── */
	.ax-split {
		display: grid;
		grid-template-columns: 220px 1fr;
		gap: 0;
		min-height: 0;
		height: calc(100dvh - 140px);
	}
	.ax-glist {
		border-right: 1px solid var(--border);
		padding: 12px 16px 12px 0px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ax-newgroup {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		font-size: 12.5px;
		color: var(--muted-foreground);
		cursor: pointer;
		margin-bottom: 6px;
	}
	.ax-newgroup:hover { border-color: var(--primary); color: var(--primary); }
	.ax-gitem {
		display: flex;
		flex-direction: column;
		width: 100%;
		padding: 9px 12px;
		background: none;
		border: none;
		border-radius: var(--radius);
		text-align: left;
		cursor: pointer;
		gap: 2px;
	}
	.ax-gitem:hover { background: var(--muted); }
	.ax-gitem.active { background: var(--accent); }
	.ax-gitem-top { display: flex; align-items: center; gap: 5px; justify-content: space-between; }
	.ax-gname { font-size: 13px; font-weight: 500; }
	.ax-gmeta { font-size: 11.5px; color: var(--muted-foreground); }

	/* ── Group detail panel ── */
	.ax-gdetail {
		padding: 20px 24px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.ax-detail-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.ax-detail-titlewrap { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
	.ax-detail-name {
		font-size: 18px;
		font-weight: 600;
		border: none;
		background: none;
		color: var(--foreground);
		padding: 0;
		width: 100%;
		outline: none;
		border-bottom: 1px solid transparent;
	}
	.ax-detail-name:focus { border-bottom-color: var(--primary); }
	.ax-detail-name:disabled { opacity: 0.7; cursor: not-allowed; }
	.ax-detail-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.ax-gdetail-content { display: flex; flex-direction: column; gap: 14px; }
	.ax-meta-text {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.ax-detail-desc {
		resize: vertical;
		min-height: 60px;
		width: 100%;
		height: auto;
		padding: 10px 12px;
	}
	.ax-permhead { display: flex; align-items: center; justify-content: space-between; }
	.ax-permcount { font-size: 12px; color: var(--muted-foreground); }

	/* ── Bypass banner ── */
	.ax-bypass {
		display: flex;
		align-items: flex-start;
		gap: 14px;
		padding: 16px;
		background: var(--primary-soft, oklch(0.646 0.187 41.6 / 0.08));
		border: 1px solid oklch(0.646 0.187 41.6 / 0.25);
		border-radius: var(--radius);
	}
	.ax-bypass-icon { color: var(--primary); flex-shrink: 0; margin-top: 2px; }
	.ax-bypass-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
	.ax-bypass-desc { font-size: 12.5px; color: var(--muted-foreground); line-height: 1.5; }

	.ax-permnote {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--muted-foreground);
		margin: 0;
	}
	/* ── Groups detail save footer ── */
	.ax-gdetail-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 0 0;
		border-top: 1px solid var(--border);
		margin-top: 4px;
	}

	/* ── Spinner ── */
	.spinner.xs { width: 12px; height: 12px; }

	/* ── Misc ── */
	.detail-section-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.set-card { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
	.set-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
	}
	.set-text { flex: 1; min-width: 0; }
	.set-title { font-size: 13.5px; font-weight: 500; }
	.set-desc { font-size: 12px; color: var(--muted-foreground); margin-top: 2px; line-height: 1.45; }
	.set-control { flex-shrink: 0; }

	/* ── Mobile overrides ── */
	@media (max-width: 767px) {
		.ax-tabsbar { padding: 8px 16px 6px; }
		.ax-hint { display: none; }
		.ax-body { padding: 2px 16px 16px; }

		/* Hide action dropdown column in card view */
		.exp-row .td-actions { display: none; }

		/* Group list: no border, full width */
		.ax-glist { border-right: none; padding: 4px 0; }

		/* .set-row collides with the global Settings-page class of the same
		   name, which stacks it vertically on mobile; keep it left-aligned
		   instead of the global rule's centered stack. */
		.set-row { align-items: flex-start; }
	}
</style>
