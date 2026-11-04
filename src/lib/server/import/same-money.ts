/**
 * The overlap guard (006 FR-066): a note on an item that may describe money
 * another document already brought into the books.
 *
 * A marketplace's wallet report lists every order paid into the wallet, and
 * the same marketplace's income statement sums the same sales in its
 * summary. Importing both counts the sales twice. A section can name the
 * profiles whose records describe the same money (`sameMoneyAs`), and an
 * income or expense item of that section gets a review note when records made
 * with one of them already cover its month. The note holds the item back from
 * "Confirm all" until the reviewer has looked, as any review note does.
 *
 * **Why the month, not the day.** A summary's records all carry one date, the
 * statement's, while the wallet report's rows carry the day of each order, so
 * the two never share a day even when they hold the same sales. Marketplace
 * statements are monthly, so the month is the period they cover.
 *
 * Only records that exist count: a document read but not yet confirmed has
 * made none, and a record deleted since is gone. Transfers are never noted
 * (FR-066): moving money to the bank repeats no sale.
 *
 * **Where the profile of a record is kept.** Confirming an item writes the
 * profile it was read with to `import_record_profiles` (`rememberProfile`).
 * The queue row and its items say the same, but clearing the import history
 * deletes them while the records stay, and the guard would then see no
 * records at all. They are still asked, for records confirmed before that
 * table existed.
 */

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { DocumentType, LedgerRecordKind } from "$lib/enums.js";
import { ImportReadAs, ImportReadHow } from "$lib/import-reading.js";
import {
  importItems,
  importQueue,
  importRecordProfiles,
  ledgerRecords,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import {
  deletedProfileName,
  getImportProfile,
} from "../services/import-profiles.js";
import { notVoided } from "../queries/void-state.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09" as "September 2026". */
function monthName(month: string): string {
  const [year, number] = month.split("-");
  return `${MONTHS[Number(number) - 1] ?? number} ${year}`;
}

/**
 * The months, as `YYYY-MM`, of the income and expense records made from
 * documents read with this saved profile, chosen at upload or found by
 * Auto-detect. `exceptJobId` is the document being read, which has made none
 * yet but is left out all the same.
 */
export function monthsCoveredBy(
  db: LedgerDb,
  profileId: number,
  exceptJobId: string,
): Set<string> {
  const readWith = and(
    eq(importQueue.profileId, String(profileId)),
    or(
      eq(importQueue.readAs, ImportReadAs.Profile),
      and(
        eq(importQueue.readAs, ImportReadAs.Auto),
        eq(importQueue.readHow, ImportReadHow.Detected),
      ),
    ),
    ne(importQueue.id, exceptJobId),
  );
  // A voided record never happened, so it does not cover its month.
  const moneyKinds = and(
    inArray(ledgerRecords.kind, [
      LedgerRecordKind.Expense,
      LedgerRecordKind.Income,
    ]),
    notVoided(ledgerRecords.id),
  );
  const month = sql<string>`substr(${ledgerRecords.date}, 1, 7)`;
  // A group's records are its items' results; a reading that found one item
  // made its record from the queue row itself.
  const fromItems = db
    .selectDistinct({ month })
    .from(importItems)
    .innerJoin(importQueue, eq(importQueue.id, importItems.jobId))
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, importItems.resultId))
    .where(and(readWith, moneyKinds))
    .all();
  const fromCards = db
    .selectDistinct({ month })
    .from(importQueue)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, importQueue.resultId))
    .where(and(readWith, moneyKinds))
    .all();
  // What the import history no longer holds once it is cleared. The record
  // of the document being read is not here: it has made none yet.
  const remembered = db
    .selectDistinct({ month })
    .from(importRecordProfiles)
    .innerJoin(
      ledgerRecords,
      eq(ledgerRecords.id, importRecordProfiles.recordId),
    )
    .where(and(eq(importRecordProfiles.profileId, profileId), moneyKinds))
    .all();
  return new Set(
    [...fromItems, ...fromCards, ...remembered].map((row) => row.month),
  );
}

/**
 * The saved profile a queue row was read with, chosen at upload or found by
 * Auto-detect, or null for any other reading. The same rule as
 * `monthsCoveredBy`'s.
 */
function profileReadWith(row: {
  profileId: string | null;
  readAs: string | null;
  readHow: string | null;
}): number | null {
  const withProfile =
    row.readAs === ImportReadAs.Profile ||
    (row.readAs === ImportReadAs.Auto &&
      row.readHow === ImportReadHow.Detected);
  if (!withProfile || row.profileId == null) return null;
  const id = Number(row.profileId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Keeps, beside a record a document's reading has just made, the saved
 * profile it was read with, so the guard still finds the record after the
 * import history is cleared. Nothing is kept for a reading with no saved
 * profile, such as every receipt (FR-004). Runs in the confirm's transaction.
 */
export function rememberProfile(
  db: LedgerDb,
  jobId: string,
  recordId: number,
): void {
  const row = db
    .select({
      profileId: importQueue.profileId,
      readAs: importQueue.readAs,
      readHow: importQueue.readHow,
    })
    .from(importQueue)
    .where(eq(importQueue.id, jobId))
    .get();
  const profileId = row ? profileReadWith(row) : null;
  if (profileId == null) return;
  db.insert(importRecordProfiles)
    .values({ recordId, profileId })
    .onConflictDoNothing()
    .run();
}

/** What the note says, naming the other profile and the month. */
export function sameMoneyNote(profileName: string, month: string): string {
  return `Records imported with “${profileName}” already cover ${monthName(month)}, and that profile describes the same money. Check that this line is not counted twice before you confirm it.`;
}

/** What the guard needs to know about one item. */
export interface SameMoneyItem {
  sectionKey: string;
  /** Its DocumentType code. Only an income or an expense is noted. */
  kind: number;
  date: string | null;
}

/**
 * The note for each item, in order, or null. `sections` are the reading's
 * sections, each with the profiles it names as the same money.
 */
export function sameMoneyNotes(
  db: LedgerDb,
  items: readonly SameMoneyItem[],
  sections: readonly { key: string; sameMoneyAs?: readonly number[] }[],
  exceptJobId: string,
): (string | null)[] {
  const named = new Map(
    sections
      .filter((section) => section.sameMoneyAs?.length)
      .map((section) => [section.key, section.sameMoneyAs!]),
  );
  if (named.size === 0) return items.map(() => null);

  const months = new Map<number, Set<string>>();
  const names = new Map<number, string>();
  const covered = (id: number) => {
    let found = months.get(id);
    if (!found) {
      found = monthsCoveredBy(db, id, exceptJobId);
      months.set(id, found);
    }
    return found;
  };
  const nameOf = (id: number) => {
    let name = names.get(id);
    if (name === undefined) {
      name =
        getImportProfile(db, id)?.name ??
        deletedProfileName(db, id) ??
        "another import profile";
      names.set(id, name);
    }
    return name;
  };

  return items.map((item) => {
    if (item.kind !== DocumentType.Income && item.kind !== DocumentType.Expense)
      return null;
    const others = named.get(item.sectionKey);
    if (!others || !item.date) return null;
    const month = item.date.slice(0, 7);
    const other = others.find((id) => covered(id).has(month));
    return other === undefined ? null : sameMoneyNote(nameOf(other), month);
  });
}
