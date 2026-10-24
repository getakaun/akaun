/**
 * Every permission Akaun knows, as one tree: `root.verb`.
 *
 * Shared by the server and the pages (it imports nothing from `$lib/server`).
 * Groups and users are granted strings from this tree; personal access tokens
 * and OAuth apps carry strings from it too; a route asks for one with
 * `can(locals, "invoices.void")`. A special ability gets its own leaf here
 * rather than a column in a grid or a combination remembered in code.
 *
 * **Implication.** Granting a root (`invoices`) grants each of its leaves
 * except the ones marked `explicit`. Nothing else implies anything: `update`
 * does not imply `read`. The seeded Data Entry group adds records it cannot
 * read, and a rule that writing implies reading would quietly change that.
 *
 * **Adding a leaf** — answer each of these on purpose (CLAUDE.md § Permissions):
 * - `explicit`: should a group that holds the whole root get it without being
 *   asked? A new leaf on an existing root is otherwise granted at once to every
 *   group holding that root.
 * - `sensitive`: is it left out of a group's default delegation ceiling?
 * - `delegable: false`: may a token or an app ever hold it?
 * - Does an OAuth scope expand to it (`oauth-scopes.ts`)?
 */

/**
 * How much an ability is, for the level editor: View is every `read` ability,
 * Edit adds every `write` one, Full adds the rest (`full`). Explicit
 * abilities belong to no level — they are only ever chosen by name.
 */
export type LeafTier = "read" | "write" | "full";

type Leaf = {
  label: string;
  description: string;
  /** Default: `read` for read, `full` for delete, `write` otherwise. */
  tier?: LeafTier;
  /**
   * How it reads in a summary sentence. `verb` goes before the area's noun
   * ("see, add and send invoices"); `phrase` stands on its own ("make
   * adjustments"). One of the two; the CRUD helpers below set `verb`.
   */
  verb?: string;
  phrase?: string;
  /** Not implied by holding the root. Granted only by name. */
  explicit?: boolean;
  /** Left out of default delegation ceilings, and shown with a warning. */
  sensitive?: boolean;
  /** False: never held by a personal access token or an OAuth app. */
  delegable?: boolean;
};

type Root = {
  label: string;
  description: string;
  /** What the area's abilities act on, in a summary sentence. */
  noun: string;
  /** Only a superuser group has it; it cannot be granted to anyone else. */
  superuserOnly?: boolean;
  children: Record<string, Leaf>;
};

const read = (what: string): Leaf => ({
  label: "View",
  description: `See ${what}.`,
  verb: "see",
});
const create = (what: string): Leaf => ({
  label: "Add",
  description: `Add ${what}.`,
  verb: "add",
});
const update = (what: string): Leaf => ({
  label: "Change",
  description: `Change ${what}.`,
  verb: "change",
});
const remove = (what: string): Leaf => ({
  label: "Delete",
  description: `Delete ${what}.`,
  verb: "delete",
});

export const PERMISSION_CATALOG = {
  dashboard: {
    label: "Dashboard",
    noun: "the dashboard",
    description: "The overview of balances and recent activity.",
    children: { read: read("the dashboard") },
  },
  records: {
    label: "Records",
    noun: "records",
    description: "All transactions: purchases, sales, transfers and payments.",
    children: {
      read: read("records, their files and statements"),
      create: create("records and payments"),
      update: update("records, settle payments and attach files"),
      delete: remove("records, settlements and attachments"),
      correctDate: {
        label: "Correct settled dates",
        description:
          "Correct a settled expense or income date with a reason and review. Changes can affect previously finalized reports.",
        phrase: "correct settled dates",
        explicit: true,
        sensitive: true,
      },
      correctReimbursementAmount: {
        label: "Correct reimbursement amounts",
        description:
          "Correct a reimbursement payment amount and its expense allocations with a reason and review. Changes historical balances.",
        phrase: "correct reimbursement amounts",
        explicit: true,
        sensitive: true,
      },
      adjust: {
        label: "Adjustments",
        description:
          "Post manual journal entries between any accounts, including entries with more than two lines. This can change any balance, so grant it only by name.",
        phrase: "make adjustments",
        explicit: true,
        sensitive: true,
      },
    },
  },
  import: {
    label: "Auto Import",
    noun: "documents",
    description: "Documents read into records.",
    children: {
      read: read("import jobs and what was read from them"),
      create: {
        label: "Upload",
        description: "Upload documents to be read.",
        verb: "upload",
      },
      update: update("what was read from a document, and read it again"),
      confirm: {
        label: "Confirm",
        description: "Turn a reviewed document into records, or skip it.",
        verb: "confirm",
      },
      profiles: {
        label: "Profiles",
        description: "Create and change import profiles.",
        phrase: "manage import profiles",
      },
      delete: remove("import jobs"),
    },
  },
  contacts: {
    label: "Contacts",
    noun: "contacts",
    description: "Customers, suppliers, employees and partners.",
    children: {
      read: read("contacts"),
      create: create("contacts"),
      update: update("contacts"),
      delete: remove("contacts"),
      merge: {
        label: "Merge",
        description: "Merge duplicate contacts into one.",
        verb: "merge",
        tier: "full",
      },
    },
  },
  quotations: {
    label: "Quotations",
    noun: "quotations",
    description: "Offers sent to customers.",
    children: {
      read: read("quotations"),
      create: create("quotations"),
      update: update("quotations and their status"),
      delete: remove("quotations"),
      revise: {
        label: "Revise",
        description: "Replace a sent quotation with a new revision.",
        verb: "revise",
      },
      convert: {
        label: "Convert",
        description: "Turn an accepted quotation into an invoice.",
        verb: "convert",
      },
    },
  },
  invoices: {
    label: "Invoices",
    noun: "invoices",
    description: "Sales invoices issued to customers.",
    children: {
      read: read("invoices"),
      create: create("draft invoices"),
      update: update("invoices"),
      delete: remove("draft invoices"),
      issue: {
        label: "Send",
        description: "Mark an invoice as sent, which posts it to the ledger.",
        verb: "send",
      },
      void: {
        label: "Void",
        description:
          "Void a sent invoice, which removes its ledger posting, and reissue it.",
        verb: "void",
        tier: "full",
      },
    },
  },
  reconciliation: {
    label: "Reconciliation",
    noun: "bank statements",
    description: "Bank statements matched against ledger entries.",
    children: {
      read: read("bank statements and their matches"),
      create: create("bank statements, and transfers from their lines"),
      update: update("bank statement lines"),
      match: {
        label: "Match",
        description: "Match bank lines to records, and undo matches.",
        verb: "match",
      },
      delete: remove("bank statements and their lines"),
    },
  },
  accounts: {
    label: "Accounts",
    noun: "accounts and categories",
    description: "The chart of accounts, including categories.",
    children: {
      read: read("accounts, categories and balances"),
      create: create("accounts and categories"),
      update: update("accounts, categories and opening balances"),
      delete: remove("unused accounts"),
    },
  },
  reports: {
    label: "Reports",
    noun: "reports",
    description: "Profit & Loss, Balance Sheet and the other statements.",
    children: { read: read("reports") },
  },
  settings: {
    label: "Settings",
    noun: "settings",
    description:
      "Company details, document templates, numbering and the AI provider.",
    children: {
      read: read("settings"),
      manage: {
        label: "Manage",
        description: "Change settings, including the AI provider and its key.",
        verb: "change",
        sensitive: true,
      },
    },
  },
  audit: {
    label: "Audit log",
    noun: "the audit log",
    description:
      "Every change anyone made, and whether it came through the app, a token or a connected app.",
    children: {
      read: {
        label: "View",
        description:
          "See every change across the ledger and administration, including who changed users, groups, tokens and settings.",
        verb: "see",
        // It shows administrative changes that the holder may not otherwise
        // see, so it is chosen by name, kept out of default ceilings, and never
        // held by a token or an app: no agent reads who did what.
        explicit: true,
        sensitive: true,
        delegable: false,
      },
    },
  },
  users: {
    label: "Users & Groups",
    noun: "users and groups",
    description: "Who can sign in, and what each group may do.",
    superuserOnly: true,
    children: {
      manage: {
        label: "Manage",
        description:
          "Add users, change groups and permissions, and revoke anyone's tokens.",
        verb: "manage",
        delegable: false,
      },
    },
  },
} as const satisfies Record<string, Root>;

type Catalog = typeof PERMISSION_CATALOG;
export type PermissionRoot = keyof Catalog;
export type LeafPermission = {
  [R in PermissionRoot]: `${R}.${keyof Catalog[R]["children"] & string}`;
}[PermissionRoot];
/** A root (all its non-explicit leaves) or one leaf. */
export type Permission = PermissionRoot | LeafPermission;

export const PERMISSION_ROOTS = Object.keys(
  PERMISSION_CATALOG,
) as PermissionRoot[];

export const LEAF_PERMISSIONS: readonly LeafPermission[] =
  PERMISSION_ROOTS.flatMap((root) =>
    Object.keys(PERMISSION_CATALOG[root].children).map(
      (verb) => `${root}.${verb}` as LeafPermission,
    ),
  );

const LEAF_SET: ReadonlySet<string> = new Set(LEAF_PERMISSIONS);
const ROOT_SET: ReadonlySet<string> = new Set(PERMISSION_ROOTS);

export function isLeafPermission(value: string): value is LeafPermission {
  return LEAF_SET.has(value);
}

export function isPermission(value: string): value is Permission {
  return LEAF_SET.has(value) || ROOT_SET.has(value);
}

export type LeafMeta = Leaf & {
  permission: LeafPermission;
  root: PermissionRoot;
  rootLabel: string;
  superuserOnly: boolean;
};

export function leafMeta(permission: LeafPermission): LeafMeta {
  const [root, verb] = permission.split(".") as [PermissionRoot, string];
  const node = PERMISSION_CATALOG[root] as Root;
  return {
    ...node.children[verb],
    permission,
    root,
    rootLabel: node.label,
    superuserOnly: node.superuserOnly ?? false,
  };
}

export function leafTier(permission: LeafPermission): LeafTier {
  const meta = leafMeta(permission);
  if (meta.tier) return meta.tier;
  const verb = permission.split(".")[1];
  return verb === "read" ? "read" : verb === "delete" ? "full" : "write";
}

/** Every leaf of one area, in catalog order. */
export function leavesOf(root: PermissionRoot): LeafPermission[] {
  return Object.keys(PERMISSION_CATALOG[root].children).map(
    (verb) => `${root}.${verb}` as LeafPermission,
  );
}

export function isDelegable(permission: LeafPermission): boolean {
  return leafMeta(permission).delegable !== false;
}

/** The leaves a stored grant stands for. Unknown strings stand for nothing. */
export function expandPermission(permission: string): LeafPermission[] {
  if (LEAF_SET.has(permission)) return [permission as LeafPermission];
  if (!ROOT_SET.has(permission)) return [];
  const root = PERMISSION_CATALOG[permission as PermissionRoot] as Root;
  return Object.entries(root.children)
    .filter(([, leaf]) => !leaf.explicit)
    .map(([verb]) => `${permission}.${verb}` as LeafPermission);
}

/**
 * The leaves a set of stored grants stands for. A string no longer in the
 * catalog is dropped rather than refused, so stored data never breaks a
 * request when a permission is retired.
 */
export function expandAll(permissions: Iterable<string>): Set<LeafPermission> {
  const leaves = new Set<LeafPermission>();
  for (const permission of permissions)
    for (const leaf of expandPermission(permission)) leaves.add(leaf);
  return leaves;
}

/** Sorted in catalog order, for storage and display. */
export function sortLeaves(leaves: Iterable<LeafPermission>): LeafPermission[] {
  const wanted = new Set(leaves);
  return LEAF_PERMISSIONS.filter((leaf) => wanted.has(leaf));
}
