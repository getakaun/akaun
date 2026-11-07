<script lang="ts">
  import AssetDetail from "$lib/components/assets/AssetDetail.svelte";
  import type { PageData } from "./$types.js";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.asset.name} - Assets - Akaun</title></svelte:head>
{#key data.asset.id}<AssetDetail {data} />{/key}
