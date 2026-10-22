<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatDate, formatMinor } from '$lib/format.js';
	import type { reimbursementsForRecord } from '$lib/server/queries/reimbursements.js';

	let {
		reimbursement,
		recordId,
		canReverse,
		disabled,
		onreverse
	}: {
		reimbursement: ReturnType<typeof reimbursementsForRecord>;
		recordId: number;
		canReverse: boolean;
		disabled: boolean;
		onreverse: (groupId: number) => void;
	} = $props();
</script>

{#each reimbursement.groups as group (group.id)}
	<section class="detail-card" aria-label="Reimbursement #{group.id}">
		<div class="detail-card-head">
			<span class="detail-card-title">Reimbursement #{group.id}</span>
		</div>
		{#if group.reversedAt}
			<div class="bg-muted mb-3 rounded-md p-3 text-sm" role="status">
				<p class="font-semibold">Reimbursement reversed</p>
				<p class="mt-1">
					{formatMinor(group.reversedAmountMinor)} reversed on {formatDate(
						group.reversalDate ?? group.reversedAt.slice(0, 10)
					)}. All {group.items.length} expenses were removed from this reimbursement.
				</p>
				<p class="mt-1">
					The original bank payment stays recorded. Any released credit can be used for a new
					reimbursement or refunded. Current available credit may change as it is used.
				</p>
				{#if group.reversalReason}<p class="mt-1">
						Reason: {group.reversalReason}
					</p>{/if}
			</div>
		{:else}
			<p class="text-muted-foreground mb-3 text-sm">
				Expense total {formatMinor(group.totalMinor)} · Applied {formatMinor(group.fundedMinor)}
				· Remaining {formatMinor(Math.max(0, group.totalMinor - group.fundedMinor))}
			</p>
		{/if}

		{#if !group.reversedAt && group.fundingForRecordMinor > 0 && group.funding.length !== 1}
			<p class="text-muted-foreground mb-3 text-sm">
				This payment contributes {formatMinor(group.fundingForRecordMinor)}. The expense amounts
				below belong to the whole reimbursement.
			</p>
		{/if}

		{#if group.reversedAt || reimbursement.generated || group.fundedMinor !== group.totalMinor || group.funding.length !== 1}
			<details class="mb-3" open={!!group.reversedAt}>
				<summary class="cursor-pointer text-sm font-medium"
					>{group.reversedAt ? 'Previously included expenses' : 'Reimbursement expenses'} ({group
						.items.length})</summary
				>
				<div class="mt-2 flex flex-col gap-2">
					{#each group.items as item (item.id)}
						<a
							class="related-link flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
							href={resolve('/(app)/records/[id]', {
								id: String(item.recordId)
							})}
						>
							<span class="min-w-0"
								><span class="block font-medium"
									>{item.description || `Expense #${item.recordId}`}</span
								>
								<span class="text-muted-foreground block text-xs"
									>{item.contactName || ''} · {formatDate(item.date)} · {item.recordNumber ||
										`#${item.recordId}`}</span
								></span
							>
							<span class="shrink-0">{formatMinor(item.amountMinor)}</span>
						</a>
					{/each}
				</div>
				{#if group.reversedAt}<p class="text-muted-foreground mt-2 text-sm">
						These are historical amounts. Each expense’s current payment status includes any other
						payments.
					</p>{/if}
			</details>
		{/if}

		{#if group.reversedAt && reimbursement.generated}
			{#each group.historicalFunding as payment (payment.settlementId)}
				{#if payment.otherRecordId !== group.paymentRecordId}
					<a
						class="sheet-btn mb-2"
						href={resolve('/(app)/records/[id]', {
							id: String(payment.otherRecordId)
						})}
						>Previous funding payment #{payment.otherRecordId} · {formatMinor(
							payment.amountMinor
						)}</a
					>
				{/if}
			{/each}
		{/if}

		<details class="mt-3">
			<summary class="cursor-pointer text-sm font-medium">Accounting details</summary>
			<p class="text-muted-foreground my-2 text-sm">
				These entries connect the original expense contacts to the reimbursement recipient. They do
				not represent additional bank payments.
			</p>
			<div class="flex flex-col gap-2">
				{#each group.entries as entry (entry.recordId)}
					<a
						class="related-link flex justify-between gap-3 rounded-lg border p-3 text-sm"
						aria-current={entry.recordId === recordId ? 'page' : undefined}
						href={resolve('/(app)/records/[id]', {
							id: String(entry.recordId)
						})}
					>
						<span
							>{entry.description}<span class="text-muted-foreground block text-xs"
								>{entry.contactName} · {entry.recordNumber || `#${entry.recordId}`}</span
							></span
						>
						<span class="shrink-0">{formatMinor(entry.amountMinor)}</span>
					</a>
				{/each}
			</div>
		</details>
		{#if !group.reversedAt && canReverse}
			<button type="button" class="sheet-btn mt-3" {disabled} onclick={() => onreverse(group.id)}
				>Reverse entire reimbursement…</button
			>
		{/if}
	</section>
{/each}

{#if reimbursement.allocationHistory.length}
	<section class="detail-card">
		<details>
			<summary class="cursor-pointer text-sm font-medium"
				>Allocation history · {reimbursement.allocationHistory.length} correction{reimbursement
					.allocationHistory.length === 1
					? ''
					: 's'}</summary
			>
			<p class="text-muted-foreground mt-2 text-sm">
				These are historical corrections. Current available credit is shown on the payment and may
				have changed since.
			</p>
			{#each reimbursement.allocationHistory as correction (correction.id)}
				<div class="mt-3 border-t pt-3 text-sm">
					<p class="font-medium">{formatDate(correction.date.slice(0, 10))}</p>
					{#if correction.removedMinor > 0}<p>
							{formatMinor(correction.removedMinor)} allocation reversed
						</p>{/if}
					{#if correction.addedMinor > 0}<p>
							{formatMinor(correction.addedMinor)} allocated to replacement records
						</p>{/if}
					{#if correction.reason}<p class="text-muted-foreground mt-1">
							Reason: {correction.reason}
						</p>{/if}
				</div>
			{/each}
		</details>
	</section>
{/if}
