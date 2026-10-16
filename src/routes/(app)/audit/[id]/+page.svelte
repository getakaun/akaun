<script lang="ts">
	import AuditDetail from '$lib/components/audit/AuditDetail.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<AuditDetail {data} />
