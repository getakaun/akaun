import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
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
  auditLog,
  bankStatementLines,
  bankStatements,
  contacts,
  groupPermissions,
  groups,
  importQueue,
  ledgerRecords,
  recordAttachments,
  settlements,
  userGroups,
  users,
} from "../db/schema.js";
import { seedAccounts } from "../db/seed-accounts.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import {
  EntityType,
  ImportState,
  Role,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import type { LedgerDb } from "../ledger/types.js";
import { bearerLocals } from "../bearer-auth.js";
import { ledgerEvents } from "../ledger/events.js";
import type { OAuthScope } from "../oauth/config.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { handleMcpRequest } from "./http.js";
import { createServer } from "./server.js";
import { TOOL_REQUIREMENTS } from "./tool-requirements.js";
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
const writerToken = "test-writer-token";
const keeperToken = "test-keeper-token";
const readerToken = "test-reader-token";
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

const EVERY = ["view", "add", "change", "delete"] as const;
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
        bearerToken: writerToken,
      },
      // Bookkeeper: add and change, never delete.
      {
        id: 2,
        email: "k@test",
        username: "keeper",
        passwordHash: "x",
        bearerToken: keeperToken,
      },
      // Views only.
      {
        id: 3,
        email: "r@test",
        username: "reader",
        passwordHash: "x",
        bearerToken: readerToken,
      },
    ])
    .run();
  db.insert(groups)
    .values([
      { id: 1, name: "writers" },
      { id: 2, name: "keepers" },
      { id: 3, name: "readers" },
    ])
    .run();
  db.insert(userGroups)
    .values([
      { userId: 1, groupId: 1 },
      { userId: 2, groupId: 2 },
      { userId: 3, groupId: 3 },
    ])
    .run();
  db.insert(groupPermissions)
    .values([
      ...RESOURCES.map((resource) => ({
        groupId: 1,
        resource,
        canView: true,
        canAdd: resource !== "reports",
        canChange: resource !== "reports",
        canDelete: resource !== "reports",
      })),
      ...RESOURCES.map((resource) => ({
        groupId: 2,
        resource,
        canView: true,
        canAdd: resource !== "reports",
        canChange: resource !== "reports",
        canDelete: false,
      })),
      ...RESOURCES.map((resource) => ({ groupId: 3, resource, canView: true })),
    ])
    .run();
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

type Auth =
  | { token: string; scopes?: undefined; bearerWrites?: boolean }
  | { token: string; scopes: OAuthScope[]; bearerWrites?: undefined };

function localsFor(auth: Auth) {
  const locals = bearerLocals(db, `Bearer ${auth.token}`);
  if (!locals) return { user: null, permissions: null, isSuperuser: false };
  return auth.scopes
    ? {
        ...locals,
        oauth: {
          clientId: "client",
          grantId: "grant",
          resource: `${origin}/mcp`,
          scopes: auth.scopes,
        },
      }
    : locals;
}

const ALL_WRITE: OAuthScope[] = [
  "records:read",
  "records:write",
  "records:delete",
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
  "reconciliation:delete",
  "import:read",
  "import:write",
  "import:delete",
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
              bearerWrites: auth.bearerWrites,
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
      it("hides every write tool from an API token unless the operator opts in", async () => {
        const plain = await tools(await connect({ token: writerToken }));
        expect(plain).toContain("get_record");
        expect(plain).not.toContain("create_record");
        const opted = await tools(
          await connect({ token: writerToken, bearerWrites: true }),
        );
        expect(opted).toContain("create_record");
        expect(opted).toContain("delete_record");
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
          locals: {
            ...localsFor({
              token: writerToken,
              scopes: [...ALL_WRITE, "reports:read"],
            }),
            isSuperuser: true,
          },
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
          .where(eq(auditLog.recordId, created.record.id))
          .all();
        expect(
          audit.some((row) => row.userId === 1 && row.action === "create"),
        ).toBe(true);
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
        locals.permissions!.records.add = false;
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
      });

      it("creates and merges contacts, and refuses deleting one in use", async () => {
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
        const merged = data(
          await call(client, "merge_contacts", {
            survivorId: supplier,
            loserIds: [duplicate.contact.id],
            expectedVersions: {
              [supplier]: versionOf(supplier),
              [duplicate.contact.id]: versionOf(duplicate.contact.id),
            },
          }),
        );
        expect(merged.contact.id).toBe(supplier);
        expect(
          db
            .select()
            .from(contacts)
            .where(eq(contacts.id, duplicate.contact.id))
            .get(),
        ).toBeUndefined();
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
        db.update(groupPermissions)
          .set({ canAdd: false })
          .where(eq(groupPermissions.resource, "records"))
          .run();
        const names = await tools(await connect());
        expect(names).toContain("create_invoice");
        expect(names).not.toContain("issue_invoice");
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

      it("matches a movement to its line, locks the line's amount, and records a transfer from another", async () => {
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

        const line = statement.lines.find(
          (l: { id: number }) => l.id === spendLine,
        );
        const locked = errorOf(
          await call(client, "update_statement_line", {
            lineId: spendLine,
            expectedVersion: data(
              await call(client, "get_bank_statement", { statementId }),
            ).lines.find((l: { id: number }) => l.id === spendLine).version,
            amount: 99,
          }),
        );
        expect(locked.code).toBe("REFUSED");
        expect(line.version).toBeTruthy();

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

      it("refuses a transfer from a line to a user who cannot add records", async () => {
        const { transferLine } = statementWithLines();
        db.update(groupPermissions)
          .set({ canAdd: false })
          .where(eq(groupPermissions.resource, "records"))
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
          .where(eq(auditLog.recordId, confirmed.recordId))
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
      });
    });

    describe("attachments", () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ]);

      it("attaches a file into the temp store and deletes it again", async () => {
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
        data(
          await call(client, "delete_attachment", {
            recordId: created.record.id,
            attachmentId: attached.attachment.id,
          }),
        );
        expect(existsSync(join(storageRoot, stored.filename))).toBe(false);
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
  it("gives every write tool a scope for each resource it changes", () => {
    for (const [name, requirement] of Object.entries(TOOL_REQUIREMENTS)) {
      if (!requirement.writes) continue;
      expect(requirement.scopes.length, name).toBeGreaterThan(0);
      for (const [resource, action] of requirement.rbac) {
        if (action === "view") continue;
        const tier = action === "delete" ? "delete" : "write";
        expect(
          requirement.scopes.some(
            (scope) =>
              scope === `${resource}:${tier}` || scope === `${resource}:delete`,
          ),
          `${name} needs a ${resource} scope`,
        ).toBe(true);
      }
    }
  });
  it("never offers a write on reports", () => {
    for (const requirement of Object.values(TOOL_REQUIREMENTS))
      expect(
        requirement.rbac.some(([r, a]) => r === "reports" && a !== "view"),
      ).toBe(false);
    expect(EVERY).toHaveLength(4);
  });
});
