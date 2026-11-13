import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { DocumentType, ImportState } from "$lib/enums.js";
import { importItems, importQueue } from "../../../db/schema.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import {
  importItemVersion,
  importJobVersion,
} from "../../../application/version.js";
import { fileExists } from "../../../file-storage.js";
import { getRecord } from "../../../queries/ledger.js";
import { importsWriteTools } from "./imports.js";

// Each test builds its own evaluation book in a folder under os.tmpdir(), puts
// staged files under that book's own storage root, and drives the tool
// in-process over InMemoryTransport; nothing here imports db/client.ts and no
// exchange rate is looked up (every document is in the main currency). Also run
// with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/imports.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// Replies are JSON read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Reply = { isError: boolean; body: Loose; text: string };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-e4-imports-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const locals = patLocals(book.db, `Bearer ${token}`)!;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: [], writes: [...importsWriteTools] },
  });
  const client = new Client({ name: "e4-imports-spec", version: "1" });
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
  const call = async (args: Record<string, unknown>): Promise<Reply> => {
    const result = await client.callTool({
      name: "akaun_review_imports",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  return { book, client, call };
}

const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

const receiptId = "5f0c9a52-6f5e-4c1e-9d38-3e1e0b7c2a11";
const secondId = "9c3b1e77-0a2d-4b58-8e61-7d4f2a9b1c33";
const groupId = "7a1d3c44-2b9e-4f10-8c55-0d2e6b9f4a22";
const tempOf = (id: string) => `import/temp/${id}_document.pdf`;

function stage(book: EvalBook, rel: string) {
  const abs = join(book.storageRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "%PDF-1.4 test");
}

/** A single receipt waiting for review, with its staged file. */
function queueReceipt(book: EvalBook, id = receiptId, amount = 12.5) {
  book.db
    .insert(importQueue)
    .values({
      id,
      createdBy: book.ownerId,
      state: ImportState.PendingReview,
      tempFilePath: tempOf(id),
      originalFilename: "document.pdf",
      documentType: DocumentType.Expense,
      itemName: "Whiteboard markers",
      supplier: "Marker Warehouse Sdn Bhd",
      date: "2026-10-14",
      amount,
      currency: "MYR",
      extractedText: "RECEIPT 12.50",
      processedAt: "2026-10-14T10:00:00.000Z",
    })
    .run();
  stage(book, tempOf(id));
}

/** A grouped document with `n` waiting items. */
function queueGroup(book: EvalBook, n = 3): string[] {
  const m = book.manifest;
  book.db
    .insert(importQueue)
    .values({
      id: groupId,
      createdBy: book.ownerId,
      state: ImportState.Grouped,
      tempFilePath: tempOf(groupId),
      originalFilename: "fees.pdf",
      date: "2026-10-31",
      supplier: "Parcel Hub Sdn Bhd",
      currency: "MYR",
    })
    .run();
  stage(book, tempOf(groupId));
  const ids: string[] = [];
  for (let position = 0; position < n; position++) {
    const id = `item-${position}`;
    ids.push(id);
    book.db
      .insert(importItems)
      .values({
        id,
        jobId: groupId,
        state: ImportState.PendingReview,
        position,
        sourceLine: 10 + position,
        sectionKey: "items",
        documentType: DocumentType.Expense,
        itemName: `Handling fee ${position + 1}`,
        supplier: "Parcel Hub Sdn Bhd",
        date: `2026-10-${String(10 + position).padStart(2, "0")}`,
        amount: 7.3 + position,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: m.accounts.postage,
        accountId: m.accounts.bank,
      })
      .run();
  }
  return ids;
}

const jobState = (book: EvalBook, id: string) =>
  book.db.select().from(importQueue).where(eq(importQueue.id, id)).get()?.state;

describe("review_imports", () => {
  it(
    "is listed, destructive and open-world, with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const mine = tools.find((t) => t.name === "akaun_review_imports");
      expect(mine).toBeDefined();
      expect(mine!.description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(mine!.description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
      expect(mine!.annotations?.destructiveHint).toBe(true);
      expect(mine!.annotations?.openWorldHint).toBe(true);
    },
    SLOW,
  );

  it(
    "confirms a prepared receipt: a dry run leaves the staged file, a save makes the record and moves it",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      queueReceipt(book);
      const input = {
        job: receiptId,
        expected_version: importJobVersion(book.db, receiptId),
        overrides: {
          account: m.accounts.bank,
          category: m.accounts.officeSupplies,
        },
      };
      const records = count(book, "ledger_records");

      const dry = await call({ confirm: [input], dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      expect(dry.body.items[0]).toMatchObject({
        action: "confirm",
        job: receiptId,
        file: "document.pdf",
      });
      expect(dry.body.items[0].record.no).toBeTruthy();
      // Nothing happened: no record, the job still waits, the file stays staged.
      expect(count(book, "ledger_records")).toBe(records);
      expect(jobState(book, receiptId)).toBe(ImportState.PendingReview);
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(true);

      const saved = await call({ confirm: [input] });
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.request_id).toBeTruthy();
      const out = saved.body.items[0];
      expect(out.job).toBe(receiptId);
      expect(typeof out.record.v).toBe("string");
      expect(count(book, "ledger_records")).toBe(records + 1);
      expect(jobState(book, receiptId)).toBe(ImportState.Imported);
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(false);
      const made = getRecord(book.db, out.record.id)!;
      expect(made).toMatchObject({
        description: "Whiteboard markers",
        amountMinor: 1250,
      });
      expect(made.movements.map((x) => x.accountId)).toContain(
        m.accounts.officeSupplies,
      );
      expect(JSON.stringify(saved.body)).not.toMatch(
        /"[a-zA-Z_]*(movement|settlement)[a-zA-Z_]*"\s*:/i,
      );
    },
    SLOW,
  );

  it(
    "confirms with only import.confirm: no records.create is asked (006 FR-045)",
    async () => {
      const { book, call } = await open(["import.confirm"]);
      queueReceipt(book);
      const confirmed = await call({
        confirm: [
          {
            job: receiptId,
            expected_version: importJobVersion(book.db, receiptId),
          },
        ],
      });
      expect(confirmed.isError).toBe(false);
      expect(confirmed.body.saved).toBe(true);
      expect(jobState(book, receiptId)).toBe(ImportState.Imported);

      // The same token may not discard: that is import.delete.
      queueReceipt(book, secondId);
      const discard = await call({
        discard: [
          {
            job: secondId,
            expected_version: importJobVersion(book.db, secondId),
          },
        ],
      });
      expect(discard.isError).toBe(true);
      expect(discard.body.error.code).toBe("FORBIDDEN");
      expect(discard.body.error.message).toContain("import.delete");
      expect(jobState(book, secondId)).toBe(ImportState.PendingReview);
    },
    SLOW,
  );

  it(
    "corrects an item, confirms some of a grouped document, then skips the rest",
    async () => {
      const { book, call } = await open();
      const ids = queueGroup(book);
      const records = count(book, "ledger_records");

      const dryUpdate = await call({
        update_item: [
          {
            job: groupId,
            item: ids[0],
            expected_version: importItemVersion(book.db, ids[0]),
            set: { description: "Handling fee, corrected", amount: "9.90" },
          },
        ],
        dry_run: true,
      });
      expect(dryUpdate.isError).toBe(false);
      expect(
        book.db
          .select({ name: importItems.itemName })
          .from(importItems)
          .where(eq(importItems.id, ids[0]))
          .get()?.name,
      ).toBe("Handling fee 1");

      const updated = await call({
        update_item: [
          {
            job: groupId,
            item: ids[0],
            expected_version: importItemVersion(book.db, ids[0]),
            set: { description: "Handling fee, corrected", amount: "9.90" },
          },
        ],
      });
      expect(updated.isError).toBe(false);
      expect(updated.body.items[0]).toMatchObject({
        action: "update_item",
        job: groupId,
        item: {
          id: ids[0],
          state: "pending_review",
          kind: "expense",
          description: "Handling fee, corrected",
          amount: "9.90",
          currency: "MYR",
        },
      });
      expect(updated.body.items[0].v).toBe(importItemVersion(book.db, ids[0]));

      const dry = await call({
        confirm: [
          {
            job: groupId,
            items: [ids[0], ids[1]],
            expected_version: importJobVersion(book.db, groupId),
          },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.items[0]).toMatchObject({
        confirmed: 2,
        not_confirmed: 0,
      });
      expect(count(book, "ledger_records")).toBe(records);
      expect(fileExists(tempOf(groupId), book.storageRoot)).toBe(true);

      const confirmed = await call({
        confirm: [
          {
            job: groupId,
            items: [ids[0], ids[1], "no-such-item"],
            expected_version: importJobVersion(book.db, groupId),
          },
        ],
      });
      expect(confirmed.isError).toBe(false);
      const out = confirmed.body.items[0];
      // The books refuse nothing here, but an item that is not part of the
      // document is reported on its own while the others are saved.
      expect(out.confirmed).toBe(2);
      expect(out.not_confirmed).toBe(1);
      expect(out.items.map((i: Loose) => [i.item, i.ok])).toEqual([
        ["no-such-item", false],
        [ids[0], true],
        [ids[1], true],
      ]);
      expect(out.items[1].record.no).toBeTruthy();
      expect(count(book, "ledger_records")).toBe(records + 2);
      expect(getRecord(book.db, out.items[1].record.id)!.description).toBe(
        "Handling fee, corrected",
      );

      const skipped = await call({
        skip: [
          {
            job: groupId,
            items: [ids[2]],
            expected_version: importJobVersion(book.db, groupId),
          },
        ],
      });
      expect(skipped.isError).toBe(false);
      expect(skipped.body.items[0].items).toEqual([{ item: ids[2], ok: true }]);
      expect(count(book, "ledger_records")).toBe(records + 2);
    },
    SLOW,
  );

  it(
    "skips and discards a receipt: the staged file goes only when the call saves",
    async () => {
      const { book, call } = await open();
      queueReceipt(book);
      queueReceipt(book, secondId, 30);

      const dry = await call({
        skip: [
          {
            job: receiptId,
            expected_version: importJobVersion(book.db, receiptId),
          },
        ],
        discard: [
          {
            job: secondId,
            expected_version: importJobVersion(book.db, secondId),
          },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.saved).toBe(false);
      expect(jobState(book, receiptId)).toBe(ImportState.PendingReview);
      expect(jobState(book, secondId)).toBe(ImportState.PendingReview);
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(true);
      expect(fileExists(tempOf(secondId), book.storageRoot)).toBe(true);

      const saved = await call({
        skip: [
          {
            job: receiptId,
            expected_version: importJobVersion(book.db, receiptId),
          },
        ],
        discard: [
          {
            job: secondId,
            expected_version: importJobVersion(book.db, secondId),
          },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(saved.body.items.map((i: Loose) => i.action)).toEqual([
        "skip",
        "discard",
      ]);
      expect(saved.body.items[0]).toMatchObject({
        job: receiptId,
        state: "skipped",
      });
      expect(saved.body.items[1]).toMatchObject({
        job: secondId,
        discarded: true,
      });
      expect(jobState(book, receiptId)).toBe(ImportState.Skipped);
      expect(jobState(book, secondId)).toBeUndefined();
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(false);
      expect(fileExists(tempOf(secondId), book.storageRoot)).toBe(false);
    },
    SLOW,
  );

  it(
    "refuses bad input and references that do not resolve, all at once",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      queueReceipt(book);
      const version = importJobVersion(book.db, receiptId);

      const badKind = await call({
        confirm: [
          {
            job: receiptId,
            expected_version: version,
            overrides: { kind: "refund" },
          },
        ],
      });
      expect(badKind.isError).toBe(true);
      expect(badKind.body.error.code).toBe("INVALID_INPUT");
      expect(badKind.body.error.issues[0].path).toBe(
        "confirm[0].overrides.kind",
      );

      const nothing = await call({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");

      const missing = await call({
        confirm: [
          { job: "no-such-job", expected_version: "x" },
          {
            job: receiptId,
            expected_version: version,
            overrides: {
              category: "No such category",
              account: m.accounts.travel,
            },
          },
        ],
        update_item: [
          { job: receiptId, item: "ghost", expected_version: "x", set: {} },
        ],
      });
      expect(missing.isError).toBe(true);
      expect(
        missing.body.error.errors.map((e: Loose) => [e.code, e.path]),
      ).toEqual([
        ["NOT_FOUND", "update_item[0].item"],
        ["NOT_FOUND", "confirm[0].job"],
        ["NOT_FOUND", "confirm[1].overrides.category"],
        ["NOT_FOUND", "confirm[1].overrides.account"],
      ]);
      expect(missing.body.error.errors[1].candidates[0].id).toBe(receiptId);

      const both = await call({
        confirm: [
          {
            job: receiptId,
            items: ["a"],
            all: true,
            expected_version: version,
          },
        ],
      });
      expect(both.body.error.code).toBe("INVALID_INPUT");
      expect(both.body.error.path).toBe("confirm[0]");

      const twice = await call({
        confirm: [{ job: receiptId, expected_version: version }],
        skip: [{ job: receiptId, expected_version: version }],
      });
      expect(twice.body.error.code).toBe("INVALID_INPUT");
      expect(twice.body.error.path).toBe("skip[0]");
      expect(jobState(book, receiptId)).toBe(ImportState.PendingReview);
    },
    SLOW,
  );

  it(
    "answers CONFLICT with the current version for a stale job version",
    async () => {
      const { book, call } = await open();
      queueReceipt(book);
      const version = importJobVersion(book.db, receiptId);
      book.db
        .update(importQueue)
        .set({ supplier: "Changed in another tab" })
        .where(eq(importQueue.id, receiptId))
        .run();

      const confirm = await call({
        confirm: [{ job: receiptId, expected_version: version }],
      });
      expect(confirm.isError).toBe(true);
      expect(confirm.body.error.code).toBe("CONFLICT");
      expect(confirm.body.error.items[0].error.current_version).toBe(
        importJobVersion(book.db, receiptId),
      );

      const skip = await call({
        skip: [{ job: receiptId, expected_version: version }],
      });
      expect(skip.body.error.code).toBe("CONFLICT");
      expect(skip.body.error.items[0].error.current_version).toBe(
        importJobVersion(book.db, receiptId),
      );
      expect(jobState(book, receiptId)).toBe(ImportState.PendingReview);
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(true);
    },
    SLOW,
  );

  it(
    "refuses an action the token lacks, naming what to grant",
    async () => {
      const { book, call } = await open(["import.update"]);
      queueReceipt(book);
      const denied = await call({
        confirm: [
          {
            job: receiptId,
            expected_version: importJobVersion(book.db, receiptId),
          },
        ],
      });
      expect(denied.isError).toBe(true);
      expect(denied.body.error.code).toBe("FORBIDDEN");
      expect(denied.body.error.message).toContain("import.confirm");
      expect(jobState(book, receiptId)).toBe(ImportState.PendingReview);
      expect(fileExists(tempOf(receiptId), book.storageRoot)).toBe(true);
    },
    SLOW,
  );
});
