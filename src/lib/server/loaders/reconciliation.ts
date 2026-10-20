import { error, redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import {
  transferTargetIds,
  workspace,
} from "$lib/server/services/reconciliation.js";
import { suggestionsForMovements } from "$lib/server/reconciliation/suggestions.js";
import { getAccount } from "$lib/server/queries/accounts.js";
import { listMovementCandidates } from "$lib/server/queries/reconciliation.js";

/**
 * What each of the two reconciliation surfaces loads.
 *
 * Reconciling is reached from the account it belongs to, so both loaders are
 * scoped to one account and the matching surface to one statement as well
 * (FR-048, FR-052). Each surface loads only what it shows, rather than the
 * whole cross-account workspace the single page used to need.
 *
 * Only movements on the statement's own account are offered. Automatic
 * suggestions require equal dates and no competing movement; explicit manual
 * allocations can still explain different bank posting dates.
 */

function permissionsOf(locals: App.Locals) {
  return {
    view: can(locals, "reconciliation.read"),
    add: can(locals, "reconciliation.create"),
    change: can(locals, "reconciliation.update"),
    match: can(locals, "reconciliation.match"),
    delete: can(locals, "reconciliation.delete"),
  };
}

/** The account whose statements these are, or a refusal (FR-049). */
function postingAccountOr404(accountId: number) {
  const account = getAccount(db, accountId);
  if (!account) throw error(404, "That account no longer exists.");
  if (!account.active || !account.postingEligible) {
    throw error(
      400,
      "Only an active account without children can be checked against a statement.",
    );
  }
  return account;
}

/** The statements for one account, and how far each has got (FR-050). */
export function loadAccountStatements(locals: App.Locals, accountId: number) {
  if (!can(locals, "reconciliation.read")) throw redirect(302, "/dashboard");

  const account = postingAccountOr404(accountId);
  const result = workspace(db, locals);

  return {
    account,
    statements: result.statements.filter((s) => s.accountId === accountId),
    // Every money-holding account, so a statement uploaded against the wrong
    // one can be moved to the right one (FR-054).
    accounts: result.accounts,
    permissions: permissionsOf(locals),
  };
}

/** One statement's lines, its account's movements, and what is matched (FR-052). */
export function loadStatementMatch(
  locals: App.Locals,
  accountId: number,
  statementId: number,
  from?: string | null,
  to?: string | null,
) {
  if (!can(locals, "reconciliation.read")) throw redirect(302, "/dashboard");

  const account = postingAccountOr404(accountId);
  const result = workspace(db, locals, from, to);

  const statement = result.statements.find((s) => s.id === statementId);
  if (!statement) throw error(404, "That statement no longer exists.");
  // The address says which account, and the statement says which account. If
  // they disagree the link is stale — the statement was moved (FR-054).
  if (statement.accountId !== accountId) {
    throw redirect(
      302,
      `/accounts/${statement.accountId}/reconcile/${statementId}`,
    );
  }

  const lines = result.lines
    .filter((line) => line.statementId === statementId)
    .map((line) => ({
      ...line,
      statementFilename: statement.originalFilename ?? "Bank statement",
      accountName: statement.accountName ?? null,
    }));

  const allocations = result.allocations.filter((allocation) =>
    lines.some((line) => line.id === allocation.lineId),
  );

  // Conflicts must include records hidden by date filters.
  const allMovements = listMovementCandidates(db, [accountId]);
  const suggestions = suggestionsForMovements(allMovements, lines);
  const movements = result.movements
    .filter((movement) => movement.accountId === accountId)
    .map((movement) => ({
      ...movement,
      ...suggestions.get(movement.movementId)!,
    }));

  return {
    account,
    statement,
    statements: [statement],
    lines,
    movements,
    allocations,
    accounts: result.accounts,
    // The accounts the Transfer sheet may offer: the same rule the service
    // applies when the transfer is saved.
    transferTargetIds: transferTargetIds(
      db,
      locals,
      accountId,
      result.accounts.map((a) => a.id),
    ),
    permissions: permissionsOf(locals),
  };
}
