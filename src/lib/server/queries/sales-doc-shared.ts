import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { contacts } from "../db/schema.js";

/**
 * What a quotation and an invoice do the same way, written once.
 *
 * The two documents have the same line shape and the same arithmetic, and
 * their search text names the customer the same way. What stays in each
 * feature's own file is what genuinely differs: an invoice's payment state, a
 * quotation's expiry, the numbering sequence, and the foreign key on a line.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;

export type SalesLineInput = {
  description: string;
  quantity: number;
  unitPrice: number;
  sortOrder?: number; // defaults to array index if omitted
};

export type SalesTotals = { subtotal: number; taxAmount: 0; total: number };

/** No tax yet, so the total is the subtotal. */
export function computeTotals(lines: SalesLineInput[]): SalesTotals {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  return { subtotal, taxAmount: 0, total: subtotal };
}

/**
 * The columns of each line row, without the document it belongs to. The caller
 * adds its own key (`invoiceId` or `quotationId`), since that is the one column
 * the two line tables do not share.
 */
export function lineRows(lines: SalesLineInput[]) {
  return lines.map((line, i) => ({
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.quantity * line.unitPrice,
    sortOrder: line.sortOrder ?? i,
  }));
}

/** The customer's name as the search text holds it; empty when there is none. */
export function contactNameFor(
  db: Db,
  contactId: number | null | undefined,
): string {
  if (!contactId) return "";
  const row = db
    .select({ legalName: contacts.legalName })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  return row?.legalName ?? "";
}
