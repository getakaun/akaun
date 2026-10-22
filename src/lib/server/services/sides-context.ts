import { DefaultAccountPurpose } from "$lib/enums.js";
import { getAccount } from "../queries/accounts.js";
import type { SidesContext } from "../ledger/sides-from-accounts.js";
import type { LedgerDb, Refusable } from "../ledger/types.js";
import { accountDefaultId, requireAccountDefault } from "./account-defaults.js";

/**
 * The three saved accounts every derivation needs, and the account lookup.
 *
 * Shared by the record operations and by a transfer written from a bank line,
 * so both ask `sidesFromAccounts` the same question about the same accounts.
 */
export function loadSidesContext(
  db: LedgerDb,
  canAdjust: boolean,
): Refusable<SidesContext> {
  const receivable = requireAccountDefault(
    db,
    DefaultAccountPurpose.Receivable,
  );
  if (!receivable.ok) return receivable;
  const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
  if (!payable.ok) return payable;
  const opening = requireAccountDefault(
    db,
    DefaultAccountPurpose.OpeningBalances,
  );
  if (!opening.ok) return opening;
  return {
    ok: true,
    value: {
      accountById: (id) => {
        const account = getAccount(db, id);
        return account
          ? {
              id: account.id,
              type: account.type,
              role: account.role,
              subType: account.subType,
              archived: account.archivedAt !== null,
            }
          : null;
      },
      canAdjust,
      receivableAccountId: receivable.value,
      payableAccountId: payable.value,
      reimbursementPayableAccountId:
        accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable) ??
        undefined,
      openingBalancesAccountId: opening.value,
    },
  };
}
