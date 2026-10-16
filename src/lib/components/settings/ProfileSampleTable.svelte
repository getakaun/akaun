<script lang="ts">
	import { FileSpreadsheet } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import ProfileColumnSelect from './ProfileColumnSelect.svelte';
	import { linesOf, type LayoutForm } from '$lib/import-profile-form.js';
	import {
		COLUMN_ROLES,
		columnRole,
		directionOf,
		setColumnRole,
		setDirection,
		type ColumnRole,
		type SampleInspection
	} from '$lib/import-profile-sample.js';

	/**
	 * An import profile's table, as the user sees it in their own spreadsheet
	 * (006 FR-053): a sample's heading row and first rows, with what each
	 * column is for chosen above it. The sample is read on the server and
	 * nothing is stored (`/api/import/profiles/sample`); the parent sends it and
	 * keeps the file, which the preview reads too.
	 *
	 * With no sample loaded, as when a saved profile is opened, the grid is the
	 * layout's own headings with no rows, and the roles can still be changed.
	 */
	let {
		layout = $bindable(),
		sample,
		sampleName,
		loading,
		error,
		canChange,
		roleProblems,
		onfile,
		onlocate,
		onadopt
	}: {
		layout: LayoutForm;
		sample: SampleInspection | null;
		sampleName: string;
		loading: boolean;
		error: string | null;
		canChange: boolean;
		/** The problems with the column choices, shown under the grid. */
		roleProblems: string[];
		onfile: (file: File) => void;
		/** Read the sample's table from another sheet or heading row. */
		onlocate: (where: { sheet: string; headerRow: number }) => void;
		/** Take the sample's headings and guesses in place of the layout's. */
		onadopt: () => void;
	} = $props();

	const PREVIEW_ROWS = 5;

	const layoutHeadings = $derived(linesOf(layout.headersText));
	// The sample's headings when they are the layout's; otherwise the layout's
	// own, with no rows: a sample of another table is offered, not forced.
	const matches = $derived(
		sample !== null &&
			layoutHeadings.length > 0 &&
			layoutHeadings.every((heading) => sample!.headers.includes(heading))
	);
	const headings = $derived(matches || layoutHeadings.length === 0 ? (sample?.headers ?? layoutHeadings) : layoutHeadings);
	const rows = $derived(matches ? sample!.rows.slice(0, PREVIEW_ROWS) : []);
	const cellAt = (row: string[], heading: string) => row[sample?.headers.indexOf(heading) ?? -1] ?? '';

	const ROLE_OPTIONS = COLUMN_ROLES.map((role) => ({ value: role.value, label: role.label }));
	const REQUIRED: { role: ColumnRole; label: string }[] = [
		{ role: 'date', label: 'Date' },
		{ role: 'description', label: 'Description' },
		{ role: 'amount', label: 'Amount' }
	];
	const missing = $derived(
		REQUIRED.filter(({ role }) => !headings.some((heading) => columnRole(layout, heading) === role)).map((r) => r.label)
	);

	// The direction column's values: the sample's, else those already marked.
	const directionValues = $derived.by(() => {
		if (!layout.directionColumn) return [];
		const fromSample = matches
			? (sample!.columns.find((c) => c.heading === layout.directionColumn)?.distinct ?? []).map((v) => v.value)
			: [];
		const marked = [...linesOf(layout.directionInText), ...linesOf(layout.directionOutText)];
		return [...new Set([...fromSample, ...marked])];
	});

	// Where the table is, when the user corrects the guess.
	let locating = $state(false);
	let sheetChoice = $state('');
	let rowChoice = $state<string | number>('');
	function startLocating() {
		sheetChoice = sample?.sheet ?? '';
		rowChoice = String(sample?.headerRow ?? '');
		locating = true;
	}
	function locate() {
		const headerRow = Number(rowChoice);
		if (!Number.isSafeInteger(headerRow) || headerRow < 1) return;
		locating = false;
		onlocate({ sheet: sheetChoice, headerRow });
	}

	let input = $state<HTMLInputElement | null>(null);
	let dragging = $state(false);

	function picked(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const file = target.files?.[0];
		if (file) onfile(file);
		target.value = '';
	}

	function dropped(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const file = event.dataTransfer?.files?.[0];
		if (file && canChange) onfile(file);
	}
</script>

{#if headings.length === 0}
	<!-- Nothing to show yet: the sample is the way in. -->
	<label
		class="st-drop"
		class:dragging
		class:disabled={!canChange}
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={dropped}
	>
		<input type="file" accept=".xlsx,.csv" class="st-file" disabled={!canChange || loading} onchange={picked} />
		<FileSpreadsheet size={22} />
		<span class="st-drop-main">{loading ? 'Wait. The app reads the sample.' : 'Drop a sample file here, or select a file'}</span>
		<span class="st-drop-hint">Use an .xlsx or .csv file from the same source. The app uses it to find the table. The app does not keep it.</span>
	</label>
	{#if error}<p class="st-error" role="alert">{error}</p>{/if}
{:else}
	<div class="st-bar">
		<span class="st-where">
			{#if matches && sample}
				<strong>{sampleName}</strong>: headings on row {sample.headerRow} of “{sample.sheet}”. {sample.rowCount.toLocaleString('en-US')} row{sample.rowCount === 1 ? '' : 's'}.
			{:else if sample}
				<strong>{sampleName}</strong> has different headings from this table.
			{:else}
				No sample. Load a sample to see the rows.
			{/if}
		</span>
		{#if canChange}
			<span class="st-actions">
				{#if sample && !matches}
					<button type="button" class="sheet-btn" onclick={onadopt}>Use the sample table</button>
				{/if}
				{#if sample}
					<button type="button" class="detail-card-action" onclick={startLocating}>Select a different table</button>
				{/if}
				<button type="button" class="detail-card-action" disabled={loading} onclick={() => input?.click()}>
					{loading ? 'Wait…' : sample ? 'Load a different sample' : 'Load a sample'}
				</button>
				<input bind:this={input} type="file" accept=".xlsx,.csv" class="st-file" onchange={picked} />
			</span>
		{/if}
	</div>

	{#if locating && sample}
		<div class="st-locate">
			{#if sample.sheets.length > 1}
				<div class="st-locate-field">
					<span class="field-label">Sheet</span>
					<ProfileColumnSelect
						options={sample.sheets.map((sheet) => ({ value: sheet.name, label: sheet.hidden ? `${sheet.name} (hidden)` : sheet.name }))}
						value={sheetChoice}
						ariaLabel="Sheet"
						onchange={(value) => (sheetChoice = value)}
					/>
				</div>
			{/if}
			<div class="st-locate-field">
				<label class="field-label" for="st-header-row">Heading row</label>
				<Input id="st-header-row" type="number" min="1" bind:value={rowChoice} class="w-full" />
			</div>
			<button type="button" class="sheet-btn sheet-btn-primary" onclick={locate}>Use this row</button>
			<button type="button" class="sheet-btn" onclick={() => (locating = false)}>Cancel</button>
		</div>
	{/if}
	{#if error}<p class="st-error" role="alert">{error}</p>{/if}

	<div class="st-scroll">
		<table class="st-table">
			<thead>
				<tr class="st-roles">
					{#each headings as heading (heading)}
						{@const role = columnRole(layout, heading)}
						<th class:st-used={role !== 'none'}>
							<ProfileColumnSelect
								options={ROLE_OPTIONS}
								value={role}
								ariaLabel="Role of “{heading}”"
								disabled={!canChange}
								onchange={(value) => setColumnRole(layout, heading, (value || 'none') as ColumnRole)}
							/>
						</th>
					{/each}
				</tr>
				<tr class="st-heads">
					{#each headings as heading (heading)}
						<th class:st-used={columnRole(layout, heading) !== 'none'}>{heading}</th>
					{/each}
				</tr>
			</thead>
			{#if rows.length}
				<tbody>
					{#each rows as row, rowIndex (rowIndex)}
						<tr>
							{#each headings as heading (heading)}
								<td class:st-used={columnRole(layout, heading) !== 'none'}>{cellAt(row, heading)}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			{/if}
		</table>
	</div>

	{#if missing.length}
		<p class="st-need">Select the {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} column{missing.length === 1 ? '' : 's'}.</p>
	{/if}
	{#each roleProblems as message, index (index)}
		<p class="st-error">{message}</p>
	{/each}

	{#if layout.directionColumn}
		<div class="st-direction">
			<span class="field-label">Set each value of “{layout.directionColumn}” to inflow or outflow.</span>
			{#if directionValues.length}
				<div class="st-values">
					{#each directionValues as value (value)}
						{@const way = directionOf(layout, value)}
						<span class="st-value">
							<span class="st-value-text">{value}</span>
							<span class="st-seg" role="group" aria-label="Direction of {value}">
								<button
									type="button"
									class:on={way === 'in'}
									aria-pressed={way === 'in'}
									disabled={!canChange}
									onclick={() => setDirection(layout, value, way === 'in' ? null : 'in')}>Inflow</button
								>
								<button
									type="button"
									class:on={way === 'out'}
									aria-pressed={way === 'out'}
									disabled={!canChange}
									onclick={() => setDirection(layout, value, way === 'out' ? null : 'out')}>Outflow</button
								>
							</span>
						</span>
					{/each}
				</div>
			{:else}
				<p class="field-hint" style="margin-top:4px;">Load a sample to see the values. Or, type the values in More options.</p>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.st-file {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
	.st-drop {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 28px 16px;
		border: 1.5px dashed var(--border);
		border-radius: 10px;
		text-align: center;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.st-drop:focus-within,
	.st-drop.dragging {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--foreground);
	}
	.st-drop.disabled {
		cursor: not-allowed;
		opacity: 0.7;
	}
	.st-drop-main {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--foreground);
	}
	.st-drop-hint {
		font-size: 12px;
	}
	.st-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 12px;
		margin-bottom: 10px;
	}
	.st-where {
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.st-where strong {
		color: var(--foreground);
		font-weight: 500;
	}
	.st-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.st-locate {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
		margin-bottom: 10px;
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--muted);
	}
	.st-locate-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 140px;
	}
	.st-scroll {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.st-table {
		border-collapse: collapse;
		font-size: 12.5px;
		min-width: 100%;
	}
	.st-table th,
	.st-table td {
		padding: 6px 10px;
		text-align: left;
		white-space: nowrap;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		border-bottom: 1px solid var(--border);
	}
	.st-roles th {
		padding: 8px 6px;
		min-width: 150px;
		font-weight: 400;
		background: var(--muted);
	}
	.st-heads th {
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.st-heads th.st-used {
		color: var(--foreground);
	}
	/* The columns the profile reads stand out from those it leaves. */
	.st-table td {
		color: var(--muted-foreground);
	}
	.st-table td.st-used,
	.st-heads th.st-used {
		background: var(--primary-soft);
	}
	.st-table td.st-used {
		color: var(--foreground);
	}
	.st-table tbody tr:last-child td {
		border-bottom: 0;
	}
	.st-need {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.st-error {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--red);
	}
	.st-direction {
		margin-top: 14px;
	}
	.st-values {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}
	.st-value {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 3px 3px 3px 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 12.5px;
	}
	.st-seg {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 5px;
		overflow: hidden;
	}
	.st-seg button {
		padding: 2px 9px;
		font-size: 12px;
		background: var(--card);
		color: var(--muted-foreground);
	}
	.st-seg button + button {
		border-left: 1px solid var(--border);
	}
	.st-seg button.on {
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.st-seg button:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}
</style>
