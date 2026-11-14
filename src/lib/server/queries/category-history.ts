import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  accountDefaults,
  accounts,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import {
  DefaultAccountPurpose,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { isCategoryAccount } from "../ledger/account-type.js";
import type { LedgerDb } from "../ledger/types.js";
import { notVoided } from "./void-state.js";

/**
 * What categories have past records used? A read-only report for an agent (or
 * a person) deciding how to categorise a record; it applies no rules of its
 * own and picks nothing.
 *
 * Two questions, both answered straight off the ledger so they can never drift
 * from what actually happened:
 *
 *  - `byContact` — the categories the same contact's *other* records used.
 *  - `similarDescriptions` — the categories used by other records whose
 *    description shares significant words with this one, for a bank line with
 *    no contact at all ("GRAB*RIDE 8821KL MY" ~ "Grab ride KL").
 *
 * A *category* is whatever `isCategoryAccount` says — an Expense or Revenue
 * account, or a purchase asset such as equipment — the same split every screen
 * uses. A record with lines on two categories counts once for each. A void is
 * a second record that negates the first, so the pair is excluded from every
 * list (`notVoided`): a record that never happened is not a precedent.
 *
 * The two "not yet categorised" default accounts are *shown*, flagged
 * `isUncategorisedDefault`, not hidden: how many past records are still
 * uncategorised is itself useful, and the caller is told so it never copies
 * "Uncategorised" as an answer.
 *
 * The contact of a record is `coalesce(supplier_contact_id, contact_id)` — the
 * merchant, the same definition `aggregateRecords` groups by.
 *
 * Money is never read, so there is no arithmetic to get wrong.
 */

/** At most this many records are described in one call. */
export const CATEGORY_HISTORY_MAX_RECORDS = 50;
/** Examples kept per category. */
export const CATEGORY_HISTORY_MAX_EXAMPLES = 3;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export type CategoryHistoryInput = {
  /** Describe each of these records (at most 50). */
  recordIds?: number[];
  /** Describe this contact's history once, with no record. */
  contactId?: number;
  /** Describe the history of descriptions like this one, with no record. */
  description?: string;
  /** Most categories kept in each of the two lists. Default 10, at most 50. */
  limit?: number;
};

export type CategoryHistoryExample = {
  recordId: number;
  date: string;
  description: string;
};

export type CategoryHistoryRow = {
  categoryAccountId: number;
  name: string;
  type: AccountTypeCode;
  /** True for the saved "not yet categorised" default accounts. */
  isUncategorisedDefault: boolean;
  /** Records that used this category. */
  count: number;
  lastDate: string;
  /** The most recent records, best match first when ranked by description. */
  examples: CategoryHistoryExample[];
  /** `similarDescriptions` only: the most significant words one record shared. */
  overlap?: number;
};

export type CategoryHistoryEntry = {
  /** The record described; null for the one contact/description entry. */
  recordId: number | null;
  contactId: number | null;
  description: string;
  byContact: CategoryHistoryRow[];
  similarDescriptions: CategoryHistoryRow[];
};

export type CategoryHistoryResult = {
  /** One entry per record in input order, then one for contact/description. */
  entries: CategoryHistoryEntry[];
  /** Record ids that do not exist. */
  missingRecordIds: number[];
  /** Ids past the 50-record limit, left undescribed. */
  skippedRecordIds: number[];
};

// ---------------------------------------------------------------------------
// Description matching
// ---------------------------------------------------------------------------

/** How a bank prints a card payment in front of the merchant. Leading only. */
const LEADING_NOISE = new Set([
  "pos",
  "eftpos",
  "debit",
  "credit",
  "card",
  "purchase",
  "visa",
  "mastercard",
  "mc",
  "txn",
  "trx",
  "sq",
  "tst",
]);

/** Words that say nothing about the merchant or the purpose. */
const STOP_WORDS = new Set([
  "pos",
  "eftpos",
  "the",
  "and",
  "for",
  "to",
  "of",
  "in",
  "at",
  "on",
  "by",
  "my",
  "mys",
  "sdn",
  "bhd",
  "berhad",
  "pte",
  "ltd",
  "inc",
  "llc",
  "co",
  "corp",
  "www",
  "com",
  "http",
  "https",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

/**
 * The significant words of a description, lowercased and de-duplicated.
 *
 * Dates, digits and `*` are dropped ("GRAB*RIDE 8821KL MY" becomes
 * `grab ride kl`, the country code being a stop word); so are the card prefix
 * a bank puts in front ("POS DEBIT SHELL KL" becomes `shell kl`), masked card
 * numbers, company suffixes and month names. The prefix is stripped only while
 * something is left, so "Debit card" does not match everything by being empty.
 */
export function descriptionTokens(description: string): string[] {
  const words = description
    .toLowerCase()
    // 12/03/2026, 2026-03-12, 12.03.26 — before digits are dropped, so the
    // separators go with them.
    .replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g, " ")
    .replace(/\d+/g, " ")
    .match(/\p{L}+/gu);
  if (!words) return [];
  let start = 0;
  while (start < words.length - 1 && LEADING_NOISE.has(words[start])) start++;
  const tokens = new Set<string>();
  for (const word of words.slice(start)) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    if (/^x+$/.test(word)) continue; // a masked card number, XXXX1234
    tokens.add(word);
  }
  return [...tokens];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type HistoryRow = {
  recordId: number;
  date: string;
  description: string;
  contactId: number | null;
  accountId: number;
  accountName: string;
  accountType: AccountTypeCode;
};

/** The one definition of "this record's contact": the merchant. */
const recordContact = sql<
  number | null
>`coalesce(${ledgerRecords.supplierContactId}, ${ledgerRecords.contactId})`;

/**
 * One row per (record, category) — a record with two lines on the same
 * category is one precedent, not two — over records that happened.
 */
function loadRows(
  db: LedgerDb,
  contactIds: number[] | undefined,
): HistoryRow[] {
  const conditions: SQL[] = [notVoided(ledgerRecords.id)];
  if (contactIds !== undefined)
    conditions.push(inArray(recordContact, contactIds));
  return db
    .selectDistinct({
      recordId: ledgerRecords.id,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      contactId: recordContact,
      accountId: accounts.id,
      accountName: accounts.name,
      accountType: accounts.type,
      accountSubType: accounts.subType,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(and(...conditions))
    .all()
    .filter((row) =>
      isCategoryAccount({
        type: row.accountType as AccountTypeCode,
        subType: row.accountSubType as AccountSubTypeCode | null,
      }),
    )
    .map((row) => ({
      recordId: row.recordId,
      date: row.date,
      description: row.description,
      contactId: row.contactId,
      accountId: row.accountId,
      accountName: row.accountName,
      accountType: row.accountType as AccountTypeCode,
    }));
}

type Hit = { row: HistoryRow; overlap: number };

/** Group matching rows by category, rank the groups, keep the best `limit`. */
function summarise(
  hits: Hit[],
  limit: number,
  uncategorisedIds: Set<number>,
  withOverlap: boolean,
): CategoryHistoryRow[] {
  const byAccount = new Map<number, Hit[]>();
  for (const hit of hits) {
    const group = byAccount.get(hit.row.accountId);
    if (group) group.push(hit);
    else byAccount.set(hit.row.accountId, [hit]);
  }
  const groups = [...byAccount.values()].map((group) => {
    const best = [...group].sort(
      (a, b) =>
        b.overlap - a.overlap ||
        b.row.date.localeCompare(a.row.date) ||
        b.row.recordId - a.row.recordId,
    );
    const first = best[0].row;
    return {
      overlap: best[0].overlap,
      row: {
        categoryAccountId: first.accountId,
        name: first.accountName,
        type: first.accountType,
        isUncategorisedDefault: uncategorisedIds.has(first.accountId),
        count: group.length,
        lastDate: group.reduce(
          (max, hit) => (hit.row.date > max ? hit.row.date : max),
          first.date,
        ),
        examples: best.slice(0, CATEGORY_HISTORY_MAX_EXAMPLES).map((hit) => ({
          recordId: hit.row.recordId,
          date: hit.row.date,
          description: hit.row.description,
        })),
      } satisfies CategoryHistoryRow,
    };
  });
  // Best word overlap first (always 0 for a contact), then the most used, then
  // the most recent; name and id only so the order is stable.
  groups.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      b.row.count - a.row.count ||
      b.row.lastDate.localeCompare(a.row.lastDate) ||
      a.row.name.localeCompare(b.row.name) ||
      a.row.categoryAccountId - b.row.categoryAccountId,
  );
  return groups
    .slice(0, limit)
    .map(({ overlap, row }) => (withOverlap ? { ...row, overlap } : row));
}

/**
 * Past categories for each record in `recordIds`, or once for a contact and/or
 * a description. When both are given, the record entries come first and the
 * contact/description entry last. Read-only.
 */
export function categoryHistory(
  db: LedgerDb,
  input: CategoryHistoryInput,
): CategoryHistoryResult {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)),
  );
  const requested = [...new Set(input.recordIds ?? [])];
  const wanted = requested.slice(0, CATEGORY_HISTORY_MAX_RECORDS);
  const skippedRecordIds = requested.slice(CATEGORY_HISTORY_MAX_RECORDS);

  const own = new Map(
    (wanted.length === 0
      ? []
      : db
          .select({
            id: ledgerRecords.id,
            description: ledgerRecords.description,
            contactId: recordContact,
          })
          .from(ledgerRecords)
          .where(inArray(ledgerRecords.id, wanted))
          .all()
    ).map((row) => [row.id, row]),
  );
  const missingRecordIds = wanted.filter((id) => !own.has(id));

  type Subject = {
    recordId: number | null;
    contactId: number | null;
    description: string;
  };
  const subjects: Subject[] = wanted.flatMap((id) => {
    const row = own.get(id);
    return row
      ? [
          {
            recordId: id,
            contactId: row.contactId,
            description: row.description,
          },
        ]
      : [];
  });
  if (input.contactId !== undefined || input.description !== undefined)
    subjects.push({
      recordId: null,
      contactId: input.contactId ?? null,
      description: input.description ?? "",
    });

  const subjectTokens = subjects.map(
    (s) => new Set(descriptionTokens(s.description)),
  );
  const wantsSimilar = subjectTokens.some((tokens) => tokens.size > 0);
  const contactIds = [
    ...new Set(
      subjects
        .map((s) => s.contactId)
        .filter((id): id is number => id !== null),
    ),
  ];
  if (!wantsSimilar && contactIds.length === 0)
    return {
      entries: subjects.map((s) => ({
        recordId: s.recordId,
        contactId: s.contactId,
        description: s.description,
        byContact: [],
        similarDescriptions: [],
      })),
      missingRecordIds,
      skippedRecordIds,
    };

  // A description match has to look at every record, so one read of all of
  // them serves both lists; a contact alone reads only that contact's.
  const rows = loadRows(db, wantsSimilar ? undefined : contactIds);
  const uncategorisedIds = new Set(
    db
      .select({ accountId: accountDefaults.accountId })
      .from(accountDefaults)
      .where(
        inArray(accountDefaults.purpose, [
          DefaultAccountPurpose.UncategorisedExpense,
          DefaultAccountPurpose.UncategorisedIncome,
        ]),
      )
      .all()
      .map((row) => row.accountId),
  );
  const tokensByRecord = new Map<number, Set<string>>();
  const tokensOf = (row: HistoryRow) => {
    let tokens = tokensByRecord.get(row.recordId);
    if (!tokens) {
      tokens = new Set(descriptionTokens(row.description));
      tokensByRecord.set(row.recordId, tokens);
    }
    return tokens;
  };

  const entries = subjects.map((subject, index): CategoryHistoryEntry => {
    const byContact: Hit[] = [];
    const similar: Hit[] = [];
    const subjectWords = subjectTokens[index];
    for (const row of rows) {
      // A record is never its own precedent.
      if (row.recordId === subject.recordId) continue;
      if (subject.contactId !== null && row.contactId === subject.contactId)
        byContact.push({ row, overlap: 0 });
      if (subjectWords.size === 0) continue;
      let overlap = 0;
      for (const token of tokensOf(row)) if (subjectWords.has(token)) overlap++;
      if (overlap > 0) similar.push({ row, overlap });
    }
    return {
      recordId: subject.recordId,
      contactId: subject.contactId,
      description: subject.description,
      byContact: summarise(byContact, limit, uncategorisedIds, false),
      similarDescriptions: summarise(similar, limit, uncategorisedIds, true),
    };
  });
  return { entries, missingRecordIds, skippedRecordIds };
}
