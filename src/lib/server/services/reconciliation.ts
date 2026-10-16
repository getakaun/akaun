import { StatementDirection, StatementExtractionState } from "$lib/enums.js";
import { diffRecords, recordAudit } from "$lib/server/audit.js";
import { mainCurrencyCode } from "$lib/server/currency/form.js";
import { deleteStatementFile } from "$lib/server/file-storage.js";
import { can } from "$lib/server/permissions.js";
import { sidesFromAccounts } from "$lib/server/ledger/sides-from-accounts.js";
import { loadSidesContext } from "$lib/server/services/sides-context.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { reconciliationEvents } from "$lib/server/reconciliation/events.js";
import {
  directionFor,
  suggestLinesForMovement,
} from "$lib/server/reconciliation/suggestions.js";
import { EPSILON, round2 } from "$lib/server/reconciliation/types.js";
import type {
  MovementCandidate,
  StatementSummary,
  StatementWithAccount,
} from "$lib/server/reconciliation/types.js";
import {
  deleteLine as deleteLineQuery,
  deleteStatement as deleteStatementQuery,
  findRecordMovementOnAccount,
  getLine,
  getMovementCandidate,
  getStatement,
  insertAllocation,
  insertStatement,
  listAllocations,
  listReconciliableAccounts,
  listLines,
  listMovementAllocations,
  listMovementCandidates,
  listStatements,
  replaceMovementAllocations as replaceMovementAllocationsQuery,
  updateLine as updateLineQuery,
  updateStatement,
} from "$lib/server/queries/reconciliation.js";
import type { ReconciliationDb } from "$lib/server/queries/reconciliation.js";
import {
  createRecord,
  emitRecordUpdate,
  type DeferredEmits,
} from "$lib/server/services/ledger.js";

export class ReconciliationError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
function authorize(locals: App.Locals, permission: LeafPermission) {
  if (!locals.user) throw new ReconciliationError("Unauthorized", 401);
  if (!can(locals, permission)) throw new ReconciliationError("Forbidden", 403);
  return locals.user.id;
}

/**
 * Every statement line, with what it still has left to allocate and the account
 * its statement belongs to. Carrying the account down onto each line is what
 * lets both the suggestion rules and the screen refuse a line from another
 * account without a second lookup (FR-021).
 */
function lineRemainders(db: ReconciliationDb) {
  const allocatedByLine = new Map<number, number>();
  for (const a of listAllocations(db)) {
    allocatedByLine.set(a.lineId, (allocatedByLine.get(a.lineId) ?? 0) + a.amount);
  }
  const accountByStatement = new Map(
    listStatements(db).map((statement) => [statement.id, statement.accountId]),
  );
  return listLines(db).map((line) => {
    const allocated = allocatedByLine.get(line.id) ?? 0;
    return {
      ...line,
      accountId: accountByStatement.get(line.statementId) ?? null,
      allocatedAmount: round2(allocated),
      remainingAmount: round2(line.amount - allocated),
    };
  });
}
function statementSummary(
  db: ReconciliationDb,
  statement: StatementWithAccount,
): StatementSummary {
  const lines = lineRemainders(db).filter(
    (l) => l.statementId === statement.id,
  );
  const remaining = lines.filter((l) => l.remainingAmount >= EPSILON);
  return {
    ...statement,
    dateFrom: lines[0]?.date ?? null,
    dateTo: lines.at(-1)?.date ?? null,
    totalLines: lines.length,
    matchedCount: lines.length - remaining.length,
    remainingCount: remaining.length,
    remainingAmount: round2(
      remaining.reduce((s, l) => s + l.remainingAmount, 0),
    ),
    completed:
      statement.extractionState === StatementExtractionState.Ready &&
      remaining.length === 0,
  };
}
/**
 * Statement lines that still have something left to match, counted per
 * account — the dashboard's "needs attention" item (007 FR-011), by the same
 * remainder rule each statement's own summary uses. Per account because
 * reconciling happens on one account's page.
 */
export function unmatchedLinesByAccount(
  db: ReconciliationDb,
): { accountId: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const line of lineRemainders(db)) {
    if (line.remainingAmount < EPSILON || line.accountId === null) continue;
    counts.set(line.accountId, (counts.get(line.accountId) ?? 0) + 1);
  }
  return [...counts].map(([accountId, count]) => ({ accountId, count }));
}

export function listStatementSummaries(
  db: ReconciliationDb,
  locals: App.Locals,
) {
  authorize(locals, "reconciliation.read");
  return listStatements(db).map((s) => statementSummary(db, s));
}
export function getStatementDetail(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
) {
  authorize(locals, "reconciliation.read");
  const s = getStatement(db, id);
  if (!s) throw new ReconciliationError("Bank statement not found", 404);
  return {
    statement: statementSummary(db, s),
    lines: lineRemainders(db).filter((l) => l.statementId === id),
  };
}

/** Refuse an account that is not somewhere money actually sits (FR-021). */
function requirePostingAccount(db: ReconciliationDb, accountId: number) {
  const account = listReconciliableAccounts(db).find(
    (candidate) => candidate.id === accountId,
  );
  if (!account)
    throw new ReconciliationError(
      "Choose an active account for this statement.",
      409,
    );
  return account;
}

export function createStatement(
  db: ReconciliationDb,
  locals: App.Locals,
  input: {
    originalFilename: string;
    storedFilePath: string;
    accountId: number;
  },
) {
  const userId = authorize(locals, "reconciliation.create");
  requirePostingAccount(db, input.accountId);
  const s = insertStatement(db, {
    ...input,
    extractionState: StatementExtractionState.Extracting,
    uploadedBy: userId,
  });
  recordAudit(db, {
    recordType: "reconciliation",
    recordId: s.id,
    userId,
    action: "create",
  });
  reconciliationEvents.emit("statement-update", {
    statement: statementSummary(db, s),
  });
  return s;
}

/**
 * Move a statement to a different account.
 *
 * Reassigning changes which movements its lines can be matched against, so any
 * match already saved against the old account would now be a match on the wrong
 * account — the reassignment is refused until those are undone rather than
 * silently leaving them behind (FR-021, FR-034a).
 */
export function setStatementAccount(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
  accountId: number,
) {
  const userId = authorize(locals, "reconciliation.update");
  const before = getStatement(db, id);
  if (!before) throw new ReconciliationError("Bank statement not found", 404);
  requirePostingAccount(db, accountId);
  if (before.accountId === accountId) return statementSummary(db, before);

  const lineIds = new Set(listLines(db, id).map((line) => line.id));
  if (listAllocations(db).some((a) => lineIds.has(a.lineId)))
    throw new ReconciliationError(
      "Undo this statement's matches before moving it to another account.",
      409,
    );

  const after = updateStatement(db, id, { accountId })!;
  recordAudit(db, {
    recordType: "reconciliation",
    recordId: id,
    userId,
    action: "update",
    changes: diffRecords(before, after),
  });
  const summary = statementSummary(db, after);
  reconciliationEvents.emit("statement-update", { statement: summary });
  return summary;
}

export function setStatementExtraction(
  db: ReconciliationDb,
  id: number,
  state: number,
  error: string | null = null,
) {
  const before = getStatement(db, id);
  const s = updateStatement(db, id, {
    extractionState: state,
    extractionError: error,
  });
  if (s) {
    recordAudit(db, {
      recordType: "reconciliation",
      recordId: id,
      userId: s.uploadedBy,
      action: "update",
      changes: diffRecords(before, s),
    });
    reconciliationEvents.emit("statement-update", {
      statement: statementSummary(db, s),
    });
  }
  return s;
}
/**
 * Put a failed statement back in the extraction queue. The uploaded file is
 * still on disk, so a retry is just a re-run against the same
 * `storedFilePath` — the caller kicks off `processStatementImport` with the
 * statement this returns.
 *
 * Gated on `add`, the same capability that started the original import.
 */
export function retryStatementExtraction(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
) {
  authorize(locals, "reconciliation.create");
  const statement = getStatement(db, id);
  if (!statement)
    throw new ReconciliationError("Bank statement not found", 404);
  if (statement.extractionState !== StatementExtractionState.Failed)
    throw new ReconciliationError(
      "Only a failed statement can be retried",
      409,
    );
  // A failed run never reaches the insert step, so there should be nothing
  // here. Refuse rather than re-run if that ever stops holding — a second
  // pass would duplicate every transaction.
  if (listLines(db, id).length)
    throw new ReconciliationError(
      "This statement already has transactions. Delete it and upload the file again.",
      409,
    );
  return setStatementExtraction(
    db,
    id,
    StatementExtractionState.Extracting,
    null,
  )!;
}
export function editLine(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
  patch: Parameters<typeof updateLineQuery>[2],
) {
  const userId = authorize(locals, "reconciliation.update"),
    before = getLine(db, id);
  if (!before) throw new ReconciliationError("Statement line not found", 404);
  // A matched line's amount and direction are what the match was checked
  // against (`replaceMovementAllocations`). Changing either under an existing
  // match would leave it covering more than the line holds, or money the wrong
  // way, without anything noticing.
  const changesMoney =
    (patch.amount !== undefined && patch.amount !== before.amount) ||
    (patch.direction !== undefined && patch.direction !== before.direction);
  if (changesMoney && listAllocations(db).some((a) => a.lineId === id))
    throw new ReconciliationError(
      "This line is matched. Undo the match before changing its amount or direction.",
      409,
    );
  const after = updateLineQuery(db, id, patch)!;
  recordAudit(db, {
    recordType: "reconciliation",
    recordId: before.statementId,
    userId,
    action: "update",
    changes: diffRecords(before, after),
  });
  reconciliationEvents.emit("line-update", {
    line: after,
    statementId: before.statementId,
  });
  return after;
}
export function removeLine(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
) {
  const userId = authorize(locals, "reconciliation.delete"),
    before = getLine(db, id);
  if (!before) throw new ReconciliationError("Statement line not found", 404);
  deleteLineQuery(db, id);
  recordAudit(db, {
    recordType: "reconciliation",
    recordId: before.statementId,
    userId,
    action: "update",
    changes: [{ field: "line", before, after: null }],
  });
  reconciliationEvents.emit("line-deleted", {
    id,
    statementId: before.statementId,
  });
}
export function removeStatement(
  db: ReconciliationDb,
  locals: App.Locals,
  id: number,
) {
  const userId = authorize(locals, "reconciliation.delete"),
    before = getStatement(db, id);
  if (!before) throw new ReconciliationError("Bank statement not found", 404);
  deleteStatementQuery(db, id);
  deleteStatementFile(before.storedFilePath);
  recordAudit(db, {
    recordType: "reconciliation",
    recordId: id,
    userId,
    action: "delete",
  });
  reconciliationEvents.emit("statement-deleted", { id });
}

/**
 * Everything the workspace screen shows.
 *
 * Candidates are gathered per account rather than per record type: only the
 * accounts that actually have a statement are worth offering matches for, and a
 * movement is offered only against a statement on its own account (D-11).
 */
export function workspace(
  db: ReconciliationDb,
  locals: App.Locals,
  from?: string | null,
  to?: string | null,
) {
  authorize(locals, "reconciliation.read");
  const statements = listStatements(db).map((s) => statementSummary(db, s));
  const accountIds = [
    ...new Set(
      statements
        .map((statement) => statement.accountId)
        .filter((id): id is number => id != null),
    ),
  ];
  return {
    movements: listMovementCandidates(db, accountIds, from, to),
    lines: lineRemainders(db),
    statements,
    allocations: listAllocations(db),
    accounts: listReconciliableAccounts(db),
  };
}

/** How much of this movement is still unmatched, as a positive decimal. */
function remainingOf(movement: MovementCandidate): number {
  return movement.remainingAmount ?? movement.amount;
}

/**
 * Save the suggested exact-match allocations for many movements in one pass.
 *
 * Suggestions are computed per movement and independently, so two movements can
 * both propose the same statement line. Walking the list against a live
 * remainder map — rather than the snapshot each movement was suggested from —
 * lets an already-consumed line drop out of the next movement's candidate set:
 * that movement is reported as skipped and left for review instead of failing
 * the whole batch with a 409.
 *
 * Deliberately not wrapped in an outer transaction:
 * `replaceMovementAllocations` opens its own, so every movement's write is
 * atomic on its own. A throw mid-batch leaves the earlier ones legitimately
 * saved.
 */
export function autoMatchMovements(
  db: ReconciliationDb,
  locals: App.Locals,
  movementIds: number[],
) {
  const userId = authorize(locals, "reconciliation.match");
  const lines = lineRemainders(db);
  const remainingByLine = new Map(
    lines.map((line) => [line.id, line.remainingAmount]),
  );
  let matched = 0;
  let skipped = 0;
  const matchedMovementIds: number[] = [];
  const matchedRecordIds = new Set<number>();

  for (const movementId of movementIds) {
    const movement = getMovementCandidate(db, movementId);
    // Bulk matching only ever fills in untouched movements — an existing
    // allocation is somebody's decision and is never overwritten here.
    if (
      !movement ||
      (movement.allocatedAmount ?? 0) >= EPSILON ||
      remainingOf(movement) < EPSILON
    ) {
      skipped += 1;
      continue;
    }
    const suggested = suggestLinesForMovement(
      { ...movement, remainingAmount: remainingOf(movement) },
      lines.map((line) => ({
        ...line,
        remainingAmount: remainingByLine.get(line.id) ?? 0,
      })),
    );
    if (!suggested.length) {
      skipped += 1;
      continue;
    }
    let remaining = remainingOf(movement);
    const allocations: { lineId: number; amount: number }[] = [];
    for (const lineId of suggested) {
      const amount = round2(
        Math.min(remainingByLine.get(lineId) ?? 0, remaining),
      );
      if (amount < EPSILON) continue;
      remaining = round2(remaining - amount);
      allocations.push({ lineId, amount });
    }
    if (!allocations.length) {
      skipped += 1;
      continue;
    }
    const before = listMovementAllocations(db, movement.movementId);
    const saved = replaceMovementAllocationsQuery(
      db,
      movement.movementId,
      movement.amount,
      allocations,
      userId,
    );
    for (const allocation of allocations) {
      remainingByLine.set(
        allocation.lineId,
        round2(
          (remainingByLine.get(allocation.lineId) ?? 0) - allocation.amount,
        ),
      );
    }
    recordAudit(db, {
      // Filed under the ledger record the allocation belongs to (see below).
      recordType: "record",
      recordId: movement.recordId,
      userId,
      action: "update",
      changes: [
        {
          field: `allocations:movement:${movement.movementId}`,
          before,
          after: saved,
        },
      ],
    });
    matched += 1;
    matchedMovementIds.push(movement.movementId);
    matchedRecordIds.add(movement.recordId);
  }

  // One event for the whole batch: every connected client reloads the
  // workspace on any allocation event, so emitting per movement would cost
  // each open tab N redundant round-trips.
  if (matched)
    reconciliationEvents.emit("allocations-bulk-update", { matched });
  // A match locks the record's amount and changes what it reads as cleared, so
  // the records list hears about it too.
  for (const recordId of matchedRecordIds) emitRecordUpdate(db, recordId);
  return { matched, skipped, matchedMovementIds };
}

/**
 * Replace every bank line matched against one movement.
 *
 * Nothing here touches the record itself — reconciling is a note that a bank
 * line covers a movement, and it never changes an amount, a date or any content
 * (FR-024). Partial and many-to-many matching are unchanged: several lines may
 * cover one movement, and one line may be split across several (FR-022).
 */
export function replaceMovementAllocations(
  db: ReconciliationDb,
  locals: App.Locals,
  movementId: number,
  inputs: { lineId: number; amount: number }[],
) {
  const userId = authorize(locals, "reconciliation.match");
  const movement = getMovementCandidate(db, movementId);
  if (!movement)
    throw new ReconciliationError("Reconciliation record not found", 404);
  const seen = new Set<number>();
  const all = listAllocations(db);
  const direction = directionFor(movement.amountMinor);
  for (const input of inputs) {
    if (seen.has(input.lineId))
      throw new ReconciliationError(
        "A statement line can only appear once",
        409,
      );
    seen.add(input.lineId);
    if (!Number.isFinite(input.amount) || input.amount <= 0)
      throw new ReconciliationError("Allocation amounts must be positive", 409);
    const line = getLine(db, input.lineId);
    if (!line) throw new ReconciliationError("Statement line not found", 404);
    const statement = getStatement(db, line.statementId);
    // The rule this whole feature exists for: a statement's lines can only ever
    // be matched against movements on that statement's own account (FR-021).
    if (!statement || statement.accountId !== movement.accountId)
      throw new ReconciliationError(
        "This statement line belongs to a different account",
        409,
      );
    if (line.direction !== direction)
      throw new ReconciliationError(
        "This statement line has the wrong money direction",
        409,
      );
    const occupied = all
      .filter((a) => a.lineId === line.id && a.movementId !== movementId)
      .reduce((s, a) => s + a.amount, 0);
    if (input.amount - (line.amount - occupied) > EPSILON)
      throw new ReconciliationError(
        "An allocation exceeds the statement line's remaining balance",
        409,
      );
  }
  const total = inputs.reduce((s, a) => s + a.amount, 0);
  if (total - movement.amount > EPSILON)
    throw new ReconciliationError(
      "Allocations cannot exceed the Akaun record's amount",
      409,
    );
  const before = listMovementAllocations(db, movementId);
  const saved = replaceMovementAllocationsQuery(
    db,
    movementId,
    movement.amount,
    inputs.map((i) => ({ ...i, amount: round2(i.amount) })),
    userId,
  );
  recordAudit(db, {
    // Filed under the ledger record the allocation belongs to, so it shows in
    // that record's Activity — statement ids live under 'reconciliation'.
    recordType: "record",
    recordId: movement.recordId,
    userId,
    action: "update",
    changes: [
      { field: `allocations:movement:${movementId}`, before, after: saved },
    ],
  });
  reconciliationEvents.emit("allocation-update", {
    movementId,
    lineIds: [...new Set([...before, ...saved].map((a) => a.lineId))],
  });
  emitRecordUpdate(db, movement.recordId);
  return {
    movement: getMovementCandidate(db, movementId),
    allocations: saved,
  };
}

/**
 * Which of these accounts a transfer from a line on `statementAccountId` may
 * name. The records form's rule: two places money sits make a transfer;
 * anything else (equity, a category, money owed with nobody named) is an
 * adjustment. Without it the other account could be any open account, and a
 * line could write a matched, locked record into Owner's Equity on
 * `records.create` alone. The Transfer sheet offers only these.
 */
export function transferTargetIds(
  db: ReconciliationDb,
  locals: App.Locals,
  statementAccountId: number,
  accountIds: number[],
): number[] {
  const others = accountIds.filter((id) => id !== statementAccountId);
  if (can(locals, "records.adjust")) return others;
  const context = loadSidesContext(db, false);
  if (!context.ok) return [];
  return others.filter((id) => {
    const derived = sidesFromAccounts(
      {
        fromAccountId: statementAccountId,
        toAccountId: id,
        amountMinor: 0,
        contactId: null,
      },
      context.value,
    );
    return derived.ok && derived.value.kind === "transfer";
  });
}

export const TRANSFER_NEEDS_ADJUSTMENTS =
  "A transfer from a bank line goes between two places money sits. Any other account needs the Adjustments ability. Ask an administrator for it, or match the line to a record instead.";

/**
 * Turn an unmatched bank line into a transfer between two accounts the user
 * holds, and match it in the same action (FR-023).
 *
 * This is the answer to a line that has no record behind it because no record
 * was ever needed: money moved from one of the user's own pots to another, so
 * nothing was earned or spent. The record, its two sides and the match are
 * written together — a half-written transfer would leave a movement nothing
 * points at, and the line still looking unmatched.
 */
export function createTransferForLine(
  db: ReconciliationDb,
  locals: App.Locals,
  lineId: number,
  input: { otherAccountId: number; description?: string },
) {
  const userId = authorize(locals, "reconciliation.create");
  // It writes a record, so it needs the ability to add one — not only the
  // reconciliation ability that lets someone match lines.
  if (!can(locals, "records.create"))
    throw new ReconciliationError("Forbidden", 403);
  const line = getLine(db, lineId);
  if (!line) throw new ReconciliationError("Statement line not found", 404);
  const statement = getStatement(db, line.statementId);
  if (!statement)
    throw new ReconciliationError("Bank statement not found", 404);
  if (statement.accountId == null)
    throw new ReconciliationError(
      "Give this statement an account before recording a transfer from it.",
      409,
    );
  if (statement.accountId === input.otherAccountId)
    throw new ReconciliationError(
      "A transfer needs two different accounts.",
      409,
    );
  requirePostingAccount(db, input.otherAccountId);
  if (
    transferTargetIds(db, locals, statement.accountId, [input.otherAccountId])
      .length === 0
  )
    throw new ReconciliationError(TRANSFER_NEEDS_ADJUSTMENTS, 403);
  if (listAllocations(db).some((a) => a.lineId === lineId))
    throw new ReconciliationError(
      "This transaction is already matched. Undo the match before recording it as a transfer.",
      409,
    );

  // Money into the statement's account came out of the other one, and the other
  // way round for money out — the line's own direction settles both sides.
  const statementAccountId = statement.accountId;
  const movesIn = line.direction === StatementDirection.In;
  const description =
    input.description?.trim() || line.description || "Transfer";

  // Held until the transaction commits, so no tab hears about a transfer that
  // a failed match then rolls back.
  const deferredEmits: DeferredEmits = [];
  const written = db.transaction(() => {
    const created = createRecord(db, userId, {
      kind: "transfer",
      date: line.date,
      description,
      amount: line.amount,
      currency: mainCurrencyCode(db),
      exchangeRate: 1,
      fromAccountId: movesIn ? input.otherAccountId : statementAccountId,
      toAccountId: movesIn ? statementAccountId : input.otherAccountId,
    }, deferredEmits);
    if (!created.ok) throw new ReconciliationError(created.reason, 409);

    const movement = findRecordMovementOnAccount(
      db,
      created.value.id,
      statementAccountId,
    );
    if (!movement)
      throw new ReconciliationError(
        "The transfer was built without a side on this statement's account.",
        409,
      );

    const allocation = insertAllocation(db, {
      lineId,
      movementId: movement.id,
      amount: round2(line.amount),
      itemAmountSnapshot: round2(Math.abs(movement.amountMinor) / 100),
      createdBy: userId,
    });
    return { record: created.value, movementId: movement.id, allocation };
  });
  for (const emit of deferredEmits) emit();

  recordAudit(db, {
    // Filed under the ledger record the allocation belongs to, so it shows in
    // that record's Activity — statement ids live under 'reconciliation'.
    recordType: "record",
    recordId: written.record.id,
    userId,
    action: "update",
    changes: [
      {
        field: `allocations:movement:${written.movementId}`,
        before: null,
        after: [written.allocation],
      },
    ],
  });
  // Both streams hear about this: `createRecord` emits `record-update` on the
  // ledger stream for the new transfer, and the reconciliation stream is told
  // here so every open workspace sees the line stop being unmatched.
  reconciliationEvents.emit("allocation-update", {
    movementId: written.movementId,
    lineIds: [lineId],
  });
  return {
    record: written.record,
    movement: getMovementCandidate(db, written.movementId),
    allocation: written.allocation,
  };
}
