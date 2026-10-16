<script lang="ts">
	import { Upload, Receipt, Check, AlertTriangle, ExternalLink, RotateCcw } from '@lucide/svelte';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import ImportContactSelect from '$lib/components/import/ImportContactSelect.svelte';
	import ImportSourceAccountSelect from '$lib/components/import/ImportSourceAccountSelect.svelte';
	import ImportCategoryAccountSelect from '$lib/components/import/ImportCategoryAccountSelect.svelte';
	import ImportTransferAccountSelect from '$lib/components/import/ImportTransferAccountSelect.svelte';
	import AmountInput from '$lib/components/ui/AmountInput.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Role } from '$lib/enums.js';
	import { mainCurrency } from '$lib/currency-state.svelte.js';
	import { CURRENCIES, currencySymbol } from '$lib/currency.js';
	import {
		dupMessage,
		dupReasonsLabel,
		editedValue,
		formatMoney,
		isTransferRow,
		readCategoryAccountId,
		reviewConverted,
		reviewCurrency,
		reviewIsForeign,
		reviewRateMissing,
		reviewRateText,
		sideIsIncome,
		targetChoices,
		transferChoices,
		type ReviewEdits,
		type ReviewOptions,
		type ReviewRow
	} from './review-card.js';

	/**
	 * The card where a person checks one proposed record before it is imported:
	 * a receipt on the import queue, or one item of a document read as several
	 * items, opened in place on the group's page (006 FR-017).
	 *
	 * The card holds no record of its own. The screen that shows it keeps the
	 * fields, the corrections and the two accounts, and is told of every change
	 * through the callbacks below. That is what lets one card serve both: a
	 * receipt keeps its corrections in the browser until it is confirmed, while
	 * an item saves each one on the server as it is made (`oncommit`).
	 */
	let {
		row,
		edits,
		sourceAccountId,
		targetAccountId,
		options,
		heading,
		headingHref,
		reading = null,
		error = null,
		note = null,
		readonly = false,
		done = false,
		busy = false,
		onedit,
		oncommit,
		oncontact,
		oncurrency,
		onsource,
		ontarget,
		onconfirm,
		onskip,
		onreadagain,
		readAgainBlocked = null
	}: {
		row: ReviewRow;
		edits: ReviewEdits;
		sourceAccountId: number | null;
		targetAccountId: number | null;
		options: ReviewOptions;
		/** The card's title: a receipt's file name, or what an item is. */
		heading: string;
		/** Opens the source file when given. */
		headingHref?: string;
		/**
		 * How the document was read, when that is worth saying: a document read
		 * with a profile that gave one item is reviewed as a receipt (FR-009), and
		 * this says which profile read it (FR-041).
		 */
		reading?: string | null;
		/** Why the last confirm was refused. */
		error?: string | null;
		/** Said in the footer in place of the count of edited fields. */
		note?: string | null;
		/** Shows the fields without letting them change, and no actions. */
		readonly?: boolean;
		/** The item is already imported or skipped, so its review note no longer applies. */
		done?: boolean;
		/** A confirm or skip is on its way. */
		busy?: boolean;
		/** A field changed. Called on every keystroke. */
		onedit: (key: string, value: string | number) => void;
		/** The reviewer finished with a field (it lost focus, or a value was picked). */
		oncommit?: (key: string) => void;
		oncontact: (v: { value: number | null; newName: string | null }) => void;
		oncurrency: (code: string) => void;
		onsource: (value: number) => void;
		ontarget: (raw: string) => void;
		onconfirm: () => void;
		onskip: () => void;
		/**
		 * "Read again" for a receipt on the queue (006 FR-023): offered only when
		 * given. An item of a group is not a document, so it has none; its group
		 * page has the action for the whole document.
		 */
		onreadagain?: () => void;
		/** Why it cannot be read again now. The action stays, disabled, and says why. */
		readAgainBlocked?: string | null;
	} = $props();

	// Raw in-progress text for the amount being typed into. Formatting (2
	// decimals) is only applied on blur, so reformatting mid-keystroke doesn't
	// fight the user's cursor/input.
	let amountDraft = $state<string | null>(null);

	const main = $derived(mainCurrency());
	// A transfer between two of the business's own accounts (FR-058): it has
	// no other party and no category, and both its sides hold money.
	const transfer = $derived(isTransferRow(row));
	const isIncome = $derived(!transfer && sideIsIncome(row, options, sourceAccountId));
	const dup = $derived(!!row.duplicateOf);
	const currency = $derived(reviewCurrency(row, edits, main));
	const foreign = $derived(reviewIsForeign(row, edits, main));
	const rateText = $derived(reviewRateText(row, edits, main));
	const converted = $derived(reviewConverted(row, edits, main));
	const rateMissing = $derived(reviewRateMissing(row, edits, main));
	const accountMissing = $derived(sourceAccountId == null || targetAccountId == null);
	// The books record a transfer in the main currency only (FR-059). The
	// server refuses one in another currency; the card says why up front.
	const transferForeign = $derived(transfer && foreign);
	// The review note asks the reviewer to choose a category. Once they have
	// picked another one here, or the item is finished, it has nothing left to
	// ask. The error line already says it when it is the only thing left. The
	// category is the source of an income and the target of an expense.
	const reviewNoteShown = $derived(
		!done &&
			!!row.reviewNote &&
			!error?.includes(row.reviewNote) &&
			(transfer ||
				(row.documentType === 'income' ? sourceAccountId : targetAccountId) ===
					readCategoryAccountId(row, options))
	);
	// What to check before confirming that no category choice answers: a
	// flag rule (FR-061) or a possible double count (FR-066). It stays until
	// the item is finished. The error line may already say it.
	const checkNoteShown = $derived(
		!done && !!row.checkNote && !error?.includes(row.checkNote)
	);
	const numEdits = $derived(Object.keys(edits).filter((k) => k !== 'document_type').length);

	function value(key: string): string | number {
		return editedValue(row, edits, key, main);
	}

	function isEdited(key: string): boolean {
		return key in edits;
	}

	// While the user is typing, show their raw text instead of the reformatted
	// amount — otherwise every keystroke gets rounded to 2dp and stomps the
	// cursor mid-edit.
	function amountDisplay(): string {
		return amountDraft ?? formatMoney(value('amount') as number);
	}

	function onAmountInput(e: Event) {
		const raw = (e.target as HTMLInputElement).value;
		amountDraft = raw;
		const v = parseFloat(raw.replace(/,/g, ''));
		if (!isNaN(v)) onedit('amount', v);
	}

	function onAmountBlur() {
		amountDraft = null;
		oncommit?.('amount');
	}
</script>

<div class="review-card" class:is-dup={dup}>
	<!-- Header -->
	<div class="review-head">
		{#if headingHref}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the caller resolves the file URL; it opens outside the app in a new tab. -->
			<a href={headingHref} target="_blank" rel="noopener" class="review-file" aria-label="Open {heading}">
				<Receipt size={15} />
				{heading}
				<ExternalLink size={11} color="var(--muted-foreground)" />
			</a>
		{:else}
			<span class="review-file">
				<Receipt size={15} />
				{heading}
			</span>
		{/if}
		<div class="review-head-right">
			{#if dup}
				<span class="dup-badge">
					<AlertTriangle size={11} /> Duplicate · {row.duplicateConfidence}% · {dupReasonsLabel(row)}
				</span>
			{/if}
		</div>
	</div>

	<div class="review-detected">
		<Upload size={12} />
		{#if reading}<span class="review-reading">{reading}</span> ·{/if}
		{#if transfer}
			Read as a transfer between two of your own accounts — check both accounts before importing
		{:else}
			AI classified this as {isIncome ? 'income' : 'an expense'} — change the category or edit any field before importing
		{/if}
	</div>

	{#if checkNoteShown}
		<!-- What to check before confirming (FR-061, FR-066). -->
		<div class="dup-note review-note">
			<AlertTriangle size={12} />
			{row.checkNote}
		</div>
	{/if}

	{#if reviewNoteShown}
		<!-- What the reading could not do as the profile asked (FR-034). -->
		<div class="dup-note review-note">
			<AlertTriangle size={12} />
			{row.reviewNote}
		</div>
	{/if}

	<!-- Fields grid. A fieldset only so that a read-only card disables every
	     control inside it at once; it draws nothing of its own. -->
	<fieldset class="review-fieldset" disabled={readonly}>
		<div class="review-grid">
			<!-- Description -->
			<div class="rfield">
				<span class="rfield-label">
					Description
					{#if isEdited('item_name')}<span class="edited-tag">edited</span>{/if}
				</span>
				<input
					class="form-input rinput"
					value={value('item_name')}
					oninput={(e) => onedit('item_name', (e.target as HTMLInputElement).value)}
					onchange={() => oncommit?.('item_name')}
				/>
			</div>

			<!-- Contact (role follows the chosen category). A transfer has none. -->
			{#if !transfer}
				<div class="rfield">
					<ImportContactSelect
						edited={isEdited('supplier') || isEdited('contactId') || isEdited('newContactName')}
						role={isIncome ? Role.Customer : Role.Supplier}
						initialLabel={row.supplier}
						matchedContactId={(row.documentType === 'income') === isIncome ? row.matchedContactId : null}
						suggestions={row.matchCandidates}
						disabled={readonly}
						onChange={oncontact}
					/>
				</div>
			{/if}

			<!-- Amount (main currency; read-only & converted when foreign) -->
			<div class="rfield">
				<span class="rfield-label">
					Amount{foreign ? ` (${main})` : ''}
					{#if !foreign && isEdited('amount')}<span class="edited-tag">edited</span>{/if}
				</span>
				{#if foreign}
					<AmountInput wrapperClass="sm" readonly value={converted != null ? formatMoney(converted) : ''} />
				{:else}
					<AmountInput wrapperClass="sm" value={amountDisplay()} oninput={onAmountInput} onblur={onAmountBlur} />
				{/if}
			</div>

			<!-- Currency + exchange rate (auto-shown when a foreign currency is detected) -->
			<div class="rfield">
				<span class="rfield-label">Currency</span>
				<Select.Root type="single" value={currency} onValueChange={(v) => oncurrency(v)} disabled={readonly}>
					<Select.Trigger class="rinput w-full">{currency}</Select.Trigger>
					<Select.Content>
						{#each CURRENCIES as c (c.code)}
							<Select.Item value={c.code} label={`${c.code} — ${c.name}`} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			{#if foreign}
				<div class="rfield">
					<span class="rfield-label">
						Amount ({currency})
						{#if isEdited('amount')}<span class="edited-tag">edited</span>{/if}
					</span>
					<AmountInput
						wrapperClass="sm"
						prefix={currencySymbol(currency)}
						value={amountDisplay()}
						oninput={onAmountInput}
						onblur={onAmountBlur}
					/>
				</div>
				<div class="rfield">
					<span class="rfield-label">Rate (1 {currency} = ? {main})</span>
					<input
						class="form-input rinput"
						inputmode="decimal"
						placeholder="0.0000"
						value={rateText}
						oninput={(e) => onedit('exchangeRate', (e.target as HTMLInputElement).value)}
						onchange={() => oncommit?.('exchangeRate')}
					/>
					{#if converted == null}
						<span class="foreign-note">Enter the rate manually to convert to {main}.</span>
					{/if}
				</div>
			{/if}

			{#if transfer}
				<!-- A transfer: the money moves from the first account to the second,
				     and both hold money (FR-058). Each list leaves out the other side. -->
				<div class="rfield">
					<span class="rfield-label">Transfer from</span>
					<ImportTransferAccountSelect
						accounts={transferChoices(options, targetAccountId)}
						value={sourceAccountId}
						label="Transfer from"
						onChange={onsource}
					/>
				</div>

				<div class="rfield">
					<span class="rfield-label">Transfer to</span>
					<ImportTransferAccountSelect
						accounts={transferChoices(options, sourceAccountId)}
						value={targetAccountId}
						label="Transfer to"
						onChange={(value) => ontarget(String(value))}
					/>
				</div>
			{:else}
				<!-- Source establishes direction; Target is then narrowed by policy. -->
				<div class="rfield">
					<span class="rfield-label">Source account</span>
					<ImportSourceAccountSelect
						accounts={options.allAccounts}
						payableAccountId={options.payableAccountId}
						value={sourceAccountId}
						incomeFirst={isIncome}
						onChange={onsource}
					/>
				</div>

				<div class="rfield">
					<span class="rfield-label">
						Target account
						{#if isEdited('category')}<span class="edited-tag">edited</span>{/if}
					</span>
					<ImportCategoryAccountSelect
						accounts={targetChoices(options, sourceAccountId)}
						value={targetAccountId}
						onChange={ontarget}
					/>
				</div>
			{/if}

			<!-- Date -->
			<div class="rfield">
				<span class="rfield-label">
					Date
					{#if isEdited('date')}<span class="edited-tag">edited</span>{/if}
				</span>
				<DatePicker
					value={value('date') as string}
					onchange={(v) => {
						onedit('date', v);
						oncommit?.('date');
					}}
				/>
			</div>

			<!-- Reference -->
			<div class="rfield">
				<span class="rfield-label">
					Reference
					{#if isEdited('reference')}<span class="edited-tag">edited</span>{/if}
				</span>
				<input
					class="form-input rinput"
					placeholder="—"
					value={value('reference')}
					oninput={(e) => onedit('reference', (e.target as HTMLInputElement).value)}
					onchange={() => oncommit?.('reference')}
				/>
			</div>

			<!-- Remark: the record's remark, for the reviewer to write. An import
			     never fills it. -->
			<div class="rfield rfield-wide">
				<span class="rfield-label">
					Remark
					{#if isEdited('remark')}<span class="edited-tag">edited</span>{/if}
				</span>
				<input
					class="form-input rinput"
					placeholder="—"
					value={value('remark')}
					oninput={(e) => onedit('remark', (e.target as HTMLInputElement).value)}
					onchange={() => oncommit?.('remark')}
				/>
			</div>
		</div>
	</fieldset>

	{#if dup}
		<div class="dup-note">
			{dupMessage(row)} Import only if this is a separate transaction.
		</div>
	{/if}

	{#if !readonly}
		<div class="review-actions">
			<span class="merge-note">
				{#if error}
					{error}
				{:else if transferForeign}
					A transfer is recorded in {main} only, and this one is in {currency}. Record it by hand, or skip it.
				{:else if accountMissing}
					{transfer
						? 'Choose both accounts of this transfer before importing it.'
						: 'Choose both the source and target account before importing it.'}
				{:else if !transfer && !isIncome && sourceAccountId === options.payableAccountId}
					Recorded in accounts payable to the contact above until it is paid.
				{:else if note}
					{note}
				{:else if numEdits > 0}
					{numEdits} field{numEdits > 1 ? 's' : ''} edited — only these override the AI values
				{:else}
					Importing AI values as-is
				{/if}
			</span>
			<div class="review-actions-btns">
				{#if onreadagain}
					<Button
						variant="ghost"
						size="sm"
						disabled={busy || readAgainBlocked != null}
						title={readAgainBlocked ?? 'Read this document again from its file, another way'}
						onclick={onreadagain}
					>
						<RotateCcw size={14} /> Read again
					</Button>
				{/if}
				<Button variant="ghost" size="sm" disabled={busy} onclick={onskip}>Skip</Button>
				<Button size="sm" disabled={busy || rateMissing || accountMissing || transferForeign} onclick={onconfirm}>
					<Check size={15} />
					{dup ? 'Import anyway' : 'Confirm & import'}
				</Button>
			</div>
		</div>
	{/if}
</div>

<style>
	/* A fieldset draws a border, padding and a minimum width by default. This one
	   only groups the fields so a read-only card can disable them together. */
	.review-fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}

	/* AccountSelect brings its own .field markup — line it up with the review grid's
	   own fields so the account reads as one more field, not a transplant. */
	.review-grid :global(.field) {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-bottom: 0;
	}
	.review-grid :global(.field-label) {
		font-size: 11.5px;
		color: var(--muted-foreground);
		font-weight: 500;
		margin-bottom: 0;
	}
	.review-grid :global(.account-select) {
		height: 34px;
	}
	/* The remark can be long, so it takes the whole row. */
	.rfield-wide {
		grid-column: 1 / -1;
	}
	/* Three actions on a receipt card: on a narrow phone they wrap rather than
	   push the card wider than the screen. */
	.review-actions-btns {
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.review-reading {
		color: var(--foreground);
		font-weight: 500;
	}
	.review-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: -6px 0 12px;
	}
	.review-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}
</style>
