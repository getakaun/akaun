import { ANY_READ, readTool } from "./define.js";

/**
 * `review_books`: listed to anyone who can read some area. Each check runs
 * only when the caller may read what it looks at (records for uncategorised
 * lines, contacts for duplicate contacts, reconciliation for unmatched bank
 * lines, invoices for overdue invoices, and so on); the others are reported
 * as skipped, never as clean.
 */
export const REVIEW_BOOKS = readTool(ANY_READ);
