import {
  reimbursementEntryDescription,
  originalReimbursementDescription,
} from "$lib/reimbursement-labels.js";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  auditLog,
  ledgerMovements,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  settlements,
  users,
} from "../db/schema.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import { getRecord } from "./ledger.js";
import { settlementsForRecord, type SettlementLink } from "./settlements.js";

export type DisplaySettlementLink = SettlementLink & {
  canUndo?: boolean;
  reversedAt?: string | null;
  reversedBy?: number | null;
  reversedByName?: string | null;
  reversalReason?: string | null;
};
type AuditChange = { field: string; before?: unknown; after?: unknown };
type HistoricalAllocation = {
  id: number;
  paymentMovementId: number;
  owedMovementId: number;
  amountMinor: number;
  createdAt: string;
  reversedAt?: string | null;
  reversedBy?: number | null;
  reversalReason?: string | null;
};
function changes(value: string | null): AuditChange[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Retained rows are authoritative; old delete audits remain a compatibility fallback. */
function reversedAllocations(
  db: LedgerDb,
  movementIds: number[],
): HistoricalAllocation[] {
  if (!movementIds.length) return [];
  const rows = db
    .select({
      changes: auditLog.changes,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.recordType, "settlement"),
        eq(auditLog.action, "delete"),
        or(
          inArray(
            sql<number>`json_extract(${auditLog.changes}, '$[0].before.paymentMovementId')`,
            movementIds,
          ),
          inArray(
            sql<number>`json_extract(${auditLog.changes}, '$[0].before.owedMovementId')`,
            movementIds,
          ),
        ),
      ),
    )
    .all();
  const retained = db
    .select()
    .from(settlements)
    .where(
      and(
        isNotNull(settlements.reversedAt),
        or(
          inArray(settlements.paymentMovementId, movementIds),
          inArray(settlements.owedMovementId, movementIds),
        ),
      ),
    )
    .all();
  const byId = new Map<number, HistoricalAllocation>(
    retained.map((row) => [row.id, row]),
  );
  const legacy = rows.flatMap((row) =>
    changes(row.changes).flatMap((change) => {
      if (
        change.field !== "allocation" ||
        !change.before ||
        typeof change.before !== "object"
      )
        return [];
      const allocation = change.before as HistoricalAllocation;
      const reason = changes(row.changes).find(
        (c) => c.field === "reason",
      )?.after;
      return Number.isSafeInteger(allocation.id) &&
        Number.isInteger(allocation.paymentMovementId) &&
        Number.isInteger(allocation.owedMovementId) &&
        Number.isInteger(allocation.amountMinor)
        ? [
            {
              ...allocation,
              reversedAt: row.createdAt,
              reversedBy: row.userId,
              reversalReason: typeof reason === "string" ? reason : null,
            },
          ]
        : [];
    }),
  );
  for (const allocation of legacy) {
    if (!byId.has(allocation.id)) byId.set(allocation.id, allocation);
  }
  return [...byId.values()];
}

/** Historical links never contribute to current funding or correction targets. */
export function reversedAllocationsForRecord(
  db: LedgerDb,
  recordId: number,
): DisplaySettlementLink[] {
  const ids = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .map((m) => m.id);
  return reversedAllocations(db, ids).flatMap((allocation) => {
    const otherId = ids.includes(allocation.paymentMovementId)
      ? allocation.owedMovementId
      : allocation.paymentMovementId;
    const movement = db
      .select()
      .from(ledgerMovements)
      .where(eq(ledgerMovements.id, otherId))
      .get();
    const other = movement ? getRecord(db, movement.recordId) : null;
    if (!other) return [];
    const user =
      allocation.reversedBy == null
        ? null
        : db
            .select({ name: users.username })
            .from(users)
            .where(eq(users.id, allocation.reversedBy))
            .get();
    return [
      {
        ...linkTo(
          other,
          allocation.amountMinor,
          allocation.id,
          allocation.createdAt,
        ),
        reversedAt: allocation.reversedAt ?? null,
        reversedBy: allocation.reversedBy ?? null,
        reversedByName: user?.name ?? null,
        reversalReason: allocation.reversalReason ?? null,
      },
    ];
  });
}

function linkTo(
  record: RecordView,
  amountMinor: number,
  settlementId: number,
  createdAt: string,
): DisplaySettlementLink {
  return {
    settlementId,
    amountMinor,
    createdAt,
    otherRecordId: record.id,
    otherRecordNumber: record.recordNumber,
    otherDate: record.date,
    otherDescription: record.description,
    otherKind: record.kind,
    otherContactId: record.contactId,
    otherContactName: record.contactName,
    canUndo: false,
  };
}

/** One authoritative record audit per correction; settlement delete audits overlap. */
function allocationHistoryForRecord(db: LedgerDb, recordId: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.recordType, "record"),
        eq(auditLog.recordId, String(recordId)),
      ),
    )
    .orderBy(desc(auditLog.id))
    .all()
    .flatMap((row) => {
      const fields = changes(row.changes);
      const change = fields.find((field) => field.field === "allocations");
      if (
        !change ||
        !Array.isArray(change.before) ||
        !Array.isArray(change.after)
      )
        return [];
      const before = change.before as HistoricalAllocation[];
      const after = change.after as HistoricalAllocation[];
      const same = (a: HistoricalAllocation, b: HistoricalAllocation) =>
        a.id === b.id &&
        a.paymentMovementId === b.paymentMovementId &&
        a.owedMovementId === b.owedMovementId &&
        a.amountMinor === b.amountMinor;
      const removed = before.filter(
        (a) =>
          Number.isSafeInteger(a.amountMinor) && !after.some((b) => same(a, b)),
      );
      const added = after.filter(
        (a) =>
          Number.isSafeInteger(a.amountMinor) &&
          !before.some((b) => same(a, b)),
      );
      if (!removed.length && !added.length) return [];
      const reason = fields.find(
        (field) => field.field === "correctionReason",
      )?.after;
      return [
        {
          id: row.id,
          date: row.createdAt,
          reason: typeof reason === "string" ? reason : null,
          removedMinor: removed.reduce((sum, a) => sum + a.amountMinor, 0),
          addedMinor: added.reduce((sum, a) => sum + a.amountMinor, 0),
        },
      ];
    });
}

/** Presentation links only; balances continue to derive from postings and settlements. */
export function reimbursementsForRecord(db: LedgerDb, recordId: number) {
  const cache = new Map<number, RecordView | null>();
  const record = (id: number) => {
    if (!cache.has(id)) cache.set(id, getRecord(db, id));
    return cache.get(id) ?? null;
  };
  const entry = db
    .select()
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.recordId, recordId))
    .get();
  const sides = db
    .select()
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all();
  const sideIds = sides.map((m) => m.id);
  const sourceGroups = sideIds.length
    ? db
        .select()
        .from(reimbursementItems)
        .where(inArray(reimbursementItems.sourceMovementId, sideIds))
        .all()
        .map((i) => i.groupId)
    : [];
  // Funding can be an older payment whose credit was explicitly carried forward.
  const linkedIds = settlementsForRecord(db, recordId).map(
    (link) => link.otherRecordId,
  );
  for (const allocation of reversedAllocations(db, sideIds)) {
    const otherId = sideIds.includes(allocation.paymentMovementId)
      ? allocation.owedMovementId
      : allocation.paymentMovementId;
    const movement = db
      .select()
      .from(ledgerMovements)
      .where(eq(ledgerMovements.id, otherId))
      .get();
    if (movement) linkedIds.push(movement.recordId);
  }
  const fundingGroups = linkedIds.length
    ? db
        .select()
        .from(reimbursementEntries)
        .where(inArray(reimbursementEntries.recordId, linkedIds))
        .all()
        .map((e) => e.groupId)
    : [];
  const ids = [
    ...new Set([
      ...sourceGroups,
      ...fundingGroups,
      ...(entry ? [entry.groupId] : []),
    ]),
  ];
  const groups = db
    .select()
    .from(reimbursements)
    .where(
      or(
        eq(reimbursements.paymentRecordId, recordId),
        ...(ids.length ? [inArray(reimbursements.id, ids)] : []),
      ),
    )
    .all()
    .map((group) => {
      const originalDescription =
        (group.paymentRecordId
          ? record(group.paymentRecordId)?.description
          : null) ||
        originalReimbursementDescription(
          record(group.payableRecordId)!.description,
        );
      const entries = db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.groupId, group.id))
        .all()
        .map((e) => {
          const r = record(e.recordId)!;
          return {
            ...e,
            contactName: r.contactName ?? "",
            description: reimbursementEntryDescription(
              e.role,
              originalDescription,
            ),
            recordNumber: r.recordNumber,
            date: r.date,
            amountMinor: r.amountMinor,
          };
        });
      const internal = new Set(entries.map((e) => e.recordId));
      const items = db
        .select()
        .from(reimbursementItems)
        .where(eq(reimbursementItems.groupId, group.id))
        .all()
        .map((i) => {
          const source = db
            .select()
            .from(ledgerMovements)
            .where(eq(ledgerMovements.id, i.sourceMovementId))
            .get()!;
          const r = record(source.recordId)!;
          return {
            ...i,
            recordId: r.id,
            recordNumber: r.recordNumber,
            description: r.description,
            date: r.date,
            contactName: r.contactName,
            contactId: r.contactId,
            kind: r.kind,
          };
        });
      const payable = record(group.payableRecordId)!;
      const funding = settlementsForRecord(db, group.payableRecordId).filter(
        (link) => !internal.has(link.otherRecordId),
      );
      const historicalFunding = reversedAllocationsForRecord(
        db,
        payable.id,
      ).filter((link) => !internal.has(link.otherRecordId));
      const reversal = group.reversedAt
        ? db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.recordType, "record"),
                eq(auditLog.recordId, String(group.payableRecordId)),
              ),
            )
            .orderBy(desc(auditLog.id))
            .all()
            .map((row) => changes(row.changes))
            .find((cs) => cs.some((c) => c.field === "reimbursementReversal"))
        : undefined;
      const reversalAfter = reversal?.find(
        (c) => c.field === "reimbursementReversal",
      )?.after as { date?: string } | undefined;
      const reason = reversal?.find(
        (c) => c.field === "correctionReason",
      )?.after;
      const totalMinor = items.reduce((sum, i) => sum + i.amountMinor, 0);
      return {
        ...group,
        description: originalDescription,
        entries,
        items,
        funding,
        historicalFunding,
        totalMinor,
        fundedMinor: group.reversedAt
          ? 0
          : funding.reduce((sum, f) => sum + f.amountMinor, 0),
        fundingForRecordMinor: group.reversedAt
          ? 0
          : funding
              .filter((f) => f.otherRecordId === recordId)
              .reduce((sum, f) => sum + f.amountMinor, 0),
        reversedAmountMinor: group.reversedAt ? payable.amountMinor : 0,
        reversalDate:
          reversalAfter?.date ??
          entries.find((e) => e.role === "recipient-reversal")?.date ??
          null,
        reversalReason: typeof reason === "string" ? reason : null,
      };
    });
  return {
    generated: !!entry,
    generatedRole: entry?.role ?? null,
    allocationHistory: allocationHistoryForRecord(db, recordId),
    groups,
    relatedRecordIds: [
      ...new Set(
        groups.flatMap((g) => [
          g.payableRecordId,
          ...(g.paymentRecordId ? [g.paymentRecordId] : []),
          ...g.entries.map((e) => e.recordId),
          ...g.items.map((i) => i.recordId),
          ...g.funding.map((f) => f.otherRecordId),
          ...g.historicalFunding.map((f) => f.otherRecordId),
        ]),
      ),
    ],
  };
}

/** Keep correction targets intact while projecting uncomplicated reimbursements. */
export function recordRelations(db: LedgerDb, recordId: number) {
  const links = settlementsForRecord(db, recordId);
  const reimbursement = reimbursementsForRecord(db, recordId);
  let displayLinks: DisplaySettlementLink[] = links.map((link) => {
    const entry = reimbursement.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.recordId === link.otherRecordId);
    return {
      ...link,
      ...(entry ? { otherDescription: entry.description } : {}),
    };
  });
  for (const group of reimbursement.groups) {
    if (group.reversedAt) continue;
    const sources = new Set(group.funding.map((f) => f.otherRecordId));
    const singleSource =
      sources.size === 1 && group.fundedMinor === group.totalMinor;
    if (!singleSource) {
      if (group.items.some((item) => item.recordId === recordId)) {
        const supplierIds = new Set(
          group.entries
            .filter((entry) => entry.role === "supplier")
            .map((entry) => entry.recordId),
        );
        displayLinks = displayLinks.map((link) =>
          supplierIds.has(link.otherRecordId)
            ? {
                ...linkTo(
                  getRecord(db, group.payableRecordId)!,
                  link.amountMinor,
                  link.settlementId,
                  link.createdAt,
                ),
                otherDescription: reimbursementEntryDescription(
                  "recipient",
                  group.description,
                ),
              }
            : link,
        );
      }
      continue;
    }
    const fundingRecordId = [...sources][0];
    const fundingLink = group.funding[0];
    if (fundingRecordId === recordId) {
      displayLinks = displayLinks.filter(
        (link) => link.otherRecordId !== group.payableRecordId,
      );
      for (const item of group.items) {
        const expense = getRecord(db, item.recordId)!;
        displayLinks.push(
          linkTo(
            expense,
            item.amountMinor,
            fundingLink.settlementId,
            fundingLink.createdAt,
          ),
        );
      }
    } else if (group.items.some((i) => i.recordId === recordId)) {
      const suppliers = new Set(
        group.entries
          .filter((e) => e.role === "supplier")
          .map((e) => e.recordId),
      );
      displayLinks = displayLinks.filter(
        (link) => !suppliers.has(link.otherRecordId),
      );
      const payment = getRecord(db, fundingRecordId)!;
      const amount = group.items
        .filter((i) => i.recordId === recordId)
        .reduce((sum, i) => sum + i.amountMinor, 0);
      displayLinks.push(
        linkTo(
          payment,
          amount,
          fundingLink.settlementId,
          fundingLink.createdAt,
        ),
      );
    }
  }
  if (reimbursement.generated) {
    // Generated entries expose external funding here; all accounting counterparts
    // are already represented in the reimbursement's accounting details.
    displayLinks = reimbursement.groups.flatMap((group) =>
      group.reversedAt
        ? []
        : group.funding.map((link) => ({ ...link, canUndo: false })),
    );
  }
  // One expense can have several owed movements in the same reimbursement.
  const combined = new Map<string, DisplaySettlementLink>();
  for (const link of displayLinks) {
    const key = `${link.settlementId}-${link.otherRecordId}`;
    const prior = combined.get(key);
    if (prior) prior.amountMinor += link.amountMinor;
    else combined.set(key, { ...link });
  }
  displayLinks = [...combined.values()];
  // Internal supplier allocations cannot be individually reversed, even in mixed groups.
  const protectedIds = new Set(
    reimbursement.groups.flatMap((g) =>
      g.entries.filter((e) => e.role !== "recipient").map((e) => e.recordId),
    ),
  );
  displayLinks = displayLinks.map((link) =>
    protectedIds.has(link.otherRecordId) || reimbursement.generated
      ? { ...link, canUndo: false }
      : link,
  );
  return {
    links,
    displayLinks,
    historicalLinks: reversedAllocationsForRecord(db, recordId),
    reimbursement,
  };
}
