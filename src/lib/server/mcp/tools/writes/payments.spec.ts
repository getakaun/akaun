import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken, localsFor } from "../../../permissions/test-locals.js";
import { createRecord } from "../../../application/records.js";
import { preparePaymentCorrection } from "../../../application/payment-corrections.js";
import { resolvePaymentMovement } from "../../../application/refs.js";
import type { AppContext } from "../../../application/context.js";
import { getRecord } from "../../../queries/ledger.js";
import { paymentsWriteTools } from "./payments.js";
import { bankWriteTools } from "./bank.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tools in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/payments.spec.ts

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
  const dir = mkdtempSync(join(tmpdir(), "akaun-e2-payments-"));
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
    tools: { reads: [], writes: [...paymentsWriteTools, ...bankWriteTools] },
  });
  const client = new Client({ name: "e2-payments-spec", version: "1" });
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
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  const owner: AppContext = {
    db: book.db,
    locals: localsFor([], { superuser: true, userId: book.ownerId }),
  };
  return { book, client, call, replies, owner };
}

const no = (book: EvalBook, id: number) =>
  getRecord(book.db, id)!.recordNumber!;
const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

/** Every key in a reply, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

function noInternalIds(replies: string[]) {
  for (const text of replies) {
    const keys = [...keysOf(JSON.parse(text))];
    expect(keys.filter((k) => /movement|settlement/i.test(k))).toEqual([]);
  }
}

/** The payment's allocation version, as a read would show it. */
function allocationsVersion(ctx: AppContext, paymentRecordId: number) {
  const line = resolvePaymentMovement(ctx, paymentRecordId);
  if (!line.ok) throw new Error(line.message);
  const prepared = preparePaymentCorrection(ctx, line.value.movementId);
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.value.version;
}

describe("record_payments and change_allocations", () => {
  it(
    "lists both tools with short descriptions free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const mine = tools.filter((t) =>
        ["akaun_record_payments", "akaun_change_allocations"].includes(t.name),
      );
      expect(mine.map((t) => t.name)).toEqual([
        "akaun_record_payments",
        "akaun_change_allocations",
      ]);
      for (const tool of mine) {
        expect(tool.description!.length).toBeLessThanOrEqual(1500);
        for (const noun of book.manifest.nouns)
          expect(tool.description!.toLowerCase()).not.toContain(
            noun.toLowerCase(),
          );
      }
      expect(mine[0].annotations?.destructiveHint).toBe(false);
      expect(mine[1].annotations?.destructiveHint).toBe(true);
    },
    SLOW,
  );

  it(
    "pays a bill by its number, inferring the direction; outstanding goes to 0",
    async () => {
      const { book, call, replies } = await open();
      const m = book.manifest;
      const bill = getRecord(book.db, m.records.spotify)!;
      const before = count(book, "ledger_records");

      const dry = await call("akaun_record_payments", {
        pay: [
          {
            contact: bill.contactId,
            account: m.accounts.bank,
            date: "2026-10-01",
            amount: "17.90",
            allocate: [{ record: bill.recordNumber }],
          },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.saved).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      expect(dry.body.items[0].allocated[0].outstanding_after).toBe("0.00");
      expect(count(book, "ledger_records")).toBe(before);
      expect(getRecord(book.db, bill.id)!.paid).toBe(false);

      const saved = await call("akaun_record_payments", {
        pay: [
          {
            contact: bill.contactId,
            account: m.accounts.bank,
            date: "2026-10-01",
            amount: "17.90",
            allocate: [{ record: bill.recordNumber }],
            reference: "card statement",
          },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.request_id).toBeTruthy();
      const item = saved.body.items[0];
      expect(item).toMatchObject({
        n: 1,
        action: "pay",
        direction: "we_pay",
        currency: "MYR",
        unapplied: "0.00",
        allocated: [
          {
            id: bill.id,
            no: bill.recordNumber,
            amount: "17.90",
            outstanding_before: "17.90",
            outstanding_after: "0.00",
          },
        ],
      });
      expect(item.payment).toMatchObject({
        amount: "17.90",
        date: "2026-10-01",
      });
      expect(typeof item.payment.v).toBe("string");
      expect(typeof item.payment.allocations_v).toBe("string");
      expect(count(book, "ledger_records")).toBe(before + 1);
      expect(getRecord(book.db, bill.id)!.paid).toBe(true);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "refuses bad input, unknown records and an ambiguous direction",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const bad = await call("akaun_record_payments", {
        pay: [
          {
            contact: 1,
            account: m.accounts.bank,
            date: "2026-10-01",
            amount: "twelve",
          },
        ],
      });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(bad.body.error.issues[0].path).toBe("pay[0].amount");

      const missing = await call("akaun_record_payments", {
        pay: [
          {
            contact: getRecord(book.db, m.records.spotify)!.contactId,
            account: m.accounts.bank,
            date: "2026-10-01",
            amount: "17.90",
            allocate: [{ record: "EX20260905-009" }],
          },
        ],
      });
      expect(missing.body.error.code).toBe("NOT_FOUND");
      expect(missing.body.error.path).toBe("pay[0].allocate[0].record");
      expect(
        missing.body.error.candidates.map((c: { name: string }) => c.name),
      ).toContain(no(book, m.records.spotify));

      const noDirection = await call("akaun_record_payments", {
        pay: [
          {
            contact: getRecord(book.db, m.records.spotify)!.contactId,
            account: m.accounts.bank,
            date: "2026-10-01",
            amount: "17.90",
          },
        ],
      });
      expect(noDirection.body.error.code).toBe("INVALID_INPUT");
      expect(noDirection.body.error.path).toBe("pay[0].direction");

      const nothing = await call("akaun_record_payments", {});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "applies an existing credit to an open bill and reports what is left",
    async () => {
      const { book, call, owner, replies } = await open();
      const m = book.manifest;
      const credit = m.plants.freightLeftOut;
      const bill = createRecord(owner, {
        kind: "expense",
        date: "2026-10-02",
        description: "Packing materials",
        amount: 50,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: m.accounts.packaging,
        paidFromAccountId: null,
        contactId: credit.supplier,
      });
      if (!bill.ok) throw new Error(bill.reason);

      const saved = await call("akaun_record_payments", {
        allocate: [
          {
            payment: no(book, credit.payment),
            to: [{ record: bill.value.record.recordNumber }],
          },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(saved.body.items[0]).toMatchObject({
        action: "allocate",
        unapplied_before: "85.00",
        unapplied: "35.00",
        allocated: [
          {
            no: bill.value.record.recordNumber,
            amount: "50.00",
            outstanding_before: "50.00",
            outstanding_after: "0.00",
          },
        ],
      });
      expect(getRecord(book.db, bill.value.record.id)!.paid).toBe(true);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "repays a person for an expense they paid personally",
    async () => {
      const { book, call, replies } = await open();
      const m = book.manifest;
      const claim = getRecord(book.db, m.plants.doubleClaims.unpaidCopy)!;
      const saved = await call("akaun_record_payments", {
        reimburse: [
          {
            contact: claim.contactId,
            date: "2026-10-03",
            description: "Repay team lunch",
            items: [claim.recordNumber],
            cash: "86.40",
            paid_from: m.accounts.bank,
          },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(saved.body.items[0]).toMatchObject({
        total: "86.40",
        not_yet_repaid: "0.00",
        items: [{ id: claim.id, outstanding_after: "0.00" }],
      });
      expect(saved.body.items[0].payment.amount).toBe("86.40");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "moves a misallocated payment to the bill it names, keeping the reversed row",
    async () => {
      const { book, call, owner, replies } = await open();
      const plant = book.manifest.plants.misallocatedPayment;
      const payment = no(book, plant.payment);
      const intended = no(book, plant.intendedBill);
      const allocated = no(book, plant.allocatedBill);
      const version = allocationsVersion(owner, plant.payment);
      const rows = count(book, "settlements");
      const args = {
        reallocate: [
          {
            payment,
            expected_version: version,
            remove: [allocated],
            add: [{ record: intended }],
            reason: `The payment reference names ${plant.reference}.`,
          },
        ],
      };

      const dry = await call("akaun_change_allocations", {
        ...args,
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      expect(getRecord(book.db, plant.intendedBill)!.paid).toBe(false);
      expect(getRecord(book.db, plant.allocatedBill)!.paid).toBe(true);
      expect(count(book, "settlements")).toBe(rows);

      const saved = await call("akaun_change_allocations", args);
      expect(saved.isError).toBe(false);
      const item = saved.body.items[0];
      expect(item.reversed).toEqual([
        { id: plant.allocatedBill, no: allocated, amount: "640.00" },
      ]);
      expect(item.added).toEqual([
        { id: plant.intendedBill, no: intended, amount: "640.00" },
      ]);
      expect(item.records).toEqual([
        {
          id: plant.allocatedBill,
          no: allocated,
          outstanding_before: "0.00",
          outstanding_after: "640.00",
        },
        {
          id: plant.intendedBill,
          no: intended,
          outstanding_before: "640.00",
          outstanding_after: "0.00",
        },
      ]);
      expect(item.unapplied).toBe("0.00");
      expect(item.payment.allocations_v).toBe(
        allocationsVersion(owner, plant.payment),
      );
      expect(getRecord(book.db, plant.intendedBill)!.paid).toBe(true);
      expect(getRecord(book.db, plant.allocatedBill)!.paid).toBe(false);
      // The reversed allocation is kept, marked reversed.
      expect(count(book, "settlements")).toBe(rows + 1);
      expect(
        (
          book.raw
            .query(
              "SELECT COUNT(*) AS n FROM settlements WHERE reversed_at IS NOT NULL",
            )
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(0);

      // The version read before the move is now stale.
      const stale = await call("akaun_change_allocations", {
        reallocate: [
          {
            payment,
            expected_version: version,
            remove: [intended],
            add: [{ record: allocated }],
            reason: "Moving it back with an old version.",
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(
        item.payment.allocations_v,
      );
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "names a record the payment does not settle, with the ones it does",
    async () => {
      const { book, call, owner } = await open();
      const plant = book.manifest.plants.misallocatedPayment;
      const reply = await call("akaun_change_allocations", {
        reallocate: [
          {
            payment: no(book, plant.payment),
            expected_version: allocationsVersion(owner, plant.payment),
            remove: [no(book, plant.intendedBill)],
            reason: "Testing a removal that does not exist.",
          },
        ],
      });
      expect(reply.body.error.code).toBe("NOT_FOUND");
      expect(reply.body.error.path).toBe("reallocate[0].remove[0]");
      expect(reply.body.error.candidates[0].id).toBe(plant.allocatedBill);

      const short = await call("akaun_change_allocations", {
        reallocate: [
          {
            payment: no(book, plant.payment),
            expected_version: "x",
            remove: [no(book, plant.allocatedBill)],
            reason: "short",
          },
        ],
      });
      expect(short.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "hides the tools from a token without the abilities",
    async () => {
      const { client, call } = await open(["records.read", "records.create"]);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("akaun_record_payments");
      expect(names).not.toContain("akaun_change_allocations");
      await expect(
        call("akaun_change_allocations", {
          reallocate: [
            {
              payment: 1,
              expected_version: "x",
              remove: [2],
              reason: "Testing a token that may not correct.",
            },
          ],
        }),
      ).rejects.toThrow(/not found/);

      const { client: readOnly } = await open(["records.read"]);
      const listed = (await readOnly.listTools()).tools.map((t) => t.name);
      expect(listed).not.toContain("akaun_record_payments");
    },
    SLOW,
  );
});
