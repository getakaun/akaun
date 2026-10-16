<script lang="ts">
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { PartnerStatementReport } from '$lib/server/ledger/types.js';
	import ReportNotes from './ReportNotes.svelte';
	import './reports.css';

	/**
	 * What each partner put in, their share of the result, and what they took
	 * back out, over a date range (FR-027).
	 *
	 * Five columns do not fit a phone, so below the breakpoint each partner
	 * becomes a small block of labelled figures instead — the same numbers, read
	 * down rather than across (FR-043).
	 */
	let {
		report,
		isMobile = false
	}: {
		report: PartnerStatementReport;
		isMobile?: boolean;
	} = $props();

	const COLUMNS = [
		{ key: 'contributionsMinor', label: 'Contributions' },
		{ key: 'shareOfResultMinor', label: 'Share of profit' },
		{ key: 'drawingsMinor', label: 'Drawings' },
		{ key: 'netMinor', label: 'Closing balance' }
	] as const;

	const totals = $derived({
		contributionsMinor: sumOf('contributionsMinor'),
		shareOfResultMinor: sumOf('shareOfResultMinor'),
		drawingsMinor: sumOf('drawingsMinor'),
		netMinor: sumOf('netMinor')
	});

	function sumOf(key: (typeof COLUMNS)[number]['key']): number {
		return report.partners.reduce((sum, partner) => sum + partner[key], 0);
	}
</script>

<div class="rep-scroll">
	<div class="rep-block">
		<div class="rep-block-head">
			<div>
				<div class="rep-block-title">Partners' equity</div>
				<div class="rep-block-sub">
					{formatDate(report.dateFrom)} to {formatDate(report.dateTo)}
				</div>
			</div>
		</div>

		{#if report.partners.length === 0}
			<p class="rep-empty">
				No contacts have the Partner role. Give a contact the Partner role to show their figures
				here.
			</p>
		{:else if isMobile}
			<table class="rep-table">
				<tbody>
					{#each report.partners as partner (partner.contactId)}
						<tr>
							<td colspan="2">
								<div class="rep-block-title">{partner.contactName}</div>
							</td>
						</tr>
						{#each COLUMNS as column (column.key)}
							<tr>
								<td>{column.label}</td>
								<td class="rep-amount">{formatMinor(partner[column.key])}</td>
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
		{:else}
			<table class="rep-table">
				<thead>
					<tr>
						<th>Partner</th>
						{#each COLUMNS as column (column.key)}
							<th class="rep-amount">{column.label}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each report.partners as partner (partner.contactId)}
						<tr>
							<td>{partner.contactName}</td>
							{#each COLUMNS as column (column.key)}
								<td class="rep-amount">{formatMinor(partner[column.key])}</td>
							{/each}
						</tr>
					{/each}
					{#if report.partners.length > 1}
						<tr class="rep-total">
							<td>All partners</td>
							{#each COLUMNS as column (column.key)}
								<td class="rep-amount">{formatMinor(totals[column.key])}</td>
							{/each}
						</tr>
					{/if}
				</tbody>
			</table>
		{/if}
	</div>

	<ReportNotes notes={report.notes} />
</div>
