import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  AccountTypeDisplayLabels,
  DefaultAccountPurpose,
  LedgerRecordKindDisplayLabels,
  RoleLabels,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import {
  accounts,
  bankStatementLines,
  bankStatements,
  contacts,
  ledgerMovements,
  ledgerRecords,
  settlements,
} from "../db/schema.js";
import { formatMinor } from "../ledger/money.js";
import { outstandingOf } from "../ledger/settlement-rules.js";
import type { LedgerDb } from "../ledger/types.js";
import { activeAllocation } from "../queries/allocation-state.js";
import { normalizeName, rolesForContacts } from "../queries/contacts.js";
import {
  correctionMovementFor,
  groupAllocationsForPayment,
} from "../queries/reimbursement-groups.js";
import { settledMinorFor } from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import type { AppContext } from "./context.js";

/**
 * What an agent or a person typed, turned into the one row it names.
 *
 * Every resolver here is a plain read of `ctx.db`: it writes nothing and
 * **asks for no permission. The caller checks the read permission for the
 * kind of item first** (`records.read`, `accounts.read`, `contacts.read`,
 * `reconciliation.read`), as it would before reading the item any other way.
 * A resolver called first would tell a caller without that permission which
 * names and numbers exist.
 *
 * - **An exact reference resolves**: an id, a record number, an account code,
 *   or a name that is equal once case, spacing and punctuation are ignored
 *   (`normalizeName`). A number is always an id. A string is an id only where
 *   it is written as one: `#42` for a record or a contact, `L123` / `S7` for a
 *   bank line or a statement.
 * - **Anything else is a miss**: `not_found`, or `ambiguous` when more than one
 *   item matches exactly. A miss carries at most five candidates, best first,
 *   for the agent or the person to choose from. **A close match is never used
 *   on its own.**
 * - A miss has the shape `resolveError` (`mcp/resolve.ts`) takes, so a tool
 *   passes it straight through. `message` says why, including what "no match"
 *   alone would hide: an archived account, a code and a name of two accounts.
 *
 * Movement and settlement ids stay on the server. The resolvers that return
 * one (`resolveOpenItem`, `resolvePaymentMovement`, `resolveSettlement`) take
 * records, and the candidates of their misses name accounts and records.
 */

/** One item a miss offers instead. Shaped for `resolveError`'s candidates. */
export type Candidate = {
  id: number;
  /** What the item is called, in a form the resolver accepts back where one exists: `"5100 Advertising"`. */
  name: string;
  /** What tells it apart from the others: a type, a date and kind, roles, an amount. */
  detail?: string;
};

export type Resolved<T> =
  | { ok: true; id: number; value: T }
  | {
      ok: false;
      kind: "not_found" | "ambiguous";
      /** Why, in a sentence or two, for whoever reads the error. */
      message: string;
      /** At most five, best first. Possibly none. */
      candidates: Candidate[];
    };

/** The most candidates a miss carries: what `resolveError` lists. */
const CANDIDATE_LIMIT = 5;
/** Below this, a name is too unlike the reference to offer. */
const MIN_SIMILARITY = 0.3;

function found<T>(id: number, value: T): Resolved<T> {
  return { ok: true, id, value };
}

/** Each candidate once, in the order given, at most five. */
function notFound<T>(
  message: string,
  candidates: Candidate[] = [],
): Resolved<T> {
  const seen = new Set<number>();
  return {
    ok: false,
    kind: "not_found",
    message,
    candidates: candidates
      .filter((candidate) => !seen.has(candidate.id) && seen.add(candidate.id))
      .slice(0, CANDIDATE_LIMIT),
  };
}

function ambiguous<T>(message: string, candidates: Candidate[]): Resolved<T> {
  return {
    ok: false,
    kind: "ambiguous",
    message,
    candidates: candidates.slice(0, CANDIDATE_LIMIT),
  };
}

const isId = (value: number) => Number.isSafeInteger(value) && value > 0;

// --- likeness --------------------------------------------------------------

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * How alike two names are, from 0 to 1, given both through `normalizeName`:
 * the better of the words they share (the measure `resolveContactCandidates`
 * uses) and the three-letter runs they share, which a typo leaves mostly
 * intact. For ranking candidates only. Nothing resolves on it.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(
    dice(new Set(a.split(" ")), new Set(b.split(" "))),
    dice(trigrams(a), trigrams(b)),
  );
}

/** The items whose name is most like `wanted` (already normalised), best first. */
function closest<T>(
  items: readonly T[],
  wanted: string,
  nameOf: (item: T) => string,
): T[] {
  if (!wanted) return [];
  return items
    .map((item) => ({
      item,
      score: similarity(wanted, normalizeName(nameOf(item))),
    }))
    .filter((entry) => entry.score >= MIN_SIMILARITY)
    .sort((x, y) => y.score - x.score)
    .slice(0, CANDIDATE_LIMIT)
    .map((entry) => entry.item);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

// --- records ---------------------------------------------------------------

/** A record, as much as a reference needs. `getRecord` has the rest. */
export type RecordBrief = {
  id: number;
  kind: LedgerRecordKindCode;
  date: string;
  recordNumber: string | null;
  description: string;
  contactId: number | null;
  /** Set on a void's reversal: the record it voids. */
  reversesRecordId: number | null;
};

function recordBriefs(db: LedgerDb, where: SQL, limit = -1): RecordBrief[] {
  return db
    .select({
      id: ledgerRecords.id,
      kind: ledgerRecords.kind,
      date: ledgerRecords.date,
      recordNumber: ledgerRecords.recordNumber,
      description: ledgerRecords.description,
      contactId: ledgerRecords.contactId,
      reversesRecordId: ledgerRecords.reversesRecordId,
    })
    .from(ledgerRecords)
    .where(where)
    .orderBy(desc(ledgerRecords.id))
    .limit(limit)
    .all()
    .map((row) => ({ ...row, kind: row.kind as LedgerRecordKindCode }));
}

function recordById(db: LedgerDb, id: number): RecordBrief | null {
  return isId(id)
    ? (recordBriefs(db, eq(ledgerRecords.id, id), 1)[0] ?? null)
    : null;
}

/** A record as messages name it: its number, or `#id` when it has none (as a void's description does). */
function recordName(record: RecordBrief): string {
  return record.recordNumber ?? `#${record.id}`;
}

function recordCandidate(record: RecordBrief): Candidate {
  const kind = LedgerRecordKindDisplayLabels[record.kind] ?? "Record";
  const about =
    record.description.length > 60
      ? `${record.description.slice(0, 59)}…`
      : record.description;
  return {
    id: record.id,
    name: recordName(record),
    detail: `${record.date} ${kind.toLowerCase()}${about ? `: ${about}` : ""}`,
  };
}

function recordByIdRef(db: LedgerDb, id: number): Resolved<RecordBrief> {
  if (!isId(id))
    return notFound(
      `${id} is not a record id. An id is a whole number above zero.`,
    );
  const record = recordById(db, id);
  return record
    ? found(record.id, record)
    : notFound(`No record has id ${id}.`);
}

/**
 * Records numbered like `text`: the same letters in front and, when `text`
 * has one, the same year. "EX20260312-004" offers the other EX…2026… numbers,
 * nearest first, whatever the numbering template. Nothing is offered for a
 * number with no letters in front.
 */
function numberNeighbours(db: LedgerDb, text: string): RecordBrief[] {
  const letters = /^[A-Za-z]+/.exec(text)?.[0];
  if (!letters) return [];
  const year = /(?:19|20)\d{2}/.exec(text.slice(letters.length))?.[0];
  // Letters and digits only, so neither pattern needs escaping. LIKE ignores
  // ASCII case, so a lower-case reference still finds its neighbours.
  const sameLetters = sql`${ledgerRecords.recordNumber} LIKE ${`${letters}%`}`;
  const rows = recordBriefs(
    db,
    year
      ? and(
          sameLetters,
          sql`${ledgerRecords.recordNumber} LIKE ${`%${year}%`}`,
        )!
      : sameLetters,
    500,
  );
  const wanted = text.toUpperCase();
  return rows
    .map((record) => ({
      record,
      distance: editDistance(wanted, (record.recordNumber ?? "").toUpperCase()),
    }))
    .sort((x, y) => x.distance - y.distance)
    .slice(0, CANDIDATE_LIMIT)
    .map((entry) => entry.record);
}

/**
 * A record by its id (a number, or `"#42"`) or its number (`"EX20260312-001"`,
 * in any case). A number that is not found offers records numbered alike: the
 * same letters in front and the same year.
 */
export function resolveRecord(
  ctx: AppContext,
  ref: number | string,
): Resolved<RecordBrief> {
  if (typeof ref === "number") return recordByIdRef(ctx.db, ref);
  const text = ref.trim();
  if (!text)
    return notFound(
      "The record reference is empty. Send the record's id or its number.",
    );
  const tagged = /^#(\d+)$/.exec(text);
  if (tagged) return recordByIdRef(ctx.db, Number(tagged[1]));

  const exact = recordBriefs(
    ctx.db,
    eq(ledgerRecords.recordNumber, text),
    1,
  )[0];
  if (exact) return found(exact.id, exact);
  const folded = recordBriefs(
    ctx.db,
    sql`lower(${ledgerRecords.recordNumber}) = lower(${text})`,
    CANDIDATE_LIMIT,
  );
  if (folded.length === 1) return found(folded[0].id, folded[0]);
  if (folded.length > 1)
    return ambiguous(
      `"${text}" matches ${folded.length} record numbers that differ only in case.`,
      folded.map(recordCandidate),
    );

  // Digits alone are a number, never an id; the record with that id is
  // offered all the same, in case an id was sent as a string.
  const asId = /^\d+$/.test(text) ? recordById(ctx.db, Number(text)) : null;
  return notFound(
    `No record is numbered "${text}".${asId ? ` Record id ${text} is ${recordName(asId)}: send the id as a number to use it.` : ""}`,
    [...(asId ? [asId] : []), ...numberNeighbours(ctx.db, text)].map(
      recordCandidate,
    ),
  );
}

// --- accounts --------------------------------------------------------------

/** An account, as much as a reference needs. `getAccount` has the rest. */
export type AccountBrief = {
  id: number;
  /** As the chart shows it: an account saved without a code shows its id (`listAccounts`). */
  code: number;
  name: string;
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
  archived: boolean;
};

export type AccountRefOptions = {
  /** Only accounts of these types. */
  types?: readonly AccountTypeCode[];
  /**
   * Only accounts this accepts, for a kind a type cannot say on its own: pass
   * `isMoneyPotAccount`, `isCategoryAccount` or `isEquipmentAccount`
   * (`ledger/account-type.ts`). There is no role filter: `accounts.role` is a
   * retired column, inert for assets.
   */
  where?: (account: AccountBrief) => boolean;
  /** What `types` and `where` ask for, for the message when they exclude the match: `"a money account"`. */
  wanted?: string;
  /** Archived accounts too. Off by default: an archived account is not offered for new entries. */
  includeArchived?: boolean;
};

function accountName(account: { code: number; name: string }): string {
  return `${account.code} ${account.name}`;
}

function typeWords(type: AccountTypeCode): string {
  const word = (AccountTypeDisplayLabels[type] ?? "other").toLowerCase();
  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word} account`;
}

function accountCandidate(account: AccountBrief): Candidate {
  const type = AccountTypeDisplayLabels[account.type] ?? "Account";
  return {
    id: account.id,
    name: accountName(account),
    detail: account.archived ? `${type}, archived` : type,
  };
}

/** Accounts whose code starts as `digits` does, nearest first: "5101" offers 5100, 5102, 5110. */
function nearbyCodes(
  pool: readonly AccountBrief[],
  digits: string,
): AccountBrief[] {
  const wanted = Number(digits);
  const lead = digits.slice(0, 2);
  return pool
    .filter((account) => String(account.code).startsWith(lead))
    .sort(
      (x, y) =>
        Math.abs(x.code - wanted) - Math.abs(y.code - wanted) ||
        x.code - y.code,
    )
    .slice(0, CANDIDATE_LIMIT);
}

/** `"5100 Advertising"`, and the screens' `"5100 — Advertising"`. */
const CODE_AND_NAME = /^(\d+)(?:\s*[-–—:|·]\s*|\s+)(\S.*)$/u;

/**
 * An account by its id (a number), its code (`"5100"`), its name
 * (`"Advertising"`, ignoring case, spacing and punctuation) or both
 * (`"5100 Advertising"`, which must be one account's code and name).
 *
 * - More than one account with the name is `ambiguous`.
 * - A merged account stands for the account it was merged into, as its old
 *   links do.
 * - `opts` narrows what may be used. An account it excludes is never
 *   returned, and when it was the only match the message says why: archived,
 *   or of another kind.
 */
export function resolveAccount(
  ctx: AppContext,
  ref: number | string,
  opts: AccountRefOptions = {},
): Resolved<AccountBrief> {
  const rows = ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subType: accounts.subType,
      archivedAt: accounts.archivedAt,
      mergedIntoAccountId: accounts.mergedIntoAccountId,
    })
    .from(accounts)
    .orderBy(asc(accounts.code), asc(accounts.id))
    .all();
  const own = new Map<number, AccountBrief>(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        code: row.code ?? row.id,
        name: row.name,
        type: row.type as AccountTypeCode,
        subType: row.subType as AccountSubTypeCode | null,
        archived: row.archivedAt !== null,
      },
    ]),
  );
  const mergedInto = new Map(
    rows.map((row) => [row.id, row.mergedIntoAccountId] as const),
  );
  const canonical = (id: number): AccountBrief => {
    const merged = mergedInto.get(id);
    return (merged != null ? own.get(merged) : undefined) ?? own.get(id)!;
  };
  const usable = (account: AccountBrief) =>
    (opts.includeArchived === true || !account.archived) &&
    (opts.types === undefined || opts.types.includes(account.type)) &&
    (opts.where === undefined || opts.where(account));
  // What candidates come from: the chart as it is now, narrowed by `opts`.
  const pool = rows
    .filter((row) => row.mergedIntoAccountId == null)
    .map((row) => own.get(row.id)!)
    .filter(usable);

  const exclusion = (account: AccountBrief) =>
    account.archived && opts.includeArchived !== true
      ? `Account ${accountName(account)} is archived, so it is not offered for new entries.`
      : `Account ${accountName(account)} is ${typeWords(account.type)}${opts.wanted ? `, and this needs ${opts.wanted}` : ", which cannot be used here"}.`;

  /** The exact matches, after following merges: one usable account resolves. */
  const decide = (
    matches: AccountBrief[],
    what: string,
  ): Resolved<AccountBrief> => {
    const unique = [...new Map(matches.map((a) => [a.id, a])).values()];
    const fits = unique.filter(usable);
    if (fits.length === 1) return found(fits[0].id, fits[0]);
    if (fits.length > 1)
      return ambiguous(
        `${what} matches ${fits.length} accounts.`,
        fits.map(accountCandidate),
      );
    return notFound(
      unique.slice(0, 3).map(exclusion).join(" "),
      closest(pool, normalizeName(unique[0].name), (a) => a.name).map(
        accountCandidate,
      ),
    );
  };
  const withCode = (code: number) =>
    rows.filter((row) => (row.code ?? row.id) === code);

  if (typeof ref === "number") {
    if (!isId(ref))
      return notFound(
        `${ref} is not an account id. An id is a whole number above zero.`,
      );
    if (own.has(ref)) return decide([canonical(ref)], `Account id ${ref}`);
    const coded = withCode(ref)
      .filter((row) => row.mergedIntoAccountId == null)
      .map((row) => own.get(row.id)!)
      .find(usable);
    return notFound(
      `No account has id ${ref}.${coded ? ` Account ${accountName(coded)} has the code ${ref}: send "${ref}" as a string to use a code.` : ""}`,
      coded ? [accountCandidate(coded)] : [],
    );
  }

  const text = ref.trim();
  if (!text)
    return notFound(
      "The account reference is empty. Send the account's id, code or name.",
    );

  if (/^\d+$/.test(text)) {
    const coded = withCode(Number(text));
    if (coded.length)
      return decide(
        coded.map((row) => canonical(row.id)),
        `Code ${text}`,
      );
    // Digits alone are a code, never an id; the account with that id is
    // offered all the same, in case an id was sent as a string.
    const asId = own.has(Number(text)) ? canonical(Number(text)) : undefined;
    const offered = asId && usable(asId) ? asId : undefined;
    return notFound(
      `No account has the code ${text}.${offered ? ` Account id ${text} is ${accountName(offered)}: send the id as a number to use it.` : ""}`,
      [...(offered ? [offered] : []), ...nearbyCodes(pool, text)].map(
        accountCandidate,
      ),
    );
  }

  const wanted = normalizeName(text);
  const named = wanted
    ? rows
        .filter((row) => normalizeName(row.name) === wanted)
        .map((row) => canonical(row.id))
    : [];
  if (named.length) return decide(named, `"${text}"`);

  const pair = CODE_AND_NAME.exec(text);
  if (pair) {
    const nameText = pair[2].trim();
    const nameWanted = normalizeName(nameText);
    const coded = withCode(Number(pair[1]))[0];
    if (coded && (!nameWanted || normalizeName(coded.name) === nameWanted))
      return decide([canonical(coded.id)], `"${text}"`);
    const sameName = rows
      .filter((row) => normalizeName(row.name) === nameWanted)
      .map((row) => canonical(row.id));
    return notFound(
      coded
        ? `Code ${pair[1]} is ${accountName(own.get(coded.id)!)}, not "${nameText}". The code and the name must be of the same account.`
        : `No account has the code ${pair[1]}. The code and the name must be of the same account.`,
      [
        ...(coded ? [canonical(coded.id)] : []),
        ...sameName,
        ...closest(pool, nameWanted, (a) => a.name),
      ]
        .filter(usable)
        .map(accountCandidate),
    );
  }

  return notFound(
    `No account is named "${text}".`,
    closest(pool, wanted, (a) => a.name).map(accountCandidate),
  );
}

// --- contacts --------------------------------------------------------------

/** A contact, as much as a reference needs. */
export type ContactBrief = {
  id: number;
  legalName: string;
  /** `EntityType` code. */
  entityType: number;
};

type ContactRow = ContactBrief & { registrationNo: string | null };

function contactBrief(row: ContactRow): ContactBrief {
  return { id: row.id, legalName: row.legalName, entityType: row.entityType };
}

/** Each contact once, at most five, with its roles and registration number to tell namesakes apart. */
function contactCandidates(db: LedgerDb, rows: ContactRow[]): Candidate[] {
  const seen = new Set<number>();
  const chosen = rows
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .slice(0, CANDIDATE_LIMIT);
  const roles = rolesForContacts(
    db,
    chosen.map((row) => row.id),
  );
  return chosen.map((row) => {
    const detail = [
      (roles[row.id] ?? [])
        .map((role) => RoleLabels[role])
        .filter(Boolean)
        .join(", "),
      row.registrationNo ? `reg. ${row.registrationNo}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return {
      id: row.id,
      name: row.legalName,
      ...(detail ? { detail } : {}),
    };
  });
}

/**
 * A contact by its id (a number, or `"#42"`) or its exact name, ignoring case,
 * spacing and punctuation (`"acme sdn. bhd."` is "Acme Sdn Bhd"). `"Name #42"`
 * is both, and they must agree. A name two contacts share is `ambiguous`.
 * **A close name is only ever a candidate.**
 */
export function resolveContact(
  ctx: AppContext,
  ref: number | string,
): Resolved<ContactBrief> {
  const columns = {
    id: contacts.id,
    legalName: contacts.legalName,
    entityType: contacts.entityType,
    registrationNo: contacts.registrationNo,
  };
  const byId = (id: number): Resolved<ContactBrief> => {
    if (!isId(id))
      return notFound(
        `${id} is not a contact id. An id is a whole number above zero.`,
      );
    const contact = ctx.db
      .select(columns)
      .from(contacts)
      .where(eq(contacts.id, id))
      .get();
    return contact
      ? found(contact.id, contactBrief(contact))
      : notFound(`No contact has id ${id}.`);
  };
  if (typeof ref === "number") return byId(ref);
  const text = ref.trim();
  if (!text)
    return notFound(
      "The contact reference is empty. Send the contact's id or its exact name.",
    );
  // `#42` alone is always the id, even beside a contact named "42".
  const bare = /^#(\d+)$/.exec(text);
  if (bare) return byId(Number(bare[1]));

  // Names are compared after `normalizeName`, which SQL cannot do, so the
  // directory is read once and matched here.
  const all: ContactRow[] = ctx.db
    .select(columns)
    .from(contacts)
    .orderBy(asc(contacts.id))
    .all();
  const named = (wanted: string) =>
    wanted ? all.filter((row) => normalizeName(row.legalName) === wanted) : [];

  const wanted = normalizeName(text);
  const exact = named(wanted);
  if (exact.length === 1) return found(exact[0].id, contactBrief(exact[0]));
  if (exact.length > 1)
    return ambiguous(
      `"${text}" is the name of ${exact.length} contacts.`,
      contactCandidates(ctx.db, exact),
    );

  const tagged = /^(.*?)\s*#(\d+)$/.exec(text);
  if (tagged) {
    const id = Number(tagged[2]);
    const nameText = tagged[1].trim();
    const nameWanted = normalizeName(nameText);
    const contact = isId(id) ? all.find((row) => row.id === id) : undefined;
    if (
      contact &&
      (!nameWanted || normalizeName(contact.legalName) === nameWanted)
    )
      return found(contact.id, contactBrief(contact));
    return notFound(
      contact
        ? `Contact #${id} is "${contact.legalName}", not "${nameText}". The name and the id must be of the same contact.`
        : `No contact has id ${tagged[2]}.`,
      contactCandidates(ctx.db, [
        ...(contact ? [contact] : []),
        ...named(nameWanted),
        ...closest(all, nameWanted, (row) => row.legalName),
      ]),
    );
  }

  return notFound(
    `No contact is named "${text}".`,
    contactCandidates(
      ctx.db,
      closest(all, wanted, (row) => row.legalName),
    ),
  );
}

// --- what a payment settles ------------------------------------------------

/**
 * A record's line on a control account (the saved receivable, payable or
 * reimbursements-payable account): the side a settlement links. On an owed
 * line `outstandingMinor` is what is still owed; on a payment's line it is
 * what is not yet applied.
 */
export type ControlLine = {
  movementId: number;
  recordId: number;
  accountId: number;
  /** Signed, as stored: positive is value into the account. */
  amountMinor: number;
  settledMinor: number;
  outstandingMinor: number;
  /** The record's contact. */
  contactId: number | null;
};

/** Where settlements live: the accounts `listOutstanding` reads. */
function controlAccountIds(db: LedgerDb): number[] {
  return [
    DefaultAccountPurpose.Receivable,
    DefaultAccountPurpose.Payable,
    DefaultAccountPurpose.ReimbursementsPayable,
  ]
    .map((purpose) => accountDefaultId(db, purpose))
    .filter((id): id is number => id !== null);
}

function controlLines(db: LedgerDb, recordId: number): ControlLine[] {
  const accountIds = controlAccountIds(db);
  if (!accountIds.length) return [];
  const rows = db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerMovements.recordId,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      contactId: ledgerRecords.contactId,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(
      and(
        eq(ledgerMovements.recordId, recordId),
        inArray(ledgerMovements.accountId, accountIds),
      ),
    )
    .orderBy(asc(ledgerMovements.sortOrder), asc(ledgerMovements.id))
    .all();
  const settled = settledMinorFor(
    db,
    rows.map((row) => row.movementId),
  );
  return rows.map((row) => {
    const settledMinor = settled.get(row.movementId) ?? 0;
    return {
      ...row,
      settledMinor,
      outstandingMinor: outstandingOf({
        movementId: row.movementId,
        amountMinor: row.amountMinor,
        settledMinor,
      }),
    };
  });
}

function accountNames(db: LedgerDb, ids: number[]): Map<number, string> {
  if (!ids.length) return new Map();
  return new Map<number, string>(
    db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(inArray(accounts.id, [...new Set(ids)]))
      .all()
      .map((row) => [
        row.id,
        accountName({ code: row.code ?? row.id, name: row.name }),
      ]),
  );
}

/** Lines as candidates: each by its account, the one thing that tells them apart. */
function lineCandidates(db: LedgerDb, lines: ControlLine[]): Candidate[] {
  const names = accountNames(
    db,
    lines.map((line) => line.accountId),
  );
  return lines.map((line) => ({
    id: line.accountId,
    name: names.get(line.accountId) ?? `Account ${line.accountId}`,
    detail: `${formatMinor(Math.abs(line.amountMinor))}, ${formatMinor(line.outstandingMinor)} outstanding`,
  }));
}

/** The one control line of a record, or the one on `accountId`. */
function pickLine(
  db: LedgerDb,
  record: RecordBrief,
  accountId: number | undefined,
  words: { none: string; several: string },
): Resolved<ControlLine> {
  const all = controlLines(db, record.id);
  const lines =
    accountId === undefined
      ? all
      : all.filter((line) => line.accountId === accountId);
  if (lines.length === 1) return found(lines[0].movementId, lines[0]);
  if (lines.length > 1)
    return ambiguous(
      `Record ${recordName(record)} ${words.several}`,
      lineCandidates(db, lines),
    );
  if (all.length)
    return notFound(
      `Record ${recordName(record)} has no such line on ${accountNames(db, [accountId!]).get(accountId!) ?? `account ${accountId}`}.`,
      lineCandidates(db, all),
    );
  return notFound(`Record ${recordName(record)} ${words.none}`);
}

/**
 * The line of a record that a payment settles: its one line on the
 * receivable, payable or reimbursements-payable account, the line
 * `listOutstanding` offers. `opts.accountId` picks one when the record has
 * several; the candidates of that `ambiguous` are the lines' accounts.
 *
 * Only the line is found. A record already paid, or voided, still resolves,
 * and the operation that uses the line refuses it with its own reason.
 */
export function resolveOpenItem(
  ctx: AppContext,
  recordId: number,
  opts: { accountId?: number } = {},
): Resolved<ControlLine> {
  const record = recordById(ctx.db, recordId);
  if (!record) return notFound(`No record has id ${recordId}.`);
  return pickLine(ctx.db, record, opts.accountId, {
    none: "has nothing owed: none of its lines is on the receivable or payable accounts, so no payment can settle it.",
    several: "has several owed lines. Say which account's line is meant.",
  });
}

/**
 * The line a payment settles with: its one line on the receivable, payable or
 * reimbursements-payable account, the `paymentMovementId` that
 * `settlePayment`, `preparePaymentCorrection` and `correctPaymentAllocations`
 * take. The kind is not checked, because any record with such a line can pay
 * off another (a supplier's credit against its bill).
 *
 * A legacy group reimbursement's supplier entry resolves to its own line. The
 * correction operations follow it to the payment that funds the group
 * (`correctionMovementFor`) themselves, so this does not.
 */
export function resolvePaymentMovement(
  ctx: AppContext,
  paymentRecordId: number,
  opts: { accountId?: number } = {},
): Resolved<ControlLine> {
  const record = recordById(ctx.db, paymentRecordId);
  if (!record) return notFound(`No record has id ${paymentRecordId}.`);
  return pickLine(ctx.db, record, opts.accountId, {
    none: "has no line on the receivable or payable accounts, so it cannot pay anything off.",
    several:
      "has several lines on the receivable or payable accounts. Say which account's line pays.",
  });
}

/** An allocation of a payment to one record: what `correctPaymentAllocations` removes. */
export type SettlementBrief = {
  /** The id `correctPaymentAllocations` takes in `removeSettlementIds`. */
  id: number;
  paymentMovementId: number;
  owedMovementId: number;
  amountMinor: number;
  /** Set when the allocation is one expense of a legacy group reimbursement. */
  reimbursementGroupId?: number;
};

type Allocation = SettlementBrief & {
  owedRecordId: number;
  owedAccountId: number;
};

/**
 * Every active allocation of a payment's control lines, as the correction
 * screen lists them: an expense in a legacy group reimbursement this payment
 * funds is one allocation of the payment's, although the group's supplier
 * entry is what settles it (`groupAllocationsForPayment`).
 */
function allocationsOf(db: LedgerDb, paymentLines: number[]): Allocation[] {
  if (!paymentLines.length) return [];
  const out: Allocation[] = [];
  const covered = new Set<number>();
  const grouped = paymentLines.flatMap((movementId) => {
    const target = correctionMovementFor(db, movementId);
    return target.ok ? groupAllocationsForPayment(db, target.movementId) : [];
  });
  const groupAccounts = new Map<number, number>(
    grouped.length
      ? db
          .select({
            id: ledgerMovements.id,
            accountId: ledgerMovements.accountId,
          })
          .from(ledgerMovements)
          .where(
            inArray(
              ledgerMovements.id,
              grouped.map((row) => row.owedMovementId),
            ),
          )
          .all()
          .map((row) => [row.id, row.accountId])
      : [],
  );
  for (const row of grouped) {
    if (covered.has(row.id)) continue;
    // The expenses stand in for the group's funding row, as on the screen.
    covered.add(row.fundingSettlementId);
    for (const id of row.itemSettlementIds) covered.add(id);
    out.push({
      id: row.id,
      paymentMovementId: row.paymentMovementId,
      owedMovementId: row.owedMovementId,
      amountMinor: row.amountMinor,
      reimbursementGroupId: row.reimbursementGroupId,
      owedRecordId: row.expenseRecordId,
      owedAccountId: groupAccounts.get(row.owedMovementId) ?? 0,
    });
  }
  const direct = db
    .select({
      id: settlements.id,
      paymentMovementId: settlements.paymentMovementId,
      owedMovementId: settlements.owedMovementId,
      amountMinor: settlements.amountMinor,
      owedRecordId: ledgerMovements.recordId,
      owedAccountId: ledgerMovements.accountId,
    })
    .from(settlements)
    .innerJoin(
      ledgerMovements,
      eq(ledgerMovements.id, settlements.owedMovementId),
    )
    .where(
      and(
        activeAllocation(),
        inArray(settlements.paymentMovementId, paymentLines),
      ),
    )
    .orderBy(asc(settlements.id))
    .all();
  for (const row of direct) if (!covered.has(row.id)) out.push(row);
  return out;
}

/**
 * The active allocation of a payment to a record it settles: the one
 * `correctPaymentAllocations` removes. Active means not reversed, and one
 * payment line and one owed line have at most one (`settlements_pair_idx`).
 *
 * An expense in a legacy group reimbursement is found through the payment
 * that funds the group or through the group's supplier entry, as the
 * correction screen shows it. Several allocations are possible only when a
 * record has more than one control line; `opts.accountId` then picks the
 * owed line's account. A miss offers the records the payment does settle.
 */
export function resolveSettlement(
  ctx: AppContext,
  paymentRecordId: number,
  owedRecordId: number,
  opts: { accountId?: number } = {},
): Resolved<SettlementBrief> {
  const payment = recordById(ctx.db, paymentRecordId);
  if (!payment) return notFound(`No record has id ${paymentRecordId}.`);
  const owed = recordById(ctx.db, owedRecordId);
  if (!owed) return notFound(`No record has id ${owedRecordId}.`);
  const paymentLines = controlLines(ctx.db, payment.id).map(
    (line) => line.movementId,
  );
  if (!paymentLines.length)
    return notFound(
      `Record ${recordName(payment)} has no line on the receivable or payable accounts, so it settles nothing.`,
    );

  const all = allocationsOf(ctx.db, paymentLines);
  const toOwed = all.filter((row) => row.owedRecordId === owed.id);
  const chosen =
    opts.accountId === undefined
      ? toOwed
      : toOwed.filter((row) => row.owedAccountId === opts.accountId);
  const asCandidates = (rows: Allocation[]) => {
    const names = accountNames(
      ctx.db,
      rows.map((row) => row.owedAccountId),
    );
    return rows.map((row) => ({
      id: row.owedAccountId,
      name: names.get(row.owedAccountId) ?? `Account ${row.owedAccountId}`,
      detail: `${formatMinor(row.amountMinor)} allocated`,
    }));
  };

  if (chosen.length === 1) {
    const {
      owedRecordId: _record,
      owedAccountId: _account,
      ...brief
    } = chosen[0];
    void _record;
    void _account;
    return found(brief.id, brief);
  }
  if (chosen.length > 1)
    return ambiguous(
      `Record ${recordName(payment)} has ${chosen.length} allocations to record ${recordName(owed)}. Say which owed account's line is meant.`,
      asCandidates(chosen),
    );
  if (toOwed.length)
    return notFound(
      `Record ${recordName(payment)} has no allocation to record ${recordName(owed)} on that account.`,
      asCandidates(toOwed),
    );
  const settled = [...new Set(all.map((row) => row.owedRecordId))]
    .slice(0, CANDIDATE_LIMIT)
    .map((id) => recordById(ctx.db, id))
    .filter((record): record is RecordBrief => record !== null);
  return notFound(
    `Record ${recordName(payment)} has no active allocation to record ${recordName(owed)}.`,
    settled.map(recordCandidate),
  );
}

// --- bank lines and statements ---------------------------------------------

/** How a tool writes a bank statement line, and what `resolveBankLine` reads back: `"L123"`. */
export function lineRef(id: number): string {
  return `L${id}`;
}

/** How a tool writes a bank statement, and what `resolveStatement` reads back: `"S7"`. */
export function statementRef(id: number): string {
  return `S${id}`;
}

export type BankLineBrief = typeof bankStatementLines.$inferSelect & {
  /** The statement's account: the account whose money the line moved. */
  accountId: number;
};

export type StatementBrief = typeof bankStatements.$inferSelect;

const TAGS = {
  L: { kind: "bank line", example: "L123", other: "bank statement" },
  S: { kind: "bank statement", example: "S7", other: "bank line" },
} as const;

/** The id in `L123` / `S7` (either case), a number, or digits; else the sentence to report. */
function taggedId(
  ref: number | string,
  tag: keyof typeof TAGS,
): { id: number } | { error: string } {
  const { kind, example, other } = TAGS[tag];
  if (typeof ref === "number")
    return isId(ref)
      ? { id: ref }
      : { error: `${ref} is not a ${kind} id. Write a ${kind} as ${example}.` };
  const text = ref.trim();
  const match = /^([LS]?)(\d+)$/i.exec(text);
  if (match && match[1] && match[1].toUpperCase() !== tag)
    return {
      error: `${text} names a ${other}. Write a ${kind} as ${example}.`,
    };
  const id = match ? Number(match[2]) : NaN;
  return isId(id)
    ? { id }
    : {
        error: `"${text}" is not a ${kind} reference. Write a ${kind} as ${example}.`,
      };
}

/** A bank statement line by its id or `"L123"`. */
export function resolveBankLine(
  ctx: AppContext,
  ref: number | string,
): Resolved<BankLineBrief> {
  const parsed = taggedId(ref, "L");
  if ("error" in parsed) return notFound(parsed.error);
  const row = ctx.db
    .select({ line: bankStatementLines, accountId: bankStatements.accountId })
    .from(bankStatementLines)
    .innerJoin(
      bankStatements,
      eq(bankStatements.id, bankStatementLines.statementId),
    )
    .where(eq(bankStatementLines.id, parsed.id))
    .get();
  return row
    ? found(parsed.id, { ...row.line, accountId: row.accountId })
    : notFound(`No bank line is ${lineRef(parsed.id)}.`);
}

/** A bank statement by its id or `"S7"`. */
export function resolveStatement(
  ctx: AppContext,
  ref: number | string,
): Resolved<StatementBrief> {
  const parsed = taggedId(ref, "S");
  if ("error" in parsed) return notFound(parsed.error);
  const row = ctx.db
    .select()
    .from(bankStatements)
    .where(eq(bankStatements.id, parsed.id))
    .get();
  return row
    ? found(parsed.id, row)
    : notFound(`No bank statement is ${statementRef(parsed.id)}.`);
}
