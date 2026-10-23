import { page, userEvent } from 'vitest/browser';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import RecordActions from './RecordActions.svelte';
import RecordActionsHarness from './__fixtures__/RecordActionsHarness.svelte';

afterEach(() => vi.unstubAllGlobals());

it('hides the menu when there are no permitted actions', async () => {
	render(RecordActions, { onaction: vi.fn() });
	await expect
		.element(page.getByRole('button', { name: 'Actions' }))
		.not.toBeInTheDocument();
});

it('shows only eligible actions and omits an unnecessary separator', async () => {
	render(RecordActions, { canCorrectDate: true, onaction: vi.fn() });
	await page.getByRole('button', { name: 'Actions' }).click();
	await expect
		.element(page.getByRole('menuitem', { name: 'Correct date…' }))
		.toBeVisible();
	await expect
		.element(page.getByRole('menuitem', { name: 'Correct payee…' }))
		.not.toBeInTheDocument();
	await expect
		.element(page.getByRole('menuitem', { name: 'Delete…' }))
		.not.toBeInTheDocument();
	expect(
		document.querySelector('[data-slot="dropdown-menu-separator"]')
	).toBeNull();
	await userEvent.keyboard('{Escape}');
	await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
});

it('separates Delete and explains blocked corrections and deletion', async () => {
	render(RecordActions, {
		canCorrectPayee: true,
		canCorrectDate: true,
		canDelete: true,
		dirty: true,
		deleteBlockedReason: 'Cancel the invoice instead',
		onaction: vi.fn()
	});
	await page.getByRole('button', { name: 'Actions' }).click();
	for (const name of ['Correct payee…', 'Correct date…', 'Delete…']) {
		await expect
			.element(page.getByRole('menuitem', { name }))
			.toHaveAttribute('aria-disabled', 'true');
	}
	expect(
		document.querySelector('[data-slot="dropdown-menu-separator"]')
	).not.toBeNull();
	await expect
		.element(
			page.getByText(
				'Save or discard your changes before correcting this record.'
			)
		)
		.toBeVisible();
	await expect
		.element(page.getByText('Cancel the invoice instead'))
		.toBeVisible();
	await userEvent.keyboard('{Escape}');
	await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
});

it('disables the trigger while saving', async () => {
	render(RecordActions, { canDelete: true, saving: true, onaction: vi.fn() });
	await expect
		.element(page.getByRole('button', { name: 'Actions' }))
		.toBeDisabled();
});

it('preserves Delete as an available action when corrections do not apply', async () => {
	const onaction = vi.fn();
	render(RecordActions, { canDelete: true, onaction });
	await page.getByRole('button', { name: 'Actions' }).click();
	expect(
		document.querySelector('[data-slot="dropdown-menu-separator"]')
	).toBeNull();
	await page.getByRole('menuitem', { name: 'Delete…' }).click();
	await expect.poll(() => onaction.mock.calls).toEqual([['delete']]);
	await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
});

it('opens each existing dialog and returns focus to Actions after cancellation', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({
				version: 'current',
				dependencies: [],
				record: {
					contactId: 90,
					contactName: 'admin',
					amountMinor: 58294,
					date: '2026-04-02',
					recordNumber: 'CL20260402-002',
					description: 'Reimbursement'
				}
			})
		)
	);
	render(RecordActionsHarness);
	for (const [item, title, role] of [
		['Correct payee…', 'Correct payee', 'dialog'],
		['Correct date…', 'Correct settled record date', 'dialog'],
		['Delete…', 'Delete this record?', 'alertdialog']
	] as const) {
		await page.getByRole('button', { name: 'Actions' }).click();
		await page.getByRole('menuitem', { name: item }).click();
		const dialog = page.getByRole(role, { name: title, exact: true });
		await expect.element(dialog).toBeVisible();
		await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
		await expect
			.poll(() => dialog.element().contains(document.activeElement))
			.toBe(true);
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Actions' }))
			.toHaveFocus();
	}
});

it('supports keyboard selection and Escape with focus returning to the trigger', async () => {
	const onaction = vi.fn();
	render(RecordActions, { canCorrectPayee: true, canDelete: true, onaction });
	await userEvent.tab();
	await expect
		.element(page.getByRole('button', { name: 'Actions' }))
		.toHaveFocus();
	await userEvent.keyboard('{ArrowDown}');
	await expect
		.element(page.getByRole('menuitem', { name: 'Correct payee…' }))
		.toHaveFocus();
	await userEvent.keyboard('{Escape}');
	await expect
		.element(page.getByRole('button', { name: 'Actions' }))
		.toHaveFocus();
	expect(onaction).not.toHaveBeenCalled();
	await userEvent.keyboard('{ArrowDown}');
	await expect
		.element(page.getByRole('menuitem', { name: 'Correct payee…' }))
		.toHaveFocus();
	await userEvent.keyboard('{Enter}');
	await expect.poll(() => onaction.mock.calls).toEqual([['payee']]);
});

it('disables reimbursement correction and explains bank matches or unsaved changes', async () => {
	render(RecordActions, {
		canCorrectAmount: true,
		amountBlockedReason: 'Remove bank matches first.',
		dirty: true,
		onaction: vi.fn()
	});
	await page.getByRole('button', { name: 'Actions' }).click();
	await expect
		.element(
			page.getByRole('menuitem', { name: 'Correct reimbursement amount…' })
		)
		.toHaveAttribute('aria-disabled', 'true');
	await expect
		.element(page.getByText('Remove bank matches first.'))
		.toBeVisible();
	await expect
		.element(
			page.getByText(
				'Save or discard your changes before correcting this record.'
			)
		)
		.toBeVisible();
	await userEvent.keyboard('{Escape}');
});

it('hands keyboard focus to reimbursement correction and returns it after closing', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({
				version: 'current',
				record: {
					amountMinor: 550,
					recordNumber: 'CL-208',
					contactName: 'Employee'
				},
				expenses: [],
				availableCreditMinor: 550
			})
		)
	);
	render(RecordActionsHarness);
	await page.getByRole('button', { name: 'Actions' }).click();
	await page
		.getByRole('menuitem', { name: 'Correct reimbursement amount…' })
		.click();
	const dialog = page.getByRole('dialog', {
		name: 'Correct reimbursement amount',
		exact: true
	});
	await expect.element(dialog).toBeVisible();
	await expect
		.poll(() => dialog.element().contains(document.activeElement))
		.toBe(true);
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await expect.element(dialog).not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: 'Actions' }))
		.toHaveFocus();
});
