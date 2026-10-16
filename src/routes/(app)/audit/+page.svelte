<script lang="ts">
	import AuditPage from '$lib/components/audit/AuditPage.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<AuditPage {data} />
