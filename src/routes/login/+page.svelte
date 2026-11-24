<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showPassword = $state(false);
	let remember = $state(true);
	let loading = $state(false);
</script>

<svelte:head>
	<title>Login - Akaun</title>
</svelte:head>

<div class="login">
	<div class="loginwrap">
		<!-- Logo mark -->
		<div class="form-logo">
			<div class="mark">
				<img src="/icons/icon-192.png" alt="Akaun" />
			</div>
		</div>

		<!-- Heading -->
		<div class="form-head">
			<h1 class="form-title">Welcome back</h1>
			<p class="form-sub">Sign in to your Akaun workspace to continue.</p>
		</div>

		{#if data.ssoError}
			<p class="field-err" role="alert">
				{data.ssoError === 'provider_configuration'
					? 'SSO is unavailable. Ask an administrator to check the issuer URL and provider connection.'
					: data.ssoError === 'unavailable'
						? 'This sign-in cannot access Akaun. Contact your administrator.'
						: 'SSO sign-in failed. Try again or contact your administrator.'}
			</p>
		{/if}
		{#if data.enabled}
			<p><a class="btn-primary" data-sveltekit-reload href={resolve(`/api/v1/auth/sso/login?${data.signInQuery}`)}>Continue with {data.displayName}</a></p>
			<p class="form-foot">
				<a href={resolve(`/login?${data.localQuery}`)}>
					{data.showPassword || form?.error
						? (data.internalEnabled ? 'Hide username and password' : 'Hide local sign-in')
						: (data.internalEnabled ? 'Use username and password' : 'Local sign-in')}
				</a>
			</p>
		{/if}
		{#if data.showPassword || form?.error}

		<form
			method="POST"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					loading = false;
					await update();
				};
			}}
		>
			<!-- Username -->
			<div class="field">
				<div class="field-label">
					<label for="username">Username</label>
				</div>
				<div class="input-wrap">
					<span class="input-lead" aria-hidden="true">
						<!-- mail icon -->
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
					</span>
					<input
						id="username"
						name="username"
						type="text"
						class="input {form?.error ? 'invalid' : ''}"
						autocomplete="username"
						placeholder="Enter username"
						required
					/>
				</div>
			</div>

			<!-- Password -->
			<div class="field">
				<div class="field-label">
					<label for="password">Password</label>
					<button type="button" class="forgot" onclick={(e) => e.preventDefault()}>Forgot?</button>
				</div>
				<div class="input-wrap">
					<span class="input-lead" aria-hidden="true">
						<!-- lock icon -->
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
					</span>
					<input
						id="password"
						name="password"
						type={showPassword ? 'text' : 'password'}
						class="input has-trail {form?.error ? 'invalid' : ''}"
						autocomplete="current-password"
						placeholder="••••••••"
						required
					/>
					<button
						type="button"
						class="eye"
						onclick={() => (showPassword = !showPassword)}
						aria-label={showPassword ? 'Hide password' : 'Show password'}
					>
						{#if showPassword}
							<!-- eye-off icon -->
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M9.36 9.36a3 3 0 0 0 4.28 4.28"/></svg>
						{:else}
							<!-- eye icon -->
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>
						{/if}
					</button>
				</div>
			</div>

			<!-- Error -->
			{#if form?.error}
				<div class="field-err">
					<!-- alert icon -->
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
					{form.error}
				</div>
			{/if}

			<!-- Keep me signed in -->
			<div class="row-between">
				<button
					type="button"
					class="remember"
					onclick={() => (remember = !remember)}
					aria-pressed={remember}
				>
					<span class="cbox {remember ? 'on' : ''}">
						{#if remember}
							<!-- check icon -->
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
						{/if}
					</span>
					Keep me signed in
				</button>
			</div>

			<!-- Submit -->
			<button type="submit" class="btn-primary" disabled={loading}>
				{#if loading}
					<span class="spinner" aria-hidden="true"></span>
					Signing in…
				{:else}
					Sign in
					<!-- arrow icon -->
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
				{/if}
			</button>
		</form>
    {/if}

		<p class="form-foot">New to Akaun? <button type="button" onclick={(e) => e.preventDefault()}>Ask your admin for access</button></p>
	</div>
</div>

<style>
	/* ── Layout ─────────────────────────────────────────────── */
	.login {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px 24px;
		background: var(--background);
	}

	.loginwrap {
		width: 100%;
		max-width: 368px;
	}

	/* ── Logo mark ───────────────────────────────────────────── */
	.form-logo {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin-bottom: 24px;
	}

	.mark {
		width: 54px;
		height: 54px;
	}

	.mark img {
		width: 100%;
		height: 100%;
		filter: drop-shadow(0 4px 10px oklch(0.646 0.187 41.6 / 0.35));
	}

	/* ── Heading ─────────────────────────────────────────────── */
	.form-head {
		text-align: center;
		margin-bottom: 24px;
	}

	.form-title {
		font-size: 23px;
		font-weight: 600;
		letter-spacing: -0.022em;
		margin: 0;
		color: var(--foreground);
	}

	.form-sub {
		font-size: 14px;
		color: var(--muted-foreground);
		margin: 7px 0 0;
		line-height: 1.5;
	}

	/* ── Fields ──────────────────────────────────────────────── */
	.field {
		margin-bottom: 15px;
	}

	.field-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
		margin-bottom: 7px;
	}

	.forgot {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--primary);
		text-decoration: none;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-family: inherit;
	}

	.forgot:hover {
		text-decoration: underline;
	}

	.input-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.input-lead {
		position: absolute;
		left: 13px;
		color: var(--muted-foreground);
		display: flex;
		pointer-events: none;
	}

	.input {
		width: 100%;
		height: 46px;
		border: 1px solid var(--input);
		background: var(--card);
		color: var(--foreground);
		border-radius: 10px;
		padding: 0 14px 0 40px;
		font-family: inherit;
		font-size: 15px;
		outline: none;
		transition:
			border-color 0.12s,
			box-shadow 0.12s;
		-webkit-appearance: none;
		appearance: none;
	}

	.input::placeholder {
		color: var(--muted-foreground);
	}

	.input:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-soft);
	}

	.input.invalid {
		border-color: var(--red);
	}

	.input.invalid:focus {
		box-shadow: 0 0 0 3px var(--red-soft);
	}

	.input.has-trail {
		padding-right: 44px;
	}

	.eye {
		position: absolute;
		right: 6px;
		width: 34px;
		height: 34px;
		border-radius: 8px;
		border: none;
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: background 0.1s, color 0.1s;
	}

	.eye:hover {
		background: var(--accent);
		color: var(--foreground);
	}

	/* ── Error ───────────────────────────────────────────────── */
	.field-err {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--red);
		margin: -6px 0 14px;
	}

	/* ── Remember row ────────────────────────────────────────── */
	.row-between {
		display: flex;
		align-items: center;
		margin: 4px 0 20px;
	}

	.remember {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 13.5px;
		color: var(--foreground);
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
		background: none;
		border: none;
		padding: 0;
		font-family: inherit;
	}

	.cbox {
		width: 19px;
		height: 19px;
		border-radius: 6px;
		border: 1.5px solid var(--border-strong);
		background: var(--card);
		display: grid;
		place-items: center;
		color: var(--primary-foreground);
		flex-shrink: 0;
		transition:
			background 0.1s,
			border-color 0.1s;
	}

	.cbox.on {
		background: var(--primary);
		border-color: var(--primary);
	}

	/* ── Submit ──────────────────────────────────────────────── */
	.btn-primary {
		text-decoration: none;
		width: 100%;
		height: 46px;
		border: none;
		border-radius: 10px;
		cursor: pointer;
		background: var(--primary);
		color: var(--primary-foreground);
		font-family: inherit;
		font-size: 15px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		box-shadow: 0 1px 2px 0 oklch(0 0 0 / 0.05);
		transition:
			filter 0.12s,
			opacity 0.12s;
	}

	.btn-primary:hover:not(:disabled) {
		filter: brightness(1.06);
	}

	.btn-primary:disabled {
		opacity: 0.7;
		cursor: default;
	}

	.btn-primary:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.spinner {
		width: 17px;
		height: 17px;
		border: 2px solid oklch(1 0 0 / 0.35);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
		flex-shrink: 0;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Footer ──────────────────────────────────────────────── */
	.form-foot {
		margin-top: 22px;
		text-align: center;
		font-size: 13px;
		color: var(--muted-foreground);
		line-height: 1.6;
	}

	.form-foot a,
	.form-foot button {
		color: var(--primary);
		text-decoration: none;
		font-weight: 500;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
	}

	.form-foot a:hover,
	.form-foot button:hover {
		text-decoration: underline;
	}
</style>
