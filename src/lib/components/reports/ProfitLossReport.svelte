<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { ProfitLossReport } from '$lib/server/ledger/types.js';
	import ReportNotes from './ReportNotes.svelte';
	import { openCategory } from './report-links.js';
	import './reports.css';

	/**
	 * What came in, what went out, and what is left, over a date range (FR-025).
	 *
	 * Every figure arrives already worked out and already the right way round —
	 * `ledger/reports/profit-loss.ts` applies the sign rule, so nothing here
	 * negates anything. A line is one category account's total, so clicking it
	 * opens that account's own history and the two can be checked against each
	 * other (FR-031).
	 */
	let {
		report,
		isMobile = false
	}: {
		report: ProfitLossReport;
		isMobile?: boolean;
	} = $props();

	const sections = $derived([
		{
			title: 'Revenue',
			sub: 'Revenue by account',
			lines: report.income,
			totalLabel: 'Total revenue',
			totalMinor: report.totalIncomeMinor
		},
		{
			title: 'Expenses',
			sub: 'Expenses by account',
			lines: report.expenses,
			totalLabel: 'Total expenses',
			totalMinor: report.totalExpensesMinor
		}
	]);
</script>

<div class="rep-scroll">
	<div class="rep-result">
		<div>
			<div class="rep-result-label">{report.resultMinor < 0 ? 'Net loss' : 'Net profit'}</div>
			<div class="rep-result-sub">
				Revenue less expenses, {formatDate(report.dateFrom)} to {formatDate(
					report.dateTo
				)}
			</div>
		</div>
		<div class="rep-result-val" class:good={report.resultMinor > 0} class:bad={report.resultMinor < 0}>
			{formatMinor(report.resultMinor)}
		</div>
	</div>

	<div class="rep-cols" class:one-col={isMobile}>
		{#each sections as section (section.title)}
			<div class="rep-block">
				<div class="rep-block-head">
					<div>
						<div class="rep-block-title">{section.title}</div>
						<div class="rep-block-sub">{section.sub}</div>
					</div>
				</div>

				{#if section.lines.length === 0}
					<p class="rep-empty">No transactions in this period.</p>
				{:else}
					<table class="rep-table">
						<tbody>
							{#each section.lines as line (line.accountId)}
								<tr>
									<td>
										<button
											type="button"
											class="rep-open related-link"
											onclick={() => openCategory(line.accountId)}
										>
											<span>{line.accountName}</span>
											<ChevronRight size={13} />
										</button>
									</td>
									<td class="rep-amount">{formatMinor(line.amountMinor)}</td>
								</tr>
							{/each}
							<tr class="rep-total">
								<td>{section.totalLabel}</td>
								<td class="rep-amount">{formatMinor(section.totalMinor)}</td>
							</tr>
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	</div>

	{#if report.subtotals.length > 0}
		<div class="rep-block">
			<div class="rep-block-head">
				<div>
					<div class="rep-block-title">Summary</div>
					<div class="rep-block-sub">Gross profit and operating income</div>
				</div>
			</div>
			<table class="rep-table">
				<tbody>
					{#each report.subtotals as subtotal (subtotal.label)}
						<tr class="rep-total">
							<td>{subtotal.label}</td>
							<td class="rep-amount">{formatMinor(subtotal.amountMinor)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<ReportNotes notes={report.notes} />
</div>
