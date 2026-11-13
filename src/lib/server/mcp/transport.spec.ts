import type { RequestEvent } from "@sveltejs/kit";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createRequestHandle } from "../request-hook.js";
import {
  auditLog,
  bankStatements,
  groupGrants,
  ledgerRecords,
  personalAccessTokens,
  recordAttachments,
} from "../db/schema.js";
import { StatementExtractionState } from "$lib/enums.js";
import { patLocals } from "../tokens/pat.js";
import { revokeAllTokens } from "../tokens/manage.js";
import { resolveAccess } from "../permissions.js";
import { grantGroup, issueTestToken } from "../permissions/test-locals.js";
import { expandScopes } from "$lib/permissions/oauth-scopes.js";
import type { OAuthScope } from "../oauth/config.js";
import { hit, reset } from "../rate-limit.js";
import { buildEvalBook, type EvalBook } from "./__fixtures__/eval-book.js";
import { downloadMcpFile, signFileToken } from "./file-links.js";
import { FILE_READ_LIMIT, MAX_FILE_BYTES } from "./file-read-policy.js";
import {
  MAX_ATTACH_FILE_BYTES,
  MAX_ATTACH_RPC_BYTES,
  MAX_RPC_BYTES,
} from "./oauth-challenge.js";
import { handleMcpRequest } from "./http.js";
import {
  createServerV2,
  defineReadTool,
  type ToolDefinition,
} from "./registry.js";

/**
 * `/mcp` as a client meets it, against the v2 tools: the Streamable HTTP
 * transport (stateless, POST only, modern and legacy protocols), who gets in
 * (401, Origin, revocation, permissions re-read on every request and checked
 * again at call time), the request-size limits with the one carve-out for
 * `akaun_attach_file`, and the signed, single-use file-link contract of
 * `akaun_get_attachment` and `akaun_get_bank_statement_file`.
 *
 * These are v1's transport, authorization and file-link assertions
 * (`mcp.spec.ts` and `mcp-write.spec.ts` at the tag `mcp-v1-baseline`), kept
 * for the v2 names. The file-link cases `tools/reads/files.spec.ts` already
 * runs in-process (the four file types, tampering and the download budget)
 * are not repeated here; this file adds the HTTP path, the request hook, a
 * revoked permission and the statement file's v1 cases. HEAD stays in
 * `file-links-route.spec.ts`, which needs Vitest's module mocks.
 *
 * Each test builds the evaluation book under `os.tmpdir()`; nothing here
 * imports `db/client.ts` (run it with `scripts/mcp-test-preload.ts` to prove
 * it), and files go to the book's own store.
 */

const SLOW = 60_000;
const TODAY = "2026-11-13";
const origin = "https://akaun.test";
const READS = [
  "records.read",
  "accounts.read",
  "contacts.read",
  "reports.read",
  "import.read",
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const PDF = Buffer.from("%PDF-1.7 receipt");

let book: EvalBook;
let dir: string;
let readToken: string;
let directoryToken: string;
let importToken: string;
const clients: Client[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "akaun-mcp-transport-"));
  book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  readToken = issueTestToken(book.db, book.agentUserId, READS);
  directoryToken = issueTestToken(book.db, book.agentUserId, ["contacts.read"]);
  importToken = issueTestToken(book.db, book.agentUserId, ["import.read"]);
  // Marked as used just now, so a read under query_only never needs to write
  // last_used_at (it is written at most once a minute).
  book.db
    .update(personalAccessTokens)
    .set({ lastUsedAt: Date.now() + 60 * 60_000 })
    .run();
  for (const user of [book.ownerId, book.agentUserId]) {
    reset(`mcp-attachment:${user}`);
    reset(`mcp-file-download:${user}`);
  }
}, SLOW);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  book.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const context = (locals: App.Locals) => ({
  db: book.db,
  store: book.store,
  storageRoot: book.storageRoot,
  locals,
});

function actor(token = readToken) {
  const locals = patLocals(book.db, `Bearer ${token}`);
  if (!locals) throw new Error("Fixture actor missing");
  return locals;
}

/** An OAuth app acting for the agent, as `oauth.authenticate` builds it. */
function appLocals(scopes: OAuthScope[]): App.Locals {
  return {
    user: actor(book.agentToken).user,
    ...resolveAccess(book.db, book.agentUserId, expandScopes(scopes)),
    credential: { kind: "oauth", grantId: "grant", clientId: "client" },
    oauth: {
      clientId: "client",
      grantId: "grant",
      resource: `${origin}/mcp`,
      scopes,
    },
  };
}

const queryOnly = (on: boolean) =>
  book.raw.exec(`PRAGMA query_only = ${on ? "ON" : "OFF"}`);

/** Stores a file under the book's store and attaches it to `recordId`. */
async function attach(recordId: number, key: string, bytes: Buffer) {
  await book.store.put(key, bytes);
  return book.db
    .insert(recordAttachments)
    .values({ recordId, filename: key, displayName: key.split("/").pop()! })
    .returning({ id: recordAttachments.id })
    .get().id;
}

const fileRecord = () => book.manifest.records.workspaceAug;

// Exercise the same token-authenticated hook bypass and route logic as GET,
// with no browser session or Authorization header.
async function redeem(
  token: string,
  request = new Request(`${origin}/api/mcp-files/${token}`),
) {
  const handle = createRequestHandle(book.db, null, null);
  return handle({
    event: {
      request,
      url: new URL(request.url),
      locals: { user: null, permissions: null },
      cookies: { get: () => undefined },
      getClientAddress: () => "127.0.0.1",
    } as unknown as RequestEvent,
    resolve: () => downloadMcpFile(book.db, book.store, token, request),
  });
}

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output, read loosely in assertions
const bodyOf = (result: Result): any => JSON.parse(result.content![0].text!);

for (const era of ["legacy", "modern", "auto"] as const) {
  async function connect(
    auth: string | App.Locals = readToken,
    exchanges?: { request: Request; response: Response }[],
  ) {
    const client = new Client(
      { name: "akaun-test", version: "1" },
      {
        versionNegotiation: {
          mode: era === "modern" ? { pin: "2026-07-28" } : era,
        },
      },
    );
    clients.push(client);
    const bearer = typeof auth === "string" ? auth : book.agentToken;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          const observed = exchanges ? request.clone() : undefined;
          const locals =
            typeof auth === "string"
              ? (patLocals(book.db, request.headers.get("Authorization")) ?? {
                  user: null,
                  permissions: null,
                })
              : auth;
          const response = await handleMcpRequest(
            request,
            context(locals),
            origin,
          );
          if (observed)
            exchanges?.push({ request: observed, response: response.clone() });
          return response;
        },
      }),
    );
    return client;
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return (await client.callTool({ name, arguments: args })) as Result;
  }

  async function names(client: Client) {
    return (await client.listTools()).tools.map((tool) => tool.name);
  }

  function request(
    method = "POST",
    headers: Record<string, string> = {},
    body?: string,
  ) {
    return new Request(`${origin}/mcp`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(era === "legacy"
          ? {}
          : {
              "Mcp-Method": "tools/list",
              "Mcp-Protocol-Version": "2026-07-28",
            }),
        ...headers,
      },
      ...(method === "POST"
        ? {
            body:
              body ??
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                ...(era === "legacy"
                  ? {}
                  : {
                      params: {
                        _meta: {
                          "io.modelcontextprotocol/protocolVersion":
                            "2026-07-28",
                          "io.modelcontextprotocol/clientCapabilities": {},
                        },
                      },
                    }),
              }),
          }
        : {}),
    });
  }

  const send = (req: Request, locals: App.Locals = actor()) =>
    handleMcpRequest(req, context(locals), origin);

  describe(`MCP transport and authorization (${era})`, () => {
    if (era !== "legacy") {
      it(
        "rejects modern header mismatches, unsupported revisions and subscription streams",
        async () => {
          const mismatchedMethod = await send(
            request("POST", { "Mcp-Method": "resources/list" }),
          );
          expect(mismatchedMethod.status).toBe(400);
          expect((await mismatchedMethod.json()).error.code).toBe(-32020);
          const missingMethod = request();
          missingMethod.headers.delete("Mcp-Method");
          const missing = await send(missingMethod);
          expect(missing.status).toBe(400);
          expect((await missing.json()).error.code).toBe(-32020);
          const body = (method: string, version = "2026-07-28", params = {}) =>
            JSON.stringify({
              jsonrpc: "2.0",
              id: 42,
              method,
              params: {
                ...params,
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": version,
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            });
          const unsupported = await send(
            request(
              "POST",
              { "Mcp-Protocol-Version": "2026-07-29" },
              body("tools/list", "2026-07-29"),
            ),
          );
          expect(unsupported.status).toBe(400);
          expect((await unsupported.json()).error.code).toBe(-32022);
          const wrongName = await send(
            request(
              "POST",
              { "Mcp-Method": "tools/call", "Mcp-Name": "akaun_get_record" },
              body("tools/call", "2026-07-28", {
                name: "akaun_search_records",
                arguments: {},
              }),
            ),
          );
          expect(wrongName.status).toBe(400);
          expect((await wrongName.json()).error.code).toBe(-32020);
          const listen = await send(
            request(
              "POST",
              { "Mcp-Method": "subscriptions/listen" },
              body("subscriptions/listen", "2026-07-28", {
                subscriptions: { toolsListChanged: true },
              }),
            ),
          );
          expect(listen.headers.get("Content-Type")).toContain(
            "application/json",
          );
          expect((await listen.json()).error.code).toBe(-32603);
        },
        SLOW,
      );
    }

    it(
      "negotiates the requested era and emits its wire contract, writing nothing",
      async () => {
        const audit = book.db.select().from(auditLog).all().length;
        queryOnly(true);
        const exchanges: { request: Request; response: Response }[] = [];
        const client = await connect(readToken, exchanges);
        const modern = era !== "legacy";
        expect(client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
        expect(client.getNegotiatedProtocolVersion()).toBe(
          modern ? "2026-07-28" : "2025-11-25",
        );
        // v2 serves tools and prompts only: no resources.
        expect(client.getServerCapabilities()).toEqual({
          tools: { listChanged: false },
          prompts: { listChanged: false },
        });
        expect(client.getServerVersion()?.name).toBe("akaun");
        expect(client.getInstructions()).toContain("akaun_get_books_overview");
        await client.listTools();
        await client.listPrompts();
        const overview = await call(client, "akaun_get_books_overview");
        expect(overview.isError).toBeFalsy();
        expect(
          (await call(client, "akaun_search_records")).isError,
        ).toBeFalsy();
        const methods: string[] = [];
        for (const exchange of exchanges) {
          if (exchange.request.method !== "POST") continue;
          const body = await exchange.request.json();
          methods.push(body.method);
          expect(exchange.response.headers.get("Cache-Control")).toBe(
            "no-store",
          );
          expect(exchange.response.headers.get("Mcp-Session-Id")).toBeNull();
          if (!modern) continue;
          expect(body.params._meta).toMatchObject({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "akaun-test",
              version: "1",
            },
          });
          expect(exchange.request.headers.get("Mcp-Method")).toBe(body.method);
          expect(exchange.request.headers.get("Mcp-Protocol-Version")).toBe(
            "2026-07-28",
          );
          if (body.method === "tools/call")
            expect(exchange.request.headers.get("Mcp-Name")).toBe(
              body.params.name,
            );
          expect(exchange.response.headers.get("Content-Type")).toContain(
            "application/json",
          );
          const wire = await exchange.response.json();
          expect(wire.result).toMatchObject({ resultType: "complete" });
          expect(
            wire.result._meta["io.modelcontextprotocol/serverInfo"],
          ).toMatchObject({ name: "akaun" });
          if (body.method !== "tools/call")
            expect(wire.result).toMatchObject({
              ttlMs: 0,
              cacheScope: "private",
            });
        }
        expect(methods[0]).toBe(modern ? "server/discover" : "initialize");
        if (modern) expect(methods).not.toContain("initialize");
        queryOnly(false);
        expect(book.db.select().from(auditLog).all()).toHaveLength(audit);
      },
      SLOW,
    );

    it(
      "advertises constrained JSON schemas for every input and kept output",
      async () => {
        const client = await connect(book.agentToken);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(28);
        const checkSchema = (value: unknown, where: string) => {
          if (typeof value === "boolean") return;
          expect(value, where).toBeTypeOf("object");
          expect(value, where).not.toBeNull();
          const node = value as Record<string, unknown>;
          expect(
            ["type", "$ref", "anyOf", "oneOf", "allOf", "const", "enum"].some(
              (key) => key in node,
            ),
            where,
          ).toBe(true);
          for (const key of ["properties", "$defs", "definitions"])
            for (const [name, child] of Object.entries(
              (node[key] ?? {}) as Record<string, unknown>,
            ))
              checkSchema(child, `${where}.${name}`);
          for (const key of ["items", "additionalProperties"])
            if (key in node) checkSchema(node[key], `${where}.${key}`);
          for (const key of ["anyOf", "oneOf", "allOf"])
            for (const child of (node[key] ?? []) as unknown[])
              checkSchema(child, `${where}.${key}`);
        };
        for (const tool of tools) {
          checkSchema(tool.inputSchema, tool.name);
          if (tool.outputSchema)
            checkSchema(tool.outputSchema, `${tool.name} output`);
        }
        // The client validates a kept contract's structured output on a real call.
        const attachmentId = await attach(fileRecord(), "records/r.pdf", PDF);
        expect(
          (
            await call(client, "akaun_get_attachment", {
              recordId: fileRecord(),
              attachmentId,
            })
          ).isError,
        ).toBeFalsy();
      },
      SLOW,
    );

    // A personal access token with reads only sees reads only.
    it(
      "connects with the official HTTP client and exposes only the granted read tools",
      async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([
          "akaun_get_books_overview",
          "akaun_search_records",
          "akaun_get_record",
          "akaun_get_category_history",
          "akaun_list_accounts",
          "akaun_find_contacts",
          "akaun_get_contact",
          "akaun_get_report",
          "akaun_get_import_queue",
          "akaun_get_change_history",
          "akaun_get_attachment",
          "akaun_review_books",
        ]);
        expect(
          tools.every(
            (tool) =>
              tool.annotations?.readOnlyHint &&
              tool.annotations?.destructiveHint === false,
          ),
        ).toBe(true);
        expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(
          ["month-end-review", "categorise-expenses", "reconcile-account"],
        );
        // v1's akaun://context and description-policy resources are gone.
        expect(client.getServerCapabilities()?.resources).toBeUndefined();
        const resources = await client
          .listResources()
          .then((listed) => listed.resources)
          .catch(() => []);
        expect(resources).toEqual([]);
        await expect(
          call(client, "akaun_change_records", {
            update: [
              {
                record: fileRecord(),
                expected_version: "x",
                set: { description: "changed" },
              },
            ],
          }),
        ).rejects.toMatchObject({ code: -32602 });
        // v1's names are gone.
        await expect(call(client, "list_records")).rejects.toMatchObject({
          code: -32602,
        });
      },
      SLOW,
    );

    it(
      "rejects missing/bad tokens and revocation, independently of the user's role label",
      () => {
        expect(patLocals(book.db, null)).toBeNull();
        expect(patLocals(book.db, "Bearer wrong")).toBeNull();
        expect(patLocals(book.db, "Basic x")).toBeNull();
        expect(
          patLocals(book.db, `bearer ${directoryToken}`)?.role?.isSuperuser,
        ).toBe(false);
        revokeAllTokens(book.db, book.agentUserId);
        expect(patLocals(book.db, `Bearer ${readToken}`)).toBeNull();
      },
      SLOW,
    );

    it(
      "returns 401 instead of a browser redirect and refuses cross-origin requests",
      async () => {
        const missing = await send(request(), {
          user: null,
          permissions: null,
        });
        expect(missing.status).toBe(401);
        expect(missing.headers.get("Location")).toBeNull();
        expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
        expect(missing.headers.get("Cache-Control")).toBe("no-store");
        for (const badOrigin of [
          "https://evil.test",
          "http://akaun.test",
          "https://akaun.test:444",
          "null",
        ]) {
          const refused = await send(request("POST", { Origin: badOrigin }));
          expect(refused.status, badOrigin).toBe(403);
          expect(refused.headers.get("Cache-Control")).toBe("no-store");
        }
        const sameOrigin = await send(request("POST", { Origin: origin }));
        expect(sameOrigin.status).toBe(200);
        expect(sameOrigin.headers.get("Cache-Control")).toBe("no-store");
        expect(sameOrigin.headers.get("mcp-session-id")).toBeNull();
      },
      SLOW,
    );

    it(
      "rejects unsupported methods, protocol versions, media types and oversized bodies",
      async () => {
        for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
          const response = await send(request(method));
          expect(response.status, method).toBe(405);
          expect(response.headers.get("Allow")).toBe("POST");
          expect(response.headers.get("Cache-Control")).toBe("no-store");
        }
        expect(
          (
            await send(
              request("POST", { "mcp-protocol-version": "1900-01-01" }),
            )
          ).status,
        ).toBe(400);
        expect(
          (await send(request("POST", { "Content-Type": "text/plain" })))
            .status,
        ).toBe(415);
        expect(
          (await send(request("POST", {}, "x".repeat(MAX_RPC_BYTES + 1))))
            .status,
        ).toBe(413);
        expect((await send(request("POST", {}, "{broken"))).status).toBe(400);
      },
      SLOW,
    );

    it(
      "isolates concurrent users and hides financial tools from directory/import-only users",
      async () => {
        const [directory, full, importer] = await Promise.all([
          connect(directoryToken),
          connect(),
          connect(importToken),
        ]);
        const [directoryTools, fullTools, importTools] = await Promise.all([
          names(directory),
          names(full),
          names(importer),
        ]);
        expect(directoryTools).toEqual([
          "akaun_get_books_overview",
          "akaun_find_contacts",
          "akaun_get_change_history",
          "akaun_review_books",
        ]);
        expect(fullTools).toHaveLength(12);
        expect(importTools).toEqual([
          "akaun_get_books_overview",
          "akaun_get_import_queue",
          "akaun_get_change_history",
          "akaun_review_books",
        ]);
        await expect(
          call(directory, "akaun_get_contact", {
            contact: book.manifest.contacts.grabCompany,
          }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          call(importer, "akaun_get_record", { record: fileRecord() }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          call(importer, "akaun_get_attachment", {
            recordId: fileRecord(),
            attachmentId: 1,
          }),
        ).rejects.toMatchObject({ code: -32602 });
      },
      SLOW,
    );

    it(
      "checks permissions at call time as well as discovery",
      async () => {
        const locals = actor();
        const server = createServerV2({
          ...context(locals),
          requestOrigin: origin,
          tools: {
            reads: (await import("./tools/reads/index.js")).READ_TOOLS,
            writes: [],
          },
        });
        const client = new Client({ name: "direct-test", version: "1" });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        clients.push(client);
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        (locals.permissions as Set<string>).delete("records.read");
        const result = (await call(client, "akaun_get_record", {
          record: fileRecord(),
        })) as Result;
        expect(result.isError).toBe(true);
        expect(bodyOf(result).error.code).toBe("FORBIDDEN");
        await server.close();
      },
      SLOW,
    );

    it(
      "honors a changed permission on the next HTTP request",
      async () => {
        const client = await connect();
        expect(await names(client)).toContain("akaun_search_records");
        book.db
          .delete(groupGrants)
          .where(eq(groupGrants.permission, "records.read"))
          .run();
        await expect(
          call(client, "akaun_search_records"),
        ).rejects.toMatchObject({ code: -32602 });
        expect(await names(client)).not.toContain("akaun_search_records");
      },
      SLOW,
    );

    it(
      "rejects an already-connected client after token revocation",
      async () => {
        const client = await connect();
        await client.listTools();
        revokeAllTokens(book.db, book.agentUserId);
        await expect(call(client, "akaun_search_records")).rejects.toThrow();
        await expect(client.listTools()).rejects.toThrow();
      },
      SLOW,
    );

    it(
      "answers a prototype key as a tool name like any unknown tool, never with a 500",
      async () => {
        const app = appLocals(["records:read"]);
        for (const name of [
          "constructor",
          "__proto__",
          "toString",
          "hasOwnProperty",
          "valueOf",
        ]) {
          const response = await send(
            request(
              "POST",
              { "Mcp-Method": "tools/call", "Mcp-Name": name },
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name,
                  arguments: {},
                  ...(era === "legacy"
                    ? {}
                    : {
                        _meta: {
                          "io.modelcontextprotocol/protocolVersion":
                            "2026-07-28",
                          "io.modelcontextprotocol/clientCapabilities": {},
                        },
                      }),
                },
              }),
            ),
            app,
          );
          expect(response.status, name).toBeLessThan(500);
          expect(response.status, name).not.toBe(403);
        }
        // And through the client, for the OAuth app and for a token.
        for (const auth of [app, readToken]) {
          const client = await connect(auth);
          await expect(call(client, "constructor")).rejects.toMatchObject({
            code: -32602,
          });
        }
      },
      SLOW,
    );

    it(
      "returns a signed, single-use link over HTTP on the request's origin, redeemed through the request hook",
      async () => {
        const client = await connect();
        for (const [name, bytes, mime] of [
          ["photo.png", PNG, "image/png"],
          ["receipt.pdf", PDF, "application/pdf"],
        ] as const) {
          const attachmentId = await attach(
            fileRecord(),
            `records/${name}`,
            bytes,
          );
          const result = await call(client, "akaun_get_attachment", {
            recordId: fileRecord(),
            attachmentId,
          });
          expect(result.isError).toBeFalsy();
          expect(result.content).toHaveLength(1);
          const data = bodyOf(result);
          expect(result.structuredContent).toEqual(data);
          expect(Object.keys(data).sort()).toEqual(
            [
              "recordId",
              "attachmentId",
              "filename",
              "mimeType",
              "size",
              "sha256",
              "downloadUrl",
              "expiresAt",
            ].sort(),
          );
          expect(data).toMatchObject({
            recordId: fileRecord(),
            attachmentId,
            filename: name,
            mimeType: mime,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
          expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(
            115_000,
          );
          expect(new URL(data.downloadUrl).origin).toBe(origin);
          expect(JSON.stringify(result)).not.toContain(book.storageRoot);
          const token = new URL(data.downloadUrl).pathname.split("/").pop()!;
          const responses = await Promise.all(
            [0, 1].map(() =>
              redeem(
                token,
                new Request(data.downloadUrl, {
                  headers: { "if-none-match": "*" },
                }),
              ),
            ),
          );
          expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);
          const response = responses.find((r) => r.status === 200)!;
          expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
          expect(response.headers.get("Content-Type")).toBe(mime);
          expect(response.headers.get("Content-Length")).toBe(
            String(bytes.length),
          );
          expect(response.headers.get("Content-Disposition")).toContain(
            `attachment; filename="${name}"`,
          );
          expect(response.headers.get("Content-Disposition")).toContain(
            "filename*=UTF-8''",
          );
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
          expect(response.headers.get("X-Content-Type-Options")).toBe(
            "nosniff",
          );
        }
      },
      SLOW,
    );
  });
}

describe("output budget and failures", () => {
  it(
    "bounds output and sanitizes unexpected failures",
    async () => {
      const anyone = [{ scopes: [], permissions: [] }] as const;
      const tool = (
        base: string,
        handler: ToolDefinition["handler"],
        input = z.object({}),
      ) =>
        defineReadTool({
          base,
          title: base,
          description: base,
          input,
          requirements: [...anyone],
          handler,
        });
      const server = createServerV2({
        ...context(actor()),
        requestOrigin: origin,
        tools: {
          reads: [
            tool("large", () => ({ text: "x".repeat(600 * 1024) })),
            tool(
              "broken",
              () => {
                throw new Error("secret /private/database");
              },
              z.object({ id: z.number() }),
            ),
          ],
          writes: [],
        },
      });
      const client = new Client({ name: "budget-test", version: "1" });
      clients.push(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const large = (await client.callTool({
        name: "akaun_large",
        arguments: {},
      })) as Result;
      expect(large.isError).toBe(true);
      expect(bodyOf(large).error.code).toBe("OUTPUT_TOO_LARGE");
      const broken = JSON.stringify(
        await client.callTool({ name: "akaun_broken", arguments: { id: 1 } }),
      );
      expect(broken).toContain("INTERNAL_ERROR");
      expect(broken).not.toContain("secret");
      expect(broken).not.toContain("/private/database");
      await server.close();
    },
    SLOW,
  );
});

describe("akaun_get_attachment links over time", () => {
  it(
    "refuses a link once the user's records permission is revoked, and again once the file is gone",
    async () => {
      const attachmentId = await attach(fileRecord(), "records/p.pdf", PDF);
      const claims = {
        userId: book.agentUserId,
        recordId: fileRecord(),
        attachmentId,
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: randomUUID(),
      };
      const token = signFileToken(claims);
      book.db
        .delete(groupGrants)
        .where(
          and(
            eq(groupGrants.groupId, book.manifest.groups.bookkeeper),
            eq(groupGrants.permission, "records.read"),
          ),
        )
        .run();
      expect((await redeem(token)).status).toBe(403);
      grantGroup(book.db, {
        name: "restored",
        userIds: [book.agentUserId],
        grants: ["records.read"],
      });
      book.db
        .delete(recordAttachments)
        .where(eq(recordAttachments.id, attachmentId))
        .run();
      expect((await redeem(token)).status).toBe(404);
    },
    SLOW,
  );
});

describe("akaun_get_bank_statement_file", () => {
  async function connect(token = book.agentToken) {
    const client = new Client({ name: "statement-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          return handleMcpRequest(
            request,
            context(
              patLocals(book.db, request.headers.get("Authorization")) ?? {
                user: null,
                permissions: null,
              },
            ),
            origin,
          );
        },
      }),
    );
    return client;
  }
  const call = async (client: Client, statementId: unknown) =>
    (await client.callTool({
      name: "akaun_get_bank_statement_file",
      arguments: { statementId },
    })) as Result;

  async function statementFile(
    key: string,
    bytes?: Buffer,
    state = StatementExtractionState.Extracting as number,
  ) {
    if (bytes) await book.store.put(key, bytes);
    const accountId = book.db
      .select({ accountId: bankStatements.accountId })
      .from(bankStatements)
      .where(eq(bankStatements.id, book.manifest.statements.bank))
      .get()!.accountId;
    return book.db
      .insert(bankStatements)
      .values({
        originalFilename: "original." + key.split(".").pop(),
        storedFilePath: key,
        extractionState: state,
        uploadedBy: book.ownerId,
        accountId,
      })
      .returning({ id: bankStatements.id })
      .get()!.id;
  }

  const download = (token: string) =>
    downloadMcpFile(
      book.db,
      book.store,
      token,
      new Request(`${origin}/api/mcp-files/${token}`),
    );

  it(
    "returns download links with reconciliation-only access and a structured output schema",
    async () => {
      const token = issueTestToken(book.db, book.agentUserId, [
        "reconciliation.read",
      ]);
      const client = await connect(token);
      const listed = (await client.listTools()).tools;
      expect(
        listed.find((t) => t.name === "akaun_get_bank_statement_file")
          ?.outputSchema,
      ).toBeDefined();
      expect(listed.map((t) => t.name)).toContain(
        "akaun_get_bank_statement_file",
      );
      expect(listed.map((t) => t.name)).not.toContain("akaun_get_attachment");
      const initialAudit = book.db.select().from(auditLog).all().length;
      const fixtures = [
        ["pdf", Buffer.from("%PDF-1.7 source"), "application/pdf"],
        ["png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7]), "image/png"],
        ["jpg", Buffer.from([255, 216, 255, 7]), "image/jpeg"],
        ["csv", Buffer.from("Date,Amount\n2026-09-01,12.50\n"), "text/csv"],
        [
          "xlsx",
          Buffer.from([80, 75, 3, 4, 7]),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
      ] as const;
      for (const [ext, bytes, mime] of fixtures) {
        const statementId = await statementFile(
          `reconciliation/private/source.${ext}`,
          bytes,
        );
        const result = await call(client, statementId);
        expect(result.isError).toBeFalsy();
        const metadata = bodyOf(result);
        expect(Object.keys(metadata).sort()).toEqual(
          [
            "statementId",
            "filename",
            "mimeType",
            "size",
            "sha256",
            "downloadUrl",
            "expiresAt",
          ].sort(),
        );
        expect(metadata).toMatchObject({
          statementId,
          filename: `original.${ext}`,
          mimeType: mime,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        expect(result.structuredContent).toEqual(metadata);
        expect(result.content).toHaveLength(1);
        expect(new URL(metadata.downloadUrl).origin).toBe(origin);
        expect(Date.parse(metadata.expiresAt) - Date.now()).toBeGreaterThan(
          115_000,
        );
        const downloadToken = new URL(metadata.downloadUrl).pathname
          .split("/")
          .pop()!;
        const request = new Request(metadata.downloadUrl);
        const responses = await Promise.all(
          [0, 1].map(() =>
            downloadMcpFile(book.db, book.store, downloadToken, request),
          ),
        );
        expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);
        const response = responses.find((r) => r.status === 200)!;
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
        expect(response.headers.get("Content-Type")).toBe(mime);
        expect(response.headers.get("Content-Length")).toBe(
          String(bytes.length),
        );
        expect(response.headers.get("Content-Disposition")).toContain(
          `attachment; filename="original.${ext}"`,
        );
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(JSON.stringify(result)).not.toContain("reconciliation/private");
        expect(JSON.stringify(result)).not.toContain(book.storageRoot);
      }
      expect(book.db.select().from(auditLog).all()).toHaveLength(initialAudit);
      const failed = await statementFile(
        "reconciliation/failed.pdf",
        Buffer.from("%PDF-failed"),
        StatementExtractionState.Failed,
      );
      expect((await call(client, failed)).isError).toBeFalsy();
    },
    SLOW,
  );

  it(
    "handles absent, unsupported, and oversized files and accepts the exact size limit",
    async () => {
      const client = await connect();
      const missing = await statementFile("reconciliation/missing.pdf");
      const absent = await statementFile("");
      for (const statementId of [missing, absent, 999_999])
        expect(bodyOf(await call(client, statementId)).error.code).toBe(
          "NOT_FOUND",
        );
      const unsupported = await statementFile(
        "reconciliation/file.txt",
        Buffer.from("hello"),
      );
      // v1's UNSUPPORTED is not a v2 code: REFUSED, with v1's sentence.
      const refused = bodyOf(await call(client, unsupported));
      expect(refused.error.code).toBe("REFUSED");
      expect(refused.error.message).toBe(
        "This file is not a PDF, an image or a spreadsheet.",
      );
      const bytes = Buffer.alloc(MAX_FILE_BYTES, 32);
      bytes.write("%PDF-");
      const exact = await statementFile("reconciliation/exact.pdf", bytes);
      const result = await call(client, exact);
      expect(result.isError).toBeFalsy();
      const metadata = bodyOf(result);
      expect(metadata.size).toBe(MAX_FILE_BYTES);
      const response = await download(
        new URL(metadata.downloadUrl).pathname.split("/").pop()!,
      );
      expect(response.status).toBe(200);
      // Buffer.equals, not toEqual: deep equality walks all 5 MB one element at a time.
      const downloaded = Buffer.from(await response.arrayBuffer());
      expect(downloaded.length).toBe(MAX_FILE_BYTES);
      expect(downloaded.equals(bytes)).toBe(true);
      const large = await statementFile(
        "reconciliation/large.pdf",
        Buffer.concat([bytes, Buffer.from("x")]),
      );
      expect(bodyOf(await call(client, large)).error.code).toBe(
        "OUTPUT_TOO_LARGE",
      );
    },
    SLOW,
  );

  it(
    "rejects expired, tampered, missing, revoked and oversized statement downloads",
    async () => {
      const statementId = await statementFile(
        "reconciliation/private.pdf",
        Buffer.from("%PDF-source"),
      );
      const claims = {
        userId: book.agentUserId,
        statementId,
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: randomUUID(),
      };
      const token = signFileToken(claims);
      expect(
        (await download(signFileToken({ ...claims, exp: 1 }))).status,
      ).toBe(410);
      expect((await download(`${token.slice(0, -2)}xx`)).status).toBe(403);
      expect(
        (await download(signFileToken({ ...claims, userId: 999_999 }))).status,
      ).toBe(403);
      expect(
        (await download(signFileToken({ ...claims, statementId: 999_999 })))
          .status,
      ).toBe(404);
      book.db
        .delete(groupGrants)
        .where(
          and(
            eq(groupGrants.groupId, book.manifest.groups.bookkeeper),
            eq(groupGrants.permission, "reconciliation.read"),
          ),
        )
        .run();
      expect((await download(token)).status).toBe(403);
      grantGroup(book.db, {
        name: "restored-reconciliation",
        userIds: [book.agentUserId],
        grants: ["reconciliation.read"],
      });
      await book.store.put(
        "reconciliation/private.pdf",
        Buffer.alloc(MAX_FILE_BYTES + 1),
      );
      expect((await download(token)).status).toBe(404);
      await book.store.put(
        "reconciliation/private.pdf",
        Buffer.from("%PDF-source"),
      );
      book.db
        .delete(bankStatements)
        .where(eq(bankStatements.id, statementId))
        .run();
      expect((await download(token)).status).toBe(404);
    },
    SLOW,
  );

  it(
    "shares the attachment read throttle and hides the tool without reconciliation access",
    async () => {
      const statementId = await statementFile(
        "reconciliation/limit.pdf",
        Buffer.from("%PDF-limit"),
      );
      for (let i = 0; i < FILE_READ_LIMIT.max; i++)
        hit(
          `mcp-attachment:${book.agentUserId}`,
          FILE_READ_LIMIT.max,
          FILE_READ_LIMIT.windowMs,
        );
      const client = await connect();
      const limited = bodyOf(await call(client, statementId));
      // v1's RATE_LIMITED is not a v2 code: REFUSED, with v1's sentence.
      expect(limited.error.code).toBe("REFUSED");
      expect(limited.error.message).toMatch(/^Too many files read\. /);
      // The same budget refuses an attachment read too.
      const attachmentId = await attach(fileRecord(), "records/l.pdf", PDF);
      const attachment = bodyOf(
        (await client.callTool({
          name: "akaun_get_attachment",
          arguments: { recordId: fileRecord(), attachmentId },
        })) as Result,
      );
      expect(attachment.error.message).toMatch(/^Too many files read\. /);
      const denied = await connect(
        issueTestToken(book.db, book.agentUserId, ["records.read"]),
      );
      expect((await denied.listTools()).tools.map((t) => t.name)).not.toContain(
        "akaun_get_bank_statement_file",
      );
      await expect(call(denied, statementId)).rejects.toThrow(/not found/i);
    },
    SLOW,
  );
});

describe("akaun_attach_file and the request size", () => {
  const rpc = (name: string, args: unknown, id = 1) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
  const post = (body: string, locals = actor(book.agentToken)) =>
    handleMcpRequest(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body,
      }),
      context(locals),
      origin,
    );
  /** A JSON-RPC answer, sent as JSON or as one server-sent event. */
  async function wireOf(response: Response) {
    const text = await response.text();
    const data = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice("data: ".length);
    return JSON.parse(data);
  }
  const storedFiles = () =>
    book.db.select().from(recordAttachments).all().length;

  it(
    "accepts one file larger than the ordinary request limit, and stores it",
    async () => {
      const pdf = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(300 * 1024, 0x20),
      ]);
      const before = storedFiles();
      const body = rpc("akaun_attach_file", {
        recordId: fileRecord(),
        filename: "big.pdf",
        contentBase64: pdf.toString("base64"),
      });
      expect(body.length).toBeGreaterThan(MAX_RPC_BYTES);
      const response = await post(body);
      expect(response.status).toBe(200);
      const wire = await wireOf(response);
      expect(wire.result.isError).toBeFalsy();
      expect(wire.result.structuredContent.data.attachment.id).toBeGreaterThan(
        0,
      );
      expect(storedFiles()).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "refuses a large body for any tool but akaun_attach_file, and saves nothing",
    async () => {
      const records = book.db.select().from(ledgerRecords).all().length;
      const files = storedFiles();
      const stored = readdirSync(book.storageRoot, { recursive: true }).length;
      const padding = "x".repeat(200 * 1024);
      for (const body of [
        rpc("akaun_create_records", {
          records: [{ description: padding }],
        }),
        // v1's name is not the carve-out.
        rpc("attach_file", {
          recordId: fileRecord(),
          filename: "a.pdf",
          contentBase64: padding,
        }),
        // Nor is a batch that holds the attach call.
        `[${rpc("akaun_attach_file", {
          recordId: fileRecord(),
          filename: "a.pdf",
          contentBase64: padding,
        })}]`,
      ]) {
        const response = await post(body);
        expect(response.status).toBe(413);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(book.db.select().from(ledgerRecords).all()).toHaveLength(records);
      expect(storedFiles()).toBe(files);
      expect(readdirSync(book.storageRoot, { recursive: true })).toHaveLength(
        stored,
      );
    },
    SLOW,
  );

  it(
    "refuses an attach call over the file allowance, by declared length and by body",
    async () => {
      expect(MAX_ATTACH_RPC_BYTES).toBe(
        Math.ceil((MAX_ATTACH_FILE_BYTES * 4) / 3) + 64 * 1024,
      );
      const declared = await handleMcpRequest(
        new Request(`${origin}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": String(MAX_ATTACH_RPC_BYTES + 1),
          },
          body: "{}",
        }),
        context(actor(book.agentToken)),
        origin,
      );
      expect(declared.status).toBe(413);
      const files = storedFiles();
      const response = await post(
        rpc("akaun_attach_file", {
          recordId: fileRecord(),
          filename: "huge.pdf",
          contentBase64: "A".repeat(MAX_ATTACH_RPC_BYTES),
        }),
      );
      expect(response.status).toBe(413);
      expect(storedFiles()).toBe(files);
    },
    SLOW,
  );

  it(
    "gives an OAuth app the same allowance, and challenges it like any write",
    async () => {
      const pdf = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(200 * 1024, 0x20),
      ]);
      const args = {
        recordId: fileRecord(),
        filename: "big.pdf",
        contentBase64: pdf.toString("base64"),
      };
      const reader = await post(
        rpc("akaun_attach_file", args),
        appLocals(["records:read"]),
      );
      expect(reader.status).toBe(403);
      expect(reader.headers.get("WWW-Authenticate")).toContain(
        'error="insufficient_scope"',
      );
      expect(reader.headers.get("WWW-Authenticate")).toContain(
        'scope="records:write"',
      );
      const writer = await post(
        rpc("akaun_attach_file", args),
        appLocals(["records:read", "records:write"]),
      );
      expect(writer.status).toBe(200);
      expect((await wireOf(writer)).result.isError).toBeFalsy();
    },
    SLOW,
  );
});
