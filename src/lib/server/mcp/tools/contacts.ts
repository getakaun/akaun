import { z } from "zod";
import { contactVersion } from "../../application/version.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { EntityType, Role, LedgerRecordKindLabels } from "$lib/enums.js";
import {
  countContacts,
  getContact,
  listContacts,
} from "../../queries/contacts.js";
import {
  contactBalances,
  listOutstandingPage,
} from "../../queries/settlements.js";
import {
  registerRead,
  id,
  pageShape,
  pagination,
  McpToolError,
  type McpContext,
} from "../common.js";

const roles = {
  customer: Role.Customer,
  supplier: Role.Supplier,
  employee: Role.Employee,
  partner: Role.Partner,
};
const entityTypes = {
  individual: EntityType.Individual,
  business: EntityType.Business,
};

export function registerContacts(server: McpServer, context: McpContext) {
  registerRead(
    server,
    context,
    "list_contacts",
    "Find contacts by name or indexed directory details, role and entity type. Returns directory information only, not financial balances. For money owed use get_contact_balance, which also requires records view.",
    {
      ...pageShape,
      search: z.string().trim().max(200).optional(),
      role: z.enum(["customer", "supplier", "employee", "partner"]).optional(),
      entityType: z.enum(["individual", "business"]).optional(),
    },
    (input) => {
      const filters = {
        ...input,
        role: input.role ? roles[input.role] : undefined,
        entityType: input.entityType
          ? entityTypes[input.entityType]
          : undefined,
      };
      const rows = listContacts(context.db, filters);
      const total = countContacts(context.db, filters);
      return {
        contacts: rows.map((contact) => ({
          id: contact.id,
          legalName: contact.legalName,
          entityType: contact.entityTypeLabel,
          roles: contact.roleLabels,
          registrationNo: contact.registrationNo,
          email: contact.email,
          phone: contact.phone,
          address: contact.address,
          path: `/contacts/${contact.id}`,
          version: contactVersion(context.db, contact.id),
        })),
        pagination: pagination(total, input, rows.length),
        filters: input,
      };
    },
  );

  registerRead(
    server,
    context,
    "get_contact_balance",
    "Read CURRENT outstanding amounts for one contact: owed to us, we owe, and net (positive means owed to us). Derived from movements and settlements, not a historical balance. Use list_outstanding or list_records for supporting records.",
    { contactId: id },
    (input) => {
      const contact = getContact(context.db, input.contactId);
      if (!contact)
        throw new McpToolError("NOT_FOUND", "That contact does not exist.");
      const owedToUsMinor =
        contactBalances(context.db, "owed-to-us", contact.id)[0]
          ?.outstandingMinor ?? 0;
      const weOweMinor =
        contactBalances(context.db, "we-owe", contact.id)[0]
          ?.outstandingMinor ?? 0;
      return {
        contactId: contact.id,
        contactName: contact.legalName,
        owedToUsMinor,
        weOweMinor,
        netMinor: owedToUsMinor - weOweMinor,
        balanceBasis: "Current outstanding settlements; not an as-at report.",
        path: `/contacts/${contact.id}`,
        recordsPath: `/records?contact=${contact.id}`,
      };
    },
  );

  registerRead(
    server,
    context,
    "list_outstanding",
    "List CURRENT open receivable/payable sides and their remaining amounts. Includes unallocated payments under the app's existing outstanding rules. Full-filter totalOutstandingMinor is independent of paging. Ageing uses today (UTC); it does not reconstruct historical balances.",
    {
      ...pageShape,
      direction: z.enum(["owed-to-us", "we-owe"]),
      contactId: id.optional(),
    },
    (input) => {
      const result = listOutstandingPage(context.db, input, input);
      return {
        direction: input.direction,
        asOf: result.asOf,
        totalOutstandingMinor: result.totalOutstandingMinor,
        items: result.items.map((item) => ({
          ...item,
          kind: LedgerRecordKindLabels[item.kind],
          path: `/records/${item.recordId}`,
        })),
        pagination: pagination(result.total, input, result.items.length),
        filters: input,
        balanceBasis:
          "Current movements less all saved settlements. asOf controls ageing, not historical inclusion.",
      };
    },
  );
}
