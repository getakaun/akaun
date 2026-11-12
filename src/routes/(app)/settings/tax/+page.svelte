<script lang="ts">
  import AssetTaxSchemeSettings from "$lib/components/settings/AssetTaxSchemeSettings.svelte";
  import type { PageData } from "./$types.js";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Tax settings - Akaun</title></svelte:head>
<AssetTaxSchemeSettings
  jurisdiction={data.jurisdiction}
  schemes={data.schemes}
  canManage={data.canManage}
  canSeeSettings={data.canSeeSettings}
  canSeeBooks={data.canSeeBooks}
  canManageSettings={data.canManageSettings}
/>
