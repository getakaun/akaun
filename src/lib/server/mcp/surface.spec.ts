import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type Tool } from "@modelcontextprotocol/server";
import * as schema from "../db/schema.js";
import {
  auditLog,
  groupDelegations,
  ledgerRecords,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { patLocals } from "../tokens/pat.js";
import { resolveAccess } from "../permissions.js";
import {
  grantGroup,
  issueTestToken,
  localsFor,
} from "../permissions/test-locals.js";
import { expandScopes } from "$lib/permissions/oauth-scopes.js";
import type { OAuthScope } from "../oauth/config.js";
import {
  BOOKKEEPER_PERMISSIONS,
  buildEvalBook,
  type EvalBook,
  type EvalVariant,
} from "./__fixtures__/eval-book.js";
import {
  createServerV2,
  listingSnapshot,
  MAX_DESCRIPTION_CHARS,
  MAX_TOOL_NAME_CHARS,
  type NamingScheme,
  type ToolContext,
} from "./registry.js";
import { READ_TOOLS } from "./tools/reads/index.js";
import { WRITE_TOOLS } from "./tools/writes/index.js";
import { handleMcpRequest } from "./http.js";

/**
 * What a client sees of the v2 surface: the annotation matrix, the listing
 * order, the naming rule, the descriptions, the tool names the surface itself
 * hands an agent, and who is offered and allowed what (listing any-of, the
 * FORBIDDEN at call time, and the OAuth step-up over HTTP).
 *
 * The annotation matrix and the listing below are written out by hand from
 * the plan's catalogue (Design rule 8, "Tool catalogue"). They are not derived
 * from the definitions or the requirement tables, so a change to either shows
 * up here as a failure to review, not as a silent update.
 *
 * Nothing here imports `db/client.ts`. Listing runs against a database that
 * throws when touched; the permission specs use SQLite `:memory:`; the noun
 * and returned-name specs build the evaluation books under `os.tmpdir()`.
 */

const SLOW = 120_000;
const ORIGIN = "https://akaun.test";
const TODAY = "2026-11-13";

const notADatabase = new Proxy({} as LedgerDb, {
  get() {
    throw new Error("Listing must not touch the database.");
  },
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An in-process client for `locals`, over the production tool set. */
async function connect(
  locals: App.Locals,
  options: {
    db?: LedgerDb;
    store?: LocalBlobStore;
    storageRoot?: string;
    naming?: NamingScheme;
  } = {},
) {
  const storageRoot = options.storageRoot ?? tempDir("akaun-surface-");
  const ctx: ToolContext = {
    db: options.db ?? notADatabase,
    store: options.store ?? new LocalBlobStore(storageRoot),
    storageRoot,
    locals,
    requestOrigin: ORIGIN,
  };
  const server = createServerV2({
    ...ctx,
    tools: { reads: READ_TOOLS, writes: WRITE_TOOLS },
    naming: options.naming,
  });
  const client = new Client({ name: "surface-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const block = (result.content as { type: string; text?: string }[])[0];
    return {
      isError: result.isError === true,
      text: block?.text ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output, read loosely in assertions
      body: JSON.parse(block?.text ?? "null") as any,
    };
  };
  return { client, call };
}

/** An evaluation book under `os.tmpdir()`, closed and removed after the test. */
async function openBook(variant: EvalVariant = "A"): Promise<EvalBook> {
  const dir = tempDir(`akaun-surface-book-${variant}-`);
  const book = await buildEvalBook({ dir, variant, today: TODAY });
  cleanups.unshift(() => book.raw.close());
  return book;
}

const everyone = () => localsFor([], { superuser: true });

async function listed(locals: App.Locals, naming?: NamingScheme) {
  const { client } = await connect(locals, { naming });
  return (await client.listTools()).tools;
}

// --- the catalogue, by hand ---------------------------------------------------

type Flags = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};
const READ: Flags = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Purely additive: changes nothing that exists. */
const ADD: Flags = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Changes or removes existing data. */
const CHANGE: Flags = { ...ADD, destructiveHint: true };
/** May look up an exchange rate outside Akaun. */
const openWorld = (flags: Flags): Flags => ({ ...flags, openWorldHint: true });

/**
 * Every tool, in the order `tools/list` gives them (reads, then writes), with
 * the annotations the plan sets. No write declares `idempotentHint`: the plan
 * sets it only where a replay has been tested, and none has.
 */
const CATALOGUE: readonly [string, Flags][] = [
  // Reads (15)
  ["akaun_get_books_overview", READ],
  ["akaun_search_records", READ],
  ["akaun_get_record", READ],
  ["akaun_get_category_history", READ],
  ["akaun_list_accounts", READ],
  ["akaun_find_contacts", READ],
  ["akaun_get_contact", READ],
  ["akaun_get_report", READ],
  ["akaun_get_bank_reconciliation", READ],
  ["akaun_get_sales_documents", READ],
  ["akaun_get_import_queue", READ],
  ["akaun_get_change_history", READ],
  ["akaun_get_attachment", READ],
  ["akaun_get_bank_statement_file", READ],
  ["akaun_review_books", READ],
  // Writes (13)
  ["akaun_attach_file", ADD],
  ["akaun_create_records", openWorld(ADD)],
  ["akaun_change_records", openWorld(CHANGE)],
  ["akaun_record_payments", ADD],
  ["akaun_change_allocations", CHANGE],
  ["akaun_match_bank_lines", ADD],
  ["akaun_unmatch_bank_lines", CHANGE],
  ["akaun_change_contacts", CHANGE],
  ["akaun_change_accounts", CHANGE],
  ["akaun_manage_fixed_assets", CHANGE],
  ["akaun_create_sales_documents", ADD],
  ["akaun_change_sales_documents", CHANGE],
  ["akaun_review_imports", openWorld(CHANGE)],
];
const NAMES = CATALOGUE.map(([name]) => name);

/** The three tools whose v1 contract is kept, and the only ones with an output schema. */
const KEPT_CONTRACTS = [
  "akaun_get_attachment",
  "akaun_get_bank_statement_file",
  "akaun_attach_file",
];

describe("the catalogue", () => {
  it("has 15 reads and 13 writes, with the additive writes the plan names", () => {
    expect(NAMES).toHaveLength(28);
    expect(new Set(NAMES).size).toBe(28);
    expect(CATALOGUE.filter(([, f]) => f.readOnlyHint)).toHaveLength(15);
    expect(
      CATALOGUE.filter(([, f]) => !f.readOnlyHint && !f.destructiveHint).map(
        ([name]) => name,
      ),
    ).toEqual([
      "akaun_attach_file",
      "akaun_create_records",
      "akaun_record_payments",
      "akaun_match_bank_lines",
      "akaun_create_sales_documents",
    ]);
    // Every change_*, unmatch_*, manage_* tool and review_imports is destructive.
    for (const [name, flags] of CATALOGUE)
      if (/^akaun_(change|unmatch|manage)_|^akaun_review_imports$/.test(name))
        expect(flags.destructiveHint, name).toBe(true);
  });
});

describe("the listing", () => {
  it("annotates every tool as the catalogue says", async () => {
    const tools = await listed(everyone());
    expect(tools.map((t) => t.name)).toEqual(NAMES);
    for (const [name, flags] of CATALOGUE) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations, name).toEqual(flags);
    }
  });

  it("lists the 28 tools in a fixed order: the snapshot", async () => {
    const tools = await listed(everyone());
    // Name, title and flags per line; the snapshot of `listingSnapshot`
    // without the description lengths and fields, which the tool tasks own.
    const lines = listingSnapshot(tools)
      .split("\n")
      .map((line) => {
        const [name, , flags] = line.split(" | ");
        return `${name} | ${flags}`;
      });
    expect(lines).toEqual([
      "akaun_get_books_overview | read,idempotent",
      "akaun_search_records | read,idempotent",
      "akaun_get_record | read,idempotent",
      "akaun_get_category_history | read,idempotent",
      "akaun_list_accounts | read,idempotent",
      "akaun_find_contacts | read,idempotent",
      "akaun_get_contact | read,idempotent",
      "akaun_get_report | read,idempotent",
      "akaun_get_bank_reconciliation | read,idempotent",
      "akaun_get_sales_documents | read,idempotent",
      "akaun_get_import_queue | read,idempotent",
      "akaun_get_change_history | read,idempotent",
      "akaun_get_attachment | read,idempotent",
      "akaun_get_bank_statement_file | read,idempotent",
      "akaun_review_books | read,idempotent",
      "akaun_attach_file | write",
      "akaun_create_records | write,open-world",
      "akaun_change_records | write,destructive,open-world",
      "akaun_record_payments | write",
      "akaun_change_allocations | write,destructive",
      "akaun_match_bank_lines | write",
      "akaun_unmatch_bank_lines | write,destructive",
      "akaun_change_contacts | write,destructive",
      "akaun_change_accounts | write,destructive",
      "akaun_manage_fixed_assets | write,destructive",
      "akaun_create_sales_documents | write",
      "akaun_change_sales_documents | write,destructive",
      "akaun_review_imports | write,destructive,open-world",
    ]);
    for (const tool of tools) expect(tool.title, tool.name).toBeTruthy();
    // The same listing twice: the order does not depend on the caller's history.
    expect((await listed(everyone())).map((t) => t.name)).toEqual(NAMES);
  });

  it("follows the naming rule in every scheme, with unique names", async () => {
    for (const naming of [
      "akaun_verb_noun",
      "akaun_noun_verb",
      "plain",
    ] as NamingScheme[]) {
      const names = (await listed(everyone(), naming)).map((t) => t.name);
      expect(names, naming).toHaveLength(28);
      expect(new Set(names).size, naming).toBe(28);
      for (const name of names) {
        expect(name.length, name).toBeLessThanOrEqual(MAX_TOOL_NAME_CHARS);
        expect(name, name).toMatch(
          naming === "plain" ? /^[a-z0-9_]+$/ : /^akaun_[a-z0-9_]+$/,
        );
      }
    }
    expect(MAX_TOOL_NAME_CHARS).toBe(64);
  });

  it("sends structured output only from the three kept contracts", async () => {
    for (const tool of await listed(everyone()))
      expect(tool.outputSchema !== undefined, tool.name).toBe(
        KEPT_CONTRACTS.includes(tool.name),
      );
  });

  it("keeps every description within 1,500 characters", async () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(1500);
    for (const tool of await listed(everyone())) {
      expect(tool.description?.trim().length, tool.name).toBeGreaterThan(0);
      expect(tool.description!.length, tool.name).toBeLessThanOrEqual(1500);
    }
  });

  it("names only registered tools in its descriptions", async () => {
    const tools = await listed(everyone());
    const registered = new Set(tools.map((t) => t.name));
    const bases = new Set(tools.map((t) => t.name.replace(/^akaun_/, "")));
    // A bare word shaped like a tool name may also be a field or action of
    // some tool (`review_only`, `create_from_lines`).
    const fields = new Set(
      tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})),
    );
    const toolShaped =
      /\b(akaun_)?(get|search|list|find|create|change|record|match|unmatch|manage|attach|review)_[a-z0-9_]+\b/g;
    for (const tool of tools)
      for (const [word, prefix] of tool.description!.matchAll(toolShaped)) {
        if (prefix)
          expect(registered.has(word), `${tool.name}: ${word}`).toBe(true);
        else
          expect(
            bases.has(word) || fields.has(word),
            `${tool.name}: ${word}`,
          ).toBe(true);
      }
  });
});

describe("what the surface says names nothing from a book, and only its own tools", () => {
  it(
    "holds none of either test book's nouns in a title, description or input schema",
    async () => {
      const nouns: string[] = [];
      for (const variant of ["A", "B"] as EvalVariant[])
        nouns.push(...(await openBook(variant)).manifest.nouns);
      expect(nouns.length).toBeGreaterThan(40);
      for (const tool of await listed(everyone())) {
        const texts = [
          tool.title ?? "",
          tool.description ?? "",
          JSON.stringify(tool.inputSchema),
        ].map((text) => text.toLowerCase());
        for (const noun of nouns)
          for (const text of texts)
            expect(text, `${tool.name}: ${noun}`).not.toContain(
              noun.toLowerCase(),
            );
      }
    },
    SLOW,
  );

  it(
    "names only registered tools in every next, drill, fix and message it returns",
    async () => {
      const book = await openBook("A");
      const { call } = await connect(
        patLocals(book.db, `Bearer ${book.agentToken}`)!,
        { db: book.db, store: book.store, storageRoot: book.storageRoot },
      );
      const registered = new Set(NAMES);
      const audit = book.db.select().from(auditLog).all().length;
      const records = book.db.select().from(ledgerRecords).all().length;
      const record = book.manifest.records.workspaceAug;
      const calls: [string, Record<string, unknown>][] = [
        ["akaun_get_books_overview", {}],
        ["akaun_review_books", {}],
        ["akaun_search_records", {}],
        ["akaun_search_records", { group_by: "category" }],
        ["akaun_get_record", { record }],
        ["akaun_get_record", { record: 999_999 }],
        ["akaun_list_accounts", {}],
        ["akaun_find_contacts", { duplicates: true }],
        ["akaun_get_bank_reconciliation", {}],
        ["akaun_get_sales_documents", {}],
        ["akaun_get_import_queue", {}],
        ["akaun_get_change_history", { item: { type: "record", id: record } }],
        ...[
          "profit_loss",
          "balance_sheet",
          "cash_flow",
          "trial_balance",
          "partner_statement",
          "expense_tax",
          "aged_receivables",
          "aged_payables",
          "fixed_assets",
        ].map(
          (report) =>
            ["akaun_get_report", { report }] as [
              string,
              Record<string, unknown>,
            ],
        ),
        // Refusals carry a fix too.
        [
          "akaun_change_records",
          {
            delete: [{ record: 999_999, expected_version: "x" }],
            dry_run: true,
          },
        ],
        ["akaun_create_records", { records: [{}], dry_run: true }],
      ];
      const named: string[] = [];
      const visit = (value: unknown, key?: string) => {
        if (typeof value === "string") {
          if (key === "tool" || key === "fix_with") named.push(value);
          named.push(...(value.match(/\bakaun_[a-z0-9_]+\b/g) ?? []));
        } else if (Array.isArray(value)) value.forEach((v) => visit(v));
        else if (value && typeof value === "object")
          for (const [k, v] of Object.entries(value)) visit(v, k);
      };
      for (const [name, args] of calls) {
        const { body } = await call(name, args);
        expect(body, name).toBeTruthy();
        visit(body);
      }
      expect(named.length).toBeGreaterThan(10);
      for (const name of named) expect(registered.has(name), name).toBe(true);
      // Nothing above saved anything.
      expect(book.db.select().from(auditLog).all()).toHaveLength(audit);
      expect(book.db.select().from(ledgerRecords).all()).toHaveLength(records);
    },
    SLOW,
  );
});

// --- who is offered and allowed what -----------------------------------------

/** SQLite `:memory:` with a bookkeeper (user 1) and a views-only user (user 2). */
function memoryBook() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values([
      { id: 1, email: "k@test", username: "keeper", passwordHash: "x" },
      { id: 2, email: "r@test", username: "reader", passwordHash: "x" },
    ])
    .run();
  grantGroup(db, {
    name: "bookkeepers",
    userIds: [1],
    grants: [...BOOKKEEPER_PERMISSIONS],
  });
  grantGroup(db, {
    name: "readers",
    userIds: [2],
    grants: BOOKKEEPER_PERMISSIONS.filter((p) => p.endsWith(".read")),
  });
  cleanups.push(() => sqlite.close());
  return db;
}

const tokenLocals = (db: LedgerDb, userId: number, permissions: string[]) =>
  patLocals(db, `Bearer ${issueTestToken(db, userId, permissions)}`)!;

/** An OAuth app acting for `userId`, as `oauth.authenticate` builds it. */
function appLocals(
  db: LedgerDb,
  userId: number,
  scopes: OAuthScope[],
): App.Locals {
  const user = patLocals(
    db,
    `Bearer ${issueTestToken(db, userId, ["records.read"])}`,
  )!.user;
  return {
    user,
    ...resolveAccess(db, userId, expandScopes(scopes)),
    credential: { kind: "oauth", grantId: "grant", clientId: "client" },
    oauth: {
      clientId: "client",
      grantId: "grant",
      resource: `${ORIGIN}/mcp`,
      scopes,
    },
  };
}

const writesOf = (tools: Tool[]) =>
  tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);

describe("per-credential listing", () => {
  it("lists a write when any one of its actions is allowed, for a token", async () => {
    const db = memoryBook();
    expect(
      writesOf(await listed(tokenLocals(db, 1, ["records.read"]))),
    ).toEqual([]);
    // Void alone is one action of change_records: the tool is listed.
    expect(
      writesOf(
        await listed(tokenLocals(db, 1, ["records.read", "records.void"])),
      ),
    ).toEqual(["akaun_change_records"]);
    // Creating records lists the two tools that only create (a payment is a
    // record too); attaching and changing need update.
    expect(
      writesOf(
        await listed(tokenLocals(db, 1, ["records.read", "records.create"])),
      ),
    ).toEqual(["akaun_create_records", "akaun_record_payments"]);
    expect(
      writesOf(
        await listed(tokenLocals(db, 1, ["records.read", "records.update"])),
      ),
    ).toEqual(["akaun_attach_file", "akaun_change_records"]);
    // The whole role lists every write.
    expect(
      writesOf(await listed(tokenLocals(db, 1, [...BOOKKEEPER_PERMISSIONS]))),
    ).toEqual(NAMES.slice(15));
  });

  it("never lists beyond the role or the delegation ceiling, whatever the credential holds", async () => {
    const db = memoryBook();
    // A views-only user's token: no write, even if one were asked for.
    expect(
      writesOf(
        await listed(
          patLocals(
            db,
            `Bearer ${issueTestToken(
              db,
              2,
              BOOKKEEPER_PERMISSIONS.filter((p) => p.endsWith(".read")),
            )}`,
          )!,
        ),
      ),
    ).toEqual([]);
    expect(
      writesOf(
        await listed(appLocals(db, 2, ["records:read", "records:write"])),
      ),
    ).toEqual([]);
    const token = issueTestToken(db, 1, ["records.read", "records.create"]);
    db.delete(groupDelegations)
      .where(eq(groupDelegations.permission, "records.create"))
      .run();
    expect(writesOf(await listed(patLocals(db, `Bearer ${token}`)!))).toEqual(
      [],
    );
  });

  it("lists for an OAuth app what its scopes allow, and any-of", async () => {
    const db = memoryBook();
    expect(writesOf(await listed(appLocals(db, 1, ["records:read"])))).toEqual(
      [],
    );
    expect(
      writesOf(
        await listed(appLocals(db, 1, ["records:read", "records:void"])),
      ),
    ).toEqual(["akaun_change_records"]);
    const contacts = writesOf(
      await listed(appLocals(db, 1, ["contacts:read", "contacts:write"])),
    );
    expect(contacts).toEqual(["akaun_change_contacts"]);
  });
});

describe("call-time checks", () => {
  it("refuses a tool whose access was withdrawn after listing, with FORBIDDEN", async () => {
    const locals = localsFor(["records.read"]);
    const { client, call } = await connect(locals);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "akaun_search_records",
    );
    (locals.permissions as Set<string>).delete("records.read");
    const refused = await call("akaun_search_records");
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    expect(refused.body.error.fix).toBeTruthy();
  });

  it(
    "refuses the actions a listed write may not use, naming each, and saves nothing",
    async () => {
      const book = await openBook();
      const locals = tokenLocals(book.db, book.agentUserId, [
        "records.read",
        "records.void",
      ]);
      const { call } = await connect(locals, {
        db: book.db,
        store: book.store,
        storageRoot: book.storageRoot,
      });
      const before = book.db.select().from(ledgerRecords).all();
      const record = book.manifest.records.workspaceAug;
      const refused = await call("akaun_change_records", {
        void: [{ record, expected_version: "any", reason: "Entered twice" }],
        delete: [{ record, expected_version: "any" }],
      });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("FORBIDDEN");
      expect(refused.body.error.message).toContain("akaun_change_records");
      expect(refused.body.error.message).toContain("delete");
      expect(refused.body.error.message).toContain("records.delete");
      expect(refused.body.error.message).not.toMatch(/void needs/);
      expect(book.db.select().from(ledgerRecords).all()).toEqual(before);
      // A tool that is not listed is not callable at all.
      await expect(
        call("akaun_create_records", { records: [] }),
      ).rejects.toThrow();
    },
    SLOW,
  );
});

describe("OAuth step-up over HTTP", () => {
  it(
    "challenges a write with two action arrays for the union, and saves nothing",
    async () => {
      const book = await openBook();
      const locals = appLocals(book.db, book.agentUserId, [
        "records:read",
        "records:write",
      ]);
      const record = book.manifest.records.workspaceAug;
      const before = book.db.select().from(ledgerRecords).all().length;
      const audit = book.db.select().from(auditLog).all().length;
      const response = await handleMcpRequest(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "akaun_change_records",
              arguments: {
                update: [
                  {
                    record,
                    expected_version: "any",
                    set: { description: "Coworking" },
                  },
                ],
                void: [
                  { record, expected_version: "any", reason: "Entered twice" },
                ],
              },
            },
          }),
        }),
        {
          db: book.db,
          store: book.store,
          storageRoot: book.storageRoot,
          locals,
        },
        ORIGIN,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const challenge = response.headers.get("WWW-Authenticate")!;
      expect(challenge).toContain('error="insufficient_scope"');
      // The scopes the update already has, plus what the void needs.
      expect(challenge).toContain(
        'scope="records:write records:read records:void"',
      );
      expect(challenge).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(book.db.select().from(ledgerRecords).all()).toHaveLength(before);
      expect(book.db.select().from(auditLog).all()).toHaveLength(audit);
    },
    SLOW,
  );
});
