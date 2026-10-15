import type { McpServer } from "@modelcontextprotocol/server";
import {
  createAccount,
  createAccountShape,
  deleteAccount,
  openingBalanceShape,
  setOpeningBalance,
  updateAccount,
  updateAccountShape,
} from "../../application/accounts.js";
import {
  createContact,
  createContactShape,
  deleteContact,
  mergeContacts,
  mergeContactsShape,
  updateContact,
  updateContactShape,
} from "../../application/contacts.js";
import {
  expectedVersion,
  id,
  registerWrite,
  type McpContext,
} from "../common.js";

/** Accounts (and categories, which are accounts) and contacts. */
export function registerDirectoryWrites(
  server: McpServer,
  context: McpContext,
) {
  registerWrite(
    server,
    context,
    "create_account",
    "Create an account or category. A category is an account: type 5 Expense for what money is spent on, 4 Revenue for what it is earned from. Asset and Liability accounts need a `subType` (see list_accounts for the kinds in use). `code` is optional and must sit in the type's range; omitted, the lowest free code is used.",
    createAccountShape,
    (input) => createAccount(context, input),
    { ids: (input) => ({ type: input.type }) },
  );

  registerWrite(
    server,
    context,
    "update_account",
    "Rename, recode or reclassify an account, or archive it with `active: false` (history is kept; it is no longer offered). Its type cannot change once it has movements. Requires the account's `version` from list_accounts.",
    { accountId: id, expectedVersion, ...updateAccountShape },
    ({ accountId, expectedVersion, ...patch }) =>
      updateAccount(context, accountId, patch, expectedVersion),
    { idempotent: true, ids: (input) => ({ accountId: input.accountId }) },
  );

  registerWrite(
    server,
    context,
    "delete_account",
    "Permanently delete an account that has never been used. Refused for system accounts and any account with movements, statements or defaults — archive those with update_account instead. Confirm with the user before calling.",
    { accountId: id, expectedVersion },
    ({ accountId, expectedVersion }) =>
      deleteAccount(context, accountId, expectedVersion),
    { destructive: true, ids: (input) => ({ accountId: input.accountId }) },
  );

  registerWrite(
    server,
    context,
    "set_opening_balance",
    "Create or replace an account's single opening balance, in main-currency minor units (negative allowed). Zero removes it. Refused once it is settled or bank-matched. Requires `expectedVersion` = the account's `openingBalanceVersion` from list_accounts.",
    { accountId: id, expectedVersion, ...openingBalanceShape },
    ({ accountId, expectedVersion, ...input }) =>
      setOpeningBalance(context, accountId, input, expectedVersion),
    { idempotent: true, ids: (input) => ({ accountId: input.accountId }) },
  );

  registerWrite(
    server,
    context,
    "create_contact",
    "Create a contact (supplier, customer, employee or partner). Search list_contacts first so you do not create a duplicate.",
    createContactShape,
    (input) => createContact(context, input),
  );

  registerWrite(
    server,
    context,
    "update_contact",
    "Change a contact's details. `roles`, when given, replaces every role. Requires the contact's `version` from list_contacts.",
    { contactId: id, expectedVersion, ...updateContactShape },
    ({ contactId, expectedVersion, ...input }) =>
      updateContact(context, contactId, input, expectedVersion),
    { idempotent: true, ids: (input) => ({ contactId: input.contactId }) },
  );

  registerWrite(
    server,
    context,
    "delete_contact",
    "Permanently delete a contact nothing refers to. Refused while any record, quotation or invoice names it. Confirm with the user before calling.",
    { contactId: id, expectedVersion },
    ({ contactId, expectedVersion }) =>
      deleteContact(context, contactId, expectedVersion),
    { destructive: true, ids: (input) => ({ contactId: input.contactId }) },
  );

  registerWrite(
    server,
    context,
    "merge_contacts",
    "Merge duplicate contacts: every record, quotation and invoice naming a contact in `loserIds` is moved to `survivorId`, and the losers are deleted. Pass `expectedVersions` keyed by contact id. Confirm the survivor with the user before calling; this cannot be undone.",
    mergeContactsShape,
    (input) => mergeContacts(context, input),
    {
      destructive: true,
      ids: (input) => ({
        survivorId: input.survivorId,
        loserIds: input.loserIds,
      }),
    },
  );
}
