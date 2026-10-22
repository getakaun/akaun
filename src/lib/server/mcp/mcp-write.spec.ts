import { getRecord } from "../queries/ledger.js";
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
  type LeafPermission,
} from "$lib/permissions/catalog.js";
import { expandScopes } from "$lib/permissions/oauth-scopes.js";
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
  (leaf) =>
    inScope(leaf) &&
    leaf !== "records.adjust" &&
    leaf !== "records.correctDate",
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
      const covered = new Set(expandScopes(requirement.scopes));
      for (const permission of requirement.permissions)
        expect(covered.has(permission), `${name}: ${permission}`).toBe(true);
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
