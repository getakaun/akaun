// Shared PDF render types — safe to import in both server and browser code.
// The theme is the only user-set knob (accent color; the font is always
// Inter); everything else about a document's appearance is decided by the
// layout function it's routed to (see $lib/server/pdf/layouts/).

export type ThemeData = {
  color: string;
};

export type LayoutLineItem = {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type LayoutRenderData = {
  document: {
    invoiceNumber?: string;
    quotationNumber?: string;
    issueDate: string | null;
    dueDate?: string | null;
    expiryDate?: string | null;
    reference?: string | null;
    currency: string;
    lines: LayoutLineItem[];
    subtotal: number;
    total: number;
    notes?: string | null;
    terms?: string | null;
    contactName?: string | null;
    contactAddress?: string | null;
    contactRegistrationNo?: string | null;
    contactPhone?: string | null;
    /**
     * How much has been paid and how much is still due, in the document's own
     * currency — the one every other figure on it is in. Worked out by
     * `server/pdf/sales-pdf.ts` from the ledger's main-currency cents.
     */
    amountPaid?: number;
    amountDue?: number;
    paid?: boolean;
    isOverdue?: boolean;
    settlements?: {
      amountMinor: number;
      createdAt: string;
      otherDate: string;
    }[];
  };
  settings: {
    companyName?: string;
    companyAddress?: string;
    companyRegistrationNo?: string;
    /**
     * Absolute path of the letterhead image, present only when the PDF should
     * print it in place of the company name at the top. Resolved by
     * `sales-pdf.ts`; a layout only decides where it goes.
     */
    letterheadPath?: string;
  };
  docTypeLabel: string;
  /**
   * Large faint text across every page: VOID on a cancelled invoice, DRAFT on
   * one not yet sent, so a printed copy cannot pass for a live demand.
   */
  statusStamp?: StatusStamp | null;
};

export type StatusStamp = "VOID" | "DRAFT" | "SUPERSEDED";
