import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  markInvoiceIssued: vi.fn(),
  createRecord: vi.fn(),
  requireAccountDefault: vi.fn(),
  reindexRecord: vi.fn(),
}));

vi.mock("$lib/server/queries/invoices.js", () => ({
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  getInvoice: mocks.getInvoice,
  markInvoiceIssued: mocks.markInvoiceIssued,
  markInvoiceCancelled: vi.fn(),
}));
vi.mock("$lib/server/services/ledger.js", () => ({
  createRecord: mocks.createRecord,
  removeRecord: vi.fn(),
}));
vi.mock("$lib/server/services/account-defaults.js", () => ({
  requireAccountDefault: mocks.requireAccountDefault,
}));
vi.mock("$lib/server/queries/ledger.js", () => ({
  reindexRecord: mocks.reindexRecord,
  lockStateFor: vi.fn(),
}));

import { issueInvoice } from "./invoices.js";

/** Issuing runs in one transaction; this stand-in just runs it. */
const fakeDb = {
  transaction: (fn: (tx: unknown) => unknown) => fn(fakeDb),
} as never;

describe("issuing an invoice with saved defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInvoice.mockReturnValue({
      id: 1,
      ledgerRecordId: null,
      status: 1,
      contactId: 5,
      issueDate: "2026-08-21",
      invoiceNumber: "INV-1",
      total: 125,
      currency: "MYR",
      exchangeRate: 1,
    });
    mocks.requireAccountDefault.mockReturnValue({ ok: true, value: 44 });
    mocks.createRecord.mockReturnValue({ ok: true, value: { id: 99 } });
    mocks.markInvoiceIssued.mockReturnValue({ id: 1, ledgerRecordId: 99 });
  });

  it("uses the saved sales revenue account when no override is supplied", () => {
    expect(issueInvoice(fakeDb, 1, 7).ok).toBe(true);
    expect(mocks.createRecord).toHaveBeenCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({ incomeAccountId: 44 }),
      // Its emits are held until the transaction commits.
      expect.any(Array),
    );
    // Reindexed again after `markInvoiceIssued` links the invoice back to the
    // record, so the record's search text can pick up the invoice's content.
    expect(mocks.reindexRecord).toHaveBeenCalledWith(expect.anything(), 99);
  });

  it("does not create a partial record when the saved account is missing or invalid", () => {
    mocks.requireAccountDefault.mockReturnValue({
      ok: false,
      reason: "Choose a valid default.",
    });
    expect(issueInvoice(fakeDb, 1, 7)).toEqual({
      ok: false,
      reason: "Choose a valid default.",
    });
    expect(mocks.createRecord).not.toHaveBeenCalled();
    expect(mocks.markInvoiceIssued).not.toHaveBeenCalled();
  });
});
