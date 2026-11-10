<script lang="ts">
  import FixedAssetsPage from "$lib/components/assets/FixedAssetsPage.svelte";
  import type { PageData } from "./$types.js";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Assets - Akaun</title></svelte:head>
<FixedAssetsPage {data} />
