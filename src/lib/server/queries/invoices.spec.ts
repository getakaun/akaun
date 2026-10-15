import { describe, expect, it } from "vitest";
import { invoicePaymentState } from "./invoices.js";
import { InvoiceStatus } from "$lib/enums.js";
import type { SettlementSide } from "../ledger/types.js";

/**
 * How much of an invoice is paid is arithmetic over settlements, never a stored
 * column (D-10). These pin the rule itself; the query around it is covered by
 * using it.
 */

/** The movement issuing an invoice creates: its amount owed to us, positive. */
function owedToUs(amountMinor: number, settledMinor = 0): SettlementSide {
  return { movementId: 1, amountMinor, settledMinor };
}

describe("what an invoice has been paid", () => {
  it("is nothing while no payment has been put against it", () => {
    expect(
      invoicePaymentState(50_000, InvoiceStatus.Sent, owedToUs(50_000)),
    ).toEqual({
      totalMinor: 50_000,
      paidMinor: 0,
      outstandingMinor: 50_000,
      paid: false,
      owedMovementId: 1,
    });
  });

  it("counts a part payment and still reads unpaid", () => {
    expect(
      invoicePaymentState(50_000, InvoiceStatus.Sent, owedToUs(50_000, 20_000)),
    ).toEqual({
      totalMinor: 50_000,
      paidMinor: 20_000,
      outstandingMinor: 30_000,
      paid: false,
      owedMovementId: 1,
    });
  });

  it("reads paid the moment settlements cover it, whatever the status says", () => {
    const state = invoicePaymentState(
      50_000,
      InvoiceStatus.Sent,
      owedToUs(50_000, 50_000),
    );
    expect(state.paid).toBe(true);
    expect(state.outstandingMinor).toBe(0);
  });

  it("adds up instalments to the same answer as one payment", () => {
    const instalments = invoicePaymentState(
      50_000,
      InvoiceStatus.Sent,
      owedToUs(50_000, 20_000 + 30_000),
    );
    expect(instalments).toEqual(
      invoicePaymentState(50_000, InvoiceStatus.Sent, owedToUs(50_000, 50_000)),
    );
  });
});

describe("an invoice with no ledger history behind it", () => {
  it("owes nothing while it is still a draft", () => {
    expect(invoicePaymentState(50_000, InvoiceStatus.Draft, null)).toEqual({
      totalMinor: 50_000,
      paidMinor: 0,
      outstandingMinor: 0,
      paid: false,
      owedMovementId: null,
    });
  });

  it("owes nothing once it is cancelled", () => {
    expect(
      invoicePaymentState(50_000, InvoiceStatus.Cancelled, null)
        .outstandingMinor,
    ).toBe(0);
  });

  // Issued before the upgrade, so there is no movement to work from (FR-030).
  it("falls back to what the old status said", () => {
    expect(invoicePaymentState(50_000, InvoiceStatus.Paid, null)).toEqual({
      totalMinor: 50_000,
      paidMinor: 50_000,
      outstandingMinor: 0,
      paid: true,
      owedMovementId: null,
    });
    expect(invoicePaymentState(50_000, InvoiceStatus.Sent, null)).toEqual({
      totalMinor: 50_000,
      paidMinor: 0,
      outstandingMinor: 50_000,
      paid: false,
      owedMovementId: null,
    });
  });
});
