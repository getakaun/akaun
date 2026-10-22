<script lang="ts">
  import { resolve } from "$app/paths";
  import { ChevronRight } from "@lucide/svelte";
  import { formatMinor } from "$lib/format.js";
  import AgeingBar from "./AgeingBar.svelte";
  import type { OwedSide } from "./types.js";

  /**
   * One side of who owes whom (007 FR-009): the total, how much of it is past
   * due, the ageing, and the three largest contacts. The figures are the
   * Contacts screen's own (`contactBalances`' rule), as at today.
   */
  let {
    title,
    side,
    canOpenContacts,
    emptyText,
  }: {
    title: string;
    side: OwedSide;
    canOpenContacts: boolean;
    emptyText: string;
  } = $props();

  function contactHref(id: number): string {
    return resolve("/(app)/contacts/[id]", { id: String(id) });
  }
</script>

<section class="dash-panel">
  <header class="dash-panel-head">
    <div>
      <h2 class="dash-panel-title">{title}</h2>
      <p class="dash-panel-sub">As at today</p>
    </div>
    {#if canOpenContacts}
      <a class="dash-panel-link" href={resolve("/(app)/contacts")}>Contacts</a>
    {/if}
  </header>

  {#if side.totalMinor === 0 && !side.obligationsMinor && !side.creditsMinor}
    <p class="dash-empty">{emptyText}</p>
  {:else}
    <div class="figures">
      <div>
        <div class="num big">{formatMinor(side.totalMinor)}</div>
        <div class="caption">net outstanding balance</div>
      </div>
      <div class="overdue" class:has={side.overdueMinor > 0}>
        <div class="num">{formatMinor(side.overdueMinor)}</div>
        <div class="caption">
          overdue{#if side.overdueCount > 0}&nbsp;· {side.overdueCount} item{side.overdueCount ===
            1
              ? ""
              : "s"}{/if}
        </div>
      </div>
    </div>
    {#if side.creditsMinor}<p class="dash-panel-sub">
        Obligations: {formatMinor(side.obligationsMinor ?? 0)} · Unapplied credits:
        {formatMinor(side.creditsMinor)}
      </p>{/if}
    <AgeingBar bands={side.bands} />
    {#if side.top.length > 0}
      <ul class="contacts">
        {#each side.top as contact (contact.contactId)}
          <li>
            {#if canOpenContacts}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
              <a class="contact related-link" href={contactHref(contact.contactId)}>
                <span class="name">{contact.contactName || "—"}</span>
                <span class="num">{formatMinor(contact.outstandingMinor)}</span>
                <ChevronRight size={13} class="chev" />
              </a>
            {:else}
              <div class="contact">
                <span class="name">{contact.contactName || "—"}</span>
                <span class="num">{formatMinor(contact.outstandingMinor)}</span>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .figures {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .big {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .overdue {
    text-align: right;
    color: var(--muted-foreground);
  }
  .overdue .num {
    font-size: 15px;
    font-weight: 600;
    margin-top: 4px;
  }
  .overdue.has .num {
    color: var(--red);
  }
  .caption {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .contacts {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .contact {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
    font-size: 13px;
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .contact :global(.chev) {
    color: var(--muted-foreground);
  }
</style>
