<script lang="ts">
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { CashFlowReport, CashFlowSection } from '$lib/server/ledger/types.js';
	import ReportNotes from './ReportNotes.svelte';
	import './reports.css';

	/**
	 * Where the period's cash came from and what it went on (FR-006, FR-010).
	 *
	 * Three activities, side by side on a wide screen and stacked below the
	 * mobile breakpoint, the same layout rule every other statement here uses
	 * (FR-043). Lines have no account to open: each is an aggregation across
	 * however many accounts landed on it (`ledger/reports/cash-flow.ts`'s
	 * `CashFlowLine.accountId` is always `null`), so unlike the Balance Sheet
	 * or Profit & Loss, nothing here is clickable.
	 */
	let {
		report,
		isMobile = false
	}: {
		report: CashFlowReport;
		isMobile?: boolean;
	} = $props();

	const activities = $derived([
		{ title: 'Operating activities', section: report.operating },
		{ title: 'Investing activities', section: report.investing },
		{ title: 'Financing activities', section: report.financing }
	]);

	function totalOf(section: CashFlowSection): string {
		return formatMinor(section.totalMinor);
	}
</script>

<div class="rep-scroll">
	<div class="rep-result">
		<div>
			<div class="rep-result-label">
				Net change in cash, {formatDate(report.dateFrom)} to {formatDate(report.dateTo)}
			</div>
			<div class="rep-result-sub">
				{#if report.ties}
					Opening cash and cash equivalents of {formatMinor(report.openingCashMinor)} plus the net
					change gives closing cash and cash equivalents of {formatMinor(report.closingCashMinor)}.
					The statement reconciles.
				{:else}
					The statement does not reconcile. The net change does not explain the change from {formatMinor(
						report.openingCashMinor
					)} to {formatMinor(report.closingCashMinor)}. The difference is {formatMinor(
						report.differenceMinor
					)}.
				{/if}
			</div>
		</div>
		<div class="rep-result-val" class:bad={!report.ties}>
			{formatMinor(report.netChangeMinor)}
		</div>
	</div>

	<div class="rep-cols" class:one-col={isMobile}>
		{#each activities as activity (activity.title)}
			<div class="rep-block">
				<div class="rep-block-head">
					<div>
						<div class="rep-block-title">{activity.title}</div>
					</div>
				</div>
				{#if activity.section.lines.length === 0}
					<p class="rep-empty">No cash flows in this period.</p>
				{:else}
					<table class="rep-table">
						<tbody>
							{#each activity.section.lines as line, i (i)}
								<tr>
									<td>{line.label}</td>
									<td class="rep-amount">{formatMinor(line.amountMinor)}</td>
								</tr>
							{/each}
							<tr class="rep-total">
								<td>Total</td>
								<td class="rep-amount">{totalOf(activity.section)}</td>
							</tr>
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	</div>

	{#if report.needsReviewMinor !== 0}
		<div class="rep-block">
			<div class="rep-block-head">
				<div>
					<div class="rep-block-title">Unclassified</div>
					<div class="rep-block-sub">
						Movements in asset or liability accounts that have no sub-type
					</div>
				</div>
			</div>
			<table class="rep-table">
				<tbody>
					<tr class="rep-total">
						<td>Unclassified accounts</td>
						<td class="rep-amount">{formatMinor(report.needsReviewMinor)}</td>
					</tr>
				</tbody>
			</table>
		</div>
	{/if}

	<ReportNotes notes={report.notes} firstIsWarning={!report.ties} />
</div>
