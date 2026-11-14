import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  DefaultAccountPurpose,
  ImportState,
  LedgerRecordKind,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import { addDaysISO } from "$lib/local-date.js";
import {
  accountDefaults,
  contacts,
  importQueue,
  ledgerMovements,
  ledgerRecords,
  reconciliationAllocations,
  recordAttachments,
  settlements,
} from "../db/schema.js";
import type { LedgerDb, Minor } from "../ledger/types.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import {
  CONTENT_CHAR_LIMIT,
  DEFAULT_THRESHOLD,
  daysBetween,
  duplicateThreshold,
  prepareDuplicateJob,
  scoreDuplicateCandidate,
  tokenSet,
  type Candidate,
  type PreparedDuplicateJob,
} from "../import/duplicate-detector.js";
import { activeAllocation } from "./allocation-state.js";
import { normalizeName } from "./contacts.js";
import { notVoided } from "./void-state.js";

/**
 * The duplicate-record finder: a record entered twice, or a receipt claimed
 * twice (use case 13, `review_books{duplicate_records}`).
 *
 * A pure read. It never writes, not even a file's hash, so it runs under
 * `PRAGMA query_only`. A file with no saved hash is hashed in memory only.
 *
 * **What is compared.** Records of the requested kinds (expenses and income
 * by default) that are neither voided nor a reversal (`notVoided`), and not a
 * generated reimbursement entry. Two records are compared only when they are
 * of the same kind. The *scanned* records are those that match the filters;
 * every group holds at least one, and its other members may lie outside the
 * filters, because the other copy of a double claim is usually in an earlier
 * month, and may be under another contact.
 *
 * **Who a record is for** (its *party* below): the supplier of a personally
 * paid expense, otherwise the record's contact.
 *
 * **Signals, strongest first**
 * - `same_file`: the same bytes stored twice, on two records. The hash is the
 *   saved `record_attachments.sha256`, else the hash Auto Import took of the
 *   same upload (`import_queue.file_hash`; the file is moved, never rewritten),
 *   else, when `files` is given, the file is hashed in memory. One stored file
 *   that several records point at is shared, not duplicated, and a document
 *   imported as several items (`group_document`) belongs to all of its records.
 *   Neither is a signal. No date limit.
 * - `same_reference`: the same reference on records of the same party, with
 *   case, spaces and punctuation ignored. It counts only when it has a digit
 *   and three or more characters ("cash" or "online" is a label), and only
 *   when at most three records share it: a number on more records is a
 *   standing one, such as an account or contract number. No date limit.
 * - `amount_date_contact`: the same main-currency amount, dates at most
 *   `maxDays` apart, and the same party. When neither record names anyone,
 *   the same description words instead.
 * - `similar_text`: Auto Import's weighted duplicate score (reference, amount,
 *   date, party name and document text; file names are no evidence here), at
 *   or above its threshold, for dates at most `maxDays` apart. The threshold is
 *   the Auto Import setting, never looser than its default of 60.
 *
 * Neither of the last two links records that carry two different document
 * numbers: those are two documents, however alike the rest (Auto Import's
 * rule for references, 006 FR-063). Without it, a monthly bill of a fixed
 * amount is one copy of the next as soon as the window spans a month. The
 * window itself stops at 14 days, where the weighted score stops counting
 * dates, for the same reason.
 *
 * Records linked by any signal form one group (union-find). A group's score is
 * the chance that at least one of its signals is right, each taken as
 * independent evidence. Groups come strongest first.
 */

export type DuplicateSignal =
  | "same_file"
  | "same_reference"
  | "amount_date_contact"
  | "similar_text";

/** Strongest first: the order a group lists its signals in. */
export const DUPLICATE_SIGNALS: readonly DuplicateSignal[] = [
  "same_file",
  "same_reference",
  "amount_date_contact",
  "similar_text",
];

/** How often each signal alone means a real duplicate. */
const SIGNAL_WEIGHT: Readonly<Record<DuplicateSignal, number>> = {
  same_file: 0.9,
  same_reference: 0.8,
  amount_date_contact: 0.5,
  similar_text: 0.4,
};

/** The defaults and the largest values `findDuplicateRecords` accepts. */
export const DUPLICATE_RECORD_LIMITS = {
  defaultMaxDays: 3,
  maxDays: 14,
  defaultLimit: 50,
  limit: 200,
} as const;

/** A reference on more records of one party than this is a standing number. */
const MAX_REFERENCE_COPIES = 3;
/** Ids per `IN (...)` list. */
const CHUNK = 500;
const HASH_CACHE_ENTRIES = 10_000;

export type DuplicateRecordQuery = {
  /** Scan records dated on or after this ISO date. */
  from?: string;
  /** Scan records dated on or before this ISO date. */
  to?: string;
  /** Record kinds to compare. Default: expenses and income. */
  kinds?: LedgerRecordKindCode[];
  /** Scan the records whose contact, or the supplier of a personally paid expense, is one of these. */
  contactIds?: number[];
  /** Scan the records with a side on one of these accounts. */
  accountIds?: number[];
  /** Scan only these records, e.g. the ones a write just made. */
  recordIds?: number[];
  /** Most days apart two copies may be for the amount/date and text signals. Default 3, at most 14. */
  maxDays?: number;
  /** Groups to return, strongest first. Default 50, at most 200. */
  limit?: number;
};

/**
 * Where stored files are read from, for files with no saved hash. A missing
 * file reads as null, and its records are simply not linked by it.
 */
export type DuplicateFileSource = {
  /** The bytes stored under `key`, or null when there are none. */
  read(key: string): Uint8Array | null;
  /**
   * The size of the file under `key` in bytes, or null when there is none.
   * Optional, but without it every unhashed file is read on every call: with
   * it, a file is read only when its size says it could match, and a file
   * hashed before is not read again (the cache is keyed by key and size).
   */
  size?(key: string): number | null;
  /** Names the store, so two stores' files never share a cache entry. */
  id?: string;
};

export type DuplicateMember = {
  id: number;
  recordNumber: string | null;
  date: string;
  kind: LedgerRecordKindCode;
  /** The record's own figure in main-currency cents. */
  amountMinor: Minor;
  /** The currency the record was entered in. `amountMinor` is always the main currency's. */
  currency: string;
  /** Who the money was for: the supplier of a personally paid expense, else the record's contact. */
  contact: { id: number; name: string } | null;
  description: string;
  reference: string;
  /** A payment or credit is applied to it: an active settlement touches one of its sides. */
  settled: boolean;
  /** An expense someone paid for personally, who has been paid back for it in whole or in part. */
  reimbursed: boolean;
  /** A bank statement line is matched to one of its sides. */
  bankMatched: boolean;
  /** Voided records and their reversals are never listed. */
  voided: false;
  /** The hash of each of its own files whose hash is known. A document shared by several records imported from it is left out. */
  attachmentSha256s: string[];
};

export type DuplicateGroup = {
  /** 0–100: the chance that at least one of its signals is right. */
  score: number;
  /** Strongest first. */
  signals: DuplicateSignal[];
  /** By date, then id. Two or more. */
  records: DuplicateMember[];
};

export type DuplicateRecordsResult = {
  /** Strongest first, at most `limit`. */
  groups: DuplicateGroup[];
  /** Every group found, before `limit`. */
  totalGroups: number;
  /** How many records matched the filters and were checked. */
  scannedRecords: number;
  /** Files with no saved hash that were hashed in memory for this answer (read now, or remembered from an earlier read). */
  hashedOnTheFly: number;
};

// ---------------------------------------------------------------------------

/** What the pairing signals read of one record. */
type Row = {
  id: number;
  kind: LedgerRecordKindCode;
  date: string;
  amountMinor: Minor;
  partyId: number | null;
  partyName: string | null;
  description: string;
  reference: string;
  /** `referenceKey(reference)`. */
  documentNumber: string;
  extractedText: string | null;
};

type AttachmentRow = {
  recordId: number;
  key: string;
  sha256: string | null;
};

const party = sql<
  number | null
>`coalesce(${ledgerRecords.supplierContactId}, ${ledgerRecords.contactId})`;
const partyContact = alias(contacts, "duplicate_party");

/** The record's figure in main-currency cents: what flows in on its sides. */
const amountMinor = sql<number>`(SELECT coalesce(sum(CASE WHEN dm.amount_minor > 0 THEN dm.amount_minor ELSE 0 END), 0) FROM ledger_movements AS dm WHERE dm.record_id = ${ledgerRecords.id})`;

/** The records that can be duplicates at all, of these kinds. */
function comparable(kinds: LedgerRecordKindCode[]): SQL {
  return and(
    inArray(ledgerRecords.kind, kinds),
    notVoided(ledgerRecords.id),
    // Postings a reimbursement generated, never entered by anyone.
    sql`NOT EXISTS (SELECT 1 FROM reimbursement_entries AS dre WHERE dre.record_id = ${ledgerRecords.id})`,
  )!;
}

const KIND_CODES = new Set<number>(
  Object.values(LedgerRecordKind).filter(
    (k) => k !== LedgerRecordKind.Reversal,
  ),
);

function wholeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function chunked<T>(ids: number[], read: (chunk: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK)
    out.push(...read(ids.slice(i, i + CHUNK)));
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The reference as compared: letters and digits only, lower case; '' when it is no document number. */
function referenceKey(reference: string): string {
  const key = reference
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return key.length >= 3 && /\p{N}/u.test(key) ? key : "";
}

function descriptionKey(description: string): string {
  return [...tokenSet(normalizeName(description))].sort().join(" ");
}

function basename(key: string): string {
  return key.split(/[\\/]/).pop() ?? key;
}

// --- hashing --------------------------------------------------------------

/** sha256 by store, key and size. Map order is the recency order. */
const hashCache = new Map<string, string>();

function cacheKey(files: DuplicateFileSource, key: string, size: number) {
  return `${files.id ?? ""}\u0000${key}\u0000${size}`;
}

function cachedHash(entry: string): string | undefined {
  const hash = hashCache.get(entry);
  if (hash !== undefined) {
    hashCache.delete(entry);
    hashCache.set(entry, hash);
  }
  return hash;
}

function rememberHash(entry: string, hash: string) {
  hashCache.delete(entry);
  hashCache.set(entry, hash);
  if (hashCache.size > HASH_CACHE_ENTRIES)
    hashCache.delete(hashCache.keys().next().value!);
}

/** The file's sha256, from the cache or by reading it. Null when it cannot be read. */
function hashOf(
  files: DuplicateFileSource,
  key: string,
  size: number | undefined,
): string | null {
  if (size !== undefined) {
    const hit = cachedHash(cacheKey(files, key, size));
    if (hit) return hit;
  }
  let bytes: Uint8Array | null;
  try {
    bytes = files.read(key);
  } catch {
    return null;
  }
  if (!bytes) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  rememberHash(cacheKey(files, key, bytes.byteLength), hash);
  return hash;
}

/**
 * The stored files under `storageRoot`, for `findDuplicateRecords`. Pass the
 * book's own root (`ctx.storageRoot`), never the configured default. A key
 * that would leave the root reads as no file.
 */
export function storageFiles(storageRoot: string): DuplicateFileSource {
  const store = new LocalBlobStore(storageRoot);
  const pathOf = (key: string): string | null => {
    try {
      return store.pathOf(key);
    } catch {
      return null;
    }
  };
  return {
    id: store.root,
    size(key) {
      const path = pathOf(key);
      if (!path) return null;
      try {
        const stats = statSync(path);
        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    },
    read(key) {
      const path = pathOf(key);
      if (!path) return null;
      try {
        return readFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

// --- grouping -------------------------------------------------------------

/** Union-find over record ids, with the signals that joined each set. */
class Linker {
  private parent = new Map<number, number>();
  private signals = new Map<number, Set<DuplicateSignal>>();

  private root(id: number): number {
    let root = id;
    for (let up = this.parent.get(root); up !== undefined && up !== root; ) {
      root = up;
      up = this.parent.get(root);
    }
    for (let node = id; node !== root; ) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  link(a: number, b: number, signal: DuplicateSignal) {
    if (a === b) return;
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const into = this.root(a);
    const from = this.root(b);
    const joined = this.signals.get(into) ?? new Set<DuplicateSignal>();
    if (from !== into) {
      this.parent.set(from, into);
      for (const s of this.signals.get(from) ?? []) joined.add(s);
      this.signals.delete(from);
    }
    joined.add(signal);
    this.signals.set(into, joined);
  }

  groups(): { ids: number[]; signals: Set<DuplicateSignal> }[] {
    const members = new Map<number, number[]>();
    for (const id of this.parent.keys()) {
      const root = this.root(id);
      const list = members.get(root) ?? [];
      list.push(id);
      members.set(root, list);
    }
    return [...members].map(([root, ids]) => ({
      ids,
      signals: this.signals.get(root)!,
    }));
  }
}

function groupScore(signals: Set<DuplicateSignal>): number {
  let missed = 1;
  for (const signal of signals) missed *= 1 - SIGNAL_WEIGHT[signal];
  return Math.round(100 * (1 - missed));
}

// --- the finder -------------------------------------------------------------

export function findDuplicateRecords(
  db: LedgerDb,
  input: DuplicateRecordQuery = {},
  files?: DuplicateFileSource,
): DuplicateRecordsResult {
  const kinds =
    input.kinds === undefined
      ? [LedgerRecordKind.Expense, LedgerRecordKind.Income]
      : [...new Set(input.kinds)].filter((k) => KIND_CODES.has(k));
  const maxDays = wholeNumber(
    input.maxDays,
    DUPLICATE_RECORD_LIMITS.defaultMaxDays,
    0,
    DUPLICATE_RECORD_LIMITS.maxDays,
  );
  const limit = wholeNumber(
    input.limit,
    DUPLICATE_RECORD_LIMITS.defaultLimit,
    1,
    DUPLICATE_RECORD_LIMITS.limit,
  );
  const none: DuplicateRecordsResult = {
    groups: [],
    totalGroups: 0,
    scannedRecords: 0,
    hashedOnTheFly: 0,
  };
  // An empty list asks for nothing; only a missing one means "any".
  if (
    !kinds.length ||
    input.contactIds?.length === 0 ||
    input.accountIds?.length === 0 ||
    input.recordIds?.length === 0
  )
    return none;

  const pool = comparable(kinds);
  const filters: SQL[] = [pool];
  if (input.from) filters.push(gte(ledgerRecords.date, input.from));
  if (input.to) filters.push(lte(ledgerRecords.date, input.to));
  if (input.contactIds)
    filters.push(
      or(
        inArray(ledgerRecords.contactId, input.contactIds),
        inArray(ledgerRecords.supplierContactId, input.contactIds),
      )!,
    );
  if (input.accountIds)
    filters.push(
      inArray(
        ledgerRecords.id,
        db
          .select({ id: ledgerMovements.recordId })
          .from(ledgerMovements)
          .where(inArray(ledgerMovements.accountId, input.accountIds)),
      ),
    );
  if (input.recordIds) filters.push(inArray(ledgerRecords.id, input.recordIds));

  const focus = db
    .select({ id: ledgerRecords.id, date: ledgerRecords.date })
    .from(ledgerRecords)
    .where(and(...filters))
    .all();
  if (!focus.length) return none;
  const scanned = new Set(focus.map((r) => r.id));
  const linker = new Linker();

  // -- Amount, date and party; similar text: pairs at most maxDays apart. ---
  const dates = focus
    .map((r) => r.date)
    .filter((d) => ISO_DATE.test(d))
    .sort();
  const rows: Row[] = dates.length
    ? db
        .select({
          id: ledgerRecords.id,
          kind: ledgerRecords.kind,
          date: ledgerRecords.date,
          amountMinor,
          partyId: party,
          partyName: partyContact.legalName,
          description: ledgerRecords.description,
          reference: ledgerRecords.reference,
          extractedText: sql<
            string | null
          >`substr(${ledgerRecords.extractedText}, 1, ${CONTENT_CHAR_LIMIT})`,
        })
        .from(ledgerRecords)
        .leftJoin(partyContact, eq(partyContact.id, party))
        .where(
          and(
            pool,
            gte(ledgerRecords.date, addDaysISO(dates[0], -maxDays)),
            lte(ledgerRecords.date, addDaysISO(dates.at(-1)!, maxDays)),
          ),
        )
        .orderBy(asc(ledgerRecords.date), asc(ledgerRecords.id))
        .all()
        .map((r) => ({
          ...r,
          kind: r.kind as LedgerRecordKindCode,
          documentNumber: referenceKey(r.reference),
        }))
    : [];

  const setting = duplicateThreshold(db);
  // Never looser than the default: Auto Import weighs one document against
  // recent records, while this links every pair, and chains them into groups.
  const threshold = Number.isFinite(setting)
    ? Math.max(DEFAULT_THRESHOLD, setting)
    : DEFAULT_THRESHOLD;
  const jobs = new Map<number, PreparedDuplicateJob>();
  const candidates = new Map<number, Candidate>();
  const textSide = (row: Row) => {
    let job = jobs.get(row.id);
    if (!job) {
      const reference = row.documentNumber || null;
      const amount = row.amountMinor > 0 ? row.amountMinor : null;
      job = prepareDuplicateJob({
        reference,
        amount,
        date: row.date,
        // A file's name is no evidence; the file itself is compared by hash.
        originalFilename: null,
        supplier: row.partyName,
        extractedText: row.extractedText,
        referenceVeto: false,
      });
      jobs.set(row.id, job);
      candidates.set(row.id, {
        id: row.id,
        amount,
        date: row.date,
        reference,
        legalName: row.partyName,
        extractedText: row.extractedText,
        originalFilename: null,
        contentTokens: job.contentTokens,
      });
    }
    return { job, candidate: candidates.get(row.id)! };
  };
  const descriptions = new Map<number, string>();
  const describe = (row: Row) => {
    let key = descriptions.get(row.id);
    if (key === undefined) {
      key = descriptionKey(row.description);
      descriptions.set(row.id, key);
    }
    return key;
  };
  const sameParty = (a: Row, b: Row) =>
    a.partyId !== null || b.partyId !== null
      ? a.partyId === b.partyId
      : describe(a) !== "" && describe(a) === describe(b);

  for (const f of rows) {
    if (!scanned.has(f.id) || !ISO_DATE.test(f.date)) continue;
    const earliest = addDaysISO(f.date, -maxDays);
    const latest = addDaysISO(f.date, maxDays);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].date < earliest) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < rows.length && rows[i].date <= latest; i++) {
      const w = rows[i];
      // Each pair once: two scanned records are paired from the lower id.
      if (w.id === f.id || w.kind !== f.kind) continue;
      if (scanned.has(w.id) && w.id < f.id) continue;
      if (daysBetween(f.date, w.date) > maxDays) continue;
      // Two different document numbers: two documents (006 FR-063).
      if (
        f.documentNumber &&
        w.documentNumber &&
        f.documentNumber !== w.documentNumber
      )
        continue;
      if (
        f.amountMinor > 0 &&
        f.amountMinor === w.amountMinor &&
        sameParty(f, w)
      )
        linker.link(f.id, w.id, "amount_date_contact");
      const [first, second] =
        f.date < w.date || (f.date === w.date && f.id < w.id) ? [f, w] : [w, f];
      const scored = scoreDuplicateCandidate(
        textSide(first).job,
        textSide(second).candidate,
      );
      if (scored && scored.score >= threshold)
        linker.link(f.id, w.id, "similar_text");
    }
  }

  // -- The same reference on the same party's records, anywhere. -----------
  const byReference = new Map<string, number[]>();
  for (const r of db
    .select({
      id: ledgerRecords.id,
      kind: ledgerRecords.kind,
      partyId: party,
      reference: ledgerRecords.reference,
    })
    .from(ledgerRecords)
    .where(and(pool, ne(ledgerRecords.reference, "")))
    .orderBy(asc(ledgerRecords.id))
    .all()) {
    const key = referenceKey(r.reference);
    if (r.partyId === null || !key) continue;
    const bucket = `${r.kind}\u0000${r.partyId}\u0000${key}`;
    const ids = byReference.get(bucket) ?? [];
    ids.push(r.id);
    byReference.set(bucket, ids);
  }
  for (const ids of byReference.values()) {
    if (ids.length < 2 || ids.length > MAX_REFERENCE_COPIES) continue;
    if (!ids.some((id) => scanned.has(id))) continue;
    for (const id of ids.slice(1)) linker.link(ids[0], id, "same_reference");
  }

  // -- The same bytes stored twice, anywhere. ------------------------------
  const kindOf = new Map<number, number>();
  const attachments: AttachmentRow[] = db
    .select({
      recordId: recordAttachments.recordId,
      kind: ledgerRecords.kind,
      key: recordAttachments.filename,
      sha256: recordAttachments.sha256,
    })
    .from(recordAttachments)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, recordAttachments.recordId))
    .where(and(pool, eq(recordAttachments.groupDocument, false)))
    .orderBy(asc(recordAttachments.id))
    .all()
    .map(({ kind, ...a }) => {
      kindOf.set(a.recordId, kind);
      return { ...a, sha256: a.sha256?.toLowerCase() ?? null };
    });

  // An imported receipt is moved into storage as uploaded, so the hash its
  // import took of the upload is the stored file's hash.
  const imported = new Map<string, string>();
  for (const job of db
    .select({
      recordId: importQueue.resultId,
      path: importQueue.tempFilePath,
      hash: importQueue.fileHash,
    })
    .from(importQueue)
    .where(
      and(
        eq(importQueue.state, ImportState.Imported),
        isNotNull(importQueue.resultId),
        isNotNull(importQueue.fileHash),
      ),
    )
    .all())
    imported.set(
      `${job.recordId}\u0000${basename(job.path)}`,
      job.hash!.toLowerCase(),
    );
  const rowsOfKey = new Map<string, AttachmentRow[]>();
  for (const a of attachments) {
    a.sha256 ??= imported.get(`${a.recordId}\u0000${basename(a.key)}`) ?? null;
    const list = rowsOfKey.get(a.key) ?? [];
    list.push(a);
    rowsOfKey.set(a.key, list);
  }
  // Rows pointing at one stored file share whatever hash one of them has.
  for (const list of rowsOfKey.values()) {
    const known = list.find((a) => a.sha256 !== null)?.sha256;
    if (known) for (const a of list) a.sha256 ??= known;
  }

  const inMemory = new Set<string>();
  const sizes = new Map<string, number | null>();
  /** Undefined when the source cannot tell sizes; null when there is no file. */
  const sizeOf = (key: string): number | null | undefined => {
    if (!files?.size) return undefined;
    if (!sizes.has(key)) {
      let size: number | null;
      try {
        size = files.size(key);
      } catch {
        size = null;
      }
      sizes.set(key, size);
    }
    return sizes.get(key)!;
  };
  /** Hashes a file with no saved hash, in memory only, for every row of it. */
  const hashUnknown = (key: string) => {
    if (!files || inMemory.has(key)) return;
    const size = sizeOf(key);
    if (size === null) return;
    const hash = hashOf(files, key, size);
    if (!hash) return;
    inMemory.add(key);
    for (const a of rowsOfKey.get(key) ?? []) a.sha256 ??= hash;
  };
  if (files) {
    const unknown = attachments.filter((a) => a.sha256 === null);
    if (unknown.length && files.size) {
      // A file can only match one of the same size, so a file outside the
      // scan is read only when a scanned record has a file of its size.
      const scannedSizes = new Set<number>();
      for (const a of attachments) {
        if (!scanned.has(a.recordId)) continue;
        const size = sizeOf(a.key);
        if (size != null) scannedSizes.add(size);
      }
      for (const a of unknown) {
        const size = sizeOf(a.key);
        if (size == null) continue;
        if (scanned.has(a.recordId) || scannedSizes.has(size))
          hashUnknown(a.key);
      }
    } else for (const a of unknown) hashUnknown(a.key);
  }

  const byHash = new Map<string, AttachmentRow[]>();
  for (const a of attachments) {
    if (!a.sha256) continue;
    const bucket = `${kindOf.get(a.recordId)}\u0000${a.sha256}`;
    const list = byHash.get(bucket) ?? [];
    list.push(a);
    byHash.set(bucket, list);
  }
  for (const list of byHash.values()) {
    // Every record pointing at one stored file shares it: not a duplicate.
    if (new Set(list.map((a) => a.key)).size < 2) continue;
    const ids = [...new Set(list.map((a) => a.recordId))];
    if (ids.length < 2 || !ids.some((id) => scanned.has(id))) continue;
    for (const id of ids.slice(1)) linker.link(ids[0], id, "same_file");
  }

  // -- Groups ------------------------------------------------------------------
  const found = linker.groups();
  const memberIds = found.flatMap((g) => g.ids);
  const members = new Map(describeMembers(db, memberIds).map((m) => [m.id, m]));
  const ranked = found
    .map((g) => {
      const records = g.ids
        .map((id) => members.get(id)!)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      return {
        score: groupScore(g.signals),
        signals: DUPLICATE_SIGNALS.filter((s) => g.signals.has(s)),
        records,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.records.at(-1)!.date.localeCompare(a.records.at(-1)!.date) ||
        Math.min(...a.records.map((r) => r.id)) -
          Math.min(...b.records.map((r) => r.id)),
    );
  const shown = ranked.slice(0, limit);

  // Each listed record's own files, hashed now where still unknown.
  const listed = new Set(shown.flatMap((g) => g.records.map((r) => r.id)));
  for (const a of attachments)
    if (a.sha256 === null && listed.has(a.recordId)) hashUnknown(a.key);
  const hashes = new Map<number, string[]>();
  for (const a of attachments) {
    if (!a.sha256 || !listed.has(a.recordId)) continue;
    const list = hashes.get(a.recordId) ?? [];
    if (!list.includes(a.sha256)) list.push(a.sha256);
    hashes.set(a.recordId, list);
  }

  return {
    groups: shown.map((g) => ({
      ...g,
      records: g.records.map((r) => ({
        ...r,
        attachmentSha256s: hashes.get(r.id) ?? [],
      })),
    })),
    totalGroups: ranked.length,
    scannedRecords: scanned.size,
    hashedOnTheFly: inMemory.size,
  };
}

/** Each record as a group lists it, with what has happened to it since. */
function describeMembers(
  db: LedgerDb,
  ids: number[],
): Omit<DuplicateMember, "attachmentSha256s">[] {
  if (!ids.length) return [];
  const rows = chunked(ids, (chunk) =>
    db
      .select({
        id: ledgerRecords.id,
        recordNumber: ledgerRecords.recordNumber,
        date: ledgerRecords.date,
        kind: ledgerRecords.kind,
        amountMinor,
        currency: ledgerRecords.currency,
        partyId: party,
        partyName: partyContact.legalName,
        contactId: ledgerRecords.contactId,
        paymentSource: ledgerRecords.expensePaymentSource,
        description: ledgerRecords.description,
        reference: ledgerRecords.reference,
      })
      .from(ledgerRecords)
      .leftJoin(partyContact, eq(partyContact.id, party))
      .where(inArray(ledgerRecords.id, chunk))
      .all(),
  );

  const sides = chunked(ids, (chunk) =>
    db
      .select({
        id: ledgerMovements.id,
        recordId: ledgerMovements.recordId,
        accountId: ledgerMovements.accountId,
      })
      .from(ledgerMovements)
      .where(inArray(ledgerMovements.recordId, chunk))
      .all(),
  );
  const sideOf = new Map(sides.map((s) => [s.id, s]));
  const sideIds = sides.map((s) => s.id);

  const payerSide = alias(ledgerMovements, "duplicate_payer_side");
  const payer = alias(ledgerRecords, "duplicate_payer");
  const allocations = chunked(sideIds, (chunk) =>
    db
      .select({
        paymentMovementId: settlements.paymentMovementId,
        owedMovementId: settlements.owedMovementId,
        payerKind: payer.kind,
        payerContactId: payer.contactId,
        payerIsReimbursementEntry: sql<number>`EXISTS (SELECT 1 FROM reimbursement_entries AS dpe WHERE dpe.record_id = ${payer.id})`,
      })
      .from(settlements)
      .innerJoin(payerSide, eq(payerSide.id, settlements.paymentMovementId))
      .innerJoin(payer, eq(payer.id, payerSide.recordId))
      .where(
        and(
          activeAllocation(),
          or(
            inArray(settlements.paymentMovementId, chunk),
            inArray(settlements.owedMovementId, chunk),
          ),
        ),
      )
      .all(),
  );
  const reimbursementsPayable =
    db
      .select({ id: accountDefaults.accountId })
      .from(accountDefaults)
      .where(
        eq(
          accountDefaults.purpose,
          DefaultAccountPurpose.ReimbursementsPayable,
        ),
      )
      .get()?.id ?? null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const settled = new Set<number>();
  const reimbursed = new Set<number>();
  for (const a of allocations) {
    for (const sideId of [a.paymentMovementId, a.owedMovementId]) {
      const side = sideOf.get(sideId);
      if (side) settled.add(side.recordId);
    }
    const owed = sideOf.get(a.owedMovementId);
    const expense = owed ? byId.get(owed.recordId) : undefined;
    if (!owed || !expense || expense.kind !== LedgerRecordKind.Expense)
      continue;
    // Paid back to whoever paid it: a payment to someone other than the
    // supplier, a payment against a personally paid expense or a
    // reimbursements-payable side, or an older group reimbursement's entry.
    if (
      Boolean(a.payerIsReimbursementEntry) ||
      expense.paymentSource === "personal" ||
      (reimbursementsPayable !== null &&
        owed.accountId === reimbursementsPayable) ||
      (a.payerKind === LedgerRecordKind.Payment &&
        a.payerContactId !== null &&
        a.payerContactId !== expense.contactId)
    )
      reimbursed.add(expense.id);
  }

  const matched = new Set(
    chunked(sideIds, (chunk) =>
      db
        .selectDistinct({ movementId: reconciliationAllocations.movementId })
        .from(reconciliationAllocations)
        .where(inArray(reconciliationAllocations.movementId, chunk))
        .all(),
    ).flatMap((m) =>
      m.movementId !== null && sideOf.has(m.movementId)
        ? [sideOf.get(m.movementId)!.recordId]
        : [],
    ),
  );

  return rows.map((r) => ({
    id: r.id,
    recordNumber: r.recordNumber,
    date: r.date,
    kind: r.kind as LedgerRecordKindCode,
    amountMinor: r.amountMinor,
    currency: r.currency,
    contact:
      r.partyId !== null && r.partyName !== null
        ? { id: r.partyId, name: r.partyName }
        : null,
    description: r.description,
    reference: r.reference,
    settled: settled.has(r.id),
    reimbursed: reimbursed.has(r.id),
    bankMatched: matched.has(r.id),
    voided: false as const,
  }));
}
