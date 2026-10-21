<script lang="ts">
	import RecordActions from '../RecordActions.svelte';
	import RecipientCorrectionDialog from '../RecipientCorrectionDialog.svelte';
	import DateCorrectionDialog from '../DateCorrectionDialog.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';

	let action = $state<'payee' | 'date' | 'delete' | null>(null);
	let deleting = $state(false);
</script>

<RecordActions
	canCorrectPayee
	canCorrectDate
	canDelete
	dialogOpen={action !== null || deleting}
	onaction={(selected) => {
		if (selected === 'delete') deleting = true;
		else action = selected;
	}}
/>
{#if action === 'payee'}
	<RecipientCorrectionDialog
		recordId={219}
		contacts={[
			{ id: 90, legalName: 'admin' },
			{ id: 21, legalName: 'TANG HAO QUAN' }
		]}
		onclose={() => (action = null)}
		oncorrected={() => {}}
	/>
{:else if action === 'date'}
	<DateCorrectionDialog
		recordId={219}
		onclose={() => (action = null)}
		oncorrected={() => {}}
	/>
{/if}
<ConfirmDialog
	bind:open={deleting}
	title="Delete this record?"
	description="This removes the record and its journal lines. It cannot be undone."
	confirmLabel="Delete"
	danger
	onConfirm={() => {}}
/>
