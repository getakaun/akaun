import { read, readTool, write, writeTool } from "./define.js";

/** Contacts: `find_contacts`, `get_contact`, `change_contacts`. */

/**
 * v1 `list_contacts`. Balances need records read as well (v1 kept them in
 * `get_contact_balance` for that reason), so a balance filter is a check.
 */
export const FIND_CONTACTS = readTool(read(["contacts:read"]), {
  balances: read(["contacts:read", "records:read"]),
});

/** v1 `get_contact_balance`: balances and open items come from the records. */
export const GET_CONTACT = readTool(read(["contacts:read", "records:read"]));

export const CHANGE_CONTACTS = writeTool({
  // v1 `create_contact`.
  create: write(["contacts:write"], ["contacts.create"]),
  // v1 `update_contact`.
  update: write(["contacts:write"], ["contacts.update"]),
  // No v1 tool. `mergeContacts` asks for merge, update and delete: the
  // merged contacts' records move to the kept one and the merged contacts
  // are deleted. `contacts:merge` is opt-in and stands for merge alone.
  merge: write(
    ["contacts:merge", "contacts:write", "contacts:delete"],
    ["contacts.merge", "contacts.update", "contacts.delete"],
  ),
  // v1 `delete_contact`.
  delete: write(["contacts:delete"], ["contacts.delete"]),
});
