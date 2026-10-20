<script lang="ts">
  import { enhance } from "$app/forms";
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import {
    Calendar,
    ChevronRight,
    Lock,
    Plus,
    Search,
    SlidersHorizontal,
    Tag,
    Trash2,
    Wallet,
    X,
  } from "@lucide/svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import StatCard from "$lib/components/ui/StatCard.svelte";
  import BulkActionBar from "$lib/components/ui/BulkActionBar.svelte";
  import FilterDropdown from "$lib/components/ui/FilterDropdown.svelte";
  import AmountInput from "$lib/components/ui/AmountInput.svelte";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { statusLabelFor } from "$lib/components/ledger/record-status.js";
  import {
    formatDateShort,
    formatMinor,
    formatMinorAmount,
  } from "$lib/format.js";
  import {
    mainCurrency,
    mainCurrencySymbol,
  } from "$lib/currency-state.svelte.js";
  import { formatCurrencyAmount } from "$lib/currency.js";
  import { createResourceStream, mergeById } from "$lib/sse.js";
  import { SvelteSet, SvelteURLSearchParams } from "svelte/reactivity";
  import { AccountType, LedgerRecordKindDisplayLabels } from "$lib/enums.js";
  import { isCategorySide } from "$lib/components/ledger/account-sub-types.js";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import type {
    OutstandingItem,
    RecordView,
  } from "$lib/server/ledger/types.js";
  import type { loadRecordsPage } from "$lib/server/loaders/records.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";

  /**
   * Everything that happened with money, in one list.
   *
   * Every row is a record in the one store — a purchase, a sale, a transfer, a
   * payment, an opening balance, an entry made by hand — newest first. There is
   * no kind to choose before you can look, because the store never had one list
   * per kind; the three screens this replaces were three filters over these same
   * rows, and a transfer belonged to neither of them (FR-001).
   *
   * Everything the screen says about payment — paid, part paid, still owed — is
   * read off what the server derived from settlements rather than from a status
   * column, so this list and the record's own drawer can never disagree
   * (FR-012).
   *
   * Labels use the standard accounting term (debit, credit, receivable,
   * payable, reconciled), with a short ASD-STE100 hint where a hint helps.
   */
  type PageData = ReturnType<typeof loadRecordsPage>;
  type ActionData = {
    error?: string;
    success?: boolean;
    deleted?: number;
    refusedReason?: string | null;
  } | null;

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The list the screen draws: what the server sent, until the stream says
  // otherwise. Writable, so an SSE event edits it in place; derived, so a real
  // navigation or a form action re-syncs it back to the server's answer.
  let records = $derived(data.records);

  // --- Reading one record -----------------------------------------------
  // The two accounts a record names: the one it posts from, and the one it
  // posts to. A record that someone else paid has Accounts Payable on the paying
  // side instead of an account (FR-008), which is what makes it read as
  // outstanding.
  //
  // Both directions live in one list now, so "category" is whichever side says
  // what the record was *for* — a spending category, an earning category, or
  // equipment — rather than the expense categories alone.
  // `isCategorySide` rather than a list of types, because equipment is an asset
  // and still a category (002 FR-006b).
  function categoryOf(record: RecordView) {
    return (
      record.movements.find(isCategorySide) ??
      record.movements.find((m) => m.amountMinor > 0) ??
      null
    );
  }

  function categoryName(record: RecordView): string {
    return categoryOf(record)?.accountName ?? "";
  }

  /**
   * Every category side a record has, not just the first — a record split
   * across more than one category (a bill covering fuel and paper) has one
   * movement per category, and the Category filter has to match any of them,
   * not only whichever `categoryOf` happens to find first.
   */
  function categoriesOf(record: RecordView) {
    const sides = record.movements.filter(isCategorySide);
    return sides.length ? sides : record.movements.filter((m) => m.amountMinor > 0);
  }

  /**
   * Which way the money went, decided by the record's own sides.
   *
   * This is the rule the `+` prefix and the green amount hang off, and it is
   * deliberately a fact about the record rather than about which screen you are
   * on: the Income list coloured every row green because it only ever held
   * income. One list holds both, so each row answers for itself.
   *
   * A transfer, a payment between accounts and a hand-made entry are neither in
   * nor out — the money moved without the business being richer or poorer — and
   * they get no sign at all rather than a misleading one.
   */
  function directionOf(record: RecordView): "in" | "out" | "neither" {
    const category = record.movements.find(isCategorySide);
    if (!category) return "neither";
    if (category.accountType === AccountType.Revenue) return "in";
    return "out";
  }

  /** The two accounts money moved between, in the order it moved. */
  function sidesOf(record: RecordView): { from: string; to: string } {
    // Value leaving an account is negative and value arriving is positive, so
    // the sides name themselves; no screen-specific rule is needed.
    const from = record.movements.find((m) => m.amountMinor < 0);
    const to = record.movements.find((m) => m.amountMinor > 0);
    return { from: from?.accountName ?? "", to: to?.accountName ?? "" };
  }

  // `locked` and `lockedReason` are computed server-side and travel with the
  // record, so the rule in src/lib/server/ledger/locking.ts is read here rather
  // than hand-duplicated — there is nothing for the two copies to disagree on.

  // --- Filter and sort state ---------------------------------------------
  let searchRaw = $state("");
  let search = $state("");
  // Which ids the server matched for the current search term — server-side
  // because the search text (including OCR'd attachment content) lives in
  // `record_search_text`, not on the record rows already loaded into the
  // browser. `null` means no search is active, so every other filter below
  // still runs over the full loaded batch exactly as before.
  let searchMatchedIds = $state<Set<number> | null>(null);
  let searchTotal = $state<number | null>(null);
  let statusTab = $state("all");
  let selectedCats = $state<number[]>([]);
  // One list of every kind, so which kinds to show is a filter rather than a
  // screen (FR-002).
  let selectedKinds = $state<number[]>([]);
  // Which account the money moved through. Also what puts the screen into
  // statement mode when it is the only filter in force (FR-040).
  let selectedAccountId = $state<number | null>(null);
  /**
   * Which contact the money was with — the purchase and sales ledger, read one
   * contact at a time. `RecordListFilters.contactId` and the API have always
   * accepted this; the screen simply never offered it (FR-008).
   */
  let selectedContactId = $state<number | null>(null);
  /**
   * The cross-account "still to clear" worklist (FR-056).
   *
   * This replaces the reconciliation workspace's "Akaun Records" tab and its
   * "Needs Review" filter. It covers **every** account, not only those with a
   * statement uploaded, which the tab it replaces could not do.
   *
   * It is a worklist and not a second way in: reconciling starts from the
   * account it belongs to, and nothing here offers to start it.
   */
  let clearedFilter = $state<"all" | "not-cleared">("all");
  let amountMin = $state("");
  let amountMax = $state("");
  let dateFrom = $state("");
  let dateTo = $state("");
  let sort = $state({ key: "date", dir: "desc" as "asc" | "desc" });
  let selected = new SvelteSet<number>();

  let mobileFilterOpen = $state(false);
  let mobileSearchOpen = $state(false);
  let mobileSearchEl = $state<HTMLInputElement | null>(null);
  let deleteDialogOpen = $state(false);
  let deleteFormEl = $state<HTMLFormElement | null>(null);
  // Shown until it is dismissed or the next action replaces it.
  let actionError = $derived(form?.error ?? form?.refusedReason ?? "");

  $effect(() => {
    if (mobileSearchOpen && mobileSearchEl) mobileSearchEl.focus();
  });

  // Debounced search
  $effect(() => {
    const v = searchRaw;
    const t = setTimeout(() => (search = v), 300);
    return () => clearTimeout(t);
  });

  // A keyword can live anywhere `record_search_text` reaches — an OCR'd
  // attachment, a reference number typed years ago — none of which is in the
  // rows already loaded into the browser, so the term goes to the server
  // instead of a client-only field check (mirrors `ContactSelect.svelte`).
  $effect(() => {
    const term = search.trim();
    if (!term) {
      searchMatchedIds = null;
      searchTotal = null;
      return;
    }
    fetch(`/api/records?search=${encodeURIComponent(term)}&limit=500`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { records: RecordView[]; total: number } | null) => {
        if (!body) {
          searchMatchedIds = new Set();
          searchTotal = null;
          return;
        }
        records = mergeById(records, body.records);
        searchMatchedIds = new Set(body.records.map((r) => r.id));
        searchTotal = body.total;
      })
      .catch(() => {
        searchMatchedIds = new Set();
        searchTotal = null;
      });
  });

  // --- Derived ------------------------------------------------------------
  /**
   * What each kind is called on screen.
   *
   * Everyday words, not the enum's names (Principle VII). Payment, transfer,
   * opening balance and hand-made entries have no screen of their own and never
   * did — this is the first list they appear on, so each one needs a name a
   * person recognises.
   */
  const KIND_LABELS = LedgerRecordKindDisplayLabels;

  function kindLabel(kind: number): string {
    return KIND_LABELS[kind] ?? "Record";
  }

  const KIND_FILTERS = Object.entries(KIND_LABELS).map(([code, label]) => ({
    code: Number(code),
    label,
  }));

  const STATUS_TABS = [
    ["all", "All"],
    ["owed", "Outstanding"],
    ["part-paid", "Partially paid"],
    ["paid", "Paid"],
  ] as const;

  const counts = $derived.by(() => {
    const out: Record<string, number> = {
      all: records.length,
      owed: 0,
      "part-paid": 0,
      paid: 0,
    };
    for (const r of records) out[statusLabelFor(r)]++;
    return out;
  });

  const filtered = $derived.by(() => {
    let rows = records.slice();
    if (statusTab !== "all") {
      rows = rows.filter((r) => statusLabelFor(r) === statusTab);
    }
    if (selectedCats.length) {
      rows = rows.filter((r) =>
        categoriesOf(r).some((category) => selectedCats.includes(category.accountId)),
      );
    }
    if (selectedKinds.length) {
      rows = rows.filter((r) => selectedKinds.includes(r.kind));
    }
    if (selectedAccountId !== null) {
      rows = rows.filter((r) =>
        r.movements.some((m) => m.accountId === selectedAccountId),
      );
    }
    if (selectedContactId !== null) {
      rows = rows.filter((r) => r.contactId === selectedContactId);
    }
    if (clearedFilter === "not-cleared") rows = rows.filter((r) => !r.cleared);
    const mn = amountMin !== "" ? parseFloat(amountMin) * 100 : null;
    const mx = amountMax !== "" ? parseFloat(amountMax) * 100 : null;
    if (mn != null) rows = rows.filter((r) => r.amountMinor >= mn);
    if (mx != null) rows = rows.filter((r) => r.amountMinor <= mx);
    if (dateFrom) rows = rows.filter((r) => r.date >= dateFrom);
    if (dateTo) rows = rows.filter((r) => r.date <= dateTo);
    if (searchMatchedIds) {
      const matched = searchMatchedIds;
      rows = rows.filter((r) => matched.has(r.id));
    }

    const key = sort.key;
    rows.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      let cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp === 0) cmp = a.id - b.id;
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return rows;
  });

  function sortValue(record: RecordView, key: string): string | number {
    switch (key) {
      case "description":
        return record.description.toLowerCase();
      case "contactName":
        return (record.contactName ?? "").toLowerCase();
      case "category":
        return categoryName(record).toLowerCase();
      case "kind":
        return kindLabel(record.kind).toLowerCase();
      case "status":
        return statusLabelFor(record);
      case "amount":
        return record.amountMinor;
      default:
        return record.date;
    }
  }

  const filteredTotal = $derived(
    filtered.reduce((sum, r) => sum + r.amountMinor, 0),
  );
  const activeFilterCount = $derived(
    selectedCats.length +
      selectedKinds.length +
      (selectedAccountId !== null ? 1 : 0) +
      (selectedContactId !== null ? 1 : 0) +
      (clearedFilter !== "all" ? 1 : 0) +
      (amountMin || amountMax ? 1 : 0) +
      (dateFrom || dateTo ? 1 : 0) +
      (search.trim() ? 1 : 0),
  );

  /**
   * One fixed set of four, in the Dashboard's vocabulary.
   *
   * Expenses showed "Still owed / Paid / This month / All recorded" and Income
   * showed "This quarter" and "Largest payment". Neither set survives whole:
   * with both directions in one list, "Paid" and "This month" answer a question
   * the reader has to guess the subject of. Income and expenses are the two
   * figures that mean the same thing whatever the row is, so they lead, and the
   * screen says the same four things the Dashboard does (research.md R-01).
   *
   * Read over `filtered`, never `records`: the strip answers for the rows the
   * table is showing. Summing everything while the table showed a subset made
   * the two halves of one screen disagree — a search for one supplier left
   * "Expenses" reading the whole book, which looks like the filter failed or,
   * worse, gets copied down as that supplier's total. The card at the end says
   * how much of the book is in view, so a filtered figure is never mistaken for
   * the all-time one.
   */
  const stats = $derived.by(() => {
    let inTotal = 0;
    let inCount = 0;
    let outTotal = 0;
    let outCount = 0;
    for (const r of filtered) {
      const direction = directionOf(r);
      if (direction === "in") {
        inTotal += r.amountMinor;
        inCount++;
      } else if (direction === "out") {
        outTotal += r.amountMinor;
        outCount++;
      }
    }
    const unpaid = filtered.filter((r) => !r.paid);
    return {
      inTotal,
      inCount,
      outTotal,
      outCount,
      owedTotal: unpaid.reduce((sum, r) => sum + r.outstandingMinor, 0),
      owedCount: unpaid.length,
    };
  });

  /** Whether anything at all narrows the list — the status tabs included. */
  const isNarrowed = $derived(activeFilterCount > 0 || statusTab !== "all");

  // --- Selection ----------------------------------------------------------
  function toggleAll() {
    if (allSelected) selectableRecords.forEach((r) => selected.delete(r.id));
    else selectableRecords.forEach((r) => selected.add(r.id));
  }

  function toggleOne(id: number) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  function clearSel() {
    selected.clear();
  }

  function onSort(key: string) {
    if (sort.key === key) {
      sort = { key, dir: sort.dir === "asc" ? "desc" : "asc" };
    } else {
      sort = { key, dir: key === "amount" || key === "date" ? "desc" : "asc" };
    }
  }

  function clearAllFilters() {
    selectedCats = [];
    selectedKinds = [];
    selectedAccountId = null;
    selectedContactId = null;
    clearedFilter = "all";
    amountMin = "";
    amountMax = "";
    dateFrom = "";
    dateTo = "";
    searchRaw = "";
    statusTab = "all";
  }

  function toggleCat(id: number) {
    selectedCats = selectedCats.includes(id)
      ? selectedCats.filter((x) => x !== id)
      : [...selectedCats, id];
  }

  /**
   * Which filter emptied the list, named.
   *
   * "You have no records" is a lie when the user has hundreds and has narrowed
   * to a date range with nothing in it — and it is the message that sends
   * somebody looking for a bug in their data (spec edge case). So the empty
   * state says what is currently narrowing the view, and the reader can see
   * which one to loosen.
   */
  const activeFilterNames = $derived.by(() => {
    const names: string[] = [];
    if (search.trim()) names.push(`the search “${search.trim()}”`);
    if (statusTab !== "all") {
      names.push(
        `the ${STATUS_TABS.find(([id]) => id === statusTab)?.[1].toLowerCase() ?? statusTab} tab`,
      );
    }
    if (selectedKinds.length) {
      names.push(
        selectedKinds.length === 1
          ? `the kind “${kindLabel(selectedKinds[0])}”`
          : `${selectedKinds.length} kinds`,
      );
    }
    if (selectedAccountId !== null) {
      const account = data.allAccounts.find(
        (a) => a.id === selectedAccountId,
      );
      names.push(account ? `the account “${account.name}”` : "an account");
    }
    if (selectedCats.length) {
      names.push(
        selectedCats.length === 1
          ? `the category “${data.categories.find((c) => c.id === selectedCats[0])?.name ?? ""}”`
          : `${selectedCats.length} categories`,
      );
    }
    if (selectedContactId !== null) {
      const contact = data.contacts.find((c) => c.id === selectedContactId);
      names.push(contact ? `the contact “${contact.legalName}”` : "a contact");
    }
    if (clearedFilter === "not-cleared") names.push("“unreconciled”");
    if (dateFrom && dateTo) names.push(`dates ${dateFrom} to ${dateTo}`);
    else if (dateFrom) names.push(`dates from ${dateFrom}`);
    else if (dateTo) names.push(`dates up to ${dateTo}`);
    if (amountMin || amountMax) names.push("the amount range");
    return names;
  });

  const emptyReason = $derived.by(() => {
    const names = activeFilterNames;
    if (names.length === 0) return "";
    if (names.length === 1) return `Nothing matches ${names[0]}.`;
    const last = names[names.length - 1];
    return `Nothing matches ${names.slice(0, -1).join(", ")} and ${last}.`;
  });

  function toggleKind(code: number) {
    selectedKinds = selectedKinds.includes(code)
      ? selectedKinds.filter((x) => x !== code)
      : [...selectedKinds, code];
  }

  // --- Opening one record -------------------------------------------------
  // A record has its own page. The row is a real link as well, so hovering
  // preloads it and Cmd-click opens it in a tab; this is the keyboard and
  // programmatic path to the same address.
  function recordHref(id: number): string {
    return resolve("/(app)/records/[id]", { id: String(id) });
  }

  function openRecord(record: RecordView) {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
    void goto(recordHref(record.id));
  }

  // --- Who is owed, and how much is left ----------------------------------
  // An expense somebody else paid for is money this business owes them until a
  // payment covers it. The figures come from `GET /api/settlements` rather than
  // being added up here, so this panel, a record's own drawer and the reports
  // are all reading one answer to one question (FR-014).
  type OwedGroup = {
    contactId: number;
    contactName: string;
    totalMinor: number;
    items: OutstandingItem[];
  };

  let owedItems = $state<OutstandingItem[]>([]);
  let owedSheetOpen = $state(false);
  const owedScreen = useIsMobile();
  const owedIsMobile = $derived(owedScreen.current);
  const owedPanelSide = $derived(owedIsMobile ? "bottom" : "right");

  async function loadOwed() {
    const res = await fetch("/api/settlements?direction=we-owe");
    if (!res.ok) return;
    const body = await res.json();
    owedItems = body?.items ?? [];
  }

  const owedGroups = $derived.by(() => {
    const byContact: Record<number, OwedGroup> = {};
    for (const item of owedItems) {
      // A record on a shared owed account always names who it is owed to, so an
      // item without one is a broken row rather than an "unknown" group.
      if (item.contactId === null) continue;
      const group = (byContact[item.contactId] ??= {
        contactId: item.contactId,
        contactName: item.contactName ?? "",
        totalMinor: 0,
        items: [],
      });
      group.totalMinor += item.outstandingMinor;
      group.items.push(item);
    }
    return Object.values(byContact).sort((a, b) => b.totalMinor - a.totalMinor);
  });

  const owedTotal = $derived(
    owedGroups.reduce((sum, g) => sum + g.totalMinor, 0),
  );

  function openOwedItem(item: OutstandingItem) {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
    void goto(recordHref(item.recordId));
  }

  // A payment opens scoped to this contact, the way the drawer it replaced
  // always did — carried as a query param since it's prefilled context for a
  // create form, not a link to another feature's record.
  function payHref(group: OwedGroup): string {
    return `${resolve("/(app)/records/new/payment")}?contactId=${group.contactId}`;
  }

  /** One transfer settling every outstanding payable at once, across every
   *  contact — the payment screen opens in batch mode with everything
   *  ticked, so this is one action rather than one per contact. */
  function payAllHref(): string {
    return `${resolve("/(app)/records/new/payment")}?direction=we-pay&batch=1`;
  }

  // --- Live updates -------------------------------------------------------
  type LedgerStreamMsg =
    | { type: "record-update"; record: RecordView }
    | { type: "record-deleted"; id: number }
    | { type: "settlement-changed"; recordIds: number[] };

  // One list of every kind, so one connection and no kind filter — on the
  // stream or here. A record arriving from another tab is merged in whatever it
  // is; there is no longer a kind this screen would have to drop.
  createResourceStream<LedgerStreamMsg>("/api/records/stream", (msg) => {
    if (msg.type === "record-update") {
      records = mergeById(records, [msg.record]);
    } else if (msg.type === "record-deleted") {
      records = records.filter((r) => r.id !== msg.id);
    }
    // The record list is patched in place from the event, but what is still
    // owed is derived across records — including payments this screen does not
    // hold — so it is asked for again rather than guessed at.
    void loadOwed();
  });

  // --- Statement mode (D-05) ----------------------------------------------
  /**
   * When the list is narrowed to one account and nothing else, it becomes that
   * account's statement: the same rows, plus a running balance, an opening
   * figure before the first row and a closing figure after the last.
   *
   * This is what the separate account-history page used to be. It is not a
   * second screen — it is this screen with one filter on it — which is why the
   * running balance appears and disappears rather than living somewhere else
   * (FR-040, FR-041).
   */
  const statementMode = $derived(
    selectedAccountId !== null &&
      selectedKinds.length === 0 &&
      selectedCats.length === 0 &&
      statusTab === "all" &&
      clearedFilter === "all" &&
      selectedContactId === null &&
      !amountMin &&
      !amountMax &&
      !search.trim(),
  );

  /**
   * Whether the running balance may be shown at all.
   *
   * Sorting by amount breaks it: each figure would be the balance of the rows
   * above it in an order the money never happened in. So the balance goes the
   * moment the sort changes, and the screen says why — a missing figure with no
   * explanation reads as a fault (FR-043).
   */
  const runningBalanceHolds = $derived(statementMode && sort.key === "date");

  type StatementEntry = {
    movementId: number;
    recordId: number;
    recordNumber: string | null;
    date: string;
    description: string;
    contactName: string | null;
    amountMinor: number;
    runningBalanceMinor: number;
  };
  type Statement = {
    account: { id: number; name: string; role: number };
    entries: StatementEntry[];
    selectionRecords: { id: number; amountMinor: number; locked: boolean }[];
    openingBalanceMinor: number;
    closingBalanceMinor: number;
    total: number;
    notes: string[];
  };

  let statement = $state<Statement | null>(null);
  let statementLoading = $state(false);
  // Statements can include older records and more than one movement per record.
  // Bulk actions use the unique records actually displayed, with their own amounts.
  const selectableRecords = $derived(
    runningBalanceHolds && statement ? statement.selectionRecords : filtered,
  );

  const allSelected = $derived(
    selectableRecords.length > 0 &&
      selectableRecords.every((r) => selected.has(r.id)),
  );
  const someSelected = $derived(
    selectableRecords.some((r) => selected.has(r.id)) && !allSelected,
  );
  const selectedList = $derived(
    selectableRecords.filter((r) => selected.has(r.id)),
  );
  const selTotal = $derived(
    selectedList.reduce((sum, r) => sum + r.amountMinor, 0),
  );
  // A record a settlement or a bank line still points at refuses deletion, so
  // the bar says so up front rather than after the fact.
  const lockedSelected = $derived(selectedList.filter((r) => r.locked).length);


  $effect(() => {
    if (!statementMode || selectedAccountId === null) {
      statement = null;
      return;
    }
    const accountId = selectedAccountId;
    const from = dateFrom;
    const to = dateTo;
    statementLoading = true;
    const query = new SvelteURLSearchParams({ accountId: String(accountId) });
    if (from) query.set("dateFrom", from);
    if (to) query.set("dateTo", to);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/records/statement?${query}`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (!cancelled) statement = body;
      } finally {
        if (!cancelled) statementLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /** The statement as a CSV, in the same signs and the same order as the screen. */
  function exportStatementCsv() {
    if (selectedAccountId === null) return;
    const query = new SvelteURLSearchParams({
      accountId: String(selectedAccountId),
      format: "csv",
    });
    if (dateFrom) query.set("dateFrom", dateFrom);
    if (dateTo) query.set("dateTo", dateTo);
    window.location.href = `/api/records/statement?${query}`;
  }

  // --- Filters in the address bar ----------------------------------------
  // A filtered view is a thing people send to each other, so it has to survive
  // being copied out of the address bar (FR-002). The URL is written from the
  // filter state, never the other way round after the first read, so typing in
  // the search box does not fight the router.
  let urlReady = $state(false);

  function readFiltersFromUrl() {
    const q = page.url.searchParams;
    const account = q.get("account");
    if (account !== null && Number.isFinite(Number(account))) {
      selectedAccountId = Number(account);
    }
    const contact = q.get("contact");
    if (contact !== null && Number.isFinite(Number(contact))) {
      selectedContactId = Number(contact);
    }
    const kinds = q.get("kind");
    if (kinds) {
      selectedKinds = kinds
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((code) => Number.isInteger(code));
    }
    const category = q.get("category");
    if (category) {
      selectedCats = category
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isInteger(id));
    }
    if (q.get("status")) statusTab = q.get("status")!;
    if (q.get("cleared") === "false") clearedFilter = "not-cleared";
    if (q.get("dateFrom")) dateFrom = q.get("dateFrom")!;
    if (q.get("dateTo")) dateTo = q.get("dateTo")!;
    if (q.get("amountMin")) amountMin = q.get("amountMin")!;
    if (q.get("amountMax")) amountMax = q.get("amountMax")!;
    if (q.get("search")) {
      searchRaw = q.get("search")!;
      search = searchRaw;
    }
    if (q.get("sort") === "amount") sort = { key: "amount", dir: "desc" };
  }

  $effect(() => {
    if (!urlReady) return;
    // Every filter that is on, and nothing that is off, so a shared link
    // carries exactly what the sender was looking at.
    const q = new SvelteURLSearchParams();
    if (selectedAccountId !== null) q.set("account", String(selectedAccountId));
    if (selectedContactId !== null) q.set("contact", String(selectedContactId));
    if (selectedKinds.length) q.set("kind", selectedKinds.join(","));
    if (selectedCats.length) q.set("category", selectedCats.join(","));
    if (statusTab !== "all") q.set("status", statusTab);
    if (clearedFilter !== "all") q.set("cleared", "false");
    if (dateFrom) q.set("dateFrom", dateFrom);
    if (dateTo) q.set("dateTo", dateTo);
    if (amountMin) q.set("amountMin", amountMin);
    if (amountMax) q.set("amountMax", amountMax);
    if (search.trim()) q.set("search", search.trim());
    if (sort.key === "amount") q.set("sort", "amount");

    const query = q.toString();
    const next = query ? `?${query}` : page.url.pathname;
    // replaceState, not a navigation: the list is already loaded and the SSE
    // connection and the scroll position must survive a filter change.
    if (next !== page.url.search || (!query && page.url.search)) {
      history.replaceState(history.state, "", next);
    }
  });

  onMount(() => {
    readFiltersFromUrl();
    urlReady = true;
    void loadOwed();
  });
</script>

{#snippet selectAllCheckbox()}
  <button
    type="button"
    style="width:17px; height:17px; border-radius:5px; border:1.5px solid {allSelected
      ? 'var(--primary)'
      : 'var(--border-strong)'}; background:{allSelected || someSelected
      ? 'var(--primary)'
      : 'var(--card)'}; display:grid; place-items:center; cursor:pointer; color:var(--primary-foreground); padding:0; flex-shrink:0;"
    onclick={toggleAll}
    aria-label="Select all"
  >
    {#if allSelected}<svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg
      >{:else if someSelected}<span
        style="width:8px; height:2px; border-radius:2px; background:white; display:block;"
      ></span>{/if}
  </button>
{/snippet}

{#snippet rowCheckbox(id: number, label: string)}
  <button
    type="button"
    style="width:17px; height:17px; border-radius:5px; border:1.5px solid {selected.has(
      id,
    )
      ? 'var(--primary)'
      : 'var(--border-strong)'}; background:{selected.has(id)
      ? 'var(--primary)'
      : 'var(--card)'}; display:grid; place-items:center; cursor:pointer; color:var(--primary-foreground); padding:0; flex-shrink:0;"
    aria-label="Select {label}"
  >
    {#if selected.has(id)}<svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg
      >{/if}
  </button>
{/snippet}

<div class="screen" style="position:relative;">
  <!-- Top bar -->
  <header class="topbar">
    <div class="topbar-left">
      <h1 class="page-title">Records</h1>
      <p class="page-sub">
        {counts.all} records · all transactions
      </p>
    </div>
    <div class="topbar-right">
      <div class="search-box">
        <div style="position:relative; display:flex; align-items:center;">
          <span
            style="position:absolute; left:10px; color:var(--muted-foreground); display:flex; pointer-events:none;"
          >
            <Search size={15} />
          </span>
          <Input
            type="search"
            placeholder="Search description, contact, ref…"
            bind:value={searchRaw}
            class="h-[34px] pl-8 text-[13px]"
          />
        </div>
      </div>
      {#if mobileSearchOpen}
        <div
          class="mobile-search-inline"
          transition:fly={{ x: 12, duration: 180 }}
        >
          <span class="mobile-search-inline-icon"><Search size={15} /></span>
          <input
            class="mobile-search-inline-input"
            type="search"
            placeholder="Search description, contact, ref…"
            bind:value={searchRaw}
            bind:this={mobileSearchEl}
          />
        </div>
      {/if}
      <button
        class="mobile-search-toggle"
        class:active={mobileSearchOpen}
        onclick={() => {
          mobileSearchOpen = !mobileSearchOpen;
          if (!mobileSearchOpen) searchRaw = "";
        }}
      >
        {#if mobileSearchOpen}<X size={16} />{:else}<Search size={16} />{/if}
      </button>
      {#if data.perms.add}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
        <a
          href={resolve("/(app)/records/new")}
          style="display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; background:var(--primary); color:var(--primary-foreground); border:none; border-radius:8px; font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; text-decoration:none;"
        >
          <Plus size={15} /> <span class="btn-text">New record</span>
        </a>
      {/if}
    </div>
  </header>

  <!-- Stat strip -->
  <div class="stat-strip">
    <StatCard
      tone="green"
      label="Income"
      cur={mainCurrencySymbol()}
      value={formatMinorAmount(stats.inTotal)}
      sub="{stats.inCount} records"
    />
    <StatCard
      tone="red"
      label="Expenses"
      cur={mainCurrencySymbol()}
      value={formatMinorAmount(stats.outTotal)}
      sub="{stats.outCount} records"
    />
    <StatCard
      label="Outstanding"
      cur={mainCurrencySymbol()}
      value={formatMinorAmount(stats.owedTotal)}
      sub="{stats.owedCount} open items"
    />
    <!-- A count, not money, so no currency prefix — the other three carry one. -->
    <StatCard
      label={isNarrowed ? "Records shown" : "All records"}
      value={String(filtered.length)}
      sub={isNarrowed
        ? `of ${counts.all} · totals reflect the filtered records`
        : "all types, newest first"}
    />
  </div>

  <div class="work">
    <div class="work-main layout-standard" style="padding-top:12px;">
      {#if actionError}
        <div class="page-error">
          {actionError}
          <button
            type="button"
            aria-label="Dismiss"
            onclick={() => (actionError = "")}><X size={13} /></button
          >
        </div>
      {/if}

      <!-- Who is owed, and how much is left -->
      {#if owedGroups.length > 0}
        <section class="owed-panel">
          <div class="owed-head-main">
            <span class="owed-head-title">Outstanding payables</span>
            <span class="owed-head-sub">
              {owedGroups.length}
              {owedGroups.length === 1 ? "contact" : "contacts"} · amounts due
              to contacts
            </span>
          </div>
          <span class="owed-head-total num">{formatMinor(owedTotal)}</span>
          {#if data.perms.add && owedGroups.length > 1}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
            <a class="owed-pay-btn" href={payAllHref()}>Pay all payables</a>
          {/if}
          <button
            type="button"
            class="owed-view-btn"
            onclick={() => (owedSheetOpen = true)}
          >
            View details
            <ChevronRight size={13} color="var(--muted-foreground)" />
          </button>
        </section>
      {/if}

      <!-- Toolbar -->
      <div class="toolbar">
        <div class="status-tabs">
          {#each STATUS_TABS as [id, label] (id)}
            <button
              class="status-tab"
              class:active={statusTab === id}
              onclick={() => (statusTab = id)}
            >
              {label}<span class="tab-count">{counts[id]}</span>
            </button>
          {/each}
        </div>
        <div class="mobile-filter-row">
          <button
            class="btn-outline btn-sm"
            style="display:inline-flex; align-items:center; gap:6px;"
            onclick={() => (mobileFilterOpen = true)}
          >
            <SlidersHorizontal size={13} /> Filters
            {#if activeFilterCount > 0}<span class="filter-count"
                >{activeFilterCount}</span
              >{/if}
          </button>
          {#if activeFilterCount > 0}
            <button class="clear-filters" onclick={clearAllFilters}
              ><X size={13} /> Clear</button
            >
          {/if}
        </div>
        <div class="toolbar-filters">
          {#if activeFilterCount > 0}
            <button class="clear-filters" onclick={clearAllFilters}>
              <X size={13} /> Clear
            </button>
          {/if}
          <!-- A worklist, not a second way into reconciling: it says what still
               needs clearing across every account, and offers no way to start
               (FR-056, D-06). -->
          <button
            type="button"
            class="clearfilter"
            class:active={clearedFilter === "not-cleared"}
            onclick={() =>
              (clearedFilter =
                clearedFilter === "not-cleared" ? "all" : "not-cleared")}
          >
            Unreconciled
          </button>

          <FilterDropdown label="Kind" active={selectedKinds.length > 0}>
            {#snippet icon()}<Wallet size={14} />{/snippet}
            <div style="padding:5px;">
              <div class="fd-head">
                <span>Kinds</span>
                {#if selectedKinds.length}<button
                    onclick={() => (selectedKinds = [])}
                    class="fd-clear">Clear</button
                  >{/if}
              </div>
              {#each KIND_FILTERS as k (k.code)}
                <button
                  class="fd-option"
                  class:selected={selectedKinds.includes(k.code)}
                  onclick={() => toggleKind(k.code)}
                >
                  <span>{k.label}</span>
                </button>
              {/each}
            </div>
          </FilterDropdown>

          <FilterDropdown label="Contact" active={selectedContactId !== null}>
            {#snippet icon()}<Tag size={14} />{/snippet}
            <div style="padding:5px; max-height:280px; overflow-y:auto;">
              <div class="fd-head">
                <span>Contacts</span>
                {#if selectedContactId !== null}<button
                    onclick={() => (selectedContactId = null)}
                    class="fd-clear">Clear</button
                  >{/if}
              </div>
              {#each data.contacts as c (c.id)}
                <button
                  class="fd-option"
                  class:selected={selectedContactId === c.id}
                  onclick={() =>
                    (selectedContactId = selectedContactId === c.id ? null : c.id)}
                >
                  <span>{c.legalName}</span>
                </button>
              {/each}
            </div>
          </FilterDropdown>

          <FilterDropdown label="Account" active={selectedAccountId !== null}>
            {#snippet icon()}<Wallet size={14} />{/snippet}
            <div style="padding:5px; max-height:280px; overflow-y:auto;">
              <div class="fd-head">
                <span>Accounts</span>
                {#if selectedAccountId !== null}<button
                    onclick={() => (selectedAccountId = null)}
                    class="fd-clear">Clear</button
                  >{/if}
              </div>
              {#each data.allAccounts as a (a.id)}
                <button
                  class="fd-option"
                  class:selected={selectedAccountId === a.id}
                  onclick={() =>
                    (selectedAccountId = selectedAccountId === a.id
                      ? null
                      : a.id)}
                >
                  <span>{a.name}</span>
                </button>
              {/each}
            </div>
          </FilterDropdown>

          <FilterDropdown label="Category" active={selectedCats.length > 0}>
            {#snippet icon()}<Tag size={14} />{/snippet}
            <div style="padding:5px;">
              <div
                style="display:flex; align-items:center; justify-content:space-between; padding:6px 8px 8px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground);"
              >
                <span>Categories</span>
                {#if selectedCats.length}<button
                    onclick={() => (selectedCats = [])}
                    style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;"
                    >Clear</button
                  >{/if}
              </div>
              {#each data.categories as cat (cat.id)}
                <button
                  onclick={() => toggleCat(cat.id)}
                  class="cat-option"
                  class:on={selectedCats.includes(cat.id)}
                >
                  <span class="cat-box" aria-hidden="true">
                    {#if selectedCats.includes(cat.id)}<svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="white"
                        stroke-width="3"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        ><path d="M20 6 9 17l-5-5" /></svg
                      >{/if}
                  </span>
                  {cat.name}
                </button>
              {/each}
            </div>
          </FilterDropdown>

          <FilterDropdown label="Date" active={!!(dateFrom || dateTo)}>
            {#snippet icon()}<Calendar size={14} />{/snippet}
            <div style="padding:12px 14px;">
              <div
                style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"
              >
                <div
                  style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground);"
                >
                  Date range
                </div>
                {#if dateFrom || dateTo}<button
                    onclick={() => {
                      dateFrom = "";
                      dateTo = "";
                    }}
                    style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600; padding:0;"
                    >Clear</button
                  >{/if}
              </div>
              <div style="display:flex; flex-direction:column; gap:8px;">
                <span style="font-size:11.5px; color:var(--muted-foreground);"
                  >From</span
                >
                <DatePicker bind:value={dateFrom} placeholder="From date" />
                <span style="font-size:11.5px; color:var(--muted-foreground);"
                  >To</span
                >
                <DatePicker bind:value={dateTo} placeholder="To date" />
              </div>
            </div>
          </FilterDropdown>

          <FilterDropdown
            label="Amount"
            active={!!(amountMin || amountMax)}
            align="right"
          >
            {#snippet icon()}<SlidersHorizontal size={14} />{/snippet}
            <div style="padding:12px 14px; min-width:168px;">
              <div
                style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"
              >
                <div
                  style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground);"
                >
                  Amount range
                </div>
                {#if amountMin || amountMax}<button
                    onclick={() => {
                      amountMin = "";
                      amountMax = "";
                    }}
                    style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600; padding:0;"
                    >Clear</button
                  >{/if}
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <AmountInput
                  wrapperStyle="width:120px;"
                  placeholder="Min"
                  bind:value={amountMin}
                  style="width:84px;"
                />
                <span style="color:var(--muted-foreground);">–</span>
                <AmountInput
                  wrapperStyle="width:120px;"
                  placeholder="Max"
                  bind:value={amountMax}
                  style="width:84px;"
                />
              </div>
            </div>
          </FilterDropdown>
        </div>
      </div>

      <!-- Result meta -->
      {#if filtered.length > 0 || activeFilterCount > 0}
        <div class="result-meta">
          <span>Showing <b>{filtered.length}</b> of {counts.all}</span>
          <span class="result-total"
            >Filtered total <b class="num">{formatMinor(filteredTotal)}</b
            ></span
          >
        </div>
      {/if}

      {#if statementMode}
        <!-- The account's statement: the same rows, with a running balance
             (FR-040–FR-042). -->
        <div
          class="statement"
          class:statement-active={runningBalanceHolds && statement}
        >
          <div class="statement-head">
            <div>
              <h2 class="statement-title">
                {statement?.account.name ??
                  data.allAccounts.find((a) => a.id === selectedAccountId)?.name ??
                  "This account"}
              </h2>
              <p class="statement-sub">
                {#if runningBalanceHolds && statement}
                  {statement.total} transactions{dateFrom || dateTo ? " in this date range" : ""}
                {:else}
                  All transactions on this account
                {/if}
              </p>
            </div>
            <button type="button" class="btn-outline btn-sm" onclick={exportStatementCsv}>
              Export CSV
            </button>
          </div>

          {#if runningBalanceHolds && statement}
            <div class="statement-figure">
              <span>Opening balance</span>
              <b class="num">{formatMinor(statement.openingBalanceMinor)}</b>
            </div>
          {:else if statementMode}
            <!-- Said out loud, because a figure that simply vanished would read
                 as a fault rather than as a consequence of the sort (FR-043). -->
            <p class="statement-note">
              The running balance shows only when the transactions are in date order
              and no other filter applies. Sort by date and clear the other filters to
              see it again.
            </p>
          {/if}

          {#if runningBalanceHolds && statement}
            <div class="table-card">
              <table class="exp-table statement-table">
                <thead>
                  <tr>
                    <th class="td-check">{@render selectAllCheckbox()}</th>
                    <th>Date</th>
                    <th>Description</th>
                    <th class="ta-right">Amount</th>
                    <th class="ta-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {#each statement.entries as entry (entry.movementId)}
                    <!-- One row per side, so a record touching this account
                         twice appears twice and the balance adds up (FR-042). -->
                    <tr
                      class="exp-row"
                      class:selected={selected.has(entry.recordId)}
                      onclick={() =>
                        goto(
                          resolve("/(app)/records/[id]", {
                            id: String(entry.recordId),
                          }),
                        )}
                    >
                      <td
                        class="td-check"
                        onclick={(ev) => {
                          ev.stopPropagation();
                          toggleOne(entry.recordId);
                        }}
                      >
                        {@render rowCheckbox(
                          entry.recordId,
                          entry.recordNumber ?? entry.description,
                        )}
                      </td>
                      <td class="td-date">{formatDateShort(entry.date)}</td>
                      <td class="td-primary">
                        <span class="cell-itemname">{entry.description}</span>
                        {#if entry.contactName}<span class="cell-contact"
                            >{entry.contactName}</span
                          >{/if}
                      </td>
                      <td class="td-amount">
                        <span class="amount-num" class:amount-in={entry.amountMinor > 0}>
                          {entry.amountMinor > 0 ? "+" : "−"}{mainCurrencySymbol()}
                          {formatMinorAmount(Math.abs(entry.amountMinor))}
                        </span>
                      </td>
                      <td class="td-amount">
                        <span class="num">{formatMinor(entry.runningBalanceMinor)}</span>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <div class="statement-figure statement-figure-closing">
              <span>Closing balance</span>
              <b class="num">{formatMinor(statement.closingBalanceMinor)}</b>
            </div>

            {#each statement.notes as note (note)}
              <p class="statement-note">{note}</p>
            {/each}
          {:else if statementLoading}
            <p class="statement-note">Calculating balance…</p>
          {/if}
        </div>
      {/if}

      <!-- Table -->
      <div class="table-card" class:table-card-hidden={runningBalanceHolds && statement}>
        <table class="exp-table">
          <thead>
            <tr>
              <th class="td-check">
                {@render selectAllCheckbox()}
              </th>
              <th
                class={`sortable ${sort.key === "description" ? "sorted" : ""}`}
                onclick={() => onSort("description")}
                style="cursor:pointer; user-select:none;"
              >
                <span class="th-inner"
                  >Item {sort.key === "description"
                    ? sort.dir === "asc"
                      ? "↑"
                      : "↓"
                    : ""}</span
                >
              </th>
              <th
                class="sortable"
                onclick={() => onSort("kind")}
                style="cursor:pointer; user-select:none;"
              >
                <span class="th-inner">Kind</span>
              </th>
              <th class="th-accounts">
                <span class="th-inner">Accounts</span>
              </th>
              <th
                class="sortable"
                onclick={() => onSort("status")}
                style="cursor:pointer; user-select:none;"
              >
                <span class="th-inner">Status</span>
              </th>
              <th
                class="sortable"
                onclick={() => onSort("date")}
                style="cursor:pointer; user-select:none;"
              >
                <span class="th-inner">Date</span>
              </th>
              <th
                class="sortable ta-right"
                onclick={() => onSort("amount")}
                style="cursor:pointer; user-select:none;"
              >
                <span class="th-inner">Amount</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as e (e.id)}
              <tr
                class="exp-row"
                class:selected={selected.has(e.id)}
                onclick={(ev) => {
                  // The primary cell's anchor handles its own click (and
                  // Cmd-click); this is the rest of the row.
                  if ((ev.target as HTMLElement).closest("a")) return;
                  openRecord(e);
                }}
              >
                <td
                  class="td-check"
                  onclick={(ev) => {
                    ev.stopPropagation();
                    toggleOne(e.id);
                  }}
                >
                  {@render rowCheckbox(e.id, e.recordNumber ?? e.description)}
                </td>
                <td class="td-primary">
                  <!-- A real link, not just a row click: the browser can then
                       preload it on hover (`data-sveltekit-preload-data` in
                       app.html), and Cmd-click and middle-click open it in a
                       tab the way every other address in the app does. -->
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
                  <a class="cell-item row-link" href={recordHref(e.id)}>
                    <span class="cell-itemname">
                      {e.description}
                      {#if e.locked}<span class="row-lock" title={e.lockedReason}
                          ><Lock size={11} /></span
                        >{/if}
                    </span>
                    <span class="cell-itemnum">{e.recordNumber ?? ""}</span>
                  </a>
                </td>
                <td class="td-supplier" data-label="Kind">
                  <span class="kind-chip">{kindLabel(e.kind)}</span>
                  {#if e.contactName}<span class="cell-contact"
                      >{e.contactName}</span
                    >{/if}
                </td>
                <td data-label="Accounts">
                  {#if e.sideCount > 2}
                    <!-- A record made by hand can have five sides. There is no
                         pair of accounts to show, so it says how many it has
                         rather than picking two arbitrarily. -->
                    <span class="sides-count">{e.sideCount} lines</span>
                  {:else}
                    {@const sides = sidesOf(e)}
                    <span class="cell-sides">
                      <span class="side-from">{sides.from}</span>
                      <ChevronRight size={12} class="side-arrow" />
                      <span class="side-to">{sides.to}</span>
                    </span>
                  {/if}
                </td>
                <td class="td-status">
                  <StatusBadge status={statusLabelFor(e)} />
                  {#if !e.cleared}
                    <span class="row-uncleared" title="Not reconciled to a bank statement."
                      >Unreconciled</span
                    >
                  {/if}
                </td>
                <td class="td-date" data-label="Date">
                  {formatDateShort(e.date)}<span class="td-year"
                    >{e.date.slice(0, 4)}</span
                  >
                </td>
                <td class="td-amount" data-label="Amount">
                  <span
                    class="amount-num"
                    class:amount-in={directionOf(e) === "in"}
                    >{directionOf(e) === "in" ? "+" : ""}{mainCurrencySymbol()}
                    {formatMinorAmount(e.amountMinor)}</span
                  >
                  {#if e.currency !== mainCurrency()}
                    <span class="amount-orig"
                      >{e.currency}
                      {formatCurrencyAmount(e.amount, e.currency)}</span
                    >
                  {/if}
                </td>
                <td class="row-break"></td>
              </tr>
            {/each}
            {#if counts.all === 0}
              <tr class="empty-row">
                <td colspan="7">
                  <EmptyState
                    title="No records yet"
                    sub="Every recorded transaction appears here."
                  >
                    {#snippet icon()}<Wallet size={20} />{/snippet}
                  </EmptyState>
                </td>
              </tr>
            {:else if filtered.length === 0}
              <tr class="empty-row">
                <td colspan="7">
                  <EmptyState title="Nothing to show" sub={emptyReason}>
                    {#snippet icon()}<Search size={20} />{/snippet}
                    {#snippet action()}<button
                        class="link-btn"
                        onclick={clearAllFilters}>Clear filters</button
                      >{/snippet}
                  </EmptyState>
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      <div class="table-foot">
        <span>{filtered.length} of {counts.all} records</span>
        {#if searchMatchedIds}
          {#if searchTotal !== null && searchTotal > searchMatchedIds.size}
            <span class="muted"
              >Showing {searchMatchedIds.size} of {searchTotal} matches</span
            >
          {:else}
            <span class="muted">Updated just now</span>
          {/if}
        {:else if data.total > records.length}
          <span class="muted"
            >Showing the {records.length} most recent of {data.total}</span
          >
        {:else}
          <span class="muted">Updated just now</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- Bulk action bar -->
  <BulkActionBar
    show={selected.size > 0}
    count={selected.size}
    total={`${mainCurrencySymbol()} ${formatMinorAmount(selTotal)}`}
    onclear={clearSel}
  >
    {#snippet actions()}
      <!-- Recording one payment against several of these arrives with the
           payment screen (User Story 3); until then the only action that spans
           a selection is removing it. -->
      {#if data.perms.delete}
        <button
          type="button"
          class="bulk-actions-ghost"
          style="display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:6px; font-family:inherit; font-size:13px; cursor:pointer;"
          onclick={() => (deleteDialogOpen = true)}
        >
          <Trash2 size={14} /> Delete
        </button>
      {/if}
    {/snippet}
  </BulkActionBar>
</div>

<ConfirmDialog
  bind:open={deleteDialogOpen}
  title={selected.size === 1 ? "Delete this record?" : "Delete these records?"}
  description={lockedSelected > 0
    ? `${lockedSelected} of the ${selected.size} selected are settled or reconciled and cannot be deleted. The others will be removed. This can't be undone.`
    : `This removes ${selected.size} ${selected.size === 1 ? "record" : "records"} and all their journal lines. It can't be undone.`}
  confirmLabel="Delete"
  danger
  onConfirm={() => deleteFormEl?.requestSubmit()}
/>

<form
  method="POST"
  action="?/delete"
  bind:this={deleteFormEl}
  use:enhance={() =>
    async ({ update }) => {
      deleteDialogOpen = false;
      clearSel();
      await update();
    }}
  style="display:none"
>
  <input type="hidden" name="ids" value={[...selected].join(",")} />
</form>

<!-- Outstanding payables sheet -->
<Sheet.Root bind:open={owedSheetOpen}>
  <Sheet.Content
    side={owedPanelSide}
    style={owedIsMobile
      ? "height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;"
      : "width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;"}
  >
    <div
      style="padding:22px 22px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between;"
    >
      <div>
        <div class="sheet-eyebrow">Records</div>
        <div class="sheet-title-text">Outstanding payables</div>
      </div>
      <Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
    </div>
    <div style="flex:1; overflow-y:auto; padding:20px 22px;">
      <div class="owed-body">
        {#if data.perms.add && owedGroups.length > 1}
          <div class="owed-all-row">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
            <a class="owed-pay-btn" href={payAllHref()}>Pay all payables</a>
          </div>
        {/if}
        {#each owedGroups as group (group.contactId)}
          <div class="owed-group">
            <div class="owed-group-head">
              <span class="owed-group-name">{group.contactName}</span>
              <span class="owed-group-total num"
                >{formatMinor(group.totalMinor)}</span
              >
              {#if data.perms.add}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
                <a class="owed-pay-btn" href={payHref(group)}>
                  Record a payment
                </a>
              {/if}
            </div>
            {#each group.items as item (item.movementId)}
              <button
                type="button"
                class="owed-row related-link"
                onclick={() => openOwedItem(item)}
              >
                <span class="owed-row-main">
                  <span class="owed-row-name"
                    >{item.description || "Expense"}</span
                  >
                  <span class="owed-row-sub">
                    {formatDateShort(item.date)}{item.recordNumber
                      ? ` · ${item.recordNumber}`
                      : ""}{item.daysOverdue > 0
                      ? ` · ${item.daysOverdue} days overdue`
                      : ""}
                  </span>
                </span>
                <span class="owed-row-amt num"
                  >{formatMinor(item.outstandingMinor)}</span
                >
                <ChevronRight size={13} color="var(--muted-foreground)" />
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- Mobile filter sheet -->
<Sheet.Root bind:open={mobileFilterOpen}>
    <Sheet.Content
      side="bottom"
      style="border-radius:16px 16px 0 0; max-height:85vh; overflow-y:auto; padding:20px 20px calc(20px + var(--safe-bottom));"
    >
      <div
        style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;"
      >
        <div style="font-size:15px; font-weight:600;">Filters</div>
        <Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
      </div>
      <div style="margin-bottom:16px;">
        <div
          style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between;"
        >
          <span>Category</span>
          {#if selectedCats.length}<button
              onclick={() => (selectedCats = [])}
              style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;"
              >Clear</button
            >{/if}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:7px;">
          {#each data.categories as cat (cat.id)}
            <button
              onclick={() => toggleCat(cat.id)}
              style="border:1px solid {selectedCats.includes(cat.id)
                ? 'var(--primary)'
                : 'var(--border)'}; background:{selectedCats.includes(cat.id)
                ? 'var(--primary-soft)'
                : 'var(--card)'}; color:{selectedCats.includes(cat.id)
                ? 'var(--primary)'
                : 'var(--foreground)'}; font-family:inherit; font-size:13px; padding:5px 12px; border-radius:999px; cursor:pointer;"
              >{cat.name}</button
            >
          {/each}
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <div
          style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between;"
        >
          <span>Date range</span>
          {#if dateFrom || dateTo}<button
              onclick={() => {
                dateFrom = "";
                dateTo = "";
              }}
              style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;"
              >Clear</button
            >{/if}
        </div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <span style="font-size:11.5px; color:var(--muted-foreground);"
            >From</span
          >
          <DatePicker bind:value={dateFrom} placeholder="From date" />
          <span style="font-size:11.5px; color:var(--muted-foreground);"
            >To</span
          >
          <DatePicker bind:value={dateTo} placeholder="To date" />
        </div>
      </div>
      <div style="margin-bottom:20px;">
        <div
          style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between;"
        >
          <span>Amount range</span>
          {#if amountMin || amountMax}<button
              onclick={() => {
                amountMin = "";
                amountMax = "";
              }}
              style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;"
              >Clear</button
            >{/if}
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <AmountInput
            wrapperStyle="flex:1;"
            placeholder="Min"
            bind:value={amountMin}
            style="flex:1;"
          />
          <span style="color:var(--muted-foreground);">–</span>
          <AmountInput
            wrapperStyle="flex:1;"
            placeholder="Max"
            bind:value={amountMax}
            style="flex:1;"
          />
        </div>
      </div>
      <Button class="w-full" onclick={() => (mobileFilterOpen = false)}>
        Show results
      </Button>
    </Sheet.Content>
</Sheet.Root>

<style>
  /* The row's primary cell is the link. It fills the cell so the whole name
     area is the target, and it never looks like a link — the row already reads
     as clickable. */
  .row-link {
    color: inherit;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row-link:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .clearfilter {
    height: 30px;
    padding: 0 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--muted-foreground);
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .clearfilter:hover {
    border-color: var(--primary);
  }
  .clearfilter.active {
    background: var(--accent);
    border-color: var(--primary);
    color: var(--foreground);
    font-weight: 500;
  }
  .row-uncleared {
    display: block;
    margin-top: 3px;
    font-size: 11px;
    color: var(--muted-foreground);
  }

  /* Statement mode — the account-history page, folded back into the list it
     was always a filtered view of (D-05). */
  .statement {
    margin-bottom: 14px;
  }
  /* Constrain the statement so its table owns desktop scrolling, like the list. */
  .statement-active {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .statement-active > :not(.table-card) {
    flex-shrink: 0;
  }
  .statement-active > .table-card {
    min-height: 0;
  }
  @media (max-width: 767px) {
    .statement-active {
      flex: none;
    }
  }
  .statement-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  .statement-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .statement-sub {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--muted-foreground);
  }
  .statement-figure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--accent);
    font-size: 13px;
    margin-bottom: 8px;
  }
  .statement-figure-closing {
    margin-top: 8px;
    margin-bottom: 0;
  }
  .statement-note {
    margin: 8px 0 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted-foreground);
  }
  .table-card-hidden {
    display: none;
  }

  .kind-chip {
    display: inline-flex;
    align-items: center;
    font-size: 11.5px;
    background: var(--secondary);
    color: var(--secondary-foreground);
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .cell-contact {
    display: block;
    margin-top: 3px;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .cell-sides {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    min-width: 0;
  }
  .side-from,
  .side-to {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 130px;
  }
  .side-from {
    color: var(--muted-foreground);
  }
  .sides-count {
    font-size: 12.5px;
    color: var(--muted-foreground);
    font-style: italic;
  }
  /* Money coming in reads green wherever it appears, and money going out keeps
     the default. Driven by the row, not by the screen. */
  .amount-in {
    color: var(--green);
  }
  .fd-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
  }
  .fd-clear {
    border: none;
    background: none;
    color: var(--primary);
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
  }
  .fd-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 8px;
    padding: 7px 8px;
    border: none;
    background: none;
    border-radius: 6px;
    font-family: inherit;
    font-size: 13px;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .fd-option:hover {
    background: var(--accent);
  }
  .fd-option.selected {
    background: var(--accent);
    font-weight: 500;
  }

  .page-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--red-soft);
    color: var(--red);
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .page-error button {
    display: flex;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
  }

  .cat-option {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 13px;
    color: var(--foreground);
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
    text-align: left;
  }
  .cat-option:hover,
  .cat-option:focus-visible {
    background: var(--accent);
  }
  .cat-box {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1.5px solid var(--border-strong);
    background: var(--card);
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .cat-option.on .cat-box {
    border-color: var(--primary);
    background: var(--primary);
  }

  .row-lock {
    display: inline-flex;
    vertical-align: middle;
    margin-left: 5px;
    color: var(--muted-foreground);
  }

  /* Who is owed, and how much is left — a fixed-height banner; the full
     per-contact breakdown lives in the sheet, not stacked inline, so this
     never grows and steals height from the table below it. */
  .owed-panel {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
    margin-bottom: 12px;
    padding: 10px 14px;
  }
  .owed-head-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .owed-head-title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .owed-head-sub {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .owed-head-total {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .owed-view-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--primary);
    cursor: pointer;
    white-space: nowrap;
    padding: 3px 2px;
  }
  .owed-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .owed-all-row {
    display: flex;
    justify-content: flex-end;
  }
  .owed-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .owed-group-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .owed-group-name {
    font-size: 12.5px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }
  .owed-group-total {
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .owed-pay-btn {
    display: inline-block;
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 7px;
    padding: 3px 9px;
    font-family: inherit;
    font-size: 11.5px;
    color: var(--foreground);
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }
  .owed-pay-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
  .owed-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 9px;
    padding: 8px 12px;
    background: var(--card);
    font-family: inherit;
    color: inherit;
    text-align: left;
  }
  .owed-row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .owed-row-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .owed-row-sub {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .owed-row-amt {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  @media (max-width: 767px) {
    /* Status leads, then the two accounts, then the kind, then date */
    td[data-label="Accounts"] {
      order: 6 !important;
    }
    .td-supplier {
      order: 7 !important;
    }
    .td-date {
      order: 8 !important;
    }
  }
</style>
