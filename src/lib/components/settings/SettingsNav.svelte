<script lang="ts" module>
  export type SettingsTab =
    | "general"
    | "company"
    | "books"
    | "intelligence"
    | "templates"
    | "advanced"
    | "tax"
    | "authentication";
</script>

<script lang="ts">
  import { resolve } from "$app/paths";
  let {
    active,
    canSeeSettings = true,
    canSeeBooks = false,
    canManageSettings = false,
    canReadTax = false,
    canManageUsers = false,
    onselect,
  }: {
    active: SettingsTab;
    canSeeSettings?: boolean;
    canSeeBooks?: boolean;
    canManageSettings?: boolean;
    canReadTax?: boolean;
    canManageUsers?: boolean;
    onselect?: (tab: SettingsTab) => void;
  } = $props();
  const tabs: { id: SettingsTab; label: string }[] = $derived([
    ...(canSeeSettings
      ? [
          { id: "general" as const, label: "General" },
          { id: "company" as const, label: "Company" },
        ]
      : []),
    ...(canReadTax ? [{ id: "tax" as const, label: "Tax" }] : []),
    ...(canSeeSettings && (canSeeBooks || canManageSettings)
      ? [{ id: "books" as const, label: "Ledger" }]
      : []),
    ...(canManageUsers ? [{ id: "authentication" as const, label: "Authentication" }] : []),
    ...(canSeeSettings
      ? [
          { id: "intelligence" as const, label: "Intelligence" },
          { id: "templates" as const, label: "Templates" },
          { id: "advanced" as const, label: "Advanced" },
        ]
      : []),
  ]);
</script>

<nav class="set-nav" aria-label="Settings">
  {#each tabs as tab (tab.id)}
    {#if onselect && tab.id !== "tax" && tab.id !== "authentication"}
      <button
        type="button"
        class="set-nav-item"
        class:active={active === tab.id}
        aria-current={active === tab.id ? "page" : undefined}
        onclick={() => onselect?.(tab.id)}>{tab.label}</button
      >
    {:else}
      <a
        class="set-nav-item"
        class:active={active === tab.id}
        aria-current={active === tab.id ? "page" : undefined}
        href={resolve(
          tab.id === "tax"
            ? "/(app)/settings/tax"
            : tab.id === "authentication"
              ? "/(app)/settings/authentication"
              : `/(app)/settings?tab=${tab.id}`,
        )}>{tab.label}</a
      >
    {/if}
  {/each}
</nav>

<style>
  a {
    text-decoration: none;
  }
</style>
