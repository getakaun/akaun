import {
	createQuotation as _create,
	updateQuotation as _update,
	deleteQuotation as _delete,
	getQuotation,
	convertQuotationToInvoice as _convert,
	setQuotationStatus as _setStatus,
	reviseQuotation as _revise,
	type QuotationCreate,
	type QuotationPatch
} from '$lib/server/queries/quotations.js';
import { getInvoice } from '$lib/server/queries/invoices.js';
import { quotationEvents, invoiceEvents } from '$lib/server/finance/events.js';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

export function createQuotation(db: Db, actingUserId: number, data: QuotationCreate) {
	const quotation = _create(db, actingUserId, data);
	quotationEvents.emit('quotation-update', { item: getQuotation(db, quotation.id) });
	return quotation;
}

export function patchQuotation(db: Db, id: number, actingUserId: number, patch: QuotationPatch) {
	const quotation = _update(db, id, actingUserId, patch);
	if (quotation) quotationEvents.emit('quotation-update', { item: getQuotation(db, id) });
	return quotation;
}

export function removeQuotation(db: Db, id: number, actingUserId: number) {
	// A deleted revision puts the quote it replaced back to Sent; found before
	// the delete, since afterwards nothing points at it.
	const previous = getQuotation(db, id)?.revisedFrom ?? null;
	const result = _delete(db, id, actingUserId);
	if (result.ok) {
		quotationEvents.emit('quotation-delete', { id });
		if (previous) quotationEvents.emit('quotation-update', { item: getQuotation(db, previous.id) });
	}
	return result;
}

/** A status change by hand (Sent, Accepted, Declined, back again). Told to the list after commit. */
export function setQuotationStatus(db: Db, id: number, actingUserId: number, to: number) {
	const result = _setStatus(db, id, actingUserId, to);
	if (result.ok) quotationEvents.emit('quotation-update', { item: result.value });
	return result;
}

export function convertToInvoice(
	db: Db,
	quotationId: number,
	userId: number,
	options: { today?: string } = {}
) {
	const result = _convert(db, quotationId, userId, options);
	if (result.ok) {
		const updatedQuotation = getQuotation(db, result.value.quotationId);
		const newInvoice = getInvoice(db, result.value.invoiceId);
		if (updatedQuotation) quotationEvents.emit('quotation-update', { item: updatedQuotation });
		if (newInvoice) invoiceEvents.emit('invoice-update', { item: newInvoice });
	}
	return result;
}

/** A sent quotation replaced by a new draft revision. Both are told to the list after commit. */
export function reviseQuotation(
	db: Db,
	quotationId: number,
	userId: number,
	options: { today?: string } = {}
) {
	const result = _revise(db, quotationId, userId, options);
	if (result.ok) {
		const previous = getQuotation(db, result.value.previousId);
		const revision = getQuotation(db, result.value.quotationId);
		if (previous) quotationEvents.emit('quotation-update', { item: previous });
		if (revision) quotationEvents.emit('quotation-update', { item: revision });
	}
	return result;
}
