import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  index,
  check,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { ExpenseTaxSnapshot, TaxTreatment } from "$lib/expense-tax.js";
import type { CapitalSchedule } from "$lib/capital-allowance.js";
import type { TaxSourceSnapshot } from "$lib/tax-worksheet.js";
import type { AssetSourceSnapshot } from "$lib/fixed-assets.js";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("owner"),
  name: text("name"),
  /** @deprecated Revoked by migration 0033; see `personal_access_tokens`. */
  bearerToken: text("bearer_token").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// OAuth credentials are separate from legacy API tokens and browser sessions.
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  authMethod: text("auth_method").notNull().default("none"),
  secretHash: text("secret_hash"),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const oauthPending = sqliteTable("oauth_pending", {
  idHash: text("id_hash").primaryKey(),
  browserHash: text("browser_hash").notNull(),
  params: text("params").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("oauth_grants_user_idx").on(t.userId)],
);

export const oauthCodes = sqliteTable("oauth_codes", {
  hash: text("hash").primaryKey(),
  grantId: text("grant_id")
    .notNull()
    .references(() => oauthGrants.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  challenge: text("challenge").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    accessHash: text("access_hash").primaryKey(),
    refreshHash: text("refresh_hash").notNull().unique(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    refreshUsedAt: integer("refresh_used_at"),
  },
  (t) => [index("oauth_tokens_grant_idx").on(t.grantId)],
);

export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  isSuperuser: integer("is_superuser", { mode: "boolean" })
    .notNull()
    .default(false),
});

/** @deprecated Read by nothing since migration 0033; dropped next release. */
export const groupPermissions = sqliteTable(
  "group_permissions",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    canView: integer("can_view", { mode: "boolean" }).notNull().default(false),
    canAdd: integer("can_add", { mode: "boolean" }).notNull().default(false),
    canChange: integer("can_change", { mode: "boolean" })
      .notNull()
      .default(false),
    canDelete: integer("can_delete", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.resource] })],
);

/**
 * What a group's members may do: permission strings from
 * `$lib/permissions/catalog.ts` (`invoices.issue`, or a root such as
 * `invoices` for all its non-explicit leaves). Replaces `group_permissions`'s
 * fixed view/add/change/delete grid, which is kept, unread, for one release
 * so migration 0033's conversion stays inspectable.
 */
export const groupGrants = sqliteTable(
  "group_grants",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.permission] })],
);

/**
 * What a group's members may hand on to a personal access token or an OAuth
 * app — the administrator's ceiling on delegation. Always a subset of the
 * group's own grants (`trimDelegations`); a credential's effective access is
 * role ∩ this ceiling ∩ the credential's own permissions, worked out on every
 * request.
 */
export const groupDelegations = sqliteTable(
  "group_delegations",
  {
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.permission] })],
);

/** Extra permissions for one user, on top of their groups'. Only ever adds. */
export const userGrants = sqliteTable(
  "user_grants",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.permission] })],
);

/**
 * Personal access tokens, fine-grained: each carries its own permissions,
 * never more than its owner's role ∩ delegation ceiling at the moment it is
 * used. Only a hash of the secret is stored. Replaces `users.bearer_token`
 * (one raw token per user, full access), which migration 0033 revokes.
 */
export const personalAccessTokens = sqliteTable(
  "personal_access_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    lastFour: text("last_four").notNull(),
    /** JSON array of permission strings. */
    permissions: text("permissions").notNull(),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    /** Who made it: the owner, or an administrator for a service user. */
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    index("personal_access_tokens_user_idx").on(t.userId),
    uniqueIndex("personal_access_tokens_live_name_idx")
      .on(t.userId, t.name)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const userGroups = sqliteTable(
  "user_groups",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);

/** @deprecated Read by nothing since migration 0033; dropped next release. */
export const userPermissions = sqliteTable(
  "user_permissions",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    canView: integer("can_view", { mode: "boolean" }).notNull().default(false),
    canAdd: integer("can_add", { mode: "boolean" }).notNull().default(false),
    canChange: integer("can_change", { mode: "boolean" })
      .notNull()
      .default(false),
    canDelete: integer("can_delete", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.resource] })],
);

export const userNavPreferences = sqliteTable(
  "user_nav_preferences",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    showOnMobile: integer("show_on_mobile", { mode: "boolean" })
      .notNull()
      .default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] })],
);

// Per-user scalar preferences (KV), the per-user mirror of the global `settings` table.
export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
});

// ---------------------------------------------------------------------------
// Contacts — shared directory of parties the ledger transacts with (Phase 2.6).
// entity_type / role are INTEGER codes; see src/lib/server/enums.ts.
// ---------------------------------------------------------------------------
export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // EntityType code (1 = individual, 2 = business). No default — UI forces choice.
  entityType: integer("entity_type").notNull(),
  legalName: text("legal_name").notNull(),
  registrationNo: text("registration_no"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  remark: text("remark"),
  createdBy: integer("created_by").references(() => users.id),
  updatedBy: integer("updated_by").references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const contactRoles = sqliteTable(
  "contact_roles",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // Role code (1 = customer, 2 = supplier, 3 = employee). See enums.ts.
    role: integer("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.role] }),
    // Required: makes the "all suppliers" filter (queries role first) index-only.
    index("contact_roles_role_contact_idx").on(t.role, t.contactId),
  ],
);

export const contactSearchText = sqliteTable("contact_search_text", {
  contactId: integer("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
});

// `claims`, `expenses` and `incomes` were here, with their attachment and
// search-text side tables. Every one of them is dropped by this release: the
// double-entry conversion moved their rows into `ledger_records` +
// `ledger_movements`, and nothing has read them since (FR-037, data-model.md
// §1). The migration that drops them is gated by `legacy-drop-guard.ts`, which
// refuses to start a server whose records have not been converted yet.

// Document types that get an auto-generated running number. A local enum (not
// $lib/enums.ts's unrelated `DocumentType`) to avoid import collisions in
// files that touch both areas.
export const SEQUENCE_DOCUMENT_TYPE = {
  expense: 0,
  income: 1,
  // Renamed from `claim`; the code stays 2 and the prefix stays 'CL' so every
  // number already issued keeps counting from where it left off. See the note on
  // SEQUENCE_PREFIXES in $lib/sequence-template.ts.
  payment: 2,
  quotation: 3,
  invoice: 4,
} as const;
export type SequenceDocumentType = keyof typeof SEQUENCE_DOCUMENT_TYPE;
export type SequenceDocumentTypeCode =
  (typeof SEQUENCE_DOCUMENT_TYPE)[keyof typeof SEQUENCE_DOCUMENT_TYPE];

// Global running-number counters across the shared ledger (no per-user split).
// Bucket = (documentType, bucketKey), where bucketKey is derived by resolving
// {PREFIX}/date tokens in the shared template for a given date and stripping
// the {SEQ[:N]} token — see running-number.ts / $lib/sequence-template.ts.
export const appSequences = sqliteTable(
  "app_sequences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentType: integer("document_type").notNull(), // SEQUENCE_DOCUMENT_TYPE code
    bucketKey: text("bucket_key").notNull(),
    lastSequence: integer("last_sequence").notNull().default(0),
  },
  (t) => [
    uniqueIndex("app_sequences_doctype_bucket_idx").on(
      t.documentType,
      t.bucketKey,
    ),
  ],
);

// App-wide settings shared by all users (global KV).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Cache of historical exchange rates, stored in the provider's native pair shape: each
// row is `rate` = `quote` units per 1 `base` on `date`. Rows are self-describing, so a
// later main-currency change needs no invalidation — new lookups simply use a different
// `base` and old rows remain valid historical facts. Same-day same-pair transactions
// reuse a row and avoid extra API calls. Rows are immutable (historical rates don't
// change); no TTL.
export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    date: text("date").notNull(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    rate: real("rate").notNull(),
    fetchedAt: text("fetched_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [primaryKey({ columns: [t.date, t.base, t.quote] })],
);

export const llmProviders = sqliteTable("llm_providers", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().default(""),
  // A `chatgpt` provider signs in instead of holding a key: the OAuth tokens
  // from Sign in with ChatGPT, as JSON (`ChatgptCredentials`). Held like the
  // key — the settings loader strips it before anything reaches a browser.
  oauthCredentials: text("oauth_credentials"),
  model: text("model").notNull(),
  baseUrl: text("base_url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortKey: text("sort_key").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * The fields a person reviews before an imported document becomes a record:
 * what was read off it, the contact and category matched to it, the duplicate
 * warning, and the account that paid or received it.
 *
 * A receipt keeps them on its queue row. A document with several items keeps
 * one set per item, in `import_items`. Both tables take their columns from this
 * one function, so a field added for review reaches both, and the two can never
 * disagree about a name or a type. It is a function because a table needs its
 * own column objects: two tables cannot share one.
 *
 * The queue row's columns were here long before items were, and their names
 * and types are fixed by the rows already stored. Change them only with a
 * migration that keeps those rows as they are.
 */
function reviewColumns() {
  return {
    expensePaymentSource: text("expense_payment_source", {
      enum: ["company", "personal", "unpaid"],
    }),
    supplierContactId: integer("supplier_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),
    paidByContactId: integer("paid_by_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),
    // DocumentType code (1 = expense, 2 = income, 3 and 4 = a transfer out of
    // or into the account the document is about). See enums.ts. On an item it
    // is the item's kind: set by its section, or by the sign of its amount.
    documentType: integer("document_type"),
    itemName: text("item_name"),
    // RAW extracted name string (entity tables carry no text name).
    supplier: text("supplier"),
    // Set only on a confident exact-normalized match against contacts.legal_name.
    matchedContactId: integer("matched_contact_id").references(
      () => contacts.id,
      {
        onDelete: "set null",
      },
    ),
    // JSON array of ranked fuzzy candidates [{id, legalName, score}].
    matchCandidates: text("match_candidates"),
    date: text("date"),
    amount: real("amount"),
    // Detected currency (ISO-4217) and its rate to the main currency. Null until the
    // LLM/worker resolve them; rate stays null when no API key (manual entry at review).
    currency: text("currency"),
    exchangeRate: real("exchange_rate"),
    reference: text("reference"),
    category: text("category"),
    categoryAccountId: integer("category_account_id").references(
      () => accounts.id,
      {
        onDelete: "set null",
      },
    ),
    remark: text("remark"),
    duplicateOf: integer("duplicate_of"),
    // 0-100 weighted-match confidence; set only when duplicateOf is set. See duplicate-detector.ts.
    duplicateConfidence: integer("duplicate_confidence"),
    // JSON array of contributing signal labels (e.g. ["reference","content"]), highest-weight first.
    duplicateReasons: text("duplicate_reasons"),
    // Which account the imported record affected — "which account paid?" /
    // "which account received it?" (FR-019, FR-011). Nullable because a queued
    // document may reach review before the user has said; the review screen
    // pre-selects the default account and confirm requires one.
    accountId: integer("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    // Something the reader could not do as the profile asked, in words for the
    // reviewer, such as a fee type's tied category that is for the other kind
    // of line (006 FR-034). While it is set, a confirm-all leaves the item for
    // the reviewer to look at. Choosing a category clears it. Null when there
    // is nothing to say, as for every receipt.
    reviewNote: text("review_note"),
    // What the reviewer is to check that no category choice answers: the
    // section's flag rule (006 FR-061) and money another profile's records
    // may already hold (FR-066). Kept apart from `review_note` because
    // choosing a category clears that one: a bulk "Set category" must not
    // wipe a warning that the line may be counted twice. While it is set, a
    // confirm-all leaves the item behind, and it is confirmed on its own.
    checkNote: text("check_note"),
    // The other side of a transfer (006 FR-058): the account money moved to
    // from `account_id`, or came from into it, as `document_type` says. Null
    // for an expense or an income, which name a category instead, and for
    // every receipt.
    counterAccountId: integer("counter_account_id").references(
      () => accounts.id,
      {
        onDelete: "set null",
      },
    ),
  };
}

/** The name of each review column, as the queue row and an item both have it. */
export type ReviewColumnName = keyof ReturnType<typeof reviewColumns>;

/** The review columns' names, in the order both tables list them. */
export const REVIEW_COLUMN_NAMES = Object.keys(
  reviewColumns(),
) as ReviewColumnName[];

export const importQueue = sqliteTable("import_queue", {
  id: text("id").primaryKey(),
  // Who uploaded the file; used for `created_by` on the resulting contact/record,
  // not for visibility filtering (shared ledger).
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // ImportState code. See enums.ts.
  state: integer("state").notNull().default(1),
  tempFilePath: text("temp_file_path").notNull(),
  originalFilename: text("original_filename").notNull(),
  // SHA-256 hex of the raw uploaded bytes, for byte-identical duplicate detection.
  // Null for rows uploaded before this column existed.
  fileHash: text("file_hash"),
  // Caller-supplied text (e.g. from client-side OCR) that skips server-side
  // extraction/OCR entirely when present. See worker.ts processJob().
  preExtractedText: text("pre_extracted_text"),
  // Raw OCR/PDF text actually used for this job (either preExtractedText or the
  // server-side extraction result), carried through to the confirmed expense/income
  // row so it becomes searchable. See worker.ts processJob() and the confirm route.
  extractedText: text("extracted_text"),
  // What was read off the document, and what the reviewer changes before
  // confirming. The same columns sit on each item of a group; see reviewColumns.
  ...reviewColumns(),
  resultId: integer("result_id"),
  // DocumentType code, mirrors document_type post-confirm.
  resultType: integer("result_type"),
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  processedAt: text("processed_at"),
  confirmedAt: text("confirmed_at"),
  completedAt: text("completed_at"),

  // How the document is to be read, and how it was read (006). Every column
  // below is empty on a row uploaded before them, and an empty row is read the
  // way every document was then: as one receipt or invoice.

  // What the uploader chose under "Read as": an ImportReadAs value
  // ($lib/import-reading.ts). Null on an older row, which means a receipt.
  readAs: text("read_as"),
  // The profile the document was read with, once one is known: the saved
  // profile's id, or the id of a built-in reading such as several items. Null
  // for the standard reading.
  profileId: text("profile_id"),
  // A copy of that profile as it was when this document was read, as JSON. A
  // profile edited, disabled or deleted later does not change this group
  // (FR-038), and "Read again" can say what the first reading used.
  profileSnapshot: text("profile_snapshot"),
  // Summary or every transaction: an ImportMode value. Only a reading with a
  // profile uses it; null otherwise.
  importMode: text("import_mode"),
  // How the reading was picked: an ImportReadHow value (chosen, detected, or
  // the standard reading as the fallback). The screen shows it (FR-041).
  readHow: text("read_how"),
  // What reading the document found besides its items, as JSON: the total the
  // document states for them, the control total worked out from the items as
  // read, and the lines it left out. See $lib/import-reading.ts.
  extractionNotes: text("extraction_notes"),
  // How far a long reading has got, for the queue to show. Null while nothing
  // is counted, as for a receipt.
  progressDone: integer("progress_done"),
  progressTotal: integer("progress_total"),
  // The Source account chosen once for a whole group. Each item takes it when
  // it is chosen, and keeps its own copy in its account column, so changing
  // one item later changes only that item (US4 scenario 4).
  groupAccountId: integer("group_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
});

/**
 * One line of a document that is to become its own record: an item of a group.
 *
 * A group is a queue row that was read as several items. Its items live here
 * and not as more queue rows, so the queue, its live updates and the history
 * never have to tell a document from a line of one. Deleting the queue row
 * deletes its items. A record made from an item is found through the item's
 * result, just as a receipt's record is found through its queue row.
 *
 * The file is the queue row's; an item has none of its own. Nor does an item
 * keep any document text, so the duplicate check and the record's search text
 * never see the whole document (FR-025, FR-029).
 */
export const importItems = sqliteTable(
  "import_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => importQueue.id, { onDelete: "cascade" }),
    // ImportState code. An item is born waiting for review, and ends Imported
    // or Skipped. See enums.ts.
    state: integer("state").notNull().default(4),
    // Where the item stood among the document's items, from 0. The group page
    // lists them in this order.
    position: integer("position").notNull(),
    // The numbered line of the document text the item was read from. Null when
    // the reading did not say.
    sourceLine: integer("source_line"),
    // The section of the profile the item was read under, by its key. The
    // several-items reading is a built-in profile with one section.
    sectionKey: text("section_key").notNull(),
    // The fee type the reader gave the line, when its section lists fee types.
    feeType: text("fee_type"),
    // The profile's extra fields for this line, as a JSON object of plain
    // values. Null when the profile has none.
    extrasJson: text("extras_json"),
    ...reviewColumns(),
    // The record this item became, and its DocumentType code, once imported.
    resultId: integer("result_id"),
    resultType: integer("result_type"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [index("import_items_job_state_idx").on(t.jobId, t.state)],
);

/**
 * A saved way of reading one kind of document: an import profile (006 US6-7,
 * FR-030 to FR-038). The user fills in a form and the server builds the schema
 * sent to the model from it; the form's values are what is stored here, as
 * checked by `$lib/import-profile-schema.ts`.
 *
 * A profile is deleted outright, not archived. A document already read with
 * it keeps its own copy of the profile on its queue row
 * (`import_queue.profile_snapshot`), so neither an edit nor a delete changes a
 * group already read (FR-038). The id is never reused (AUTOINCREMENT), so an
 * old queue row's profile id can never name a newer profile.
 */
export const importProfiles = sqliteTable("import_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // How to recognise the document, in plain words.
  description: text("description").notNull().default(""),
  // Text the document always prints, as a JSON list of strings.
  phrasesJson: text("phrases_json").notNull().default("[]"),
  // Replaces the general import instructions for this profile (FR-036).
  instructions: text("instructions").notNull().default(""),
  // The sections, as a JSON list of ProfileSection.
  sectionsJson: text("sections_json").notNull().default("[]"),
  // Which printed total each import mode compares against, as a JSON object
  // keyed by mode ("summary", "every_transaction"). A mode with no key names
  // no total.
  statedTotalLabelsJson: text("stated_total_labels_json")
    .notNull()
    .default("{}"),
  // The rest of the profile's form that is about the whole document, as a
  // JSON object: `accountId`, the account the document is about (the
  // marketplace wallet of a wallet report, FR-058), and later the table
  // layout of a spreadsheet (FR-053). "{}" names neither.
  optionsJson: text("options_json").notNull().default("{}"),
  // A disabled profile is not offered under "Read as" (US6 AS12).
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedBy: integer("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ---------------------------------------------------------------------------
// Phase 7 — Quotations & Invoicing
// sourceQuotationId / convertedInvoiceId are plain integers (no cross-FK) to
// avoid circular FK issues between the two tables. App logic enforces the link.
// ---------------------------------------------------------------------------

export const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceNumber: text("invoice_number").notNull().unique(),
  contactId: integer("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  // InvoiceStatus code (1=Draft, 2=Sent, 3=Paid, 4=Cancelled). See enums.ts.
  status: integer("status").notNull().default(1),
  reference: text("reference"),
  issueDate: text("issue_date").notNull(),
  dueDate: text("due_date"),
  currency: text("currency").notNull().default("USD"),
  exchangeRate: real("exchange_rate").notNull().default(1),
  subtotal: real("subtotal").notNull(),
  taxAmount: real("tax_amount").notNull().default(0),
  total: real("total").notNull(),
  /** @deprecated Stops being read — how much is paid is derived from settlements (D-10). */
  amountPaid: real("amount_paid").notNull().default(0),
  notes: text("notes"),
  terms: text("terms"),
  // Plain integer — no FK to avoid circular reference with quotations.
  sourceQuotationId: integer("source_quotation_id"),
  // The voided invoice this one was reissued to replace. A sent invoice is never
  // edited for money; it is voided and a linked copy is issued in its place.
  replacesInvoiceId: integer("replaces_invoice_id"),
  // `result_income_id` was here. Its job passed to `ledger_record_id`, and its
  // foreign key pointed into `incomes` — one of the tables this release drops,
  // which is why the migration has to rebuild this table rather than only drop
  // the column (FR-037b, data-model.md §1).
  // Which income category the invoice earns into, chosen on issue and defaulting
  // to the seeded Sales income account (FR-018a).
  incomeAccountId: integer("income_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  // The record that issuing this invoice created: +total into Money owed to us,
  // −total into `income_account_id` (FR-018a).
  ledgerRecordId: integer("ledger_record_id").references(
    () => ledgerRecords.id,
    { onDelete: "set null" },
  ),
  createdBy: integer("created_by").references(() => users.id),
  updatedBy: integer("updated_by").references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const quotations = sqliteTable("quotations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quotationNumber: text("quotation_number").notNull().unique(),
  contactId: integer("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  // QuotationStatus code (1=Draft, 2=Sent, 3=Accepted, 4=Declined, 5=Converted,
  // 6=Superseded). See enums.ts.
  status: integer("status").notNull().default(1),
  reference: text("reference"),
  issueDate: text("issue_date").notNull(),
  expiryDate: text("expiry_date"),
  currency: text("currency").notNull().default("USD"),
  exchangeRate: real("exchange_rate").notNull().default(1),
  subtotal: real("subtotal").notNull(),
  taxAmount: real("tax_amount").notNull().default(0),
  total: real("total").notNull(),
  notes: text("notes"),
  terms: text("terms"),
  // Plain integer — no FK to avoid circular reference with invoices.
  convertedInvoiceId: integer("converted_invoice_id"),
  // 0 for an original; n for the nth revision (number suffixed `-R<n>`). A quote
  // that has gone to the customer is never edited; it is revised into a new
  // draft and the old one is marked Superseded, pointing at its replacement.
  revision: integer("revision").notNull().default(0),
  supersededById: integer("superseded_by_id"),
  createdBy: integer("created_by").references(() => users.id),
  updatedBy: integer("updated_by").references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const quotationLines = sqliteTable("quotation_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quotationId: integer("quotation_id")
    .notNull()
    .references(() => quotations.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const invoiceLines = sqliteTable("invoice_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: real("quantity").notNull(),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const quotationSearchText = sqliteTable("quotation_search_text", {
  quotationId: integer("quotation_id")
    .primaryKey()
    .references(() => quotations.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
});

export const invoiceSearchText = sqliteTable("invoice_search_text", {
  invoiceId: integer("invoice_id")
    .primaryKey()
    .references(() => invoices.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
});

// ---------------------------------------------------------------------------
// Audit trail — one row per create/update/delete across every editable record
// type. Standard editing (no more "god mode") is offset by always knowing who
// changed what and when. See src/lib/server/audit.ts.
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // A RecordType from src/lib/server/audit.ts.
    recordType: text("record_type").notNull(),
    // Text, because some audited things have text ids (an OAuth grant, an LLM
    // provider, an import job) or none at all (a settings section).
    recordId: text("record_id").notNull(),
    // What the record was called when this was written, so a deleted record
    // still reads as something.
    recordLabel: text("record_label"),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The acting user's name when this was written — users are hard-deleted.
    actorName: text("actor_name"),
    // How the change arrived: 'session' | 'pat' | 'oauth' | 'system'.
    via: text("via").notNull(),
    // The personal access token id or OAuth grant id behind a 'pat'/'oauth' write.
    credentialId: text("credential_id"),
    // The OAuth client id behind an 'oauth' write.
    clientId: text("client_id"),
    // The token's name or the app's name when this was written.
    credentialLabel: text("credential_label"),
    // Every change made by one request (one MCP tool call) shares this.
    requestId: text("request_id"),
    // 'POST /api/records' or 'mcp:create_record'.
    operation: text("operation"),
    // 'create' | 'update' | 'delete'
    action: text("action").notNull(),
    // JSON: FieldChange[] — [{ field, before, after }]. A delete carries the
    // whole row as `before`.
    changes: text("changes"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("audit_log_record_idx").on(t.recordType, t.recordId, t.createdAt),
    index("audit_log_user_idx").on(t.userId, t.id),
    index("audit_log_via_idx").on(t.via, t.id),
    index("audit_log_client_idx").on(t.clientId, t.id),
    index("audit_log_request_idx").on(t.requestId),
  ],
);

// ---------------------------------------------------------------------------
// Reconciliation — checks the ledger against a bank statement without changing
// the cash-basis single-entry model. No column is added to expenses, incomes,
// or claims: allocation state is derived from reconciliation_allocations.
// See specs/001-bank-reconciliation/data-model.md.
// ---------------------------------------------------------------------------
export const bankStatements = sqliteTable(
  "bank_statements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    originalFilename: text("original_filename").notNull(),
    storedFilePath: text("stored_file_path").notNull(),
    extractionState: integer("extraction_state").notNull().default(2),
    extractionError: text("extraction_error"),
    uploadedBy: integer("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    // Which account this statement belongs to (FR-021). Only movements on this
    // account are ever offered as matches for its lines.
    //
    // Required in behaviour, nullable in the column, and it cannot be otherwise:
    // a pre-upgrade statement predates the chart of accounts, which the ledger
    // upgrade seeds *after* Drizzle has applied the migration. SQLite will not
    // add a NOT NULL column without a default, and any non-null default here
    // would name an account row that does not exist yet — a foreign-key
    // violation during the migration itself. So the column arrives nullable, the
    // upgrade's reconciliation phase assigns the default bank account to every
    // existing statement (FR-034a), and `POST /api/reconciliation/statements`
    // requires an accountId from then on (FR-021). Null means "not yet
    // assigned", and only a row that predates the upgrade can be in that state.
    //
    // Declared LAST on purpose: Drizzle rewrites a SQLite table wholesale when a
    // column is inserted mid-list, and rewriting this one would mean dropping a
    // table `bank_statement_lines` still references. Migrations run inside a
    // transaction, where `PRAGMA foreign_keys=OFF` is a no-op, so that drop
    // fails on any database that holds real statement lines. Appending keeps the
    // migration a plain ADD COLUMN.
    //
    // Required now (FR-055, invariant 9). It was nullable only because a
    // pre-upgrade statement predated the chart of accounts; the conversion
    // backfilled every one of those, and this release's migration backfills any
    // that are somehow left before adding the constraint. Reconciling starts
    // from an account, so a statement without one cannot be reached at all.
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
  },
  (t) => [index("bank_statements_state_idx").on(t.extractionState)],
);

export const bankStatementLines = sqliteTable(
  "bank_statement_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    statementId: integer("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    description: text("description").notNull().default(""),
    // Always positive; the sign is carried by `direction`.
    amount: real("amount").notNull(),
    // StatementDirection code (1 = in, 2 = out). See enums.ts.
    direction: integer("direction").notNull(),
    // ReconItemType code. Non-null ⟺ the line is cleared — there is no separate
    // `cleared` column, so two fields can never disagree.
    note: text("note").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("bank_statement_lines_statement_idx").on(t.statementId, t.date),
  ],
);

// Many-to-many allocation ledger. A bank line may cover several Akaun records and
// one record may be covered by lines from several reconciliation sessions.
export const reconciliationAllocations = sqliteTable(
  "reconciliation_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lineId: integer("line_id")
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: "cascade" }),
    // `item_type` and `item_id` were here: the pre-upgrade way of naming what a
    // bank line covered, replaced by `movement_id`. They were kept nullable and
    // unread for one release so the backfill stayed inspectable against what it
    // came from; that release is over, and no reader remains anywhere in `src/`
    // (FR-037b, R-10).
    // The ledger movement this bank line covers. Nullable for exactly the reason
    // `bank_statements.account_id` is — a pre-upgrade allocation predates every
    // movement, and the upgrade's reconciliation phase repoints it at the bank
    // movement of the record it named (FR-034). Every allocation written after
    // the upgrade sets it, and the service layer requires it.
    movementId: integer("movement_id").references(() => ledgerMovements.id, {
      onDelete: "cascade",
    }),
    amount: real("amount").notNull(),
    itemAmountSnapshot: real("item_amount_snapshot").notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex("reconciliation_allocations_line_movement_idx").on(
      t.lineId,
      t.movementId,
    ),
    index("reconciliation_allocations_movement_idx").on(t.movementId),
  ],
);

// ---------------------------------------------------------------------------
// Ledger — one record store with two sides (specs/002-double-entry-ledger).
//
// `ledger_records` is what happened; `ledger_movements` is each side of it,
// against an account in `accounts`. A movement's amount is POSITIVE when value
// goes into that account and NEGATIVE when it leaves, and every record's
// movements add up to zero. Money is whole cents of the main currency in an
// INTEGER column, which is what makes "the two sides cancel out exactly"
// provable rather than approximate. `ledger/entry-builder.ts` is the only place
// movements are constructed. See data-model.md.
// ---------------------------------------------------------------------------

// One line in the Chart of Accounts. Type and code become required after the
// explicit conversion has populated every legacy row; the merge link preserves
// old deep links.
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // AccountRole code. See $lib/enums.ts.
    role: integer("role").notNull(),
    // Fixed accounting type and system-owned number. `role` remains during the
    // conversion release only, so migration 0016 can map old installations in
    // one transaction before later readers stop depending on it.
    type: integer("type"),
    // AccountSubType code. Meaningful only when type = Asset; NULL there means
    // "needs review", not a distinct sentinel value. NULL/unused for every
    // other type. See $lib/enums.ts.
    subType: integer("sub_type"),
    defaultTaxPercentageBps: integer("default_tax_percentage_bps"),
    defaultTaxTreatment: text("default_tax_treatment").$type<TaxTreatment>(),
    code: integer("code"),
    name: text("name").notNull(),
    mergedIntoAccountId: integer("merged_into_account_id").references(
      (): AnySQLiteColumn => accounts.id,
      { onDelete: "restrict" },
    ),
    // Only partner capital/drawings accounts set this (FR-008b). SET NULL so
    // retiring a contact never destroys the account's history.
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    // System accounts can never be deleted (FR-009).
    isSystem: integer("is_system", { mode: "boolean" })
      .notNull()
      .default(false),
    // Lexorank ordering, carried over from categories.rank.
    rank: text("rank").notNull(),
    // Non-null = hidden from pickers for new records; history untouched.
    archivedAt: text("archived_at"),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    check(
      "accounts_tax_percentage_check",
      sql`${t.defaultTaxPercentageBps} IS NULL OR (typeof(${t.defaultTaxPercentageBps}) = 'integer' AND ${t.defaultTaxPercentageBps} BETWEEN 0 AND 10000 AND ${t.type} IS 5)`,
    ),
    check(
      "accounts_tax_treatment_check",
      sql`${t.defaultTaxTreatment} IS NULL OR (${t.type} IS 5 AND ${t.defaultTaxTreatment} IN ('ordinary_deductible', 'partial', 'non_deductible', 'capital_expenditure', 'unclassified', 'requires_review'))`,
    ),
    // Transitional index used only while migration readers still classify old rows.
    index("accounts_role_rank_idx").on(t.role, t.rank),
    // The partner statement's lookup.
    index("accounts_contact_idx").on(t.contactId),
    // Names are intentionally not unique: code is the stable identity.
    index("accounts_role_name_idx").on(t.role, t.name),
    uniqueIndex("accounts_code_idx").on(t.code),
    index("accounts_merged_into_idx").on(t.mergedIntoAccountId),
  ],
);

// Six workflow choices replace role/name lookup. Purpose and required type are
// fixed in $lib/enums.ts; services validate that each target is an active leaf.
export const accountDefaults = sqliteTable(
  "account_defaults",
  {
    purpose: integer("purpose").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    updatedBy: integer("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [index("account_defaults_account_idx").on(t.accountId)],
);

export const accountMigrationRuns = sqliteTable("account_migration_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: text("version").notNull().unique(),
  status: text("status").notNull(),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
  summaryJson: text("summary_json").notNull().default("{}"),
  beforeSnapshotJson: text("before_snapshot_json").notNull().default("{}"),
  afterSnapshotJson: text("after_snapshot_json").notNull().default("{}"),
});

export const accountMergeAudits = sqliteTable(
  "account_merge_audits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceAccountId: integer("source_account_id").notNull(),
    survivorAccountId: integer("survivor_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    runId: integer("run_id")
      .notNull()
      .references(() => accountMigrationRuns.id, { onDelete: "restrict" }),
    normalizedName: text("normalized_name").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    referenceCountsJson: text("reference_counts_json").notNull().default("{}"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex("account_merge_audits_source_idx").on(t.sourceAccountId),
    index("account_merge_audits_run_idx").on(t.runId),
  ],
);

// One thing that happened, on one date, with its human context.
export const ledgerRecords = sqliteTable(
  "ledger_records",
  {
    // Migrated expenses keep their original id, so every pre-upgrade
    // /expenses/[id] link still resolves (D-14).
    id: integer("id").primaryKey({ autoIncrement: true }),
    // LedgerRecordKind code. See $lib/enums.ts.
    kind: integer("kind").notNull(),
    date: text("date").notNull(),
    // From the existing sequences; null for transfers, opening balances and
    // journal entries (D-13). No reference number is ever regenerated.
    recordNumber: text("record_number").unique(),
    description: text("description").notNull().default(""),
    expensePaymentSource: text("expense_payment_source", {
      enum: ["company", "personal", "unpaid"],
    }),
    supplierContactId: integer("supplier_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),
    // Required when any movement touches a shared owed account (FR-008).
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    reference: text("reference").notNull().default(""),
    remark: text("remark").notNull().default(""),
    // The currency `amount` is denominated in.
    currency: text("currency").notNull().default("USD"),
    // Locked at creation so historical conversions never drift.
    exchangeRate: real("exchange_rate").notNull().default(1),
    // The figure as entered, in `currency`. Display and audit only — NEVER
    // summed for a report. Every total reads ledger_movements.amount_minor
    // (D-02). Invariant 6 ties the two together.
    amount: real("amount").notNull(),
    // Raw OCR/PDF text captured during auto-import.
    extractedText: text("extracted_text"),
    // Upgrade provenance and idempotency key: 'expense' | 'income' | 'claim'
    // and the row's id in that old table (D-14).
    legacyKind: text("legacy_kind"),
    legacyId: integer("legacy_id"),
    // Set only on a Reversal record: the record it voids. A void is a second
    // record whose movements negate the first on the same date, so every
    // balance and report nets to zero with no query aware of it. "Voided" is
    // derived from this link existing; nothing on the voided record changes.
    // Restrict: a voided record cannot be deleted from under its reversal.
    reversesRecordId: integer("reverses_record_id").references(
      (): AnySQLiteColumn => ledgerRecords.id,
      { onDelete: "restrict" },
    ),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    // One void per record.
    uniqueIndex("ledger_records_reverses_idx").on(t.reversesRecordId),
    // Every list screen.
    index("ledger_records_kind_date_idx").on(t.kind, t.date),
    index("ledger_records_contact_idx").on(t.contactId),
    // Makes a rerun of the upgrade skip what it already converted (FR-037).
    // Both columns are null for records created after the upgrade, and SQLite
    // treats nulls as distinct in a unique index, so those never collide.
    uniqueIndex("ledger_records_legacy_idx").on(t.legacyKind, t.legacyId),
  ],
);

/**
 * Which saved import profile read the document a record was imported from
 * (006 FR-066). The overlap guard asks it which months a profile's records
 * cover. It lives apart from `import_queue` and `import_items`, which
 * clearing the import history deletes while the records stay: the guard would
 * then lose sight of them. Deleting the record deletes its row. The profile id
 * has no foreign key, as `import_queue.profile_id` has none: a profile is
 * deleted outright, and its records still describe the money they did.
 */
export const importRecordProfiles = sqliteTable(
  "import_record_profiles",
  {
    recordId: integer("record_id")
      .primaryKey()
      .references(() => ledgerRecords.id, { onDelete: "cascade" }),
    profileId: integer("profile_id").notNull(),
  },
  (t) => [index("import_record_profiles_profile_idx").on(t.profileId)],
);

// One side of a record: an amount against one account.
export const fixedAssets = sqliteTable(
  "fixed_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    assetType: text("asset_type").notNull(),
    serialNumber: text("serial_number").notNull().default(""),
    acquisitionDate: text("acquisition_date").notNull(),
    inServiceDate: text("in_service_date"),
    assetAccountId: integer("asset_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    costMinor: integer("cost_minor").notNull(),
    // Movement IDs may disappear during an audited source edit. Keep their identity
    // as evidence, without blocking the ledger's existing movement rebuild path.
    sourceMovementId: integer("source_movement_id"),
    sourceRecordId: integer("source_record_id").references(
      () => ledgerRecords.id,
      { onDelete: "restrict" },
    ),
    sourceSortOrder: integer("source_sort_order"),
    sourceSnapshot: text("source_snapshot", {
      mode: "json",
    }).$type<AssetSourceSnapshot>(),
    openingAsAt: text("opening_as_at"),
    broughtForwardDepMinor: integer("brought_forward_dep_minor")
      .notNull()
      .default(0),
    accumulatedDepreciationAccountId: integer(
      "accumulated_depreciation_account_id",
    ).references(() => accounts.id, { onDelete: "restrict" }),
    openingRecordId: integer("opening_record_id").references(
      () => ledgerRecords.id,
      { onDelete: "restrict" },
    ),
    businessUseBps: integer("business_use_bps"),
    documentReference: text("document_reference").notNull().default(""),
    bookMethod: text("book_method"),
    usefulLifeMonths: integer("useful_life_months"),
    residualMinor: integer("residual_minor"),
    depreciationExpenseAccountId: integer(
      "depreciation_expense_account_id",
    ).references(() => accounts.id, { onDelete: "restrict" }),
    createdBy: integer("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedBy: integer("updated_by").notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    uniqueIndex("fixed_assets_source_movement_unique").on(t.sourceMovementId),
    uniqueIndex("fixed_assets_source_slot_unique").on(
      t.sourceRecordId,
      t.sourceSortOrder,
    ),
    index("fixed_assets_account_idx").on(t.assetAccountId),
    check(
      "fixed_assets_cost_check",
      sql`typeof(${t.costMinor}) = 'integer' AND ${t.costMinor} > 0 AND ${t.costMinor} <= 9007199254740991`,
    ),
    check(
      "fixed_assets_dep_check",
      sql`typeof(${t.broughtForwardDepMinor}) = 'integer' AND ${t.broughtForwardDepMinor} BETWEEN 0 AND ${t.costMinor}`,
    ),
    check(
      "fixed_assets_business_check",
      sql`${t.businessUseBps} IS NULL OR (typeof(${t.businessUseBps}) = 'integer' AND ${t.businessUseBps} BETWEEN 0 AND 10000)`,
    ),
    check(
      "fixed_assets_source_check",
      sql`(${t.sourceRecordId} IS NOT NULL AND ${t.sourceMovementId} IS NOT NULL AND ${t.sourceSortOrder} IS NOT NULL AND ${t.sourceSnapshot} IS NOT NULL AND ${t.openingAsAt} IS NULL AND ${t.broughtForwardDepMinor} = 0 AND ${t.openingRecordId} IS NULL) OR (${t.sourceRecordId} IS NULL AND ${t.sourceMovementId} IS NULL AND ${t.sourceSortOrder} IS NULL AND ${t.sourceSnapshot} IS NULL AND ${t.openingAsAt} IS NOT NULL)`,
    ),
    check(
      "fixed_assets_accounts_check",
      sql`${t.accumulatedDepreciationAccountId} IS NULL OR ${t.accumulatedDepreciationAccountId} <> ${t.assetAccountId}`,
    ),
    check(
      "fixed_assets_dep_mapping_check",
      sql`${t.broughtForwardDepMinor} = 0 OR ${t.accumulatedDepreciationAccountId} IS NOT NULL`,
    ),
    check(
      "fixed_assets_residual_check",
      sql`${t.residualMinor} IS NULL OR (typeof(${t.residualMinor}) = 'integer' AND ${t.residualMinor} BETWEEN 0 AND ${t.costMinor})`,
    ),
  ],
);

// Approved profiles are versioned: later estimates never rewrite posted periods.
export const depreciationProfiles = sqliteTable(
  "depreciation_profiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "restrict" }),
    startMonth: text("start_month").notNull(),
    months: integer("months").notNull(),
    baseNbvMinor: integer("base_nbv_minor").notNull(),
    residualMinor: integer("residual_minor").notNull(),
    expenseAccountId: integer("expense_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    accumulatedAccountId: integer("accumulated_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    mode: text("mode", { enum: ["review", "auto"] }).notNull(),
    basis: text("basis").notNull(),
    stoppedFrom: text("stopped_from"),
    approvedBy: integer("approved_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("depreciation_profile_version").on(t.assetId, t.startMonth),
    check(
      "depreciation_profile_amounts",
      sql`typeof("base_nbv_minor") = 'integer' AND "base_nbv_minor" BETWEEN 0 AND 9007199254740991 AND typeof("residual_minor") = 'integer' AND "residual_minor" BETWEEN 0 AND "base_nbv_minor" AND typeof("months") = 'integer' AND "months" BETWEEN 1 AND 1200`,
    ),
    check("depreciation_profile_mode", sql`"mode" IN ('review', 'auto')`),
  ],
);

export const depreciationRuns = sqliteTable("depreciation_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  month: text("month").notNull(),
  recordId: integer("record_id")
    .notNull()
    .unique()
    .references(() => ledgerRecords.id, { onDelete: "restrict" }),
  reversalRecordId: integer("reversal_record_id")
    .unique()
    .references(() => ledgerRecords.id, { onDelete: "restrict" }),
  reversedOn: text("reversed_on"),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const depreciationPostings = sqliteTable(
  "depreciation_postings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "restrict" }),
    month: text("month").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => depreciationProfiles.id, { onDelete: "restrict" }),
    runId: integer("run_id")
      .notNull()
      .references(() => depreciationRuns.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
  },
  (t) => [
    uniqueIndex("depreciation_asset_month").on(t.assetId, t.month),
    check(
      "depreciation_posting_amount",
      sql`typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 1 AND 9007199254740991`,
    ),
  ],
);

// Future automation has a separate approval boundary from historical catch-up.
// Missing rows (profiles approved before this feature) require history review.
export const depreciationApprovals = sqliteTable("depreciation_approvals", {
  profileId: integer("profile_id")
    .primaryKey()
    .references(() => depreciationProfiles.id, { onDelete: "restrict" }),
  futureFromMonth: text("future_from_month").notNull(),
});

// Allocation of an existing journal is evidence only: never a second ledger posting.
export const depreciationAllocations = sqliteTable(
  "depreciation_allocations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "restrict" }),
    recordId: integer("record_id")
      .notNull()
      .references(() => ledgerRecords.id, { onDelete: "restrict" }),
    expenseAccountId: integer("expense_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    accumulatedAccountId: integer("accumulated_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    fromMonth: text("from_month").notNull(),
    throughMonth: text("through_month").notNull(),
    recordDate: text("record_date").notNull(),
    approvedBy: integer("approved_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  () => [
    check(
      "depreciation_allocation_amount",
      sql`typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 1 AND 9007199254740991`,
    ),
  ],
);

export const ledgerMovements = sqliteTable(
  "ledger_movements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Deleting a record deletes its sides.
    recordId: integer("record_id")
      .notNull()
      .references(() => ledgerRecords.id, { onDelete: "cascade" }),
    // No cascade — an account holding movements cannot be deleted (FR-009).
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    // Whole cents of the main currency, signed. Positive = value in.
    amountMinor: integer("amount_minor").notNull(),
    // Stable display order of the sides on the journal screen.
    sortOrder: integer("sort_order").notNull().default(0),
    // The user's own name for this line, when the record's description alone
    // does not tell two category lines apart (e.g. "Scissors" vs "Paper" on
    // one bill). Null means "use the record's description" — resolved once,
    // in accountHistory(), never a second copy of the record's own field.
    label: text("label"),
    /** NULL is historical/unreviewed; never infer from current defaults. */
    taxClassification: text("tax_classification", {
      mode: "json",
    }).$type<ExpenseTaxSnapshot>(),
  },
  (t) => [
    check(
      "movements_tax_json_check",
      sql`${t.taxClassification} IS NULL OR CASE WHEN json_valid(${t.taxClassification}) THEN coalesce(json_type(${t.taxClassification}, '$.percentageBps') IN ('null', 'integer') AND (json_extract(${t.taxClassification}, '$.percentageBps') IS NULL OR json_extract(${t.taxClassification}, '$.percentageBps') BETWEEN 0 AND 10000) AND json_extract(${t.taxClassification}, '$.source') IN ('account_default', 'override', 'unreviewed') AND json_extract(${t.taxClassification}, '$.treatment') IN ('ordinary_deductible', 'partial', 'non_deductible', 'capital_expenditure', 'unclassified', 'requires_review'), 0) ELSE 0 END`,
    ),
    // The balance check and every record read.
    index("ledger_movements_record_idx").on(t.recordId),
    // Account balance and account history.
    index("ledger_movements_account_date_idx").on(t.accountId, t.id),
  ],
);

// A note that a payment paid off a particular outstanding item, for a particular
// amount. Changes no balance (D-09) — it is what makes "paid" and "how much is
// left" derivable rather than stored (FR-012).
export const settlements = sqliteTable(
  "settlements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // The paying side, on a shared owed account.
    paymentMovementId: integer("payment_movement_id")
      .notNull()
      .references(() => ledgerMovements.id, { onDelete: "restrict" }),
    // The outstanding side, on the same shared owed account.
    owedMovementId: integer("owed_movement_id")
      .notNull()
      .references(() => ledgerMovements.id, { onDelete: "restrict" }),
    // How much of the outstanding item this payment covers. Always > 0; the
    // total against one owed movement may never exceed its own amount (FR-016).
    amountMinor: integer("amount_minor").notNull(),
    reversedAt: text("reversed_at"),
    reversedBy: integer("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex("settlements_pair_idx")
      .on(t.paymentMovementId, t.owedMovementId)
      .where(sql`${t.reversedAt} IS NULL`),
    // The "how much is left" aggregate.
    index("settlements_owed_idx").on(t.owedMovementId),
  ],
);

// Replaces expense_attachments, income_attachments and claim_attachments (FR-032b).
export const recordAttachments = sqliteTable(
  "record_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recordId: integer("record_id")
      .notNull()
      .references(() => ledgerRecords.id, { onDelete: "cascade" }),
    // Path relative to STORAGE_PATH; records/YYYY/MM/... after the upgrade (D-16).
    filename: text("filename").notNull(),
    displayName: text("display_name").notNull(),
    addedDate: text("added_date")
      .notNull()
      .default(sql`(date('now'))`),
    // Where the file was before the upgrade. This is what makes the file move
    // resumable and checkable: a rerun sees the file already at its destination
    // and skips it, and verification compares the two hashes before any
    // original is removed (D-16, SC-014). Cleared by the release that drops the
    // legacy tables.
    legacyFilename: text("legacy_filename"),
    // True when the file is a document that was imported as several items,
    // one record each, so every one of those records has it (006 FR-027). Its
    // text describes all of them, so it is never searched as this record's
    // own (FR-029), even after the others have let it go. Set when the item is
    // confirmed; the import's own rows may be cleared from history later, so
    // this flag is what remembers it.
    groupDocument: integer("group_document", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    index("record_attachments_record_idx").on(t.recordId),
    // A stored file may be shared by several records. Before one is deleted,
    // the file's other users are looked up by this path.
    index("record_attachments_filename_idx").on(t.filename),
  ],
);

// Replaces expense_search_text and income_search_text, unchanged in shape.
// Every existing reference number is folded in exactly as typed (SC-013).
export const recordSearchText = sqliteTable("record_search_text", {
  recordId: integer("record_id")
    .primaryKey()
    .references(() => ledgerRecords.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
});

/** Linked, read-only postings transfer supplier obligations to one recipient. */
export const reimbursements = sqliteTable("reimbursements", {
  reversedAt: text("reversed_at"),
  id: integer("id").primaryKey({ autoIncrement: true }),
  payableRecordId: integer("payable_record_id")
    .notNull()
    .references(() => ledgerRecords.id, { onDelete: "restrict" }),
  paymentRecordId: integer("payment_record_id").references(
    () => ledgerRecords.id,
    { onDelete: "restrict" },
  ),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
export const reimbursementEntries = sqliteTable("reimbursement_entries", {
  recordId: integer("record_id")
    .primaryKey()
    .references(() => ledgerRecords.id, { onDelete: "restrict" }),
  groupId: integer("group_id")
    .notNull()
    .references(() => reimbursements.id, { onDelete: "restrict" }),
  role: text("role", {
    enum: ["supplier", "recipient", "supplier-reversal", "recipient-reversal"],
  }).notNull(),
});
export const reimbursementItems = sqliteTable("reimbursement_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id")
    .notNull()
    .references(() => reimbursements.id, { onDelete: "restrict" }),
  sourceMovementId: integer("source_movement_id")
    .notNull()
    .references(() => ledgerMovements.id, { onDelete: "restrict" }),
  amountMinor: integer("amount_minor").notNull(),
});

/** Redeemed MCP file capabilities. The primary key makes consumption atomic. */
export const mcpFileLinkUses = sqliteTable("mcp_file_link_uses", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});

// Annual tax evidence is independent of live source row lifetimes and GL posting.
export const taxWorksheets = sqliteTable(
  "tax_worksheets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ya: integer("ya").notNull().unique(),
    dateFrom: text("date_from").notNull(),
    dateTo: text("date_to").notNull(),
    requestKey: text("request_key").notNull().unique(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  () => [check("tax_period_order", sql`"date_from" <= "date_to"`)],
);

export const taxWorksheetRevisions = sqliteTable(
  "tax_worksheet_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    worksheetId: integer("worksheet_id")
      .notNull()
      .references(() => taxWorksheets.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status")
      .$type<"draft" | "reviewed" | "finalised">()
      .notNull()
      .default("draft"),
    snapshot: text("snapshot", { mode: "json" })
      .$type<TaxSourceSnapshot>()
      .notNull(),
    sourceHash: text("source_hash").notNull(),
    capturedAt: text("captured_at").notNull(),
    amendmentReason: text("amendment_reason"),
    requestKey: text("request_key").notNull().unique(),
    reviewedBy: integer("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: text("reviewed_at"),
    finalisedBy: integer("finalised_by").references(() => users.id, {
      onDelete: "set null",
    }),
    finalisedAt: text("finalised_at"),
  },
  (t) => [
    uniqueIndex("tax_revision_number").on(t.worksheetId, t.revision),
    check(
      "tax_revision_status",
      sql`"status" IN ('draft', 'reviewed', 'finalised')`,
    ),
    check(
      "tax_revision_numbers",
      sql`typeof("revision") = 'integer' AND "revision" > 0 AND typeof("version") = 'integer' AND "version" > 0`,
    ),
    check("tax_revision_json", sql`json_valid("snapshot")`),
    check(
      "tax_revision_lock",
      sql`("status" = 'draft' AND "reviewed_at" IS NULL AND "finalised_at" IS NULL) OR ("status" = 'reviewed' AND "reviewed_at" IS NOT NULL AND "finalised_at" IS NULL) OR ("status" = 'finalised' AND "reviewed_at" IS NOT NULL AND "finalised_at" IS NOT NULL)`,
    ),
  ],
);

export const taxWorksheetAdjustments = sqliteTable(
  "tax_worksheet_adjustments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    revisionId: integer("revision_id")
      .notNull()
      .references(() => taxWorksheetRevisions.id, { onDelete: "restrict" }),
    kind: text("kind")
      .$type<"source" | "other" | "loss_brought_forward">()
      .notNull(),
    sourceMovementId: integer("source_movement_id"),
    percentageBps: integer("percentage_bps"),
    treatment: text("treatment").$type<TaxTreatment>(),
    amountMinor: integer("amount_minor").notNull().default(0),
    direction: text("direction")
      .$type<"increase" | "decrease">()
      .notNull()
      .default("decrease"),
    balanceMinor: integer("balance_minor").notNull().default(0),
    originYa: integer("origin_ya"),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    requestKey: text("request_key").notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name").notNull(),
    createdAt: text("created_at").notNull(),
    withdrawnAt: text("withdrawn_at"),
    withdrawalReason: text("withdrawal_reason"),
  },
  (t) => [
    uniqueIndex("tax_adjustment_request").on(t.revisionId, t.requestKey),
    uniqueIndex("tax_active_source_correction")
      .on(t.revisionId, t.sourceMovementId)
      .where(sql`"withdrawn_at" IS NULL AND "kind" = 'source'`),
    uniqueIndex("tax_carry_origin")
      .on(t.revisionId, t.kind, t.originYa)
      .where(sql`"withdrawn_at" IS NULL AND "kind" = 'loss_brought_forward'`),
    index("tax_adjustment_revision").on(t.revisionId),
    check(
      "tax_adjustment_kind",
      sql`"kind" IN ('source', 'other', 'loss_brought_forward')`,
    ),
    check(
      "tax_adjustment_direction",
      sql`"direction" IN ('increase', 'decrease')`,
    ),
    check(
      "tax_adjustment_amount",
      sql`typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 0 AND 9007199254740991 AND typeof("balance_minor") = 'integer' AND "balance_minor" BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "tax_adjustment_values",
      sql`coalesce("kind" = 'source' OR ("kind" = 'other' AND "amount_minor" > 0 AND "balance_minor" = 0 AND "origin_ya" IS NULL) OR ("kind" = 'loss_brought_forward' AND "direction" = 'decrease' AND typeof("origin_ya") = 'integer' AND "origin_ya" BETWEEN 2000 AND 9999 AND "amount_minor" <= "balance_minor"), 0)`,
    ),
    check(
      "tax_adjustment_source",
      sql`coalesce(("kind" = 'source' AND typeof("source_movement_id") = 'integer' AND "source_movement_id" > 0 AND typeof("percentage_bps") = 'integer' AND "balance_minor" = 0 AND "origin_ya" IS NULL AND (("treatment" = 'ordinary_deductible' AND "percentage_bps" = 10000) OR ("treatment" = 'partial' AND "percentage_bps" BETWEEN 1 AND 9999) OR ("treatment" IN ('non_deductible', 'capital_expenditure') AND "percentage_bps" = 0))) OR ("kind" <> 'source' AND "source_movement_id" IS NULL AND "percentage_bps" IS NULL AND "treatment" IS NULL), 0)`,
    ),
  ],
);

/** Revision-owned scheme calculations; never a source of book depreciation journals. */
export const taxCapitalSchedules = sqliteTable(
  "tax_capital_schedules",
  {
    revisionId: integer("revision_id")
      .primaryKey()
      .references(() => taxWorksheetRevisions.id, { onDelete: "restrict" }),
    evidence: text("evidence", { mode: "json" })
      .$type<CapitalSchedule>()
      .notNull(),
  },
  () => [
    check(
      "tax_capital_json",
      sql`CASE WHEN json_valid("evidence") THEN coalesce(json_extract("evidence", '$.calculationVersion') = 2 AND json_type("evidence", '$.currency') = 'text' AND length(json_extract("evidence", '$.currency')) = 3 AND json_type("evidence", '$.rows') = 'array' AND json_type("evidence", '$.assets') = 'array' AND json_type("evidence", '$.utilisation') = 'array', 0) ELSE 0 END`,
    ),
  ],
);

export const taxCapitalCommands = sqliteTable("tax_capital_commands", {
  requestKey: text("request_key").primaryKey(),
  revisionId: integer("revision_id")
    .notNull()
    .references(() => taxWorksheetRevisions.id, { onDelete: "restrict" }),
  payloadHash: text("payload_hash").notNull(),
});

/** Every edit is a new immutable scheme version; applications retain the exact definition. */
export const assetTaxSchemes = sqliteTable(
  "asset_tax_schemes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    familyKey: text("family_key").notNull(),
    version: integer("version").notNull(),
    definition: text("definition", { mode: "json" })
      .$type<import("$lib/asset-tax-scheme.js").AssetTaxSchemeDefinition>()
      .notNull(),
    requestKey: text("request_key").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    actorName: text("actor_name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("asset_tax_scheme_version").on(t.familyKey, t.version),
    check(
      "asset_tax_scheme_version_check",
      sql`typeof("version") = 'integer' AND "version" > 0`,
    ),
    check("asset_tax_scheme_definition", sql`json_valid("definition")`),
  ],
);
