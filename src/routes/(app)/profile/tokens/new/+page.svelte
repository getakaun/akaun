<script lang="ts">
	import TokenCreate from '$lib/components/permissions/TokenCreate.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<TokenCreate delegable={data.delegable} />
