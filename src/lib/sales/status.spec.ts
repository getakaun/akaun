import { describe, expect, it } from "vitest";
import { InvoiceStatus, QuotationStatus } from "$lib/enums.js";
import {
  canCancelInvoice,
  canConvert,
  canSetQuotationStatus,
  invoiceStatusKey,
  quotationStatusKey,
} from "./status.js";

const sent = {
  status: InvoiceStatus.Sent,
  paid: false,
  paidMinor: 0,
  isOverdue: false,
};

describe("invoiceStatusKey", () => {
  it("reads the stored lifecycle first", () => {
    expect(invoiceStatusKey({ ...sent, status: InvoiceStatus.Draft })).toBe(
      "draft",
    );
    expect(
      invoiceStatusKey({
        ...sent,
        status: InvoiceStatus.Cancelled,
        isOverdue: true,
      }),
    ).toBe("cancelled");
  });

  it("works out paid, overdue and part-paid from the payments", () => {
    expect(invoiceStatusKey(sent)).toBe("sent");
    expect(invoiceStatusKey({ ...sent, paidMinor: 500 })).toBe("part-paid");
    expect(invoiceStatusKey({ ...sent, paid: true, paidMinor: 1000 })).toBe(
      "paid",
    );
    expect(invoiceStatusKey({ ...sent, isOverdue: true, paidMinor: 500 })).toBe(
      "overdue",
    );
  });

  it("reads a pre-upgrade Paid invoice as paid", () => {
    expect(
      invoiceStatusKey({
        status: InvoiceStatus.Paid,
        paid: true,
        paidMinor: 1000,
        isOverdue: false,
      }),
    ).toBe("paid");
  });
});

describe("quotationStatusKey", () => {
  it("says expired only for an open quote", () => {
    expect(
      quotationStatusKey({ status: QuotationStatus.Draft, isExpired: true }),
    ).toBe("expired");
    expect(
      quotationStatusKey({ status: QuotationStatus.Sent, isExpired: true }),
    ).toBe("expired");
    expect(
      quotationStatusKey({ status: QuotationStatus.Accepted, isExpired: true }),
    ).toBe("accepted");
  });

  it("uses the stored status otherwise", () => {
    expect(
      quotationStatusKey({ status: QuotationStatus.Sent, isExpired: false }),
    ).toBe("sent");
    expect(
      quotationStatusKey({
        status: QuotationStatus.Declined,
        isExpired: false,
      }),
    ).toBe("declined");
    expect(
      quotationStatusKey({
        status: QuotationStatus.Converted,
        isExpired: false,
      }),
    ).toBe("converted");
  });
});

describe("canSetQuotationStatus", () => {
  it("allows a move between two different open statuses", () => {
    expect(
      canSetQuotationStatus(QuotationStatus.Draft, QuotationStatus.Sent),
    ).toBe(true);
    expect(
      canSetQuotationStatus(QuotationStatus.Accepted, QuotationStatus.Sent),
    ).toBe(true);
    expect(
      canSetQuotationStatus(QuotationStatus.Declined, QuotationStatus.Sent),
    ).toBe(true);
  });

  it("never moves a quotation back to Draft, or into or out of Superseded", () => {
    expect(
      canSetQuotationStatus(QuotationStatus.Declined, QuotationStatus.Draft),
    ).toBe(false);
    expect(
      canSetQuotationStatus(QuotationStatus.Sent, QuotationStatus.Superseded),
    ).toBe(false);
    expect(
      canSetQuotationStatus(QuotationStatus.Superseded, QuotationStatus.Sent),
    ).toBe(false);
  });

  it("never moves into or out of Converted", () => {
    expect(
      canSetQuotationStatus(
        QuotationStatus.Accepted,
        QuotationStatus.Converted,
      ),
    ).toBe(false);
    expect(
      canSetQuotationStatus(QuotationStatus.Converted, QuotationStatus.Draft),
    ).toBe(false);
  });

  it("refuses a move to the same status, or to an unknown one", () => {
    expect(
      canSetQuotationStatus(QuotationStatus.Sent, QuotationStatus.Sent),
    ).toBe(false);
    expect(canSetQuotationStatus(QuotationStatus.Sent, 99)).toBe(false);
  });
});

describe("canConvert", () => {
  it("allows Sent and Accepted only", () => {
    expect(canConvert({ status: QuotationStatus.Sent })).toBe(true);
    expect(canConvert({ status: QuotationStatus.Accepted })).toBe(true);
    expect(canConvert({ status: QuotationStatus.Draft })).toBe(false);
    expect(canConvert({ status: QuotationStatus.Declined })).toBe(false);
    expect(canConvert({ status: QuotationStatus.Converted })).toBe(false);
    expect(canConvert({ status: QuotationStatus.Superseded })).toBe(false);
  });

  it("refuses an expired one", () => {
    expect(canConvert({ status: QuotationStatus.Sent, isExpired: true })).toBe(
      false,
    );
  });
});

describe("canCancelInvoice", () => {
  const base = { status: InvoiceStatus.Sent, ledgerRecordId: 7, paidMinor: 0 };

  it("allows a sent invoice nothing has been paid against", () => {
    expect(canCancelInvoice(base)).toBe(true);
  });

  it("refuses once anything is paid, and refuses a draft", () => {
    expect(canCancelInvoice({ ...base, paidMinor: 1 })).toBe(false);
    expect(
      canCancelInvoice({
        status: InvoiceStatus.Draft,
        ledgerRecordId: null,
        paidMinor: 0,
      }),
    ).toBe(false);
  });

  it("finishes an old cancellation that left its posting behind", () => {
    expect(canCancelInvoice({ ...base, status: InvoiceStatus.Cancelled })).toBe(
      true,
    );
    expect(
      canCancelInvoice({
        ...base,
        status: InvoiceStatus.Cancelled,
        ledgerRecordId: null,
      }),
    ).toBe(false);
  });
});
