import { page } from 'vitest/browser';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReimbursementAmountCorrectionDialog from './ReimbursementAmountCorrectionDialog.svelte';

afterEach(() => vi.unstubAllGlobals());

const snapshot = {
	version: 'current',
	availableCreditMinor: 0,
	record: { amountMinor: 550, recordNumber: 'CL-208', contactName: 'Employee' },
	expenses: [
		{
			recordId: 6,
			recordNumber: 'EX-6',
			description: 'Travel adaptor',
			owedMovementId: 12,
			amountMinor: 550,
			allocatedMinor: 550,
			otherPaidMinor: 0,
			availableMinor: 550
		}
	]
};

it('reviews the fifty-cent remainder and confirms once with the displayed allocations', async () => {
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
		Response.json(init?.method === 'POST' ? {} : snapshot)
	);
	vi.stubGlobal('fetch', fetch);
	const oncorrected = vi.fn();
	const onclose = vi.fn();
	render(ReimbursementAmountCorrectionDialog, {
		recordId: 208,
		oncorrected,
		onclose
	});
	await expect
		.element(page.getByLabelText('Actual amount paid'))
		.toHaveValue('5.50');
	await page.getByLabelText('Actual amount paid').fill('5.00');
	await page
		.getByLabelText('Reason', { exact: true })
		.fill('Correct to the actual bank transfer.');
	await page.getByRole('button', { name: 'Review correction' }).click();
	await expect.element(page.getByText(/Remaining:.*0\.50/)).toBeVisible();
	await page.getByRole('button', { name: 'Confirm correction' }).click();
	await expect.poll(() => oncorrected.mock.calls.length).toBe(1);
	expect(onclose).toHaveBeenCalledTimes(1);
	const write = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
	expect(JSON.parse(String(write?.[1]?.body))).toEqual({
		amountMinor: 500,
		allocations: [{ owedMovementId: 12, amountMinor: 500 }],
		reason: 'Correct to the actual bank transfer.',
		expectedVersion: 'current'
	});
});

it('requires explicit valid allocations when several expenses are covered', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({
				...snapshot,
				record: { ...snapshot.record, amountMinor: 1100 },
				expenses: [
					...snapshot.expenses,
					{
						...snapshot.expenses[0],
						recordId: 7,
						recordNumber: 'EX-7',
						owedMovementId: 13
					}
				]
			})
		)
	);
	render(ReimbursementAmountCorrectionDialog, {
		recordId: 208,
		oncorrected: vi.fn(),
		onclose: vi.fn()
	});
	await expect
		.element(page.getByLabelText('Actual amount paid'))
		.toHaveValue('11.00');
	await page.getByLabelText('Actual amount paid').fill('10.50');
	await page
		.getByLabelText('Reason', { exact: true })
		.fill('Correct the underpaid travel adaptor.');
	await expect
		.element(page.getByRole('button', { name: 'Review correction' }))
		.toBeDisabled();
	await page.getByLabelText(/EX-6/).fill('5.00');
	await expect
		.element(page.getByRole('button', { name: 'Review correction' }))
		.toBeEnabled();
});

it('requires reload after a conflict instead of retrying the same correction', async () => {
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
		init?.method === 'POST'
			? Response.json({ error: 'Changed while reviewing.' }, { status: 409 })
			: Response.json(snapshot)
	);
	vi.stubGlobal('fetch', fetch);
	render(ReimbursementAmountCorrectionDialog, {
		recordId: 208,
		oncorrected: vi.fn(),
		onclose: vi.fn()
	});
	await expect
		.element(page.getByLabelText('Actual amount paid'))
		.toHaveValue('5.50');
	await page.getByLabelText('Actual amount paid').fill('5.00');
	await page
		.getByLabelText('Reason', { exact: true })
		.fill('Correct to the actual bank transfer.');
	await page.getByRole('button', { name: 'Review correction' }).click();
	await page.getByRole('button', { name: 'Confirm correction' }).click();
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent('Changed while reviewing.');
	await expect
		.element(page.getByRole('button', { name: 'Confirm correction' }))
		.toBeDisabled();
	expect(
		fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
	).toHaveLength(1);
});

it('disables confirmation while saving and sends only one correction', async () => {
	let finish: (response: Response) => void = () => {};
	const pending = new Promise<Response>((resolve) => {
		finish = resolve;
	});
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
		init?.method === 'POST' ? pending : Response.json(snapshot)
	);
	vi.stubGlobal('fetch', fetch);
	const oncorrected = vi.fn();
	render(ReimbursementAmountCorrectionDialog, {
		recordId: 208,
		oncorrected,
		onclose: vi.fn()
	});
	await expect
		.element(page.getByLabelText('Actual amount paid'))
		.toHaveValue('5.50');
	await page.getByLabelText('Actual amount paid').fill('5.00');
	await page
		.getByLabelText('Reason', { exact: true })
		.fill('Correct to the actual bank transfer.');
	await page.getByRole('button', { name: 'Review correction' }).click();
	await page.getByRole('button', { name: 'Confirm correction' }).click();
	await expect
		.element(page.getByRole('button', { name: 'Saving…' }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: 'Close', exact: true }))
		.toBeDisabled();
	expect(
		fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
	).toHaveLength(1);
	finish(Response.json({}));
	await expect.poll(() => oncorrected.mock.calls.length).toBe(1);
});

it('requires reload when the save result is uncertain', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (init?.method === 'POST') throw new Error('Connection lost');
			return Response.json(snapshot);
		})
	);
	const oncorrected = vi.fn();
	render(ReimbursementAmountCorrectionDialog, {
		recordId: 208,
		oncorrected,
		onclose: vi.fn()
	});
	await expect
		.element(page.getByLabelText('Actual amount paid'))
		.toHaveValue('5.50');
	await page.getByLabelText('Actual amount paid').fill('5.00');
	await page
		.getByLabelText('Reason', { exact: true })
		.fill('Correct to the actual bank transfer.');
	await page.getByRole('button', { name: 'Review correction' }).click();
	await page.getByRole('button', { name: 'Confirm correction' }).click();
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent(/Reload the record before trying again/);
	await expect
		.element(page.getByRole('button', { name: 'Confirm correction' }))
		.toBeDisabled();
	expect(oncorrected).not.toHaveBeenCalled();
});
