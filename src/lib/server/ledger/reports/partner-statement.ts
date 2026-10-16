import { AccountType } from "$lib/enums.js";
import { allocateMinor } from "../money.js";
import type {
  AccountTotal,
  Minor,
  PartnerStatementBlock,
  PartnerStatementReport,
} from "../types.js";
import { historyGapNotes } from "./notes.js";

/**
 * What each partner put in, what they are owed of the result, and what they
 * took back out, over a date range (FR-027).
 *
 * Pure: the partners and their accounts' totals arrive from
 * `queries/reports.ts`.
 *
 * One block per contact holding the Partner role, built from that contact's own
 * pair of accounts (FR-008b) — a partner who has not moved a cent still gets a
 * block, because the statement is a list of the partners, not a list of the
 * accounts that happen to have something in them.
 */

export type PartnerContact = { contactId: number; contactName: string };

export type PartnerStatementInput = {
  dateFrom: string;
  dateTo: string;
  /** Every contact holding the Partner role, in the order to show them. */
  partners: PartnerContact[];
  /** Totals over the range for the partners' capital and drawings accounts. */
  totals: AccountTotal[];
  /** The result for the same period, from the profit and loss. */
  resultMinor: Minor;
  /** The day the ledger began, so a period reaching further back says so (FR-030). */
  trackingStartedOn?: string | null;
};

/**
 * The app records no share for each partner, so the result is split evenly.
 * `allocateMinor` does the splitting rather than a division, so an amount that
 * does not divide evenly still adds back up to exactly the result — a cent
 * quietly disappearing here is the kind of wrong nobody notices.
 */
const EQUAL_SHARE_NOTE =
  "Net profit is allocated equally among the partners, because no " +
  "profit-sharing ratio is recorded.";

export function partnerStatement(
  input: PartnerStatementInput,
): PartnerStatementReport {
  const contributionsByContact = new Map<number, Minor>();
  const drawingsByContact = new Map<number, Minor>();

  for (const total of input.totals) {
    // Only a partner's capital and drawings accounts point at a contact, and
    // they are the only accounts this statement is made of.
    if (total.contactId === null) continue;

    if (total.type !== AccountType.Equity) continue;
    if (total.amountMinor < 0) {
      contributionsByContact.set(
        total.contactId,
        (contributionsByContact.get(total.contactId) ?? 0) - total.amountMinor,
      );
    } else if (total.amountMinor > 0) {
      drawingsByContact.set(
        total.contactId,
        (drawingsByContact.get(total.contactId) ?? 0) + total.amountMinor,
      );
    }
  }

  const shares = allocateMinor(
    input.resultMinor,
    input.partners.map(() => 1),
  );

  const partners: PartnerStatementBlock[] = input.partners.map(
    (partner, index) => {
      const contributionsMinor =
        contributionsByContact.get(partner.contactId) ?? 0;
      const drawingsMinor = drawingsByContact.get(partner.contactId) ?? 0;
      const shareOfResultMinor = shares[index] ?? 0;
      return {
        contactId: partner.contactId,
        contactName: partner.contactName,
        contributionsMinor,
        shareOfResultMinor,
        drawingsMinor,
        netMinor: contributionsMinor + shareOfResultMinor - drawingsMinor,
      };
    },
  );

  return {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    partners,
    notes: [
      EQUAL_SHARE_NOTE,
      ...historyGapNotes(input.dateFrom, input.trackingStartedOn),
    ],
  };
}
