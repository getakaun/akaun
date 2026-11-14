import {
  LedgerRecordKind,
  StatementExtractionState,
  type StatementDirectionCode,
} from "$lib/enums.js";
import { diffRecords, recordAudit } from "$lib/server/audit.js";
import { isValidDate } from "$lib/server/date.js";
import { deleteStatementFile } from "$lib/server/file-storage.js";
import { can } from "$lib/server/permissions.js";
import { fromMinor, toMinor } from "$lib/server/ledger/money.js";
import type { Minor } from "$lib/server/ledger/types.js";
import { sidesFromAccounts } from "$lib/server/ledger/sides-from-accounts.js";
import { loadSidesContext } from "$lib/server/services/sides-context.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { reconciliationEvents } from "$lib/server/reconciliation/events.js";
import {
  directionFor,
  suggestionsForMovements,
} from "$lib/server/reconciliation/suggestions.js";
import { EPSILON, round2 } from "$lib/server/reconciliation/types.js";
import { VOIDED_RECORD_REASON } from "$lib/server/queries/void-state.js";
import type {
  MovementCandidate,
  ReconciliationAllocation,
  StatementLineRow,
  StatementSummary,
  StatementWithAccount,
} from "$lib/server/reconciliation/types.js";
import {
  deleteLine as deleteLineQuery,
  deleteStatement as deleteStatementQuery,
  getLine,
  getMovementCandidate,
  getStatement,
  insertAllocation,
  insertStatement,
  listAllocations,
  listLineAllocations,
  listReconciliableAccounts,
  listLines,
  listMovementAllocations,
  listMovementCandidates,
  movementInVoidPair,
  listStatements,
  replaceMovementAllocations as replaceMovementAllocationsQuery,
  updateLine as updateLineQuery,
  updateStatement,
} from "$lib/server/queries/reconciliation.js";
import type { ReconciliationDb } from "$lib/server/queries/reconciliation.js";
import {
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
    allocatedByLine.set(
      a.lineId,
      (allocatedByLine.get(a.lineId) ?? 0) + a.amount,
    );
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
export function requirePostingAccount(db: ReconciliationDb, accountId: number) {
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
 * Conflicts are checked against all movements, including ones omitted from
 * the request. Live balances are rechecked before each atomic write.
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
  statementId?: number,
) {
  const userId = authorize(locals, "reconciliation.match");
  const statement =
    statementId === undefined ? undefined : getStatement(db, statementId);
  if (statementId !== undefined && !statement)
    throw new ReconciliationError("Bank statement not found", 404);
  const lines = lineRemainders(db).filter(
    (line) => statementId === undefined || line.statementId === statementId,
  );
  const accountIds = [
    ...new Set(
      lines.flatMap((line) =>
        line.accountId === null ? [] : [line.accountId],
      ),
    ),
  ];
  const allMovements = listMovementCandidates(db, accountIds);
  const initialSuggestions = suggestionsForMovements(allMovements, lines);
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
      movementInVoidPair(db, movementId) ||
      initialSuggestions.get(movementId)?.suggestionConflict ||
      (movement.allocatedAmount ?? 0) >= EPSILON ||
      remainingOf(movement) < EPSILON
    ) {
      skipped += 1;
      continue;
    }
    // Recheck current balances and the full population before each save.
    const liveLines = lines.map((line) => ({
      ...line,
      remainingAmount: remainingByLine.get(line.id) ?? 0,
    }));
    const suggested =
      suggestionsForMovements(
        listMovementCandidates(db, accountIds),
        liveLines,
      ).get(movementId)?.suggestedLineIds ?? [];
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
    // The match and its audit row commit together, or neither does.
    db.transaction(() => {
      const saved = replaceMovementAllocationsQuery(
        db,
        movement.movementId,
        movement.amount,
        allocations,
        userId,
      );
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
    });
    for (const allocation of allocations) {
      remainingByLine.set(
        allocation.lineId,
        round2(
          (remainingByLine.get(allocation.lineId) ?? 0) - allocation.amount,
        ),
      );
    }
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
  // A voided record and its reversal never moved money. Clearing is still
  // allowed, so nothing can be left stuck on one.
  if (inputs.length > 0 && movementInVoidPair(db, movementId))
    throw new ReconciliationError(VOIDED_RECORD_REASON, 409);
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
  // The match and its audit row commit together, or neither does.
  const saved = db.transaction(() => {
    const rows = replaceMovementAllocationsQuery(
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
        { field: `allocations:movement:${movementId}`, before, after: rows },
      ],
    });
    return rows;
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
 * The rules a transfer from a bank line keeps, whichever door it comes through
 * (FR-023): two different accounts, the other one still open, and — unless the
 * user may post adjustments — both of them places money sits
 * (`transferTargetIds`). Throws the refusal.
 */
export function assertTransferAccounts(
  db: ReconciliationDb,
  locals: App.Locals,
  statementAccountId: number,
  otherAccountId: number,
): void {
  if (statementAccountId === otherAccountId)
    throw new ReconciliationError(
      "A transfer needs two different accounts.",
      409,
    );
  requirePostingAccount(db, otherAccountId);
  if (
    transferTargetIds(db, locals, statementAccountId, [otherAccountId])
      .length === 0
  )
    throw new ReconciliationError(TRANSFER_NEEDS_ADJUSTMENTS, 403);
}

/** One bank line a new record will stand for, and what is still unmatched on it. */
export type LineToRecord = {
  line: StatementLineRow;
  /** How many matches the line already has. */
  matchCount: number;
  /** What those matches already cover, in whole cents. */
  matchedMinor: Minor;
  /** What is left to match, in whole cents. Zero or less: matched in full. */
  remainingMinor: Minor;
};

/**
 * The bank lines one new record will stand for, checked to be money moving one
 * way through one account: every line on a statement of the same account
 * (FR-021), and all in the same direction, because one record moves money one
 * way. Throws the refusal. Whether a line is already matched is left to the
 * caller, which knows how much of a match it tolerates.
 *
 * `recordName` finishes "Give this statement an account before recording …",
 * e.g. "a transfer". Asks nobody's permission: the operation calling it has.
 */
export function linesToRecord(
  db: ReconciliationDb,
  lineIds: readonly number[],
  recordName: string,
): {
  accountId: number;
  direction: StatementDirectionCode;
  lines: LineToRecord[];
} {
  const lines: LineToRecord[] = [];
  let accountId: number | undefined;
  let direction: StatementDirectionCode | undefined;
  for (const id of lineIds) {
    const line = getLine(db, id);
    if (!line)
      throw new ReconciliationError(
        lineIds.length === 1
          ? "Statement line not found"
          : `Statement line ${id} not found`,
        404,
      );
    const statement = getStatement(db, line.statementId);
    if (!statement)
      throw new ReconciliationError("Bank statement not found", 404);
    if (statement.accountId == null)
      throw new ReconciliationError(
        `Give this statement an account before recording ${recordName} from it.`,
        409,
      );
    if (accountId !== undefined && statement.accountId !== accountId)
      throw new ReconciliationError(
        "These lines are on different accounts' statements. One record can stand only for lines from one account.",
        409,
      );
    if (direction !== undefined && line.direction !== direction)
      throw new ReconciliationError(
        "These lines move money both ways. Record the money in and the money out as separate records.",
        409,
      );
    accountId = statement.accountId;
    direction = line.direction;
    const matches = listLineAllocations(db, id);
    const matchedMinor = matches.reduce(
      (sum, allocation) => sum + toMinor(allocation.amount, 1),
      0,
    );
    lines.push({
      line,
      matchCount: matches.length,
      matchedMinor,
      remainingMinor: toMinor(line.amount, 1) - matchedMinor,
    });
  }
  if (accountId === undefined || direction === undefined)
    throw new ReconciliationError("Choose at least one statement line.", 400);
  return { accountId, direction, lines };
}

/**
 * Matches bank lines to the side a record just built from them has on their
 * statement's account, each line for what is still unmatched on it (FR-023).
 *
 * Written inside the caller's transaction, audit row included, so a rollback
 * anywhere — the record refusing, or an outer batch — undoes the match and its
 * history together. The events wait in `emits` for the caller's commit.
 *
 * Asks nobody's permission and checks no amount: the operation that built the
 * record from these lines has done both.
 */
export function matchLinesToNewMovement(
  db: ReconciliationDb,
  userId: number,
  movement: { id: number; recordId: number; amountMinor: Minor },
  lines: readonly { lineId: number; amountMinor: Minor }[],
  emits: DeferredEmits,
): ReconciliationAllocation[] {
  const snapshot = fromMinor(Math.abs(movement.amountMinor));
  const saved = lines.map((line) =>
    insertAllocation(db, {
      lineId: line.lineId,
      movementId: movement.id,
      amount: fromMinor(line.amountMinor),
      itemAmountSnapshot: snapshot,
      createdBy: userId,
    }),
  );
  recordAudit(db, {
    // Filed under the ledger record the allocation belongs to, so it shows in
    // that record's Activity — statement ids live under 'reconciliation'.
    recordType: "record",
    recordId: movement.recordId,
    userId,
    action: "update",
    changes: [
      {
        field: `allocations:movement:${movement.id}`,
        before: null,
        after: saved,
      },
    ],
    deferredEmits: emits,
  });
  const lineIds = lines.map((line) => line.lineId);
  // Every open workspace sees the lines stop being unmatched. The record is
  // announced again because the event `createRecord` sent was read before the
  // match existed, so it still says "not cleared".
  emits.push(
    () =>
      reconciliationEvents.emit("allocation-update", {
        movementId: movement.id,
        lineIds,
      }),
    () => emitRecordUpdate(db, movement.recordId),
  );
  return saved;
}

// ---------------------------------------------------------------------------
// Tolerant automatic matching: one line, one movement, the exact amount, a few
// days apart
// ---------------------------------------------------------------------------

export type TolerantSkipReason =
  | "no_candidate"
  | "ambiguous_line"
  | "ambiguous_movement";

export type TolerantMatchPlan = {
  /** Each line in the period that fits one movement, which fits no other line. */
  pairs: {
    line: StatementLineRow;
    movement: MovementCandidate;
    /** How many days apart the line and the record are. */
    days: number;
  }[];
  /** Every other untouched line in the period, and why it was left alone. */
  skipped: { lineId: number; reason: TolerantSkipReason }[];
};

const MILLISECONDS_PER_DAY = 86_400_000;

/** Days since the epoch, or null for anything that is not a real calendar date. */
function dayNumber(date: string): number | null {
  return isValidDate(date)
    ? Date.parse(`${date}T00:00:00Z`) / MILLISECONDS_PER_DAY
    : null;
}

/**
 * Which untouched lines on one account fit exactly one untouched movement on
 * it: the same amount to the cent, the same direction, and dates at most
 * `maxDays` apart — where that movement also fits no other line. A choice
 * between two is a person's to make, never input order's, so a tie either way
 * is skipped with its reason.
 *
 * Untouched means no match at all: a line with no allocation, and a movement
 * no bank line covers any part of. A voided record and its reversal are never
 * candidates, and neither is an opening balance: a person may still match one
 * by hand. Uniqueness is judged against every untouched line on the
 * account, so a twin just outside `from`..`to` still makes a movement
 * ambiguous; the period only picks which lines are acted on.
 *
 * Not `rankCandidates`: its one-percent band and fixed seven-day window are
 * the rules for a suggestion a person reviews, and this saves without one.
 */
export function planTolerantMatches(
  db: ReconciliationDb,
  input: { accountId: number; from?: string; to?: string; maxDays: number },
): TolerantMatchPlan {
  const touched = new Set(listAllocations(db).map((a) => a.lineId));
  const lines = listStatements(db)
    .filter((statement) => statement.accountId === input.accountId)
    .flatMap((statement) => listLines(db, statement.id))
    .filter((line) => !touched.has(line.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  // Untouched movements, filed by direction and exact amount, so each line
  // looks only at the movements it could possibly be.
  const byFit = new Map<
    string,
    { movement: MovementCandidate; day: number }[]
  >();
  for (const movement of listMovementCandidates(db, [input.accountId])) {
    const day = dayNumber(movement.date);
    if (
      day === null ||
      movement.amountMinor === 0 ||
      (movement.allocationCount ?? 0) > 0 ||
      // What an account held on the day the books start is no bank event,
      // however exactly a deposit's amount happens to equal it.
      movement.kind === LedgerRecordKind.OpeningBalance
    )
      continue;
    const key = `${directionFor(movement.amountMinor)}:${Math.abs(movement.amountMinor)}`;
    const list = byFit.get(key) ?? [];
    list.push({ movement, day });
    byFit.set(key, list);
  }

  const fitsByLine = new Map<
    number,
    { movement: MovementCandidate; days: number }[]
  >();
  const linesPerMovement = new Map<number, number>();
  for (const line of lines) {
    const day = dayNumber(line.date);
    const fits =
      day === null
        ? []
        : (byFit.get(`${line.direction}:${toMinor(line.amount, 1)}`) ?? [])
            .map(({ movement, day: movementDay }) => ({
              movement,
              days: Math.abs(day - movementDay),
            }))
            .filter(({ days }) => days <= input.maxDays);
    fitsByLine.set(line.id, fits);
    for (const { movement } of fits)
      linesPerMovement.set(
        movement.movementId,
        (linesPerMovement.get(movement.movementId) ?? 0) + 1,
      );
  }

  const plan: TolerantMatchPlan = { pairs: [], skipped: [] };
  for (const line of lines) {
    if (input.from && line.date < input.from) continue;
    if (input.to && line.date > input.to) continue;
    const fits = fitsByLine.get(line.id) ?? [];
    if (fits.length === 0)
      plan.skipped.push({ lineId: line.id, reason: "no_candidate" });
    else if (fits.length > 1)
      plan.skipped.push({ lineId: line.id, reason: "ambiguous_line" });
    else if ((linesPerMovement.get(fits[0].movement.movementId) ?? 0) > 1)
      plan.skipped.push({ lineId: line.id, reason: "ambiguous_movement" });
    else plan.pairs.push({ line, ...fits[0] });
  }
  return plan;
}

/**
 * Saves `planTolerantMatches`' pairs, each line covering its movement in full,
 * inside the caller's transaction, with each record's audit row beside it —
 * the row `autoMatchMovements` writes. The events wait in `emits`.
 *
 * Asks nobody's permission: the operation calling it has.
 */
export function saveTolerantMatches(
  db: ReconciliationDb,
  userId: number,
  pairs: TolerantMatchPlan["pairs"],
  emits: DeferredEmits,
): ReconciliationAllocation[] {
  const saved: ReconciliationAllocation[] = [];
  const recordIds = new Set<number>();
  for (const { line, movement } of pairs) {
    const allocation = insertAllocation(db, {
      lineId: line.id,
      movementId: movement.movementId,
      amount: fromMinor(toMinor(line.amount, 1)),
      itemAmountSnapshot: fromMinor(Math.abs(movement.amountMinor)),
      createdBy: userId,
    });
    recordAudit(db, {
      recordType: "record",
      recordId: movement.recordId,
      userId,
      action: "update",
      changes: [
        {
          field: `allocations:movement:${movement.movementId}`,
          before: [],
          after: [allocation],
        },
      ],
      deferredEmits: emits,
    });
    saved.push(allocation);
    recordIds.add(movement.recordId);
  }
  // One event for the batch, as `autoMatchMovements` sends. Each matched
  // record now reads as cleared, so the records list hears about it too.
  const matched = saved.length;
  if (matched)
    emits.push(() =>
      reconciliationEvents.emit("allocations-bulk-update", { matched }),
    );
  for (const recordId of recordIds)
    emits.push(() => emitRecordUpdate(db, recordId));
  return saved;
}
