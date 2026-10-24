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
    "Create an account or category. A category is an account: type 5 Expense or 4 Revenue. Asset and Liability accounts need a `subType` (see list_accounts for the kinds in use). `code` is optional and must sit in the type's range; omitted, the lowest free code is used.",
    createAccountShape,
    (input) => createAccount(context, input),
    { destructive: false, ids: (input) => ({ type: input.type }) },
  );

  registerWrite(
    server,
    context,
    "update_account",
    "Rename, recode or reclassify an account, or archive it with `active: false` (history is kept; it is no longer offered). Its type cannot change once it has movements. Requires the account's `version` from list_accounts.",
    { accountId: id, expectedVersion, ...updateAccountShape },
    ({ accountId, expectedVersion, ...patch }) =>
      updateAccount(context, accountId, patch, expectedVersion),
    {
      destructive: true,
      idempotent: true,
      ids: (input) => ({ accountId: input.accountId }),
    },
  );

  registerWrite(
    server,
    context,
    "delete_account",
    "Permanently delete an account that has never been used. Refused for system accounts and accounts with movements, statements or defaults; archive those with update_account instead. Present the account being removed and obtain reviewed confirmation before calling. Requires the account's version from list_accounts.",
    { accountId: id, expectedVersion },
    ({ accountId, expectedVersion }) =>
      deleteAccount(context, accountId, expectedVersion),
    { destructive: true, ids: (input) => ({ accountId: input.accountId }) },
  );

  registerWrite(
    server,
    context,
    "set_opening_balance",
    "Create or replace an account's single opening balance, in main-currency minor units (negative allowed). Zero removes an existing opening balance and needs records delete permission. Read the existing opening-balance record through list_records/get_record when available. Before replacing or removing an existing balance, present the old and new amounts and dates and historical report effects, and obtain reviewed confirmation. A specific request to create a previously absent balance authorizes creation. Refused once it is settled or bank-matched. Requires expectedVersion = the account's openingBalanceVersion from list_accounts.",
    { accountId: id, expectedVersion, ...openingBalanceShape },
    ({ accountId, expectedVersion, ...input }) =>
      setOpeningBalance(context, accountId, input, expectedVersion),
    {
      // Zero deletes the opening-balance record, and a new figure replaces it.
      destructive: true,
      idempotent: true,
      ids: (input) => ({ accountId: input.accountId }),
    },
  );

  registerWrite(
    server,
    context,
    "create_contact",
    "Create a contact (supplier, customer, employee or partner). Search list_contacts first so you do not create a duplicate.",
    createContactShape,
    (input) => createContact(context, input),
    { destructive: false },
  );

  registerWrite(
    server,
    context,
    "update_contact",
    "Change a contact's details. `roles`, when given, replaces every role. Requires the contact's `version` from list_contacts.",
    { contactId: id, expectedVersion, ...updateContactShape },
    ({ contactId, expectedVersion, ...input }) =>
      updateContact(context, contactId, input, expectedVersion),
    {
      destructive: true,
      idempotent: true,
      ids: (input) => ({ contactId: input.contactId }),
    },
  );

  registerWrite(
    server,
    context,
    "delete_contact",
    "Permanently delete a contact nothing refers to. Refused while any record, quotation or invoice names it. Present the contact being removed and obtain reviewed confirmation before calling. Requires the contact's version from list_contacts.",
    { contactId: id, expectedVersion },
    ({ contactId, expectedVersion }) =>
      deleteContact(context, contactId, expectedVersion),
    { destructive: true, ids: (input) => ({ contactId: input.contactId }) },
  );
}
