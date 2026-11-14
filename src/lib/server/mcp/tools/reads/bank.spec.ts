import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { bankStatementLines } from "../../../db/schema.js";
import { statementLineVersion } from "../../../application/version.js";
import {
  findRecordMovementOnAccount,
  insertAllocation,
} from "../../../queries/reconciliation.js";
import { getRecord } from "../../../queries/ledger.js";
import { bankReadTools } from "./bank.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tool in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/bank.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-bank-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: bankReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-bank-spec", version: "1" });
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
      name: "akaun_get_bank_reconciliation",
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

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

const noInternalIds = (replies: string[]) => {
  for (const text of replies)
    expect(
      [...keysOf(JSON.parse(text))].filter((k) =>
        /movement|settlement/i.test(k),
      ),
    ).toEqual([]);
};

const plants = (book: EvalBook) => book.manifest.plants.bankStatement;
const lineOf = (body: Loose, id: number) =>
  body.unmatched_lines.find((l: Loose) => l.line === `L${id}`);

/** Matches a line to a record in full, as the app would. */
function matchInFull(book: EvalBook, lineId: number, recordId: number) {
  const { account } = plants(book);
  const movement = findRecordMovementOnAccount(book.db, recordId, account)!;
  const line = book.db
    .select()
    .from(bankStatementLines)
    .all()
    .find((l) => l.id === lineId)!;
  insertAllocation(book.db, {
    lineId,
    movementId: movement.id,
    amount: line.amount,
    itemAmountSnapshot: line.amount,
    createdBy: book.ownerId,
  });
}

describe("get_bank_reconciliation", () => {
  it(
    "is one read-only tool with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "akaun_get_bank_reconciliation",
      ]);
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
    "lists the statement and every unmatched line with a version and ranked candidates",
    async () => {
      const { book, call, replies } = await open();
      const p = plants(book);
      const { isError, body } = await call({ statement: `S${p.statement}` });
      expect(isError).toBe(false);
      expect(body.currency).toBe("MYR");
      expect(body.statements).toHaveLength(1);
      expect(body.statements[0]).toMatchObject({
        statement: `S${p.statement}`,
        lines: body.total,
        matched: 0,
        unmatched: body.total,
      });
      expect(body.statements[0].period).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}/);
      expect(body.unmatched_lines).toHaveLength(body.total);
      for (const line of body.unmatched_lines) {
        expect(line.v).toBe(
          statementLineVersion(book.db, Number(line.line.slice(1))),
        );
        expect(line.direction).toMatch(/^(in|out)$/);
        expect(line.amount).toMatch(/^\d+\.\d{2}$/);
        expect(line.candidates?.length ?? 0).toBeLessThanOrEqual(3);
      }
      // Oldest first.
      const dates = body.unmatched_lines.map((l: Loose) => l.date);
      expect([...dates].sort()).toEqual(dates);

      // A line with exactly one right record offers it first, as an exact amount.
      for (const { line, record } of p.matches) {
        const row = lineOf(body, line);
        expect(row.candidates[0].id, `line L${line}`).toBe(record);
        expect(row.candidates[0].record).toBe(
          getRecord(book.db, record)!.recordNumber,
        );
        expect(row.candidates[0].why).toContain("exact amount");
      }
      // The date gap: two days apart, said so.
      const gap = lineOf(body, p.dateGap.line).candidates[0];
      expect(gap.id).toBe(p.dateGap.record);
      expect(gap.why).toContain(`${p.dateGap.days} days apart`);
      // The decoy pair: each line offers its own record among the candidates.
      for (const { line, record } of p.decoyPair)
        expect(lineOf(body, line).candidates.map((c: Loose) => c.id)).toContain(
          record,
        );
      // A movement the books lack has no candidates.
      for (const { line } of p.noRecord)
        expect(lineOf(body, line).candidates).toBeUndefined();
      expect(body.uncleared_records).toBeDefined();
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "takes the account and a period, and a candidates count",
    async () => {
      const { book, call } = await open();
      const p = plants(book);
      const byAccount = await call({ account: p.account, candidates: 0 });
      expect(byAccount.body.statements.map((s: Loose) => s.statement)).toEqual([
        `S${p.statement}`,
      ]);
      for (const line of byAccount.body.unmatched_lines)
        expect(line.candidates).toBeUndefined();

      const gapLine = lineOf(
        (await call({ statement: p.statement })).body,
        p.dateGap.line,
      );
      const narrow = await call({
        statement: `S${p.statement}`,
        period: gapLine.date,
        candidates: 1,
      });
      expect(
        narrow.body.unmatched_lines.every(
          (l: Loose) => l.date === gapLine.date,
        ),
      ).toBe(true);
      expect(lineOf(narrow.body, p.dateGap.line).candidates).toHaveLength(1);
      const none = await call({ period: "2019" });
      expect(none.body.statements).toBeUndefined();
    },
    SLOW,
  );

  it(
    "flags a line the statement repeats, and stops listing a line once it is matched",
    async () => {
      const { book, call } = await open();
      const p = plants(book);
      const [first] = p.matches;
      const original = book.db
        .select()
        .from(bankStatementLines)
        .all()
        .find((l) => l.id === first.line)!;
      const copy = book.db
        .insert(bankStatementLines)
        .values({
          statementId: original.statementId,
          date: original.date,
          description: original.description,
          amount: original.amount,
          direction: original.direction,
        })
        .returning({ id: bankStatementLines.id })
        .get().id;
      const twice = await call({ statement: p.statement });
      expect(lineOf(twice.body, first.line).duplicate_of).toBe(`L${copy}`);
      expect(lineOf(twice.body, copy).duplicate_of).toBe(`L${first.line}`);
      expect(
        lineOf(twice.body, p.matches[1].line).duplicate_of,
      ).toBeUndefined();

      // Matching the record to the first line clears it from both lists.
      const before = twice.body.uncleared_records.map((r: Loose) => r.id);
      expect(before).toContain(first.record);
      matchInFull(book, first.line, first.record);
      const after = await call({ statement: p.statement, detail: "full" });
      expect(lineOf(after.body, first.line)).toBeUndefined();
      expect(
        after.body.uncleared_records.map((r: Loose) => r.id),
      ).not.toContain(first.record);
      const matched = after.body.matched_lines.find(
        (l: Loose) => l.line === `L${first.line}`,
      );
      expect(matched.matched_to).toEqual([
        {
          record: getRecord(book.db, first.record)!.recordNumber,
          id: first.record,
          amount: matched.amount,
        },
      ]);
      expect(matched.v).toBe(statementLineVersion(book.db, first.line));
      expect(after.body.statements[0].matched).toBe(1);
    },
    SLOW,
  );

  it(
    "pages the unmatched lines with a cursor tied to the filters",
    async () => {
      const { book, call } = await open();
      const p = plants(book);
      const first = await call({ statement: p.statement, limit: 3 });
      expect(first.body.unmatched_lines).toHaveLength(3);
      expect(first.body.note).toMatch(/^Showing 1–3 of /);
      expect(first.body.uncleared_records).toBeDefined();
      const second = await call({
        statement: p.statement,
        limit: 3,
        cursor: first.body.next_cursor,
      });
      expect(second.body.unmatched_lines[0].line).not.toBe(
        first.body.unmatched_lines[0].line,
      );
      // The records not covered are listed once, on the first page.
      expect(second.body.uncleared_records).toBeUndefined();
      const wrong = await call({
        statement: p.statement,
        limit: 3,
        candidates: 1,
        cursor: first.body.next_cursor,
      });
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "answers NOT_FOUND, INVALID_INPUT and is offered only with reconciliation and records read",
    async () => {
      const { book, call } = await open();
      const missingStatement = await call({ statement: "S9999" });
      expect(missingStatement.body.error.code).toBe("NOT_FOUND");
      expect(missingStatement.body.error.path).toBe("statement");
      const wrongKind = await call({ statement: "L1" });
      expect(wrongKind.body.error.code).toBe("NOT_FOUND");
      const missingAccount = await call({ account: "No Such Account" });
      expect(missingAccount.body.error.code).toBe("NOT_FOUND");
      const mismatch = await call({
        statement: plants(book).statement,
        account: book.manifest.accounts.cash,
      });
      expect(mismatch.body.error.code).toBe("INVALID_INPUT");
      expect((await call({ period: "soon" })).body.error.code).toBe(
        "INVALID_INPUT",
      );
      expect((await call({ candidates: 11 })).body.error.code).toBe(
        "INVALID_INPUT",
      );

      const recordsOnly = await open(["records.read"]);
      expect((await recordsOnly.client.listTools()).tools).toEqual([]);
    },
    SLOW,
  );
});
