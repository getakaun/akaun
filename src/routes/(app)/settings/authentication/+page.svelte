<script lang="ts">
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import SettingsNav from "$lib/components/settings/SettingsNav.svelte";
  import type { ActionData, PageData } from "./$types.js";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let draft = $state<typeof data.settings | null>(null);
  let secret = $state("");
  let saving = $state(false);
  $effect.pre(() => {
    draft = {
      ...data.settings,
      groupMappings: data.settings.groupMappings.map((mapping) => ({
        ...mapping,
      })),
      recoveryUserIds: [...data.settings.recoveryUserIds],
    };
    secret = "";
  });
  const values = $derived(draft ?? data.settings);
</script>

<svelte:head><title>Authentication settings - Akaun</title></svelte:head>

<header class="page-header">
  <div>
    <h1 class="page-title">Settings</h1>
    <p class="page-sub">Configure your workspace</p>
  </div>
</header>

<div class="set-layout">
  <SettingsNav
    active="authentication"
    canManageUsers
    canSeeSettings={data.canSeeSettings}
    canReadTax={data.canReadTax}
    canSeeBooks={data.canSeeBooks}
  />
  <div class="set-content">
    <div class="set-section">
      <div class="set-section-head">
        <h2 class="set-section-title">Authentication</h2>
        <p class="set-section-sub">Choose how users sign in to Akaun.</p>
      </div>

      {#if data.recoveryMode}
        <p role="status" class="text-sm text-muted-foreground mb-4">
          Recovery mode is active. Local password sign-in is available and
          settings are read-only.
        </p>
      {/if}

      <form
        method="POST"
        use:enhance={() => {
          saving = true;
          return async ({ result, update }) => {
            try {
              await update({ reset: false });
              if (result.type === "success") secret = "";
            } finally {
              saving = false;
            }
          };
        }}
      >
        <input type="hidden" name="revision" value={data.revision} />
        <fieldset class="grid gap-4" disabled={data.recoveryMode || saving}>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="internalAuthenticationEnabled"
              bind:checked={values.internalAuthenticationEnabled}
            />
            Internal authentication
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="oidcEnabled"
              bind:checked={values.oidcEnabled}
            />
            OIDC authentication
          </label>
          {#if values.oidcEnabled}
            {#if data.callback}
              <div class="grid gap-1 text-sm">
                <span>Redirect URI</span><code
                  class="break-all text-muted-foreground">{data.callback}</code
                >
                <span class="mt-2">Back-channel logout URI</span><code
                  class="break-all text-muted-foreground">{data.logout}</code
                >
              </div>
            {:else}
              <p class="text-sm text-muted-foreground">
                Set PUBLIC_BASE_URL or ORIGIN to your public URL before enabling
                OIDC.
              </p>
            {/if}
            <label class="grid gap-1.5 text-sm"
              >Provider name
              <Input
                name="displayName"
                placeholder="SSO"
                maxlength={80}
                bind:value={values.displayName}
              />
            </label>
            <label class="grid gap-1.5 text-sm"
              >Issuer URL
              <Input
                name="authority"
                type="url"
                required
                bind:value={values.authority}
              />
            </label>
            <label class="grid gap-1.5 text-sm"
              >Client ID
              <Input name="clientId" required bind:value={values.clientId} />
            </label>
            <label class="grid gap-1.5 text-sm"
              >Client secret
              <Input
                name="clientSecret"
                type="password"
                autocomplete="new-password"
                bind:value={secret}
                required={!data.hasSecret ||
                  values.authority.trim() !== data.settings.authority ||
                  values.clientId.trim() !== data.settings.clientId}
              />
              {#if data.hasSecret}<span class="text-muted-foreground"
                  >Leave blank to keep the saved secret.</span
                >{/if}
            </label>
            <label class="grid gap-1.5 text-sm"
              >Additional scopes
              <Input
                name="additionalScopes"
                bind:value={values.additionalScopes}
              />
              <span class="text-muted-foreground"
                >Separate scope names with spaces.</span
              >
            </label>

            <fieldset class="grid gap-2 border-t pt-3">
              <legend class="text-sm font-medium"
                >Recovery administrators</legend
              >
              <p class="text-sm text-muted-foreground">
                These accounts can still sign in with a password when internal
                authentication is off.
              </p>
              {#each data.recoveryAccounts as account (account.id)}
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="recoveryUserId"
                    value={account.id}
                    checked={values.recoveryUserIds.includes(account.id)}
                  />
                  {account.name || account.username}
                </label>
              {/each}
            </fieldset>

            <fieldset class="grid gap-3 border-t pt-3">
              <legend class="text-sm font-medium">Account provisioning</legend>
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="jitEnabled"
                  bind:checked={values.jitEnabled}
                />
                Create accounts on first sign-in
              </label>
              {#if values.jitEnabled}
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="requireVerifiedEmail"
                    bind:checked={values.requireVerifiedEmail}
                  />
                  Require verified email
                </label>
                <label class="grid gap-1.5 text-sm"
                  >Default group
                  <select
                    name="defaultGroupId"
                    bind:value={values.defaultGroupId}
                    required
                    class="rounded-md border bg-background p-2"
                  >
                    <option value={null}>Select a group</option>
                    {#each data.groups.filter((group) => group.defaultAllowed) as group (group.id)}
                      <option value={group.id}>{group.name}</option>
                    {/each}
                  </select>
                </label>
                <label class="grid gap-1.5 text-sm"
                  >Groups claim
                  <Input
                    name="groupsClaim"
                    required
                    bind:value={values.groupsClaim}
                  />
                </label>
                {#each values.groupMappings as mapping, index (mapping)}
                  <div class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <label class="grid gap-1.5 text-sm"
                      >Provider group
                      <Input
                        name="externalGroup"
                        required
                        maxlength={256}
                        bind:value={mapping.externalGroup}
                      />
                    </label>
                    <label class="grid gap-1.5 text-sm"
                      >Akaun group
                      <select
                        name="groupId"
                        bind:value={mapping.groupId}
                        required
                        class="rounded-md border bg-background p-2"
                      >
                        <option value={0} disabled>Select a group</option>
                        {#each data.groups as group (group.id)}
                          <option value={group.id}>{group.name}</option>
                        {/each}
                      </select>
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      onclick={() => values.groupMappings.splice(index, 1)}
                      >Remove</Button
                    >
                  </div>
                {/each}
                <Button
                  type="button"
                  variant="outline"
                  class="justify-self-start"
                  disabled={values.groupMappings.length >= 50}
                  onclick={() =>
                    values.groupMappings.push({
                      externalGroup: "",
                      groupId: 0,
                    })}>Add group mapping</Button
                >
              {/if}
            </fieldset>
          {/if}
          <Button type="submit" class="justify-self-start">Save changes</Button>
        </fieldset>
        {#if form?.error}<p role="alert" class="mt-3 text-sm text-destructive">
            {form.error}
          </p>{/if}
        {#if form?.saved}<p
            role="status"
            class="mt-3 text-sm text-muted-foreground"
          >
            Authentication settings saved.
          </p>{/if}
      </form>
    </div>
  </div>
</div>
