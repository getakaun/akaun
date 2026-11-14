import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import {
  bankStatements,
  recordAttachments,
  users,
} from "../../../db/schema.js";
import { hit, reset } from "../../../rate-limit.js";
import {
  downloadMcpFile,
  fileLinkConfig,
  signFileToken,
} from "../../file-links.js";
import {
  FILE_READ_LIMIT as ATTACHMENT_READ_LIMIT,
  MAX_FILE_BYTES as MAX_ATTACHMENT_BYTES,
} from "../../file-read-policy.js";
import { filesReadTools } from "./files.js";

// The key assertions of v1's file-link contract (mcp.spec.ts, "get_attachment"),
// run against the v2 registration of the same two tools. Each test builds its
// own evaluation book under os.tmpdir(); nothing here imports db/client.ts.
// Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/files.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;
const ORIGIN = "https://akaun.test";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const PDF = Buffer.from("%PDF-1.7 receipt");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-files-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    requestOrigin: ORIGIN,
    tools: { reads: filesReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-files-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    book.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const user of [book.ownerId, book.agentUserId]) {
    reset(`mcp-attachment:${user}`);
    reset(`mcp-file-download:${user}`);
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return {
      result,
      isError: result.isError === true,
      body: JSON.parse(text),
    };
  };
  return { book, client, call };
}

const recordWithFile = (book: EvalBook) =>
  Number(
    Object.keys(book.manifest.attachments).map(
      (key) => book.manifest.records[key as keyof typeof book.manifest.records],
    )[0],
  );

/** Stores a file under the book's store and attaches it to `recordId`. */
async function attach(
  book: EvalBook,
  recordId: number,
  key: string,
  bytes: Buffer,
) {
  await book.store.put(key, bytes);
  return book.db
    .insert(recordAttachments)
    .values({ recordId, filename: key, displayName: key.split("/").pop()! })
    .returning({ id: recordAttachments.id })
    .get().id;
}

const redeem = (book: EvalBook, token: string, url = `${ORIGIN}/x`) =>
  downloadMcpFile(book.db, book.store, token, new Request(url));

describe("get_attachment", () => {
  it(
    "lists both tools with v1's input names, output keys and descriptions free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "akaun_get_attachment",
        "akaun_get_bank_statement_file",
      ]);
      const [attachment, statement] = tools;
      expect(Object.keys(attachment.inputSchema.properties!).sort()).toEqual([
        "attachmentId",
        "recordId",
      ]);
      expect(Object.keys(statement.inputSchema.properties!)).toEqual([
        "statementId",
      ]);
      expect(Object.keys(attachment.outputSchema!.properties!).sort()).toEqual([
        "attachmentId",
        "downloadUrl",
        "expiresAt",
        "filename",
        "mimeType",
        "recordId",
        "sha256",
        "size",
      ]);
      expect(Object.keys(statement.outputSchema!.properties!).sort()).toEqual([
        "downloadUrl",
        "expiresAt",
        "filename",
        "mimeType",
        "sha256",
        "size",
        "statementId",
      ]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.description!.length).toBeLessThanOrEqual(1500);
        for (const noun of book.manifest.nouns)
          expect(tool.description!.toLowerCase()).not.toContain(
            noun.toLowerCase(),
          );
      }
    },
    SLOW,
  );

  it(
    "returns only signed metadata and downloads exact PDF/image/CSV/unknown bytes once",
    async () => {
      const { book, call } = await open();
      const recordId = recordWithFile(book);
      for (const [name, bytes, mime] of [
        ["photo.png", PNG, "image/png"],
        ["receipt.pdf", PDF, "application/pdf"],
        [
          "export.csv",
          Buffer.from("Date,Amount\n2026-08-01,12.50\n"),
          "text/csv",
        ],
        ["raw.bin", Buffer.from([0, 1, 2, 3]), "application/octet-stream"],
      ] as const) {
        const attachmentId = await attach(
          book,
          recordId,
          `records/${name}`,
          bytes,
        );
        const { result, isError, body } = await call("akaun_get_attachment", {
          recordId,
          attachmentId,
        });
        expect(isError).toBe(false);
        expect(result.content).toHaveLength(1);
        // v1: the structured content is the same object as the text.
        expect(result.structuredContent).toEqual(body);
        expect(Object.keys(body).sort()).toEqual(
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
        expect(body).toMatchObject({
          recordId,
          attachmentId,
          filename: name,
          mimeType: mime,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(
          115_000,
        );
        expect(new URL(body.downloadUrl).origin).toBe(ORIGIN);
        expect(JSON.stringify(result)).not.toContain(book.storageRoot);

        const token = new URL(body.downloadUrl).pathname.split("/").pop()!;
        const responses = await Promise.all(
          [0, 1].map(() => redeem(book, token, body.downloadUrl)),
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
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      }
    },
    SLOW,
  );

  it(
    "rejects expired, tampered, wrong-user, missing-user, revoked-permission and deleted-attachment links",
    async () => {
      const { book, call } = await open();
      const recordId = recordWithFile(book);
      const attachmentId = await attach(
        book,
        recordId,
        "records/private.pdf",
        PDF,
      );
      const { body } = await call("akaun_get_attachment", {
        recordId,
        attachmentId,
      });
      expect(body.attachmentId).toBe(attachmentId);
      const agent = book.agentUserId;
      const claims = {
        userId: agent,
        recordId,
        attachmentId,
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: randomUUID(),
      };
      const token = signFileToken(claims);
      expect(
        (await redeem(book, signFileToken({ ...claims, exp: 1 }))).status,
      ).toBe(410);
      expect((await redeem(book, `${token.slice(0, -2)}xx`)).status).toBe(403);
      // Changing the bound user without signing cannot impersonate another user.
      const [payload, signature] = token.split(".");
      const changed = JSON.parse(Buffer.from(payload, "base64url").toString());
      changed.userId = book.ownerId;
      expect(
        (
          await redeem(
            book,
            `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`,
          )
        ).status,
      ).toBe(403);
      // A user with no grants, and a user that does not exist.
      book.db
        .insert(users)
        .values({
          id: 99,
          email: "nobody@test",
          username: "nobody",
          passwordHash: "unused",
        })
        .run();
      expect(
        (await redeem(book, signFileToken({ ...claims, userId: 99 }))).status,
      ).toBe(403);
      expect(
        (await redeem(book, signFileToken({ ...claims, userId: 999 }))).status,
      ).toBe(403);
      book.db
        .delete(recordAttachments)
        .where(eq(recordAttachments.id, attachmentId))
        .run();
      expect((await redeem(book, token)).status).toBe(404);
    },
    SLOW,
  );

  it(
    "uses RFC 5987 filenames and enforces a separate download budget",
    async () => {
      const { book } = await open();
      const recordId = recordWithFile(book);
      const attachmentId = await attach(
        book,
        recordId,
        "records/named.pdf",
        PDF,
      );
      book.db
        .update(recordAttachments)
        .set({ displayName: "收据\r\n\"'()*.pdf" })
        .where(eq(recordAttachments.id, attachmentId))
        .run();
      const claims = {
        userId: book.agentUserId,
        recordId,
        attachmentId,
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: randomUUID(),
      };
      const response = await redeem(book, signFileToken(claims));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toContain(
        "%E6%94%B6%E6%8D%AE%0D%0A%22%27%28%29%2A.pdf",
      );
      await response.arrayBuffer();
      for (let i = 0; i < 60; i++)
        hit(`mcp-file-download:${book.agentUserId}`, 60, 600_000);
      expect(
        (await redeem(book, signFileToken({ ...claims, jti: randomUUID() })))
          .status,
      ).toBe(403);
    },
    SLOW,
  );

  it("requires a production secret and validates TTL configuration", () => {
    expect(() => fileLinkConfig({ NODE_ENV: "production" })).toThrow();
    expect(() => fileLinkConfig({ MCP_FILE_LINK_TTL_SECONDS: "0" })).toThrow();
    expect(
      fileLinkConfig({
        NODE_ENV: "production",
        MCP_FILE_LINK_SECRET: "s".repeat(32),
        MCP_FILE_LINK_TTL_SECONDS: "30",
      }).ttl,
    ).toBe(30);
  });

  it(
    "refuses a file over the size cap, another record's file and a file outside storage",
    async () => {
      const { book, call } = await open();
      const recordId = recordWithFile(book);
      const otherRecord = book.manifest.records.workspaceAug;
      const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
      PNG.copy(big);
      const large = await attach(book, recordId, "records/big.png", big);
      const other = await attach(book, otherRecord, "records/other.pdf", PDF);
      const outside = book.db
        .insert(recordAttachments)
        .values({
          recordId,
          filename: "/internal/private/receipt.pdf",
          displayName: "Receipt.pdf",
        })
        .returning({ id: recordAttachments.id })
        .get().id;

      const tooLarge = await call("akaun_get_attachment", {
        recordId,
        attachmentId: large,
      });
      expect(tooLarge.isError).toBe(true);
      expect(tooLarge.body.error.code).toBe("OUTPUT_TOO_LARGE");
      expect(tooLarge.body.error.message).toBe("Files over 5 MB are refused.");

      const wrongRecord = await call("akaun_get_attachment", {
        recordId,
        attachmentId: other,
      });
      expect(wrongRecord.body.error.code).toBe("NOT_FOUND");

      const escaped = await call("akaun_get_attachment", {
        recordId,
        attachmentId: outside,
      });
      expect(escaped.body.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(escaped.body)).not.toContain("/internal/private");

      const missing = await call("akaun_get_attachment", {
        recordId: 999_999,
        attachmentId: 1,
      });
      expect(missing.body.error.code).toBe("NOT_FOUND");
    },
    SLOW,
  );

  it(
    "limits how many files one user reads in a window",
    async () => {
      const { book, call } = await open();
      const recordId = recordWithFile(book);
      const pdf = await attach(book, recordId, "records/f.pdf", PDF);
      for (let i = 0; i < ATTACHMENT_READ_LIMIT.max; i++)
        hit(
          `mcp-attachment:${book.agentUserId}`,
          ATTACHMENT_READ_LIMIT.max,
          ATTACHMENT_READ_LIMIT.windowMs,
        );
      const limited = await call("akaun_get_attachment", {
        recordId,
        attachmentId: pdf,
      });
      expect(limited.isError).toBe(true);
      // v1 answered RATE_LIMITED; v2 has no such code, so it is REFUSED with v1's sentence.
      expect(limited.body.error.code).toBe("REFUSED");
      expect(limited.body.error.message).toMatch(/^Too many files read\. /);
    },
    SLOW,
  );

  it(
    "is not offered to a caller who cannot read records, and bad input is INVALID_INPUT",
    async () => {
      const importer = await open(["import.read"]);
      expect(
        (await importer.client.listTools()).tools.map((t) => t.name),
      ).toEqual([]);

      const { call } = await open();
      const bad = await call("akaun_get_attachment", { recordId: "x" });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(
        (
          await call("akaun_get_attachment", {
            recordId: 1,
            attachmentId: 1,
            extra: true,
          })
        ).body.error.code,
      ).toBe("INVALID_INPUT");
    },
    SLOW,
  );
});

describe("get_bank_statement_file", () => {
  async function statementOf(book: EvalBook, bytes: Buffer) {
    const statementId = book.manifest.statements.bank;
    const row = book.db
      .select()
      .from(bankStatements)
      .where(eq(bankStatements.id, statementId))
      .get()!;
    await book.store.put(row.storedFilePath, bytes);
    return { statementId, row };
  }

  it(
    "returns v1's keys and a single-use link to the exact bytes",
    async () => {
      const { book, call } = await open();
      const { statementId, row } = await statementOf(book, PDF);
      const { result, isError, body } = await call(
        "akaun_get_bank_statement_file",
        { statementId },
      );
      expect(isError).toBe(false);
      expect(result.structuredContent).toEqual(body);
      expect(Object.keys(body).sort()).toEqual(
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
      expect(body).toMatchObject({
        statementId,
        filename: row.originalFilename,
        mimeType: "application/pdf",
        size: PDF.length,
        sha256: createHash("sha256").update(PDF).digest("hex"),
      });
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(115_000);
      expect(new URL(body.downloadUrl).origin).toBe(ORIGIN);
      expect(JSON.stringify(result)).not.toContain(book.storageRoot);
      expect(JSON.stringify(result)).not.toContain(row.storedFilePath);

      const token = new URL(body.downloadUrl).pathname.split("/").pop()!;
      const responses = await Promise.all(
        [0, 1].map(() => redeem(book, token, body.downloadUrl)),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);
      const ok = responses.find((r) => r.status === 200)!;
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(PDF);
    },
    SLOW,
  );

  it(
    "refuses a missing statement, a missing file, a file over the cap and an unknown type",
    async () => {
      const { book, call } = await open();
      expect(
        (await call("akaun_get_bank_statement_file", { statementId: 9999 }))
          .body.error.code,
      ).toBe("NOT_FOUND");
      // The row exists, but its file is not in the store.
      const original = book.db
        .select()
        .from(bankStatements)
        .where(eq(bankStatements.id, book.manifest.statements.bank))
        .get()!.storedFilePath;
      book.db
        .update(bankStatements)
        .set({ storedFilePath: "reconciliation/gone.pdf" })
        .where(eq(bankStatements.id, book.manifest.statements.bank))
        .run();
      const absent = await call("akaun_get_bank_statement_file", {
        statementId: book.manifest.statements.bank,
      });
      expect(absent.body.error.code).toBe("NOT_FOUND");
      book.db
        .update(bankStatements)
        .set({ storedFilePath: original })
        .where(eq(bankStatements.id, book.manifest.statements.bank))
        .run();

      const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
      PDF.copy(big);
      const { statementId } = await statementOf(book, big);
      const tooLarge = await call("akaun_get_bank_statement_file", {
        statementId,
      });
      expect(tooLarge.body.error.code).toBe("OUTPUT_TOO_LARGE");
      expect(tooLarge.body.error.message).toContain(
        "akaun_get_bank_reconciliation",
      );

      await statementOf(book, Buffer.from("plain words, no signature"));
      const unknown = await call("akaun_get_bank_statement_file", {
        statementId,
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.body.error.code).toBe("REFUSED");
      expect(unknown.body.error.message).toBe(
        "This file is not a PDF, an image or a spreadsheet.",
      );
    },
    SLOW,
  );

  it(
    "is offered only with reconciliation.read, and a download needs it too",
    async () => {
      const importer = await open(["records.read"]);
      expect(
        (await importer.client.listTools()).tools.map((t) => t.name),
      ).toEqual(["akaun_get_attachment"]);

      const { book, call } = await open();
      const { statementId } = await statementOf(book, PDF);
      expect(
        (
          await call("akaun_get_bank_statement_file", {
            statementId: "S7",
          })
        ).body.error.code,
      ).toBe("INVALID_INPUT");
      const { body } = await call("akaun_get_bank_statement_file", {
        statementId,
      });
      const claims = {
        userId: 99,
        statementId,
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: randomUUID(),
      };
      book.db
        .insert(users)
        .values({
          id: 99,
          email: "nobody@test",
          username: "nobody",
          passwordHash: "unused",
        })
        .run();
      expect(body.statementId).toBe(statementId);
      expect((await redeem(book, signFileToken(claims))).status).toBe(403);
    },
    SLOW,
  );
});
