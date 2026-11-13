import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DocumentType, ImportState } from "$lib/enums.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { importItems, importQueue } from "../../../db/schema.js";
import {
  importItemVersion,
  importJobVersion,
} from "../../../application/version.js";
import { getRecord } from "../../../queries/ledger.js";
import { importsReadTools } from "./imports.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tool in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/imports.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

const FAILED = "00000000-0000-4000-8000-000000000001";
const PENDING = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Three jobs: a failed duplicate, one waiting for review, and a document read as two items. */
function plant(book: EvalBook) {
  const duplicate = book.manifest.records.nandosClaimed;
  const supplier = book.manifest.contacts.canva;
  const base = {
    createdBy: book.ownerId,
    tempFilePath: "/internal/private/import.pdf",
  };
  book.db
    .insert(importQueue)
    .values([
      {
        ...base,
        id: FAILED,
        originalFilename: "invoice.pdf",
        state: ImportState.Failed,
        itemName: "Software",
        date: "2026-08-31",
        amount: 1285.5,
        currency: "MYR",
        createdAt: "2026-09-05 10:00:00",
        error: "Provider error with secret and /internal/private/trace",
        extractedText: `Receipt text. ${"x".repeat(6500)}`,
        duplicateOf: duplicate,
        duplicateConfidence: 95,
        duplicateReasons: JSON.stringify(["reference"]),
        matchedContactId: supplier,
        matchCandidates: JSON.stringify([
          { id: supplier, legalName: "Canva Pty Ltd", score: 90 },
        ]),
      },
      {
        ...base,
        id: PENDING,
        originalFilename: "receipt.png",
        state: ImportState.PendingReview,
        itemName: "Taxi",
        date: "2026-09-06",
        amount: 12,
        currency: "USD",
        createdAt: "2026-09-06 09:00:00",
        documentType: DocumentType.Expense,
      },
      {
        ...base,
        id: GROUP,
        originalFilename: "settlement.xlsx",
        state: ImportState.Grouped,
        createdAt: "2026-09-07 09:00:00",
      },
    ])
    .run();
  book.db
    .insert(importItems)
    .values(
      [1, 2].map((n) => ({
        id: `00000000-0000-4000-8000-0000000001${n}0`,
        jobId: GROUP,
        position: n - 1,
        sectionKey: "main",
        state: ImportState.PendingReview,
        itemName: `Fee ${n}`,
        date: "2026-09-07",
        amount: n * 10,
        currency: "MYR",
        documentType: DocumentType.Expense,
        reviewNote: n === 2 ? "Check the category" : null,
      })),
    )
    .run();
}

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-imports-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  plant(book);
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: importsReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-imports-spec", version: "1" });
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
  const replies: string[] = [];
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "akaun_get_import_queue",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Loose,
      text,
    };
  };
  return { book, client, call, replies };
}

describe("get_import_queue", () => {
  it(
    "is one read-only tool with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["akaun_get_import_queue"]);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      expect(tools[0].description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tools[0].description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
    },
    SLOW,
  );

  it(
    "lists the queue newest first with versions, duplicates and no internal paths or raw errors",
    async () => {
      const { book, call, replies } = await open();
      const { isError, body } = await call({});
      expect(isError).toBe(false);
      expect(body.total).toBe(3);
      expect(body.jobs.map((j: Loose) => j.job)).toEqual([
        GROUP,
        PENDING,
        FAILED,
      ]);
      const failed = body.jobs.find((j: Loose) => j.job === FAILED);
      const number = getRecord(
        book.db,
        book.manifest.records.nandosClaimed,
      )!.recordNumber;
      expect(failed).toMatchObject({
        state: "failed",
        file: "invoice.pdf",
        description: "Software",
        amount: "1285.50",
        error: true,
        v: importJobVersion(book.db, FAILED),
      });
      expect(failed.duplicate_of).toEqual({
        id: book.manifest.records.nandosClaimed,
        no: number,
        confidence: 95,
        reasons: ["reference"],
      });
      // A document in another currency carries its own.
      const pending = body.jobs.find((j: Loose) => j.job === PENDING);
      expect(pending).toMatchObject({
        state: "pending_review",
        amount: "12.00",
        currency: "USD",
      });
      for (const text of replies) {
        expect(text).not.toContain("/internal/private");
        expect(text).not.toContain("secret");
        expect(text).not.toContain("tempFilePath");
      }
    },
    SLOW,
  );

  it(
    "filters by state and by duplicates, and pages",
    async () => {
      const { call } = await open();
      const waiting = await call({ states: ["pending_review", "grouped"] });
      expect(waiting.body.jobs.map((j: Loose) => j.job)).toEqual([
        GROUP,
        PENDING,
      ]);
      const dupes = await call({ duplicates_only: true });
      expect(dupes.body.jobs.map((j: Loose) => j.job)).toEqual([FAILED]);
      const first = await call({ limit: 2 });
      expect(first.body.jobs).toHaveLength(2);
      expect(first.body.note).toMatch(/^Showing 1–2 of 3/);
      const second = await call({ limit: 2, cursor: first.body.next_cursor });
      expect(second.body.jobs.map((j: Loose) => j.job)).toEqual([FAILED]);
      const wrong = await call({
        limit: 2,
        duplicates_only: true,
        cursor: first.body.next_cursor,
      });
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "reads one job with candidates and its match, and shows its text only on request",
    async () => {
      const { book, call, replies } = await open();
      const { body } = await call({ job: FAILED });
      expect(body.currency).toBe("MYR");
      expect(body.job).toMatchObject({
        job: FAILED,
        state: "failed",
        contact: { id: book.manifest.contacts.canva },
        candidates: [
          {
            id: book.manifest.contacts.canva,
            name: "Canva Pty Ltd",
            score: 90,
          },
        ],
        v: importJobVersion(book.db, FAILED),
      });
      expect(body.job.contact.name).toBeTypeOf("string");
      expect(body.job.error).toMatch(/^Processing failed; raw server/);
      expect(body.evidence).toBeUndefined();
      expect(body.items).toBeUndefined();

      const full = await call({ job: FAILED, detail: "full" });
      expect(full.body.evidence.text.length).toBe(6000);
      expect(full.body.evidence.truncated).toBe(true);
      expect(full.body.evidence.warning).toMatch(/untrusted/);
      for (const text of replies)
        expect(text).not.toContain("/internal/private");
    },
    SLOW,
  );

  it(
    "reads a grouped job's items with their own versions, and pages them",
    async () => {
      const { book, call } = await open();
      const { body } = await call({ job: GROUP });
      expect(body.job.state).toBe("grouped");
      expect(body.items).toHaveLength(2);
      const [one, two] = body.items;
      expect(one).toMatchObject({
        n: 1,
        description: "Fee 1",
        amount: "10.00",
      });
      expect(one.v).toBe(importItemVersion(book.db, one.item));
      expect(two).toMatchObject({ n: 2, note: "Check the category" });
      expect(body.total).toBe(2);

      const first = await call({ job: GROUP, limit: 1 });
      expect(first.body.items).toHaveLength(1);
      expect(first.body.next_cursor).toBeTypeOf("string");
      const next = await call({
        job: GROUP,
        limit: 1,
        cursor: first.body.next_cursor,
      });
      expect(next.body.items[0].n).toBe(2);
    },
    SLOW,
  );

  it(
    "answers NOT_FOUND and INVALID_INPUT with a fix, and is offered only with import read",
    async () => {
      const { call } = await open();
      const missing = await call({
        job: "00000000-0000-4000-8000-0000000000ff",
      });
      expect(missing.isError).toBe(true);
      expect(missing.body.error.code).toBe("NOT_FOUND");
      expect(missing.body.error.fix).toContain("akaun_get_import_queue");
      const bad = await call({ states: ["finished"] });
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(bad.body.error.issues)).toContain("pending_review");
      expect((await call({ extra: 1 })).body.error.code).toBe("INVALID_INPUT");

      const records = await open(["records.read"]);
      expect((await records.client.listTools()).tools).toEqual([]);
    },
    SLOW,
  );
});
