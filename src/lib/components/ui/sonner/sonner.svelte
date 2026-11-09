<script lang="ts">
	import {
		Toaster as Sonner,
		type ToasterProps as SonnerProps
	} from 'svelte-sonner';
	import { mode } from 'mode-watcher';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import './sonner.css';

	let { richColors = true, ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme={mode.current}
	{richColors}
	class="toaster group"
	style="--normal-bg: var(--popover); --normal-text: var(--popover-foreground); --normal-border: var(--border);
    --success-bg: var(--app-toast-success-bg); --success-text: var(--app-toast-success-text); --success-border: var(--app-toast-success-border);
    --warning-bg: var(--app-toast-warning-bg); --warning-text: var(--app-toast-warning-text); --warning-border: var(--app-toast-warning-border);
    --error-bg: var(--app-toast-error-bg); --error-text: var(--app-toast-error-text); --error-border: var(--app-toast-error-border);
    --info-bg: var(--app-toast-info-bg); --info-text: var(--app-toast-info-text); --info-border: var(--app-toast-info-border);"
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4" />
	{/snippet}
</Sonner>
