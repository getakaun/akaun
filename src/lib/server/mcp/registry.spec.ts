import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { LedgerRecordKindLabels } from "$lib/enums.js";
import { currentAuditScope } from "../audit-context.js";
import { fail } from "../application/result.js";
import type { LedgerDb } from "../ledger/types.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { localsFor } from "../permissions/test-locals.js";
import { fromAppFailure, toolError, toolResult } from "./envelope.js";
import { enumCode, enumInput } from "./format.js";
import {
  actionAllowed,
  createServerV2,
  defineReadTool,
  defineWriteTool,
  listingSnapshot,
  MAX_DESCRIPTION_CHARS,
  toolName,
  visibleTools,
  type NamingScheme,
  type ToolDefinition,
  type ToolSet,
} from "./registry.js";
import { READ_TOOLS } from "./tools/reads/index.js";
import { WRITE_TOOLS } from "./tools/writes/index.js";

/**
 * The v2 registry, driven in-process through a real MCP client over
 * `InMemoryTransport`. The dummy tools need no book, so `db` is a stand-in
 * that throws if touched; files would go to a folder under `os.tmpdir()`.
 */

const RECORDS_READ = [
  { scopes: ["records:read" as const], permissions: ["records.read" as const] },
];
const RECORDS_WRITE = [
  {
    scopes: ["records:write" as const],
    permissions: ["records.create" as const],
  },
];

let seenRequestIds: { scope: string; meta?: string }[] = [];

const getWidget = defineReadTool({
  base: "get_widget",
  title: "Get a widget",
  description: "Reads one widget by id.",
  input: z.object({
    id: z.number().int().positive(),
    kind: enumInput(LedgerRecordKindLabels).optional(),
    note: z.string().optional(),
  }),
  requirements: RECORDS_READ,
  handler: (_ctx, args, meta) => {
    if (args.id === 404)
      return toolError({
        code: "NOT_FOUND",
        message: "No widget 404.",
        fix: `Search with ${meta.nameOf("search_widgets")}.`,
      });
    const kind = args.kind
      ? enumCode(LedgerRecordKindLabels, args.kind)
      : undefined;
    return {
      id: args.id,
      kind: kind?.ok ? kind.value : undefined,
      note: args.note ?? null,
      tags: [],
    };
  },
});

const explodeWidget = defineReadTool({
  base: "explode_widget",
  title: "Explode",
  description: "Always throws.",
  input: z.object({}),
  requirements: RECORDS_READ,
  handler: () => {
    throw new Error(
      "SQLITE_ERROR: no such table: secret_things at /private/data/akaun.db",
    );
  },
});

const hiddenWidget = defineReadTool({
  base: "list_secrets",
  title: "Hidden",
  description: "Needs a permission the caller lacks.",
  input: z.object({}),
  requirements: [{ scopes: ["accounts:read"], permissions: ["accounts.read"] }],
  handler: () => ({}),
});

const changeWidgets = defineWriteTool({
  base: "change_widgets",
  title: "Change widgets",
  description: "Saves widgets in one batch.",
  input: z.object({ names: z.array(z.string().min(1)).min(1).max(50) }),
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  actions: {
    rename: RECORDS_WRITE,
    remove: [{ scopes: ["records:delete"], permissions: ["records.delete"] }],
  },
  handler: (_ctx, args, meta) => {
    seenRequestIds.push({
      scope: currentAuditScope().requestId,
      meta: meta.requestId,
    });
    if (args.names.includes("refuse"))
      return toolError(
        fromAppFailure(fail("REFUSED", "That widget is locked.")),
      );
    return {
      saved: true,
      items: args.names.map((name, i) => ({ id: i + 1, name })),
    };
  },
});

const explodeWrite = defineWriteTool({
  base: "create_widgets",
  title: "Create widgets",
  description: "Always throws.",
  input: z.object({}),
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  requirements: RECORDS_WRITE,
  handler: async () => {
    await Promise.resolve();
    throw new Error("UNIQUE constraint failed: ledger_records.number");
  },
});

const hugeWrite = defineWriteTool({
  base: "record_widgets",
  title: "Record widgets",
  description: "Saves, then returns too much.",
  input: z.object({}),
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: RECORDS_WRITE,
  handler: () => toolResult({ saved: true, blob: "x".repeat(600 * 1024) }),
});

const TOOLS: ToolSet = {
  reads: [getWidget, explodeWidget, hiddenWidget],
  writes: [changeWidgets, explodeWrite, hugeWrite],
};

const notADatabase = new Proxy({} as LedgerDb, {
  get() {
    throw new Error("The dummy tools must not touch the database.");
  },
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  seenRequestIds = [];
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect(
  locals: App.Locals = localsFor(["records.read", "records.create"]),
  naming?: NamingScheme,
  tools: ToolSet = TOOLS,
) {
  const storageRoot = mkdtempSync(join(tmpdir(), "akaun-mcp-v2-"));
  const server = createServerV2({
    db: notADatabase,
    store: new LocalBlobStore(storageRoot),
    storageRoot,
    locals,
    naming,
    tools,
  });
  const client = new Client({ name: "v2-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });
  return { client, locals };
}

type Result = Awaited<ReturnType<Client["callTool"]>>;
const json = (result: Result) =>
  JSON.parse((result.content as { type: string; text: string }[])[0].text);

describe("toolName", () => {
  it("prefixes verb_noun by default", () => {
    expect(toolName("search_records")).toBe("akaun_search_records");
    expect(toolName("get_bank_reconciliation", "akaun_verb_noun")).toBe(
      "akaun_get_bank_reconciliation",
    );
  });

  it("moves the verb to the end for noun_verb", () => {
    expect(toolName("search_records", "akaun_noun_verb")).toBe(
      "akaun_records_search",
    );
    expect(toolName("get_bank_reconciliation", "akaun_noun_verb")).toBe(
      "akaun_bank_reconciliation_get",
    );
    expect(toolName("review_books", "akaun_noun_verb")).toBe(
      "akaun_books_review",
    );
  });

  it("leaves the base alone under plain", () => {
    expect(toolName("search_records", "plain")).toBe("search_records");
  });

  it("refuses a prefixed name over 64 characters or outside [a-z0-9_]", () => {
    expect(() => toolName(`get_${"x".repeat(60)}`)).toThrow(/64/);
    expect(() => toolName("get-records")).toThrow(/akaun_/);
  });
});

describe("define*", () => {
  const base = {
    title: "T",
    input: z.object({}),
    requirements: RECORDS_READ,
    handler: () => ({}),
  };

  it("asserts the description limit, a snake_case base and a way to be allowed", () => {
    expect(() =>
      defineReadTool({
        ...base,
        base: "get_x",
        description: "d".repeat(MAX_DESCRIPTION_CHARS + 1),
      }),
    ).toThrow(/1501 characters/);
    expect(() =>
      defineReadTool({ ...base, base: "getX", description: "d" }),
    ).toThrow(/snake_case/);
    expect(() =>
      defineReadTool({
        ...base,
        base: "get_x",
        description: "d",
        requirements: [],
      }),
    ).toThrow(/no way to be allowed/);
    expect(
      defineReadTool({
        ...base,
        base: "get_x",
        description: "d".repeat(MAX_DESCRIPTION_CHARS),
      }).kind,
    ).toBe("read");
  });

  it("fixes read annotations and keeps a write's explicit ones", () => {
    expect(getWidget.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(explodeWrite.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("derives a write's tool-level requirements from its actions, and checks each action", () => {
    const writer = localsFor(["records.create"]);
    expect(changeWidgets.requirements).toHaveLength(2);
    expect(actionAllowed(writer, changeWidgets, "rename")).toBe(true);
    expect(actionAllowed(writer, changeWidgets, "remove")).toBe(false);
    expect(actionAllowed(writer, explodeWrite, "anything")).toBe(true);
  });

  it("refuses two tools that would share a name", () => {
    expect(() =>
      visibleTools(localsFor([]), {
        reads: [getWidget, getWidget],
        writes: [],
      }),
    ).toThrow(/defined twice/);
  });
});

describe("the real tool indexes", () => {
  it("load without an import cycle and hold only tool definitions", () => {
    const all: readonly ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];
    for (const tool of all)
      expect(tool.kind === "read" || tool.kind === "write").toBe(true);
    expect(READ_TOOLS.every((t) => t.kind === "read")).toBe(true);
    expect(WRITE_TOOLS.every((t) => t.kind === "write")).toBe(true);
    expect(() =>
      visibleTools(localsFor([], { superuser: true }), {
        reads: READ_TOOLS,
        writes: WRITE_TOOLS,
      }),
    ).not.toThrow();
  });
});

describe("createServerV2 in-process", () => {
  it("lists reads then writes, in definition order, skipping what the caller cannot use", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "akaun_get_widget",
      "akaun_explode_widget",
      "akaun_change_widgets",
      "akaun_create_widgets",
      "akaun_record_widgets",
    ]);
    expect(listingSnapshot(tools)).toBe(
      [
        "akaun_get_widget | Get a widget | read,idempotent | 23 chars | id kind? note?",
        "akaun_explode_widget | Explode | read,idempotent | 14 chars | ",
        "akaun_change_widgets | Change widgets | write,destructive | 27 chars | names",
        "akaun_create_widgets | Create widgets | write,open-world | 14 chars | ",
        "akaun_record_widgets | Record widgets | write | 29 chars | ",
      ].join("\n"),
    );
  });

  it("shows zod's JSON schema for the input, strict", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const schema = tools[0].inputSchema as Record<string, unknown>;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "integer" },
        kind: { enum: expect.arrayContaining(["expense", "journal"]) },
      },
    });
  });

  it("names tools by the requested scheme", async () => {
    const { client } = await connect(undefined, "akaun_noun_verb");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      "akaun_widget_get",
      "akaun_widget_explode",
      "akaun_widgets_change",
      "akaun_widgets_create",
      "akaun_widgets_record",
    ]);
    const plain = await connect(undefined, "plain");
    expect((await plain.client.listTools()).tools[0].name).toBe("get_widget");
  });

  it("returns compact text JSON with no structuredContent", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_get_widget",
      arguments: { id: 7, kind: "journal" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(json(result)).toEqual({ id: 7, kind: 7 });
  });

  it("passes a handler's own error through, naming tools in the active scheme", async () => {
    const { client } = await connect(undefined, "akaun_noun_verb");
    const result = await client.callTool({
      name: "akaun_widget_get",
      arguments: { id: 404 },
    });
    expect(result.isError).toBe(true);
    expect(json(result).error).toEqual({
      code: "NOT_FOUND",
      message: "No widget 404.",
      fix: "Search with akaun_widgets_search.",
    });
  });

  it("reports bad arguments as INVALID_INPUT with located, hinted issues", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_get_widget",
      arguments: { ids: 7, kind: "expence", note: 5 },
    });
    expect(result.isError).toBe(true);
    const { error } = json(result);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.fix).toMatch(/Correct the fields/);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        { path: "id", message: "Required (number)." },
        {
          path: "kind",
          message: expect.stringMatching(
            /^"expence" is not allowed\. Did you mean "expense"\? Use one of: expense, income/,
          ),
        },
        { path: "note", message: expect.stringContaining("string") },
        {
          path: "ids",
          message: expect.stringMatching(
            /^Unknown field "ids"\. Did you mean "id"\? Fields here: id, kind, note\.$/,
          ),
        },
      ]),
    );
    expect(error.issues).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("Input validation error");
  });

  it("treats missing arguments as {}", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "akaun_get_widget" });
    expect(json(result).error).toMatchObject({
      code: "INVALID_INPUT",
      issues: [{ path: "id" }],
    });
  });

  it("wraps a thrown read as INTERNAL_ERROR without leaking its text", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_explode_widget",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(json(result).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The read failed unexpectedly.",
    });
    expect(JSON.stringify(result)).not.toMatch(/SQLITE|secret|private/);
  });

  it("wraps a thrown write as INTERNAL_ERROR saying nothing was saved", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_create_widgets",
      arguments: {},
    });
    expect(json(result).error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.stringContaining("Nothing was saved"),
    });
    expect(JSON.stringify(result)).not.toMatch(/UNIQUE|ledger_records/);
  });

  it("runs a write in its own audit scope and returns its request_id", async () => {
    const { client } = await connect();
    const first = await client.callTool({
      name: "akaun_change_widgets",
      arguments: { names: ["a", "b"] },
    });
    const second = await client.callTool({
      name: "akaun_change_widgets",
      arguments: { names: ["c"] },
    });
    const [one, two] = [json(first), json(second)];
    expect(one).toMatchObject({
      saved: true,
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });
    expect(one.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.request_id).not.toBe(two.request_id);
    expect(seenRequestIds).toEqual([
      { scope: one.request_id, meta: one.request_id },
      { scope: two.request_id, meta: two.request_id },
    ]);
    expect(first.structuredContent).toBeUndefined();
  });

  it("returns a write's refusal unchanged, without a request_id", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_change_widgets",
      arguments: { names: ["refuse"] },
    });
    expect(json(result)).toEqual({
      error: { code: "REFUSED", message: "That widget is locked." },
    });
  });

  it("never reports a saved write as too large; it says it was saved", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "akaun_record_widgets",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const body = json(result);
    expect(body).toMatchObject({
      saved: true,
      note: expect.stringContaining("Do not repeat the call"),
    });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("re-checks requirements when a tool is called", async () => {
    const { client, locals } = await connect();
    (locals.permissions as Set<string>).delete("records.read");
    const result = await client.callTool({
      name: "akaun_get_widget",
      arguments: { id: 1 },
    });
    expect(json(result).error).toMatchObject({
      code: "FORBIDDEN",
      message: "This connection may not use akaun_get_widget.",
    });
  });

  it("lists only what an OAuth app's scopes allow", async () => {
    const locals = {
      ...localsFor(["records.read", "records.create"]),
      oauth: {
        clientId: "c",
        grantId: "g",
        resource: "r",
        scopes: ["records:read" as const],
      },
    };
    const { client } = await connect(locals);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "akaun_get_widget",
      "akaun_explode_widget",
    ]);
  });
});
