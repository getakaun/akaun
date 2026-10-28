import { reset, hit } from "../rate-limit.js";
import { MAX_FILE_BYTES, FILE_READ_LIMIT } from "./file-read-policy.js";
import { getRecord } from "../queries/ledger.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq, getTableName } from "drizzle-orm";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as schema from "../db/schema.js";
import {
  accounts,
  accountDefaults,
  auditLog,
  bankStatementLines,
  bankStatements,
  contacts,
  groupDelegations,
  groupGrants,
  importQueue,
  ledgerRecords,
  recordAttachments,
  settlements,
  users,
} from "../db/schema.js";
import { seedAccounts } from "../db/seed-accounts.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import {
  DefaultAccountPurpose,
  EntityType,
  ImportState,
  Role,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import type { LedgerDb } from "../ledger/types.js";
import { patLocals } from "../tokens/pat.js";
import { resolveAccess } from "../permissions.js";
import { grantGroup, issueTestToken } from "../permissions/test-locals.js";
import {
  LEAF_PERMISSIONS,
  isDelegable,
  type LeafPermission,
} from "$lib/permissions/catalog.js";
import { expandScopes } from "$lib/permissions/oauth-scopes.js";
import { ledgerEvents } from "../ledger/events.js";
import type { OAuthScope } from "../oauth/config.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { handleMcpRequest } from "./http.js";
import { createServer } from "./server.js";
import {
  TOOL_REQUIREMENTS,
  toolAccessOptions,
  toolAllowed,
} from "./tool-requirements.js";
import { inspectRpc } from "./oauth-challenge.js";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";

// Like mcp.spec.ts, nothing here imports db/client.ts or starts the app: the
// database is SQLite :memory: and files go to a folder under os.tmpdir(). The
// preload (`scripts/mcp-test-preload.ts`) also points `$env/dynamic/private`
// at a temp folder and makes any import of db/client.ts throw.
let sqlite: Database;
let db: LedgerDb;
let storageRoot: string;
let store: LocalBlobStore;
const clients: Client[] = [];
const origin = "https://akaun.test";
// Personal access tokens with each user's whole role, issued in the fixture.
let writerToken: string;
let keeperToken: string;
let readerToken: string;
let bank: number;
let cash: number;
let software: number;
let payable: number;
let supplier: number;

function account(code: number) {
  return db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.code, code))
    .get()!.id;
}

const RESOURCES = [
  "records",
  "accounts",
  "contacts",
  "invoices",
  "quotations",
  "reconciliation",
  "import",
  "reports",
] as const;
const inScope = (leaf: LeafPermission) =>
  (RESOURCES as readonly string[]).includes(leaf.split(".")[0]);
/** Delegable abilities in these areas except Adjustments. */
const WRITER = LEAF_PERMISSIONS.filter(
  (leaf) => inScope(leaf) && leaf !== "records.adjust" && isDelegable(leaf),
);
/** A bookkeeper: adds and changes, never deletes or merges. */
const KEEPER = WRITER.filter(
  (leaf) => !leaf.endsWith(".delete") && leaf !== "contacts.merge",
);
/** Views only. */
const READER = WRITER.filter((leaf) => leaf.endsWith(".read"));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "akaun-mcp-write-spec-"));
  store = new LocalBlobStore(storageRoot);
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values([
      // Every ability except adjustments, like the seeded Owner without a grant.
      {
        id: 1,
        email: "w@test",
        username: "writer",
        passwordHash: "x",
      },
      // Bookkeeper: add and change, never delete.
      {
        id: 2,
        email: "k@test",
        username: "keeper",
        passwordHash: "x",
      },
      // Views only.
      {
        id: 3,
        email: "r@test",
        username: "reader",
        passwordHash: "x",
      },
    ])
    .run();
  grantGroup(db, { name: "writers", userIds: [1], grants: WRITER });
  grantGroup(db, { name: "keepers", userIds: [2], grants: KEEPER });
  grantGroup(db, { name: "readers", userIds: [3], grants: READER });
  writerToken = issueTestToken(db, 1, WRITER);
  keeperToken = issueTestToken(db, 2, KEEPER);
  readerToken = issueTestToken(db, 3, READER);
  seedAccounts(db);
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  setSetting(
    db,
    SETTING_KEYS.ledgerUpgradeState,
    JSON.stringify({ finishedAt: "2026-09-01T00:00:00Z" }),
  );
  bank = account(1100);
  cash = account(1000);
  software = account(5400);
  payable = account(2000);
  supplier = db
    .insert(contacts)
    .values({
      entityType: EntityType.Business,
      legalName: "Supplier",
      createdBy: 1,
      updatedBy: 1,
    })
    .returning({ id: contacts.id })
    .get()!.id;
  db.insert(schema.contactRoles)
    .values({ contactId: supplier, role: Role.Supplier })
    .run();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  sqlite.close();
  rmSync(storageRoot, { recursive: true, force: true });
});

/** A personal access token alone, or an OAuth app acting for that token's user. */
type Auth = { token: string; scopes?: OAuthScope[] };

function localsFor(auth: Auth): App.Locals {
  const locals = patLocals(db, `Bearer ${auth.token}`);
  if (!locals) return { user: null, permissions: null };
  if (!auth.scopes) return locals;
  // As `oauth.authenticate` builds it: the scopes, expanded, ∩ role ∩ ceiling.
  return {
    user: locals.user,
    ...resolveAccess(db, locals.user!.id, expandScopes(auth.scopes)),
    credential: { kind: "oauth", grantId: "grant", clientId: "client" },
    oauth: {
      clientId: "client",
      grantId: "grant",
      resource: `${origin}/mcp`,
      scopes: auth.scopes,
    },
  };
}

const ALL_WRITE: OAuthScope[] = [
  "records:read",
  "records:write",
  "records:delete",
  "records:correct-date",
  "records:correct-reimbursement-amount",
  "accounts:read",
  "accounts:write",
  "accounts:delete",
  "contacts:read",
  "contacts:write",
  "contacts:delete",
  "invoices:read",
  "invoices:write",
  "invoices:delete",
  "quotations:read",
  "quotations:write",
  "quotations:delete",
  "reconciliation:read",
  "reconciliation:write",
  "import:read",
  "import:write",
  "import:delete",
];

// Independent expected behavior, deliberately not derived from registrations or permissions.
const READ_TOOLS = [
  "list_records",
  "get_record",
  "get_attachment",
  "list_outstanding",
  "get_account_statement",
  "list_accounts",
  "list_contacts",
  "get_contact_balance",
  "get_financial_report",
  "list_import_jobs",
  "get_import_job",
  "list_invoices",
  "get_invoice",
  "list_quotations",
  "get_quotation",
  "get_bank_statement_file",
  "list_bank_statements",
  "get_bank_statement",
  "get_audit_history",
  "get_reimbursement_reversal",
  "get_reimbursement_candidates",
  "get_payment_recipient_correction",
  "get_record_date_correction",
  "get_reimbursement_amount_correction",
  "get_payment_allocations",
];
const ADDITIVE_TOOLS = [
  "create_account",
  "create_contact",
  "create_record",
  "record_payment",
  "create_reimbursement",
  "settle_payment",
  "attach_file",
  "create_invoice",
  "create_quotation",
  "auto_match",
  "record_transfer_from_line",
];
const OVERWRITE_TOOLS = [
  "update_account",
  "delete_account",
  "set_opening_balance",
  "update_contact",
  "delete_contact",
  "update_import_item",
  "confirm_import",
  "skip_import",
  "discard_import_job",
  "correct_record_date",
  "correct_reimbursement_amount",
  "reverse_reimbursement",
  "correct_payment_recipient",
  "update_record",
  "delete_record",
  "undo_settlement",
  "correct_payment_allocations",
  "update_invoice",
  "issue_invoice",
  "void_invoice",
  "delete_invoice",
  "update_quotation",
  "set_quotation_status",
  "revise_quotation",
  "convert_quotation_to_invoice",
  "delete_quotation",
  "set_movement_matches",
];
const IDEMPOTENT_WRITES = [
  "update_account",
  "set_opening_balance",
  "update_contact",
  "update_import_item",
  "update_record",
  "update_invoice",
  "update_quotation",
  "set_quotation_status",
  "set_movement_matches",
];
const REVIEWED_TOOLS = [
  "correct_record_date",
  "correct_reimbursement_amount",
  "correct_payment_recipient",
  "reverse_reimbursement",
  "delete_record",
  "undo_settlement",
  "correct_payment_allocations",
  "delete_account",
  "delete_contact",
  "void_invoice",
  "delete_invoice",
  "delete_quotation",
  "skip_import",
  "discard_import_job",
  "set_opening_balance",
  "set_movement_matches",
  "create_record",
  "update_record",
  "record_transfer_from_line",
];

for (const era of ["legacy", "modern"] as const) {
  async function connect(
    auth: Auth = { token: writerToken, scopes: ALL_WRITE },
  ) {
    const client = new Client(
      { name: "akaun-write-test", version: "1" },
      {
        versionNegotiation: {
          mode: era === "modern" ? { pin: "2026-07-28" } : era,
        },
      },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
        fetch: async (url, init) =>
          handleMcpRequest(
            new Request(url, init),
            {
              db,
              store,
              storageRoot,
              locals: localsFor(auth),
            },
            origin,
          ),
      }),
    );
    return client;
  }

  type Result = {
    isError?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output, read loosely in assertions
    structuredContent?: { data: Record<string, any> };
    content?: { type: string; text?: string }[];
  };
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) {
    return (await client.callTool({ name, arguments: args })) as Result;
  }
  function errorOf(result: Result) {
    expect(result.isError).toBe(true);
    return JSON.parse(result.content![0].text!).error as {
      code: string;
      message: string;
      currentVersion?: string;
    };
  }
  function data(result: Result) {
    if (result.isError) throw new Error(result.content?.[0]?.text);
    return result.structuredContent!.data;
  }
  async function tools(client: Client) {
    return (await client.listTools()).tools.map((tool) => tool.name);
  }

  const expenseArgs = {
    date: "2026-09-02",
    description: "Software",
    amount: 12.5,
    currency: "MYR",
    fromAccountId: 0,
    toAccountId: 0,
  };

  describe(`MCP writes (${era})`, () => {
    describe("discovery", () => {
      it("publishes the complete reviewed annotation matrix", async () => {
        const client = await connect({ token: writerToken });
        const listed = (await client.listTools()).tools;
        const expectedNames = [
          ...READ_TOOLS,
          ...ADDITIVE_TOOLS,
          ...OVERWRITE_TOOLS,
        ];
        expect(new Set(expectedNames).size).toBe(63);
        expect(listed.map((tool) => tool.name).sort()).toEqual(
          expectedNames.sort(),
        );
        for (const tool of listed) {
          const read = READ_TOOLS.includes(tool.name);
          expect(tool.annotations, tool.name).toMatchObject({
            readOnlyHint: read,
            destructiveHint: OVERWRITE_TOOLS.includes(tool.name),
            idempotentHint: read || IDEMPOTENT_WRITES.includes(tool.name),
            openWorldHint: tool.name === "confirm_import",
          });
          expect(tool.description?.length, tool.name).toBeGreaterThan(0);
        }
      });

      it("describes reviewed approvals separately from overwrite effects", async () => {
        const client = await connect({ token: writerToken });
        const listed = (await client.listTools()).tools;
        for (const name of REVIEWED_TOOLS) {
          const tool = listed.find((tool) => tool.name === name)!;
          expect(tool.description, name).toMatch(/reviewed confirmation/i);
          expect(tool.description, name).toMatch(/present/i);
        }
        const description = (name: string) =>
          listed.find((tool) => tool.name === name)!.description!;
        expect(description("set_opening_balance")).toMatch(
          /before replacing or removing/i,
        );
        expect(description("set_movement_matches")).toMatch(
          /before removing or reducing/i,
        );
        expect(description("set_movement_matches")).toContain(
          "do not assume there are none",
        );
        expect(description("record_transfer_from_line")).toContain(
          "records:adjust",
        );
        expect(description("confirm_import")).toContain(
          "external exchange-rate provider",
        );
        expect(description("confirm_import")).toContain("partial result");
        expect(description("undo_settlement")).toContain(
          "may still keep records locked",
        );
        for (const name of ["create_record", "record_payment"]) {
          const tool = listed.find((tool) => tool.name === name)!;
          expect(tool.inputSchema.properties).toHaveProperty("dryRun");
          expect(tool.annotations?.readOnlyHint).toBe(false);
        }
        for (const name of ["record_payment", "create_reimbursement"])
          expect(description(name)).toContain("does not send money");
        for (const name of [
          "issue_invoice",
          "set_quotation_status",
          "revise_quotation",
          "convert_quotation_to_invoice",
        ])
          expect(description(name)).toMatch(/does not email/i);
        // Legacy initialization and modern server/discover both expose instructions.
        expect(client.getInstructions()).toContain(
          "explicit user request authorizes routine",
        );
        expect(client.getInstructions()).toContain(
          "effects, not a mandatory approval policy",
        );
        expect(client.getInstructions()).toContain(
          "An existing approval covering that exact reviewed change remains valid",
        );
        expect(client.getInstructions()).toContain("saved: true");
        const prompt = await client.getPrompt({
          name: "review-record-descriptions",
        });
        expect(JSON.stringify(prompt.messages)).toContain(
          "without another approval question for each row",
        );
        expect(JSON.stringify(prompt.messages)).toContain(
          "apply only the approved rows",
        );
      });

      it("lists for a personal access token exactly what it was granted", async () => {
        const reads = await tools(
          await connect({ token: issueTestToken(db, 1, ["records.read"]) }),
        );
        expect(reads).toContain("get_record");
        expect(reads).not.toContain("create_record");
        const writes = await tools(
          await connect({
            token: issueTestToken(db, 1, ["records.read", "records.create"]),
          }),
        );
        expect(writes).toContain("create_record");
        expect(writes).not.toContain("delete_record");
        const all = await tools(await connect({ token: writerToken }));
        expect(all).toContain("delete_record");
      });

      it("never lets a token go beyond its owner's delegation ceiling", async () => {
        const token = issueTestToken(db, 1, ["records.read", "records.create"]);
        db.delete(groupDelegations)
          .where(eq(groupDelegations.permission, "records.create"))
          .run();
        const names = await tools(await connect({ token }));
        expect(names).toContain("get_record");
        expect(names).not.toContain("create_record");
      });

      it("lists writes only for granted scopes, and deletes only for :delete", async () => {
        const readOnly = await tools(
          await connect({ token: writerToken, scopes: ["records:read"] }),
        );
        expect(readOnly).not.toContain("create_record");
        const write = await tools(
          await connect({
            token: writerToken,
            scopes: ["records:read", "records:write"],
          }),
        );
        expect(write).toContain("create_record");
        expect(write).toContain("update_record");
        expect(write).not.toContain("delete_record");
        expect(write).not.toContain("undo_settlement");
        const all = await tools(await connect());
        expect(all).toContain("delete_record");
      });

      it("never lists what the user cannot do, whatever the token holds", async () => {
        const keeper = await tools(
          await connect({ token: keeperToken, scopes: ALL_WRITE }),
        );
        expect(keeper).toContain("update_record");
        expect(keeper).not.toContain("delete_record");
        const reader = await tools(
          await connect({ token: readerToken, scopes: ALL_WRITE }),
        );
        expect(reader.some((name) => TOOL_REQUIREMENTS[name]?.writes)).toBe(
          false,
        );
      });

      it("answers an unlisted write call with an insufficient_scope challenge", async () => {
        const client = await connect({
          token: writerToken,
          scopes: ["records:read"],
        });
        await expect(
          client.callTool({
            name: "create_record",
            arguments: {
              ...expenseArgs,
              fromAccountId: bank,
              toAccountId: software,
            },
          }),
        ).rejects.toThrow();
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("registers exactly the tools in TOOL_REQUIREMENTS", async () => {
        const names = new Set<string>();
        const server = createServer({
          db,
          store,
          storageRoot,
          locals: localsFor({
            token: writerToken,
            scopes: [...ALL_WRITE, "reports:read"],
          }),
        } as never) as McpServer;
        const registered = (
          server as unknown as { _registeredTools: Record<string, unknown> }
        )._registeredTools;
        for (const name of Object.keys(registered)) names.add(name);
        expect([...names].sort()).toEqual(
          Object.keys(TOOL_REQUIREMENTS).sort(),
        );
      });
    });

    describe("declared idempotence", () => {
      it("repeating every declared idempotent write has no additional business effects", async () => {
        const client = await connect({ token: writerToken });
        const tested = new Set<string>();
        const businessTables = [
          schema.accounts,
          schema.contacts,
          schema.contactRoles,
          schema.ledgerRecords,
          schema.ledgerMovements,
          schema.settlements,
          schema.invoices,
          schema.invoiceLines,
          schema.quotations,
          schema.quotationLines,
          schema.importQueue,
          schema.importItems,
          schema.reconciliationAllocations,
          schema.reimbursements,
          schema.reimbursementEntries,
        ];
        // Credential usage and audit metadata are intentionally outside business-state idempotence.
        const snapshot = () =>
          businessTables.map((table) =>
            sqlite
              .query(`SELECT * FROM "${getTableName(table)}" ORDER BY rowid`)
              .all(),
          );
        const applyAndRepeat = async (
          name: string,
          input: Record<string, unknown>,
        ) => {
          const first = data(await call(client, name, input));
          const before = snapshot();
          const repeated = await call(client, name, input);
          if (repeated.isError)
            expect(["CONFLICT", "REFUSED"]).toContain(errorOf(repeated).code);
          expect(snapshot(), name).toEqual(before);
          tested.add(name);
          return first;
        };
        const record = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        await applyAndRepeat("update_record", {
          recordId: record.record.id,
          expectedVersion: record.version,
          description: "Annual software",
        });
        const account = data(
          await call(client, "list_accounts", {}),
        ).accounts.find((a: { id: number }) => a.id === software);
        await applyAndRepeat("update_account", {
          accountId: software,
          expectedVersion: account.version,
          name: "Software licences",
        });
        const contact = data(
          await call(client, "list_contacts", {}),
        ).contacts.find((c: { id: number }) => c.id === supplier);
        const changedContact = await applyAndRepeat("update_contact", {
          contactId: supplier,
          expectedVersion: contact.version,
          legalName: "Supplier Sdn Bhd",
          roles: [2],
        });
        // Replacing an already identical set of roles is also a business no-op.
        await applyAndRepeat("update_contact", {
          contactId: supplier,
          expectedVersion: changedContact.version,
          roles: [2],
        });
        const document = {
          contactId: supplier,
          issueDate: "2026-09-01",
          lines: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
        };
        const invoice = data(await call(client, "create_invoice", document));
        await applyAndRepeat("update_invoice", {
          invoiceId: invoice.invoice.id,
          expectedVersion: invoice.invoice.version,
          notes: "Reviewed terms",
        });
        const quotation = data(
          await call(client, "create_quotation", document),
        );
        const updatedQuotation = await applyAndRepeat("update_quotation", {
          quotationId: quotation.quotation.id,
          expectedVersion: quotation.quotation.version,
          notes: "Reviewed offer",
        });
        await applyAndRepeat("set_quotation_status", {
          quotationId: quotation.quotation.id,
          expectedVersion: updatedQuotation.quotation.version,
          status: "sent",
        });
        await applyAndRepeat("set_opening_balance", {
          accountId: bank,
          expectedVersion: "absent",
          date: "2026-01-01",
          amountMinor: 100000,
        });
        const jobId = "00000000-0000-4000-8000-0000000000aa";
        db.insert(importQueue)
          .values({
            id: jobId,
            createdBy: 1,
            originalFilename: "group.pdf",
            tempFilePath: "import/temp/group.pdf",
            state: ImportState.Grouped,
          })
          .run();
        db.insert(schema.importItems)
          .values({
            id: "item-one",
            jobId,
            position: 0,
            sectionKey: "items",
            state: ImportState.PendingReview,
            itemName: "Software",
            documentType: 1,
            date: "2026-09-02",
            amount: 12.5,
            currency: "MYR",
            exchangeRate: 1,
            accountId: bank,
            categoryAccountId: software,
          })
          .run();
        const job = data(await call(client, "get_import_job", { jobId }));
        await applyAndRepeat("update_import_item", {
          jobId,
          itemId: "item-one",
          expectedVersion: job.items[0].version,
          item_name: "Software licence",
        });
        const statementId = db
          .insert(bankStatements)
          .values({
            originalFilename: "sept.pdf",
            storedFilePath: "reconciliation/sept.pdf",
            extractionState: StatementExtractionState.Ready,
            uploadedBy: 1,
            accountId: bank,
          })
          .returning()
          .get()!.id;
        const lineId = db
          .insert(bankStatementLines)
          .values({
            statementId,
            date: "2026-09-02",
            amount: 12.5,
            direction: StatementDirection.Out,
          })
          .returning()
          .get()!.id;
        const read = data(
          await call(client, "get_bank_statement", { statementId }),
        );
        const movement = read.candidates.find(
          (candidate: { recordId: number }) =>
            candidate.recordId === record.record.id,
        );
        const matched = await applyAndRepeat("set_movement_matches", {
          movementId: movement.movementId,
          expectedVersion: movement.matchesVersion,
          allocations: [{ lineId, amount: 12.5 }],
        });
        const cleared = await applyAndRepeat("set_movement_matches", {
          movementId: movement.movementId,
          expectedVersion: matched.version,
          allocations: [],
        });
        await applyAndRepeat("set_movement_matches", {
          movementId: movement.movementId,
          expectedVersion: cleared.version,
          allocations: [],
        });
        expect([...tested].sort()).toEqual([...IDEMPOTENT_WRITES].sort());
      });
    });

    describe("grouped correction access", () => {
      const grouped: OAuthScope[] = [
        "records:read",
        "records:write",
        "records:correction",
      ];
      const permissions: LeafPermission[] = [
        "records.read",
        "records.create",
        "records.update",
        "records.correctAllocations",
        "records.correctPaymentRecipient",
      ];

      it("offers grouped corrections without deletion, adjustment or group reversal", async () => {
        const client = await connect({ token: writerToken, scopes: grouped });
        const names = await tools(client);
        for (const name of [
          "undo_settlement",
          "correct_payment_allocations",
          "correct_payment_recipient",
          "correct_record_date",
          "correct_reimbursement_amount",
        ])
          expect(names).toContain(name);
        for (const name of ["delete_record", "reverse_reimbursement"])
          expect(names).not.toContain(name);
        const auth = localsFor({ token: writerToken, scopes: grouped });
        expect(auth.permissions?.has("records.delete")).toBe(false);
        expect(auth.permissions?.has("records.adjust")).toBe(false);
        const resource = await client.readResource({ uri: "akaun://context" });
        const resourceContent = resource.contents[0];
        if (!("text" in resourceContent))
          throw new Error("Expected JSON context");
        const context = JSON.parse(resourceContent.text);
        expect(context.recordCorrections.undo_settlement.available).toBe(true);
        expect(
          context.recordCorrections.correct_payment_recipient.available,
        ).toBe(true);
        const limited = await connect({
          token: writerToken,
          scopes: ["records:read", "records:write"],
        });
        const limitedResource = await limited.readResource({
          uri: "akaun://context",
        });
        const limitedContent = limitedResource.contents[0];
        if (!("text" in limitedContent))
          throw new Error("Expected JSON context");
        const unavailable = JSON.parse(limitedContent.text).recordCorrections
          .correct_payment_recipient;
        expect(unavailable.available).toBe(false);
        expect(unavailable.alternatives[0].missingScopes).toEqual([
          "records:correction",
        ]);
        const narrow = await tools(
          await connect({
            token: writerToken,
            scopes: ["records:read", "records:write", "records:correct-date"],
          }),
        );
        expect(narrow).toContain("correct_record_date");
        expect(narrow).not.toContain("correct_reimbursement_amount");
        expect(narrow).not.toContain("undo_settlement");
        expect(narrow).not.toContain("correct_payment_recipient");
      });

      it("checks complete alternatives instead of mixing their scopes and permissions", () => {
        const auth = localsFor({ token: writerToken, scopes: grouped });
        auth.permissions = new Set([
          "records.create",
          "records.update",
          "records.delete",
        ]);
        expect(
          toolAllowed(auth, TOOL_REQUIREMENTS.correct_payment_recipient),
        ).toBe(false);
        expect(toolAllowed(auth, TOOL_REQUIREMENTS.undo_settlement)).toBe(
          false,
        );
      });

      it("bounds a grouped grant by each role leaf and delegation ceiling", async () => {
        const cases = [
          ["records.correctAllocations", "undo_settlement"],
          ["records.correctPaymentRecipient", "correct_payment_recipient"],
          ["records.correctDate", "correct_record_date"],
          [
            "records.correctReimbursementAmount",
            "correct_reimbursement_amount",
          ],
        ] as const;
        const client = await connect({ token: writerToken, scopes: grouped });
        for (const [permission, name] of cases) {
          db.delete(groupDelegations)
            .where(eq(groupDelegations.permission, permission))
            .run();
          expect(await tools(client)).not.toContain(name);
        }
        // Having some other grouped permission is not enough to step up for a
        // correction whose own role/delegation leaf is missing.
        const inspection = await inspectRpc(
          new Request(`${origin}/mcp`, {
            method: "POST",
            body: JSON.stringify({
              method: "tools/call",
              params: { name: "correct_payment_recipient" },
            }),
          }),
          localsFor({
            token: writerToken,
            scopes: ["records:read", "records:write"],
          }),
        );
        // Legacy delete access is still grantable, so only that route is offered.
        expect(inspection.response?.headers.get("WWW-Authenticate")).toContain(
          "records:delete",
        );
        expect(
          inspection.response?.headers.get("WWW-Authenticate"),
        ).not.toContain("records:correction");
        db.delete(groupGrants)
          .where(eq(groupGrants.permission, "records.correctDate"))
          .run();
        expect(await tools(client)).not.toContain("correct_record_date");
      });

      it("challenges for one grantable alternative and does not challenge an existing grouped grant", async () => {
        const request = () =>
          new Request(`${origin}/mcp`, {
            method: "POST",
            body: JSON.stringify({
              method: "tools/call",
              params: { name: "correct_payment_recipient" },
            }),
          });
        const inspection = await inspectRpc(
          request(),
          localsFor({
            token: writerToken,
            scopes: ["records:read", "records:write"],
          }),
        );
        const header = inspection.response?.headers.get("WWW-Authenticate");
        expect(inspection.response?.status).toBe(403);
        expect(header).toContain("records:correction");
        expect(header).not.toContain("records:delete");
        expect(
          (
            await inspectRpc(
              request(),
              localsFor({ token: writerToken, scopes: grouped }),
            )
          ).response,
        ).toBeNull();
        // With both authorization routes unavailable, no impossible consent loop.
        for (const permission of [
          "records.correctPaymentRecipient",
          "records.delete",
        ])
          db.delete(groupDelegations)
            .where(eq(groupDelegations.permission, permission))
            .run();
        expect(
          (
            await inspectRpc(
              request(),
              localsFor({
                token: writerToken,
                scopes: ["records:read", "records:write"],
              }),
            )
          ).response,
        ).toBeNull();
      });

      for (const blockedBy of ["role", "ceiling"] as const) {
        it(`steps up to a grantable legacy route when the grouped permission is blocked by ${blockedBy}`, async () => {
          const table = blockedBy === "role" ? groupGrants : groupDelegations;
          db.delete(table)
            .where(eq(table.permission, "records.correctPaymentRecipient"))
            .run();
          const auth = localsFor({ token: writerToken, scopes: grouped });
          // The grouped scope is valid for another correction, but cannot
          // authorize this payee operation through the user's role/ceiling.
          expect(auth.permissions?.has("records.correctDate")).toBe(true);
          expect(
            toolAllowed(auth, TOOL_REQUIREMENTS.correct_payment_recipient),
          ).toBe(false);
          const inspection = await inspectRpc(
            new Request(`${origin}/mcp`, {
              method: "POST",
              body: JSON.stringify({
                method: "tools/call",
                params: { name: "correct_payment_recipient" },
              }),
            }),
            auth,
          );
          expect(inspection.response?.status).toBe(403);
          expect(
            inspection.response?.headers.get("WWW-Authenticate"),
          ).toContain('scope="records:write records:delete"');
          expect(
            inspection.response?.headers.get("WWW-Authenticate"),
          ).not.toContain("records:correction");
          const steppedUp = await connect({
            token: writerToken,
            scopes: [...grouped, "records:delete"],
          });
          expect(await tools(steppedUp)).toContain("correct_payment_recipient");
        });
      }

      it("rechecks correction authorization when invoking a registered tool", async () => {
        const auth = localsFor({ token: writerToken, scopes: grouped });
        const server = createServer({ db, store, storageRoot, locals: auth });
        const registered = (
          server as unknown as {
            _registeredTools: Record<
              string,
              { handler: (input: unknown, extra: unknown) => Promise<Result> }
            >;
          }
        )._registeredTools;
        expect(registered.correct_payment_recipient).toBeDefined();
        auth.permissions = new Set(["records.create", "records.update"]);
        expect(
          errorOf(
            await registered.correct_payment_recipient.handler(
              {
                recordId: 1,
                contactId: supplier,
                reason: "Reviewed payee correction",
                expectedVersion: "stale",
              },
              {},
            ),
          ).code,
        ).toBe("FORBIDDEN");
        await server.close();
      });

      for (const via of ["pat", "oauth"] as const) {
        for (const correctedMinor of [1000, 1500]) {
          it(`reopens, edits, corrects payee and reapplies original credit to ${correctedMinor} cents through ${via} without deletion`, async () => {
            const token = issueTestToken(db, 1, permissions);
            const client = await connect({
              token,
              ...(via === "oauth" ? { scopes: grouped } : {}),
            });
            expect(await tools(client)).not.toContain("delete_record");
            const correctPayee = db
              .insert(contacts)
              .values({ entityType: 2, legalName: "Correct employee" })
              .returning()
              .get()!.id;
            const bill = data(
              await call(client, "create_record", {
                ...expenseArgs,
                fromAccountId: payable,
                toAccountId: software,
                contactId: supplier,
              }),
            );
            const owedId = bill.record.movements.find(
              (m: { accountId: number }) => m.accountId === payable,
            ).id;
            const reimbursed = data(
              await call(client, "create_reimbursement", {
                contactId: supplier,
                personallyPaid: true,
                date: "2026-09-03",
                description: "Imported reimbursement with wrong payee",
                items: [{ owedMovementId: owedId, amountMinor: 1250 }],
                cashMinor: 1250,
                paidFromAccountId: bank,
              }),
            );
            const paymentId = reimbursed.payment.id;
            const paymentMovementId = reimbursed.payment.movements.find(
              (m: { accountId: number }) => m.accountId === payable,
            ).id;
            const original = getRecord(db, paymentId)!;
            const postings = original.movements.map(
              ({ id, accountId, amountMinor }) => ({
                id,
                accountId,
                amountMinor,
              }),
            );
            const preview = data(
              await call(client, "get_payment_allocations", {
                paymentMovementId,
              }),
            );
            const undo = {
              settlementId: preview.allocations[0].id,
              reason: "Reopen imported expense to correct its amount",
              expectedVersion: preview.version,
            };
            data(await call(client, "undo_settlement", undo));
            expect(
              errorOf(await call(client, "undo_settlement", undo)).code,
            ).toBe("NOT_FOUND");
            expect(
              errorOf(
                await call(client, "correct_payment_allocations", {
                  paymentMovementId,
                  allocations: [{ owedMovementId: owedId, amountMinor: 1000 }],
                  reason: "Reapply credit using a stale allocation preview",
                  expectedVersion: preview.version,
                }),
              ).code,
            ).toBe("CONFLICT");
            expect(getRecord(db, bill.record.id)!.locked).toBe(false);
            const fresh = data(
              await call(client, "get_record", { recordId: bill.record.id }),
            );
            data(
              await call(client, "update_record", {
                recordId: bill.record.id,
                expectedVersion: fresh.record.version,
                amount: correctedMinor / 100,
              }),
            );
            const recipient = data(
              await call(client, "get_payment_recipient_correction", {
                recordId: paymentId,
              }),
            );
            data(
              await call(client, "correct_payment_recipient", {
                recordId: paymentId,
                contactId: correctPayee,
                reason: "Correct payee from the original bank evidence",
                expectedVersion: recipient.version,
              }),
            );
            const current = data(
              await call(client, "get_payment_allocations", {
                paymentMovementId,
              }),
            );
            data(
              await call(client, "correct_payment_allocations", {
                paymentMovementId,
                removeSettlementIds: [],
                allocations: [
                  {
                    owedMovementId: owedId,
                    amountMinor: Math.min(1250, correctedMinor),
                  },
                ],
                reason: "Reapply original payment credit to corrected expense",
                expectedVersion: current.version,
              }),
            );
            const finalPayment = getRecord(db, paymentId)!;
            const finalExpense = getRecord(db, bill.record.id)!;
            expect(finalPayment.contactId).toBe(correctPayee);
            expect(finalPayment.amountMinor).toBe(1250);
            expect(finalPayment.date).toBe(original.date);
            expect(finalPayment.recordNumber).toBe(original.recordNumber);
            expect(
              finalPayment.movements.map(({ id, accountId, amountMinor }) => ({
                id,
                accountId,
                amountMinor,
              })),
            ).toEqual(postings);
            expect(finalExpense.contactId).toBe(supplier);
            expect(finalExpense.outstandingMinor).toBe(
              Math.max(0, correctedMinor - 1250),
            );
            expect(finalPayment.outstandingMinor).toBe(
              Math.max(0, 1250 - correctedMinor),
            );
            const history = data(
              await call(client, "get_record", {
                recordId: paymentId,
                includeSettlements: true,
              }),
            );
            expect(history.reversedSettlements).toHaveLength(1);
            expect(history.reversedSettlements[0].reversalReason).toBe(
              undo.reason,
            );
            expect(db.select().from(ledgerRecords).all()).toHaveLength(2);
            expect(
              db
                .select()
                .from(auditLog)
                .all()
                .filter(
                  (entry) =>
                    entry.operation === "mcp:correct_payment_recipient",
                ).length,
            ).toBeGreaterThan(0);
            expect(
              db
                .select()
                .from(auditLog)
                .all()
                .filter(
                  (entry) =>
                    entry.operation === "mcp:correct_payment_recipient",
                )
                .every((entry) => entry.via === via && entry.userId === 1),
            ).toBe(true);
          });
        }
      }
    });

    describe("historical corrections", () => {
      const corrections = [
        {
          scope: "records:correct-date",
          permission: "records.correctDate",
          read: "get_record_date_correction",
          write: "correct_record_date",
        },
        {
          scope: "records:correct-reimbursement-amount",
          permission: "records.correctReimbursementAmount",
          read: "get_reimbursement_amount_correction",
          write: "correct_reimbursement_amount",
        },
      ] as const;

      for (const correction of corrections) {
        it(`requires every scope and PAT permission for ${correction.write}`, async () => {
          const scopes: OAuthScope[] = [
            "records:read",
            "records:write",
            correction.scope,
          ];
          const permissions: LeafPermission[] = [
            "records.read",
            "records.update",
            correction.permission,
          ];
          for (const missing of scopes) {
            const auth = {
              token: writerToken,
              scopes: scopes.filter((scope) => scope !== missing),
            };
            const names = await tools(await connect(auth));
            expect(names).not.toContain(correction.read);
            expect(names).not.toContain(correction.write);
            const response = await handleMcpRequest(
              new Request(`${origin}/mcp`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: correction.write,
                    arguments: { recordId: 1 },
                  },
                }),
              }),
              { db, store, storageRoot, locals: localsFor(auth) },
              origin,
            );
            expect(response.status).toBe(403);
            expect(response.headers.get("WWW-Authenticate")).toContain(
              'error="insufficient_scope"',
            );
            expect(response.headers.get("WWW-Authenticate")).toContain(
              correction.scope,
            );
          }
          for (const missing of permissions) {
            const token = issueTestToken(
              db,
              1,
              permissions.filter((permission) => permission !== missing),
            );
            const client = await connect({ token });
            expect(await tools(client)).not.toContain(correction.read);
            expect(await tools(client)).not.toContain(correction.write);
            await expect(
              call(client, correction.write, { recordId: 1 }),
            ).rejects.toThrow("not found");
          }
          const names = await tools(
            await connect({ token: writerToken, scopes }),
          );
          expect(names).toContain(correction.read);
          expect(names).toContain(correction.write);
          expect(names).not.toContain(
            corrections.find((c) => c.scope !== correction.scope)!.write,
          );
        });

        it(`revokes ${correction.write} when its role or delegation changes`, async () => {
          for (const table of [groupDelegations, groupGrants]) {
            const client = await connect({ token: writerToken });
            expect(await tools(client)).toContain(correction.write);
            db.delete(table)
              .where(eq(table.permission, correction.permission))
              .run();
            expect(await tools(client)).not.toContain(correction.read);
            expect(await tools(client)).not.toContain(correction.write);
            await expect(
              call(client, correction.write, { recordId: 1 }),
            ).rejects.toThrow("not found");
            // Restore the rows for the independent role/ceiling check.
            const groups = db.select().from(schema.groups).all();
            db.insert(table)
              .values(
                groups
                  .filter((g) => g.name !== "readers")
                  .map((g) => ({
                    groupId: g.id,
                    permission: correction.permission,
                  })),
              )
              .run();
          }
        });

        it(`rechecks ${correction.write} at invocation on an existing server`, async () => {
          const locals = localsFor({ token: writerToken });
          const server = createServer({ db, store, storageRoot, locals });
          const client = new Client({
            name: "correction-recheck",
            version: "1",
          });
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          clients.push(client);
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          (locals.permissions as Set<string>).delete(correction.permission);
          expect(
            errorOf(await call(client, correction.read, { recordId: 1 })).code,
          ).toBe("FORBIDDEN");
          const input =
            correction.scope === "records:correct-date"
              ? { date: "2026-08-31", acknowledgePeriodChange: true }
              : { amountMinor: 500, allocations: [] };
          expect(
            errorOf(
              await call(client, correction.write, {
                recordId: 1,
                reason: "Correction checked against receipt",
                expectedVersion: "stale",
                ...input,
              }),
            ).code,
          ).toBe("FORBIDDEN");
          await server.close();
        });
      }

      for (const via of ["pat", "oauth", "grouped-oauth"] as const) {
        it(`corrects dates and reimbursement amounts with audit attribution through ${via}`, async () => {
          const client = await connect({
            token: writerToken,
            ...(via === "oauth"
              ? { scopes: ALL_WRITE }
              : via === "grouped-oauth"
                ? {
                    scopes: [
                      "records:read",
                      "records:write",
                      "records:correction",
                    ] as OAuthScope[],
                  }
                : {}),
          });
          const employee = db
            .insert(contacts)
            .values({ entityType: 2, legalName: "Employee" })
            .returning()
            .get()!.id;
          const bill = data(
            await call(client, "create_record", {
              ...expenseArgs,
              amount: 5.5,
              fromAccountId: payable,
              toAccountId: software,
              contactId: supplier,
            }),
          );
          const owed = bill.record.movements.find(
            (m: { accountId: number }) => m.accountId === payable,
          );
          const reimbursement = data(
            await call(client, "create_reimbursement", {
              contactId: employee,
              personallyPaid: true,
              date: "2026-09-03",
              description: "Employee reimbursement",
              items: [{ owedMovementId: owed.id, amountMinor: 550 }],
              cashMinor: 550,
              paidFromAccountId: bank,
            }),
          );
          const paymentId = reimbursement.payment.id;
          const before = getRecord(db, bill.record.id)!;
          const dateState = data(
            await call(client, "get_record_date_correction", {
              recordId: before.id,
            }),
          );
          const dateInput = {
            recordId: before.id,
            date: "2026-08-31",
            reason: "Corrected against original receipt",
            expectedVersion: dateState.version,
            acknowledgePeriodChange: true,
          };
          expect(
            errorOf(
              await call(client, "correct_record_date", {
                ...dateInput,
                acknowledgePeriodChange: false,
              }),
            ).code,
          ).toBe("INVALID_INPUT");
          const dated = data(
            await call(client, "correct_record_date", dateInput),
          );
          expect(dated.record.date).toBe("2026-08-31");
          expect(getRecord(db, before.id)!.movements).toEqual(before.movements);
          expect(getRecord(db, paymentId)!.date).toBe("2026-09-03");
          expect(
            errorOf(await call(client, "correct_record_date", dateInput)).code,
          ).toBe("CONFLICT");
          const amountState = data(
            await call(client, "get_reimbursement_amount_correction", {
              recordId: paymentId,
            }),
          );
          const amountInput = {
            recordId: paymentId,
            amountMinor: 500,
            allocations: [{ owedMovementId: owed.id, amountMinor: 500 }],
            reason: "Correct to actual bank transfer amount",
            expectedVersion: amountState.version,
          };
          expect(
            errorOf(
              await call(client, "correct_reimbursement_amount", {
                ...amountInput,
                allocations: [{ owedMovementId: owed.id, amountMinor: 600 }],
              }),
            ).code,
          ).toBe("INVALID_INPUT");
          const corrected = data(
            await call(client, "correct_reimbursement_amount", amountInput),
          );
          expect(corrected.record.mainCurrencyAmountMinor).toBe(500);
          const finalState = data(
            await call(client, "get_reimbursement_amount_correction", {
              recordId: paymentId,
            }),
          );
          expect(
            finalState.expenses[0].availableMinor -
              finalState.expenses[0].allocatedMinor,
          ).toBe(50);
          expect(finalState.availableCreditMinor).toBe(0);
          expect(
            errorOf(
              await call(client, "correct_reimbursement_amount", amountInput),
            ).code,
          ).toBe("CONFLICT");
          for (const name of [
            "correct_record_date",
            "correct_reimbursement_amount",
          ]) {
            const entries = db
              .select()
              .from(auditLog)
              .all()
              .filter((entry) => entry.operation === `mcp:${name}`);
            expect(entries.length).toBeGreaterThan(0);
            expect(
              entries.every(
                (entry) =>
                  entry.via === (via === "grouped-oauth" ? "oauth" : via) &&
                  entry.userId === 1 &&
                  entry.credentialId !== null,
              ),
            ).toBe(true);
          }
        });
      }
    });

    describe("records", () => {
      it("creates a record, audited under the caller, and emits after commit", async () => {
        const client = await connect();
        const seen: number[] = [];
        const listener = ({ record }: { record: { id: number } }) => {
          // Emitted after the write is final: the row is already readable.
          expect(
            db
              .select()
              .from(ledgerRecords)
              .where(eq(ledgerRecords.id, record.id))
              .get(),
          ).toBeTruthy();
          seen.push(record.id);
        };
        ledgerEvents.on("record-update", listener);
        let created;
        try {
          created = data(
            await call(client, "create_record", {
              ...expenseArgs,
              fromAccountId: bank,
              toAccountId: software,
            }),
          );
        } finally {
          ledgerEvents.off("record-update", listener);
        }
        expect(created.record.kind).toBe("expense");
        expect(created.version).toMatch(/^[0-9a-f]{16}$/);
        expect(seen).toContain(created.record.id);
        const audit = db
          .select()
          .from(auditLog)
          .where(eq(auditLog.recordId, String(created.record.id)))
          .all();
        // Credited to the user, and marked as the app's doing: one request id
        // per tool call, so the log groups everything the call changed.
        const made = audit.find(
          (row) =>
            row.recordType === "record" &&
            row.userId === 1 &&
            row.action === "create",
        );
        expect(made).toMatchObject({
          via: "oauth",
          credentialId: "grant",
          clientId: "client",
          operation: "mcp:create_record",
        });
        expect(made?.requestId).toBeTruthy();
      });

      it("saves nothing on a dry run", async () => {
        const client = await connect();
        const preview = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
            dryRun: true,
          }),
        );
        expect(preview.record.sides).toHaveLength(2);
        // Says so, and hands back no id or version a client could act on.
        expect(preview.dryRun).toBe(true);
        expect(preview.saved).toBe(false);
        expect(preview.record.id).toBeUndefined();
        expect(preview.version).toBeUndefined();
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("refuses an adjustment for a user without the ability", async () => {
        const client = await connect();
        const refused = errorOf(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: cash,
            extraSides: [{ accountId: software, amountMinor: 100 }],
          }),
        );
        expect(refused.code).toBe("REFUSED");
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("updates with the current version and refuses a stale one", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const updated = data(
          await call(client, "update_record", {
            recordId: created.record.id,
            expectedVersion: created.version,
            description: "Software licence",
          }),
        );
        expect(updated.record.description).toBe("Software licence");
        const stale = errorOf(
          await call(client, "update_record", {
            recordId: created.record.id,
            expectedVersion: created.version,
            description: "Overwritten",
          }),
        );
        expect(stale.code).toBe("CONFLICT");
        expect(stale.currentVersion).toBe(updated.version);
        const read = data(
          await call(client, "get_record", { recordId: created.record.id }),
        );
        expect(read.record.description).toBe("Software licence");
        expect(read.record.version).toBe(updated.version);

        // A list row's version is good for a write, with no get_record first.
        const listed = data(await call(client, "list_records", {})).records[0];
        expect(listed.version).toBe(updated.version);
        const fromList = data(
          await call(client, "update_record", {
            recordId: listed.id,
            expectedVersion: listed.version,
            description: "Software licence (annual)",
          }),
        );
        expect(fromList.record.description).toBe("Software licence (annual)");
      });

      it("reimburses directly and corrects allocations without changing the expense supplier", async () => {
        const client = await connect();
        const employee = db
          .insert(contacts)
          .values({ entityType: 2, legalName: "Employee" })
          .returning()
          .get()!.id;
        const other = db
          .insert(contacts)
          .values({ entityType: 2, legalName: "Other employee" })
          .returning()
          .get()!.id;
        const reimbursementPayable = payable;
        const bill = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: reimbursementPayable,
            toAccountId: software,
            contactId: supplier,
          }),
        );
        const owed = bill.record.movements.find(
          (m: { accountId: number }) => m.accountId === reimbursementPayable,
        );
        const candidates = data(
          await call(client, "get_reimbursement_candidates", {
            contactId: employee,
          }),
        );
        expect(
          candidates.items.some(
            (i: { movementId: number }) => i.movementId === owed.id,
          ),
        ).toBe(true);
        const claim = data(
          await call(client, "create_reimbursement", {
            contactId: employee,
            personallyPaid: true,
            date: "2026-09-03",
            description: "Employee reimbursement",
            items: [{ owedMovementId: owed.id, amountMinor: 1250 }],
            cashMinor: 1250,
            paidFromAccountId: bank,
          }),
        );
        expect(claim.payment.contactId).toBe(employee);
        expect(
          db
            .select()
            .from(ledgerRecords)
            .where(eq(ledgerRecords.id, bill.record.id))
            .get(),
        ).toMatchObject({ contactId: supplier });
        const preview = data(
          await call(client, "get_payment_recipient_correction", {
            recordId: claim.payment.id,
          }),
        );
        const recipientCorrection = data(
          await call(client, "correct_payment_recipient", {
            recordId: claim.payment.id,
            contactId: other,
            reason: "Change recipient after reviewing",
            expectedVersion: preview.version,
          }),
        );
        expect(recipientCorrection).toBeDefined();
        const movement = claim.payment.movements.find(
          (m: { accountId: number }) => m.accountId === reimbursementPayable,
        );
        const allocations = data(
          await call(client, "get_payment_allocations", {
            paymentMovementId: movement.id,
          }),
        );
        const corrected = data(
          await call(client, "correct_payment_allocations", {
            paymentMovementId: movement.id,
            removeSettlementIds: allocations.allocations.map(
              (a: { id: number }) => a.id,
            ),
            allocations: [],
            reason: "Remove the mistaken coverage",
            expectedVersion: allocations.version,
          }),
        );
        expect(corrected.undoneIds).toHaveLength(1);
        expect(getRecord(db, claim.payment.id)!.outstandingMinor).toBe(1250);
        expect(getRecord(db, bill.record.id)!.contactId).toBe(supplier);
      });

      it("records a payment with its settlement, and keeps the settled amount locked", async () => {
        const client = await connect();
        const bill = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: payable,
            toAccountId: software,
            contactId: supplier,
          }),
        );
        const owed = bill.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        );
        const paid = data(
          await call(client, "record_payment", {
            date: "2026-09-03",
            description: "Pay supplier",
            amount: 12.5,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: supplier,
            direction: "we-pay",
            settlements: [{ owedMovementId: owed.id, amountMinor: 1250 }],
          }),
        );
        expect(paid.record.kind).toBe("payment");
        expect(db.select().from(settlements).all()).toHaveLength(1);

        const current = data(
          await call(client, "get_record", { recordId: bill.record.id }),
        );
        const locked = errorOf(
          await call(client, "update_record", {
            recordId: bill.record.id,
            expectedVersion: current.record.version,
            amount: 99,
          }),
        );
        expect(locked.code).toBe("REFUSED");
        const described = data(
          await call(client, "update_record", {
            recordId: bill.record.id,
            expectedVersion: current.record.version,
            description: "Software (settled)",
          }),
        );
        expect(described.record.description).toBe("Software (settled)");
      });

      it("previews and corrects an allocation with a reason and fresh version", async () => {
        const client = await connect();
        const bill = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: payable,
            toAccountId: software,
            contactId: supplier,
          }),
        );
        const owedMovementId = bill.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        ).id;
        const payment = data(
          await call(client, "record_payment", {
            date: "2026-09-03",
            amount: 28,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: supplier,
            direction: "we-pay",
            settlements: [{ owedMovementId, amountMinor: 1250 }],
          }),
        );
        const paymentMovementId = payment.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        ).id;
        const preview = data(
          await call(client, "get_payment_allocations", { paymentMovementId }),
        );
        expect(preview.payment.settledMinor).toBe(1250);
        const corrected = data(
          await call(client, "correct_payment_allocations", {
            paymentMovementId,
            removeSettlementIds: [preview.allocations[0].id],
            reason: "Company had paid the supplier directly.",
            expectedVersion: preview.version,
          }),
        );
        expect(corrected.undoneIds).toEqual([preview.allocations[0].id]);
        const history = data(
          await call(client, "get_record", {
            recordId: payment.record.id,
            includeSettlements: true,
          }),
        );
        expect(history.settlements).toEqual([]);
        expect(history.reversedSettlements).toEqual([
          expect.objectContaining({
            settlementId: preview.allocations[0].id,
            reversedAt: expect.any(String),
            reversalReason: "Company had paid the supplier directly.",
            canUndo: false,
          }),
        ]);
        const balance = data(
          await call(client, "get_contact_balance", { contactId: supplier }),
        );
        expect(balance).toMatchObject({
          payableObligationsMinor: 1250,
          payableCreditsMinor: 2800,
          weOweMinor: -1550,
          netMinor: 1550,
        });
        const stale = errorOf(
          await call(client, "correct_payment_allocations", {
            paymentMovementId,
            removeSettlementIds: [preview.allocations[0].id],
            reason: "Company had paid the supplier directly.",
            expectedVersion: preview.version,
          }),
        );
        expect(stale.code).toBe("CONFLICT");
        data(
          await call(client, "settle_payment", {
            paymentMovementId,
            allocations: [{ owedMovementId, amountMinor: 1250 }],
          }),
        );
        const again = data(
          await call(client, "get_payment_allocations", { paymentMovementId }),
        );
        const undone = data(
          await call(client, "undo_settlement", {
            settlementId: again.allocations[0].id,
            reason: "Remove the allocation after checking the receipt.",
            expectedVersion: again.version,
          }),
        );
        expect(undone.undoneIds).toEqual([again.allocations[0].id]);
      });

      it("applies prior payment credit through MCP without a zero cash record", async () => {
        const client = await connect();
        const bill = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: payable,
            toAccountId: software,
            contactId: supplier,
          }),
        );
        const owedMovementId = bill.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        ).id;
        const credit = data(
          await call(client, "record_payment", {
            date: "2026-09-03",
            amount: 28,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: supplier,
            direction: "we-pay",
          }),
        );
        const paymentMovementId = credit.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        ).id;
        const before = db.select().from(ledgerRecords).all().length;
        const covered = data(
          await call(client, "record_payment", {
            date: "2026-09-04",
            amount: 0,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: supplier,
            direction: "we-pay",
            creditApplications: [
              { paymentMovementId, owedMovementId, amountMinor: 1250 },
            ],
          }),
        );
        expect(covered.record.id).toBe(bill.record.id);
        expect(covered.record.paid).toBe(true);
        expect(db.select().from(ledgerRecords).all()).toHaveLength(before);
      });

      it("saves neither the payment nor its settlement when one is refused", async () => {
        const client = await connect();
        const bill = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: payable,
            toAccountId: software,
            contactId: supplier,
          }),
        );
        const owed = bill.record.movements.find(
          (m: { accountId: number }) => m.accountId === payable,
        );
        const refused = errorOf(
          await call(client, "record_payment", {
            date: "2026-09-03",
            amount: 12.5,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: supplier,
            direction: "we-pay",
            settlements: [{ owedMovementId: owed.id, amountMinor: 999_999 }],
          }),
        );
        expect(refused.code).toBe("REFUSED");
        expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
        expect(db.select().from(settlements).all()).toHaveLength(0);
      });

      it("deletes with the delete scope and refuses without the RBAC ability", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const keeper = await connect({ token: keeperToken, scopes: ALL_WRITE });
        expect(await tools(keeper)).not.toContain("delete_record");
        const removed = data(
          await call(client, "delete_record", {
            recordId: created.record.id,
            expectedVersion: created.version,
          }),
        );
        expect(removed.id).toBe(created.record.id);
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("checks the user's ability again when the tool runs", async () => {
        const locals = localsFor({ token: writerToken, scopes: ALL_WRITE });
        const server = createServer({ db, store, storageRoot, locals });
        const client = new Client({ name: "direct-test", version: "1" });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        clients.push(client);
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        (locals.permissions as Set<string>).delete("records.create");
        const refused = errorOf(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        expect(refused.code).toBe("FORBIDDEN");
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
        await server.close();
      });
    });

    describe("accounts and contacts", () => {
      it("creates, archives and refuses a stale account change", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_account", {
            type: 5,
            name: "Courier fees",
          }),
        );
        expect(created.account.name).toBe("Courier fees");
        const archived = data(
          await call(client, "update_account", {
            accountId: created.account.id,
            expectedVersion: created.version,
            active: false,
          }),
        );
        expect(archived.account.archivedAt).not.toBeNull();
        const stale = errorOf(
          await call(client, "update_account", {
            accountId: created.account.id,
            expectedVersion: created.version,
            name: "Courier",
          }),
        );
        expect(stale.code).toBe("CONFLICT");
      });

      it("sets an opening balance as a record, checked against its version", async () => {
        const client = await connect();
        const listed = data(
          await call(client, "list_accounts", { search: "Bank" }),
        );
        const account = listed.accounts.find(
          (a: { id: number }) => a.id === bank,
        );
        expect(account.openingBalanceVersion).toBe("absent");
        const set = data(
          await call(client, "set_opening_balance", {
            accountId: bank,
            expectedVersion: "absent",
            date: "2026-01-01",
            amountMinor: 100_000,
          }),
        );
        expect(set.recordId).toBeGreaterThan(0);
        const again = errorOf(
          await call(client, "set_opening_balance", {
            accountId: bank,
            expectedVersion: "absent",
            date: "2026-01-01",
            amountMinor: 5,
          }),
        );
        expect(again.code).toBe("CONFLICT");

        // Zero deletes the record, so it needs the delete ability: a keeper
        // (add and change, never delete) is refused, the writer is not.
        const versionNow = async () =>
          data(
            await call(client, "list_accounts", { search: "Bank" }),
          ).accounts.find((a: { id: number }) => a.id === bank)
            .openingBalanceVersion;
        const keeper = await connect({ token: keeperToken });
        const forbidden = errorOf(
          await call(keeper, "set_opening_balance", {
            accountId: bank,
            expectedVersion: await versionNow(),
            date: "2026-01-01",
            amountMinor: 0,
          }),
        );
        expect(forbidden.code).toBe("FORBIDDEN");
        const cleared = data(
          await call(client, "set_opening_balance", {
            accountId: bank,
            expectedVersion: await versionNow(),
            date: "2026-01-01",
            amountMinor: 0,
          }),
        );
        expect(cleared.recordId).toBeNull();
      });

      it("creates contacts, and refuses deleting one in use", async () => {
        const client = await connect();
        const duplicate = data(
          await call(client, "create_contact", {
            entityType: 2,
            legalName: "Supplier Sdn Bhd",
            roles: [2],
          }),
        );
        data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
            contactId: duplicate.contact.id,
          }),
        );
        const listed = data(await call(client, "list_contacts", {}));
        const versionOf = (contactId: number) =>
          listed.contacts.find((c: { id: number }) => c.id === contactId)
            .version;
        const inUse = errorOf(
          await call(client, "delete_contact", {
            contactId: duplicate.contact.id,
            expectedVersion: versionOf(duplicate.contact.id),
          }),
        );
        expect(inUse.code).toBe("REFUSED");
      });
    });

    describe("invoices and quotations", () => {
      const lines = [
        { description: "Consulting", quantity: 2, unitPrice: 150 },
      ];

      it("issues an invoice into the books, takes a payment and refuses to void it once paid", async () => {
        const client = await connect();
        const draft = data(
          await call(client, "create_invoice", {
            newContactName: "New Customer",
            issueDate: "2026-09-01",
            currency: "MYR",
            lines,
          }),
        );
        expect(draft.invoice.status).toBe("draft");
        const issued = data(
          await call(client, "issue_invoice", {
            invoiceId: draft.invoice.id,
            expectedVersion: draft.invoice.version,
          }),
        );
        expect(issued.invoice.status).toBe("sent");
        expect(issued.invoice.owedMovementId).toBeGreaterThan(0);

        // Existing invoices retain their original receivable when the default changes.
        const savedDefault = db
          .select()
          .from(accountDefaults)
          .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
          .get()!;
        const original = db
          .select()
          .from(accounts)
          .where(eq(accounts.id, savedDefault.accountId))
          .get()!;
        const replacement = db
          .insert(accounts)
          .values({
            ...original,
            id: undefined,
            code: 1199,
            name: "Replacement receivable",
          })
          .returning({ id: accounts.id })
          .get()!;
        db.update(accountDefaults)
          .set({ accountId: replacement.id })
          .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
          .run();
        const reread = data(
          await call(client, "get_invoice", { invoiceId: draft.invoice.id }),
        );
        expect(reread.invoice.owedMovementId).toBe(
          issued.invoice.owedMovementId,
        );
        db.update(accountDefaults)
          .set({ accountId: original.id })
          .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
          .run();

        const sealed = errorOf(
          await call(client, "update_invoice", {
            invoiceId: draft.invoice.id,
            expectedVersion: issued.invoice.version,
            lines: [{ description: "More", quantity: 1, unitPrice: 1 }],
          }),
        );
        expect(sealed.code).toBe("REFUSED");

        data(
          await call(client, "record_payment", {
            date: "2026-09-10",
            amount: 300,
            currency: "MYR",
            paidFromAccountId: bank,
            contactId: issued.invoice.contactId,
            direction: "we-receive",
            settlements: [
              {
                owedMovementId: issued.invoice.owedMovementId,
                amountMinor: 30_000,
              },
            ],
          }),
        );
        const paid = data(
          await call(client, "get_invoice", { invoiceId: draft.invoice.id }),
        );
        expect(paid.invoice.outstandingMinor).toBe(0);
        const voidRefused = errorOf(
          await call(client, "void_invoice", {
            invoiceId: draft.invoice.id,
            expectedVersion: paid.invoice.version,
          }),
        );
        expect(voidRefused.code).toBe("REFUSED");
      });

      it("needs contacts:write to create a customer by name", async () => {
        const client = await connect({
          token: writerToken,
          scopes: ["invoices:read", "invoices:write"],
        });
        const before = db.select().from(contacts).all().length;
        const refused = errorOf(
          await call(client, "create_invoice", {
            newContactName: "Brand New Customer",
            issueDate: "2026-09-01",
            lines,
          }),
        );
        expect(refused.code).toBe("FORBIDDEN");
        expect(db.select().from(contacts).all()).toHaveLength(before);
      });

      it("refuses an income account that is not Revenue", async () => {
        const client = await connect();
        const draft = data(
          await call(client, "create_invoice", {
            contactId: supplier,
            issueDate: "2026-09-01",
            lines,
          }),
        );
        const refused = errorOf(
          await call(client, "issue_invoice", {
            invoiceId: draft.invoice.id,
            expectedVersion: draft.invoice.version,
            incomeAccountId: bank,
          }),
        );
        expect(refused.code).toBe("REFUSED");
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("hides issue_invoice from a user who cannot add records", async () => {
        db.delete(groupGrants)
          .where(eq(groupGrants.permission, "records.create"))
          .run();
        const names = await tools(await connect());
        expect(names).toContain("create_invoice");
        expect(names).not.toContain("issue_invoice");
      });

      it("advertises only reachable manual quotation statuses", async () => {
        const client = await connect();
        const tool = (await client.listTools()).tools.find(
          (tool) => tool.name === "set_quotation_status",
        )!;
        const status = tool.inputSchema.properties?.status as {
          enum: string[];
        };
        expect(status.enum).toEqual(["sent", "accepted", "declined"]);
        expect(tool.description).not.toContain("back to draft");
      });

      it("seals a sent quotation, revises it and converts the revision", async () => {
        const client = await connect();
        const draft = data(
          await call(client, "create_quotation", {
            contactId: supplier,
            issueDate: "2026-09-01",
            lines,
          }),
        );
        const sent = data(
          await call(client, "set_quotation_status", {
            quotationId: draft.quotation.id,
            expectedVersion: draft.quotation.version,
            status: "sent",
          }),
        );
        const sealed = errorOf(
          await call(client, "update_quotation", {
            quotationId: draft.quotation.id,
            expectedVersion: sent.quotation.version,
            lines,
          }),
        );
        expect(sealed.code).toBe("REFUSED");
        const revised = data(
          await call(client, "revise_quotation", {
            quotationId: draft.quotation.id,
            expectedVersion: sent.quotation.version,
          }),
        );
        expect(revised.previous.status).toBe("superseded");
        const accepted = data(
          await call(client, "set_quotation_status", {
            quotationId: revised.quotation.id,
            expectedVersion: revised.quotation.version,
            status: "accepted",
          }),
        );
        const converted = data(
          await call(client, "convert_quotation_to_invoice", {
            quotationId: revised.quotation.id,
            expectedVersion: accepted.quotation.version,
          }),
        );
        expect(converted.quotation.status).toBe("converted");
        expect(converted.invoice.status).toBe("draft");
      });
    });

    describe("reconciliation", () => {
      async function statementFile(
        key: string,
        bytes?: Buffer,
        state = StatementExtractionState.Extracting as number,
      ) {
        if (bytes) await store.put(key, bytes);
        return db
          .insert(bankStatements)
          .values({
            originalFilename: "original." + key.split(".").pop(),
            storedFilePath: key,
            extractionState: state,
            uploadedBy: 1,
            accountId: bank,
          })
          .returning({ id: bankStatements.id })
          .get()!.id;
      }

      beforeEach(() => reset("mcp-attachment:1"));

      it("reads original bytes with reconciliation-only access and no output schema", async () => {
        const token = issueTestToken(db, 1, ["reconciliation.read"]);
        const client = await connect({
          token,
          scopes: ["reconciliation:read"],
        });
        const listed = (await client.listTools()).tools;
        expect(
          listed.find((t) => t.name === "get_bank_statement_file")
            ?.outputSchema,
        ).toBeUndefined();
        expect(listed.map((t) => t.name)).toContain("get_bank_statement_file");
        expect(listed.map((t) => t.name)).not.toContain("get_bank_statement");
        const initialAudit = db.select().from(auditLog).all().length;
        const fixtures = [
          [
            "pdf",
            Buffer.from("%PDF-1.7 source"),
            "application/pdf",
            "resource",
          ],
          [
            "png",
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7]),
            "image/png",
            "image",
          ],
          ["jpg", Buffer.from([255, 216, 255, 7]), "image/jpeg", "image"],
          [
            "csv",
            Buffer.from("Date,Amount\n2026-09-01,12.50\n"),
            "text/csv",
            "resource",
          ],
          [
            "xlsx",
            Buffer.from([80, 75, 3, 4, 7]),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "resource",
          ],
        ] as const;
        for (const [ext, bytes, mime, type] of fixtures) {
          const statementId = await statementFile(
            `reconciliation/private/source.${ext}`,
            bytes,
          );
          const result = await call(client, "get_bank_statement_file", {
            statementId,
          });
          expect(result.isError).toBeFalsy();
          const metadata = JSON.parse(
            (result.content as { text: string }[])[0].text,
          );
          expect(metadata).toMatchObject({
            statementId,
            originalFilename: `original.${ext}`,
            mimeType: mime,
            sizeBytes: bytes.length,
          });
          expect(result.content).toMatchObject([
            { type: "text" },
            type === "image"
              ? { type, mimeType: mime, data: bytes.toString("base64") }
              : {
                  type,
                  resource: {
                    uri: `akaun://bank-statements/${statementId}/file`,
                    mimeType: mime,
                    blob: bytes.toString("base64"),
                  },
                },
          ]);
          expect(JSON.stringify(result)).toContain("untrusted");
          expect(JSON.stringify(result)).not.toContain(
            "reconciliation/private",
          );
          expect(JSON.stringify(result)).not.toContain(storageRoot);
        }
        expect(db.select().from(auditLog).all()).toHaveLength(initialAudit);
        const failed = await statementFile(
          "reconciliation/failed.pdf",
          Buffer.from("%PDF-failed"),
          StatementExtractionState.Failed,
        );
        expect(
          (
            await call(client, "get_bank_statement_file", {
              statementId: failed,
            })
          ).isError,
        ).toBeFalsy();
      });

      it("handles absent, unsupported, and oversized files and accepts the exact size limit", async () => {
        const client = await connect();
        const missing = await statementFile("reconciliation/missing.pdf");
        const absent = await statementFile("");
        for (const statementId of [missing, absent, 999999])
          expect(
            JSON.stringify(
              await call(client, "get_bank_statement_file", { statementId }),
            ),
          ).toContain("NOT_FOUND");
        const unsupported = await statementFile(
          "reconciliation/file.txt",
          Buffer.from("hello"),
        );
        expect(
          JSON.stringify(
            await call(client, "get_bank_statement_file", {
              statementId: unsupported,
            }),
          ),
        ).toContain("UNSUPPORTED");
        const bytes = Buffer.alloc(MAX_FILE_BYTES, 32);
        bytes.write("%PDF-");
        const exact = await statementFile("reconciliation/exact.pdf", bytes);
        const result = await call(client, "get_bank_statement_file", {
          statementId: exact,
        });
        expect(result.isError).toBeFalsy();
        expect(result.content).toMatchObject([
          { type: "text" },
          { type: "resource", resource: { blob: bytes.toString("base64") } },
        ]);
        const large = await statementFile(
          "reconciliation/large.pdf",
          Buffer.concat([bytes, Buffer.from("x")]),
        );
        expect(
          JSON.stringify(
            await call(client, "get_bank_statement_file", {
              statementId: large,
            }),
          ),
        ).toContain("OUTPUT_TOO_LARGE");
      });

      it("shares the attachment read throttle and hides the tool without reconciliation access", async () => {
        const statementId = await statementFile(
          "reconciliation/limit.pdf",
          Buffer.from("%PDF-limit"),
        );
        for (let i = 0; i < FILE_READ_LIMIT.max; i++)
          hit(
            "mcp-attachment:1",
            FILE_READ_LIMIT.max,
            FILE_READ_LIMIT.windowMs,
          );
        const client = await connect();
        expect(
          JSON.stringify(
            await call(client, "get_bank_statement_file", { statementId }),
          ),
        ).toContain("RATE_LIMITED");
        const denied = await connect({
          token: issueTestToken(db, 1, ["records.read"]),
        });
        expect(await tools(denied)).not.toContain("get_bank_statement_file");
        await expect(
          call(denied, "get_bank_statement_file", { statementId }),
        ).rejects.toThrow("not found");
      });

      function statementWithLines() {
        const statementId = db
          .insert(bankStatements)
          .values({
            originalFilename: "sept.pdf",
            storedFilePath: "reconciliation/1/x_sept.pdf",
            extractionState: StatementExtractionState.Ready,
            uploadedBy: 1,
            accountId: bank,
          })
          .returning({ id: bankStatements.id })
          .get()!.id;
        const [spend, moved] = db
          .insert(bankStatementLines)
          .values([
            {
              statementId,
              date: "2026-09-02",
              description: "SOFTWARE CO",
              amount: 12.5,
              direction: StatementDirection.Out,
              note: "",
            },
            {
              statementId,
              date: "2026-09-05",
              description: "TO CASH",
              amount: 40,
              direction: StatementDirection.Out,
              note: "",
            },
          ])
          .returning({ id: bankStatementLines.id })
          .all();
        return { statementId, spendLine: spend.id, transferLine: moved.id };
      }

      it("matches a movement to its line and records a transfer from another", async () => {
        const client = await connect();
        const { statementId, spendLine, transferLine } = statementWithLines();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const statement = data(
          await call(client, "get_bank_statement", { statementId }),
        );
        const candidate = statement.candidates.find(
          (c: { recordId: number }) => c.recordId === created.record.id,
        );
        expect(candidate.suggestedLineIds).toEqual([spendLine]);
        let recordEvents = 0;
        const listener = () => recordEvents++;
        ledgerEvents.on("record-update", listener);
        try {
          data(
            await call(client, "set_movement_matches", {
              movementId: candidate.movementId,
              expectedVersion: candidate.matchesVersion,
              allocations: [{ lineId: spendLine, amount: 12.5 }],
            }),
          );
        } finally {
          ledgerEvents.off("record-update", listener);
        }
        expect(recordEvents).toBeGreaterThan(0);

        const transferLineVersion = statement.lines.find(
          (l: { id: number }) => l.id === transferLine,
        ).version;
        const transfer = data(
          await call(client, "record_transfer_from_line", {
            lineId: transferLine,
            expectedVersion: transferLineVersion,
            otherAccountId: cash,
          }),
        );
        expect(transfer.record.id).toBeGreaterThan(0);
      });

      it("reports competing same-date suggestions and skips a requested subset", async () => {
        const client = await connect();
        const { statementId, spendLine } = statementWithLines();
        const records: number[] = [];
        for (let i = 0; i < 2; i++) {
          records.push(
            data(
              await call(client, "create_record", {
                ...expenseArgs,
                fromAccountId: bank,
                toAccountId: software,
              }),
            ).record.id,
          );
        }
        const statement = data(
          await call(client, "get_bank_statement", { statementId }),
        );
        const candidates = statement.candidates.filter(
          (c: { recordId: number }) => records.includes(c.recordId),
        );
        expect(candidates).toHaveLength(2);
        for (const candidate of candidates) {
          expect(candidate.suggestionConflict).toBe(true);
          expect(candidate.suggestedLineIds).toEqual([]);
        }
        const result = data(
          await call(client, "auto_match", {
            movementIds: [candidates[0].movementId],
            statementId,
          }),
        );
        expect(result).toMatchObject({ matched: 0, skipped: 1 });
        // Explicit manual choice still works and removes the conflict.
        data(
          await call(client, "set_movement_matches", {
            movementId: candidates[0].movementId,
            expectedVersion: candidates[0].matchesVersion,
            allocations: [{ lineId: spendLine, amount: 12.5 }],
          }),
        );
        const refreshed = data(
          await call(client, "get_bank_statement", { statementId }),
        );
        expect(
          refreshed.candidates.every(
            (c: { suggestionConflict: boolean }) => !c.suggestionConflict,
          ),
        ).toBe(true);
      });

      it("keeps same-date suggestions and automatic saves scoped to one statement", async () => {
        const client = await connect();
        const first = statementWithLines();
        const second = statementWithLines();
        const differentDate = data(
          await call(client, "create_record", {
            ...expenseArgs,
            date: "2026-09-03",
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const statement = data(
          await call(client, "get_bank_statement", {
            statementId: second.statementId,
          }),
        );
        const candidate = statement.candidates.find(
          (c: { recordId: number }) => c.recordId === created.record.id,
        );
        expect(candidate.suggestedLineIds).toEqual([second.spendLine]);
        expect(
          statement.candidates.find(
            (c: { recordId: number }) => c.recordId === differentDate.record.id,
          ).suggestedLineIds,
        ).toEqual([]);
        const matched = data(
          await call(client, "auto_match", {
            movementIds: [candidate.movementId],
            statementId: second.statementId,
          }),
        );
        expect(matched.matched).toBe(1);
        const untouched = data(
          await call(client, "get_bank_statement", {
            statementId: first.statementId,
          }),
        );
        expect(
          untouched.lines.find((l: { id: number }) => l.id === first.spendLine)
            .remainingAmount,
        ).toBe(12.5);
      });

      it("refuses a transfer from a line into equity or a category without Adjustments", async () => {
        const client = await connect();
        const { statementId, transferLine } = statementWithLines();
        const version = () =>
          call(client, "get_bank_statement", { statementId }).then(
            (result) =>
              data(result).lines.find(
                (l: { id: number }) => l.id === transferLine,
              ).version,
          );
        for (const other of [account(3000), account(4000), software]) {
          const refused = errorOf(
            await call(client, "record_transfer_from_line", {
              lineId: transferLine,
              expectedVersion: await version(),
              otherAccountId: other,
            }),
          );
          expect(refused.code).toBe("FORBIDDEN");
          expect(refused.message).toContain("Adjustments");
        }
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
      });

      it("refuses a transfer from a line to a user who cannot add records", async () => {
        const { transferLine } = statementWithLines();
        db.delete(groupGrants)
          .where(eq(groupGrants.permission, "records.create"))
          .run();
        const names = await tools(await connect());
        expect(names).toContain("set_movement_matches");
        expect(names).not.toContain("record_transfer_from_line");
        expect(transferLine).toBeGreaterThan(0);
      });
    });

    describe("import", () => {
      const jobId = "00000000-0000-4000-8000-0000000000aa";
      function pendingReceipt(createdBy = 2) {
        const tempFilePath =
          "import/temp/00000000-0000-4000-8000-0000000000bb_receipt.pdf";
        mkdirSync(join(storageRoot, "import/temp"), { recursive: true });
        writeFileSync(join(storageRoot, tempFilePath), "%PDF-1.4 test");
        db.insert(importQueue)
          .values({
            id: jobId,
            createdBy,
            tempFilePath,
            originalFilename: "receipt.pdf",
            state: ImportState.PendingReview,
            documentType: 1,
            itemName: "Software",
            supplier: "Supplier",
            date: "2026-09-02",
            amount: 12.5,
            currency: "MYR",
            exchangeRate: 1,
            accountId: bank,
            categoryAccountId: software,
            processedAt: "2026-09-02 10:00:00",
          })
          .run();
        return tempFilePath;
      }

      it("confirms a receipt into a record owned by the uploader and audited under the confirmer", async () => {
        const client = await connect();
        pendingReceipt();
        const job = data(await call(client, "get_import_job", { jobId }));
        const confirmed = data(
          await call(client, "confirm_import", {
            jobId,
            expectedVersion: job.job.version,
          }),
        );
        const record = db
          .select()
          .from(ledgerRecords)
          .where(eq(ledgerRecords.id, confirmed.recordId))
          .get()!;
        expect(record.createdBy).toBe(2);
        const audit = db
          .select()
          .from(auditLog)
          .where(eq(auditLog.recordId, String(confirmed.recordId)))
          .all()
          .find(
            (row) => row.recordType === "record" && row.action === "create",
          );
        expect(audit?.userId).toBe(1);
        const again = errorOf(
          await call(client, "confirm_import", {
            jobId,
            expectedVersion: job.job.version,
          }),
        );
        expect(again.code).toBe("CONFLICT");
      });

      it("skips a receipt and releases its file", async () => {
        const client = await connect();
        const tempFilePath = pendingReceipt();
        const job = data(await call(client, "get_import_job", { jobId }));
        data(
          await call(client, "skip_import", {
            jobId,
            expectedVersion: job.job.version,
          }),
        );
        expect(existsSync(join(storageRoot, tempFilePath))).toBe(false);
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
        // The file is gone for good, so a client must be told to ask first.
        const { tools: listed } = await client.listTools();
        const skip = listed.find((tool) => tool.name === "skip_import")!;
        expect(skip.annotations?.destructiveHint).toBe(true);
      });
    });

    describe("attachments", () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ]);

      it("attaches a file into the temp store", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const attached = data(
          await call(client, "attach_file", {
            recordId: created.record.id,
            filename: "receipt.png",
            contentBase64: png.toString("base64"),
          }),
        );
        expect(attached.attachment.displayName).toBe("receipt.png");
        const stored = db.select().from(recordAttachments).get()!;
        expect(existsSync(join(storageRoot, stored.filename))).toBe(true);
      });

      it("refuses a file whose bytes are not PDF, JPEG or PNG, and stores nothing", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const refused = errorOf(
          await call(client, "attach_file", {
            recordId: created.record.id,
            filename: "receipt.pdf",
            contentBase64: Buffer.from("MZ not a pdf").toString("base64"),
          }),
        );
        expect(refused.code).toBe("UNSUPPORTED_MEDIA_TYPE");
        expect(readdirSync(storageRoot)).toHaveLength(0);
      });

      it("accepts a file larger than the ordinary request limit", async () => {
        const client = await connect();
        const created = data(
          await call(client, "create_record", {
            ...expenseArgs,
            fromAccountId: bank,
            toAccountId: software,
          }),
        );
        const pdf = Buffer.concat([
          Buffer.from("%PDF-1.4\n"),
          Buffer.alloc(300 * 1024, 0x20),
        ]);
        const attached = data(
          await call(client, "attach_file", {
            recordId: created.record.id,
            filename: "big.pdf",
            contentBase64: pdf.toString("base64"),
          }),
        );
        expect(attached.attachment.id).toBeGreaterThan(0);
      });
    });

    describe("request size", () => {
      it("refuses a large body for any tool but attach_file", async () => {
        const client = await connect();
        await expect(
          client.callTool({
            name: "create_record",
            arguments: {
              ...expenseArgs,
              fromAccountId: bank,
              toAccountId: software,
              remark: "x".repeat(200 * 1024),
            },
          }),
        ).rejects.toThrow();
        expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
        expect(readdirSync(storageRoot)).toHaveLength(0);
      });
    });
  });
}

describe("MCP writes (requirements table)", () => {
  it("gives every tool scopes that stand for its permissions", () => {
    for (const [name, requirement] of Object.entries(TOOL_REQUIREMENTS)) {
      if (requirement.writes)
        expect(requirement.scopes.length, name).toBeGreaterThan(0);
      for (const option of toolAccessOptions(requirement)) {
        if (requirement.writes)
          expect(option.scopes.length, name).toBeGreaterThan(0);
        const covered = new Set(expandScopes(option.scopes));
        for (const permission of option.permissions)
          expect(covered.has(permission), `${name}: ${permission}`).toBe(true);
      }
    }
  });
  it("never offers a write on reports", () => {
    for (const requirement of Object.values(TOOL_REQUIREMENTS))
      expect(
        requirement.permissions.some(
          (p) => p.startsWith("reports.") && p !== "reports.read",
        ),
      ).toBe(false);
  });
});
