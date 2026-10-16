<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { BalanceSheetReport, BalanceSheetSection } from '$lib/server/ledger/types.js';
	import ReportNotes from './ReportNotes.svelte';
	import { openAccountHistory } from './report-links.js';
	import './reports.css';

	/**
	 * What the business owns, what it owes and what the owners have in it, as at
	 * a date (FR-026).
	 *
	 * The two sides are shown next to each other on a wide screen because the
	 * whole point of the report is that they match; below the mobile breakpoint
	 * they stack, since a column too narrow to read is worse than a longer page
	 * (FR-043).
	 */
	let {
		report,
		isMobile = false
	}: {
		report: BalanceSheetReport;
		isMobile?: boolean;
	} = $props();

	/**
	 * The accumulated result is not an account — no account holds it, it is the
	 * categories' running total brought across — so it is the one line with
	 * nothing to open. `ledger/reports/balance-sheet.ts` marks it with id 0.
	 */
	const NOTHING_TO_OPEN = 0;

	const owedAndOwners = $derived([
		{
			title: 'Liabilities',
			sub: 'Amounts that the business must pay to other parties',
			section: report.owed
		},
		{
			title: 'Equity',
			sub: 'Capital contributions minus drawings, plus retained earnings',
			section: report.ownersStake
		}
	]);

	function totalOf(section: BalanceSheetSection): string {
		return formatMinor(section.totalMinor);
	}
</script>

{#snippet lineRow(line: BalanceSheetSection['lines'][number])}
	<tr>
		<td>
			{#if line.accountId === NOTHING_TO_OPEN}
				<span>{line.accountName}</span>
			{:else}
				<button
					type="button"
					class="rep-open related-link"
					onclick={() => openAccountHistory(line.accountId)}
				>
					<span>{line.accountName}</span>
					<ChevronRight size={13} />
				</button>
			{/if}
		</td>
		<td class="rep-amount">{formatMinor(line.amountMinor)}</td>
	</tr>
{/snippet}

{#snippet sectionTable(section: BalanceSheetSection)}
	{#if section.lines.length === 0}
		<p class="rep-empty">No balances at this date.</p>
	{:else if section.subsections && section.subsections.length > 0}
		{#each section.subsections as subsection (subsection.label)}
			<div class="rep-subsection-title">{subsection.label}</div>
			<table class="rep-table">
				<tbody>
					{#each subsection.lines as line (line.accountId)}
						{@render lineRow(line)}
					{/each}
					<tr class="rep-total">
						<td>Subtotal</td>
						<td class="rep-amount">{formatMinor(subsection.totalMinor)}</td>
					</tr>
				</tbody>
			</table>
		{/each}
		<table class="rep-table">
			<tbody>
				<tr class="rep-total">
					<td>Total</td>
					<td class="rep-amount">{totalOf(section)}</td>
				</tr>
			</tbody>
		</table>
	{:else}
		<table class="rep-table">
			<tbody>
				{#each section.lines as line (line.accountId)}
					{@render lineRow(line)}
				{/each}
				<tr class="rep-total">
					<td>Total</td>
					<td class="rep-amount">{totalOf(section)}</td>
				</tr>
			</tbody>
		</table>
	{/if}
{/snippet}

<div class="rep-scroll">
	<div class="rep-result">
		<div>
			<div class="rep-result-label">Total assets, as at {formatDate(report.asAt)}</div>
			<div class="rep-result-sub">
				{#if report.balances}
					Total assets equal total liabilities plus equity. The balance sheet is in balance.
				{:else}
					The balance sheet is out of balance by {formatMinor(report.differenceMinor)}. Total
					assets do not equal total liabilities plus equity.
				{/if}
			</div>
		</div>
		<div class="rep-result-val" class:bad={!report.balances}>
			{totalOf(report.owned)}
		</div>
	</div>

	<div class="rep-cols" class:one-col={isMobile}>
		<div class="rep-block">
			<div class="rep-block-head">
				<div>
					<div class="rep-block-title">Assets</div>
					<div class="rep-block-sub">Cash and cash equivalents, receivables and other resources that the business controls</div>
				</div>
			</div>
			{@render sectionTable(report.owned)}
		</div>

		<div class="rep-cols one-col">
			{#each owedAndOwners as group (group.title)}
				<div class="rep-block">
					<div class="rep-block-head">
						<div>
							<div class="rep-block-title">{group.title}</div>
							<div class="rep-block-sub">{group.sub}</div>
						</div>
					</div>
					{@render sectionTable(group.section)}
				</div>
			{/each}
		</div>
	</div>

	<ReportNotes notes={report.notes} firstIsWarning={!report.balances} />
</div>
