<script lang="ts">
	import SalesDocCreate from '$lib/components/sales/SalesDocCreate.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<SalesDocCreate kind="quotation" defaultDays={data.defaultDays} />
