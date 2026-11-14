import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { StatementDirection, StatementExtractionState } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountEvents, ledgerEvents } from "../ledger/events.js";
import { contactEvents } from "../finance/events.js";
import { reconciliationEvents } from "../reconciliation/events.js";
import { auditEvents } from "../audit-events.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import { createRecord, prepareVoidRecord, voidRecord } from "./records.js";
import { setMovementMatches } from "./reconciliation.js";
import { mergeContacts } from "./contacts.js";

/**
 * W0 nesting spike. The MCP redesign runs several application operations in
 * ONE outer `ctx.db.transaction(...)`. Each operation opens its own
 * `ctx.db.transaction(...)` (some `{ behavior: "immediate" }`); drizzle's
 * bun-sqlite session hands that to `client.transaction(fn)[behavior]()`, and
 * Bun's wrapper uses SAVEPOINT when `inTransaction` is already true. These
 * specs check that, against a migrated in-memory book (`releaseBook`), never
 * `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

const VOID_REASON = "Entered twice by mistake; nesting spike.";
const expenseInput = (bank: number, category: number, amount = 12.5) => ({
  kind: "expense" as const,
  date: "2026-09-02",
  amount,
  currency: "MYR",
  exchangeRate: 1,
  description: "Nesting spike expense",
  categoryAccountId: category,
  paidFromAccountId: bank,
});

function seed() {
  book = releaseBook();
  const { db, ctx, bank, expense } = book;
  const [keep, lose] = ["Keep Sdn Bhd", "Lose Sdn Bhd"].map(
    (legalName) =>
      db
        .insert(schema.contacts)
        .values({ legalName, entityType: 2 })
        .returning()
        .get()!.id,
  );
  const existing = resultValue(
    createRecord(ctx, expenseInput(bank, expense, 40)),
  ).record;
  const statementId = db
    .insert(schema.bankStatements)
    .values({
      originalFilename: "sept.pdf",
      storedFilePath: "reconciliation/sept.pdf",
      extractionState: StatementExtractionState.Ready,
      uploadedBy: 1,
      accountId: bank,
    })
    .returning()
    .get()!.id;
  const lineId = db
    .insert(schema.bankStatementLines)
    .values({
      statementId,
      date: "2026-09-02",
      amount: 12.5,
      direction: StatementDirection.Out,
    })
    .returning()
    .get()!.id;
  return { ...book, keep, lose, existing, lineId };
}

function tableNames(book: Book): string[] {
  return (
    book.raw
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** Row count and an order-independent digest of every row, per table. */
function snapshot(
  book: Book,
): Record<string, { count: number; digest: string }> {
  const out: Record<string, { count: number; digest: string }> = {};
  for (const name of tableNames(book)) {
    const rows = book.raw
      .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) =>
        JSON.stringify(row, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
        ),
      )
      .sort();
    out[name] = {
      count: rows.length,
      digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    };
  }
  return out;
}

const count = (book: Book, table: string) =>
  (
    book.raw.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;

/** Records every event emitted on the emitters these operations use. */
function recordEvents() {
  const emitters: Record<string, EventEmitter> = {
    ledgerEvents,
    accountEvents,
    contactEvents,
    reconciliationEvents,
    auditEvents,
  };
  const fired: string[] = [];
  const restore: (() => void)[] = [];
  for (const [label, emitter] of Object.entries(emitters)) {
    const original = emitter.emit;
    emitter.emit = function (
      this: EventEmitter,
      event: string | symbol,
      ...args: unknown[]
    ) {
      fired.push(`${label}:${String(event)}`);
      return original.call(this, event, ...args);
    } as typeof emitter.emit;
    restore.push(() => {
      emitter.emit = original;
    });
  }
  return { fired, stop: () => restore.forEach((r) => r()) };
}

/** The four operations, each asserted ok and visible inside the transaction. */
function runFour(s: ReturnType<typeof seed>) {
  const { ctx, raw, bank, expense, existing, keep, lose, lineId } = s;
  expect(raw.inTransaction).toBe(true);

  const recordsBefore = count(s, "ledger_records");
  const auditBefore = count(s, "audit_log");
  const created = createRecord(ctx, expenseInput(bank, expense));
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.reason);
  expect(count(s, "ledger_records")).toBe(recordsBefore + 1);
  expect(count(s, "audit_log")).toBeGreaterThan(auditBefore);
  expect(raw.inTransaction).toBe(true);

  const preview = resultValue(prepareVoidRecord(ctx, existing.id));
  const voided = voidRecord(ctx, existing.id, {
    reason: VOID_REASON,
    expectedVersion: preview.version,
  });
  expect(voided.ok).toBe(true);
  if (!voided.ok) throw new Error(voided.reason);
  expect(count(s, "ledger_records")).toBe(recordsBefore + 2);
  expect(raw.inTransaction).toBe(true);

  const bankSide = created.value.record.movements.find(
    (m) => m.accountId === bank,
  )!;
  const allocationsBefore = count(s, "reconciliation_allocations");
  const matched = setMovementMatches(ctx, bankSide.id, [
    { lineId, amount: 12.5 },
  ]);
  expect(matched.ok).toBe(true);
  if (!matched.ok) throw new Error(matched.reason);
  expect(count(s, "reconciliation_allocations")).toBe(allocationsBefore + 1);
  expect(raw.inTransaction).toBe(true);

  const contactsBefore = count(s, "contacts");
  const merged = mergeContacts(ctx, { survivorId: keep, loserIds: [lose] });
  expect(merged.ok).toBe(true);
  if (!merged.ok) throw new Error(merged.reason);
  expect(count(s, "contacts")).toBe(contactsBefore - 1);
  expect(raw.inTransaction).toBe(true);

  return { created: created.value.record };
}

class Sentinel extends Error {}

describe("application operations nest inside one outer transaction", () => {
  it("rolls every table back when the outer callback throws", () => {
    const s = seed();
    const before = snapshot(s);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(["audit_log", "app_sequences"]),
    );
    const events = recordEvents();
    const sentinel = new Sentinel("roll it all back");
    let caught: unknown;
    try {
      s.db.transaction(() => {
        runFour(s);
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    } finally {
      events.stop();
    }
    if (caught !== sentinel) throw caught;
    expect(s.raw.inTransaction).toBe(false);
    expect(snapshot(s)).toEqual(before);
    // Reported, not asserted: events are not yet deferred until commit.
    console.log(
      `[nesting-spike] events fired during the rolled-back run: ${JSON.stringify(events.fired)}`,
    );
  });

  it("commits the same sequence when the outer callback returns", () => {
    const s = seed();
    const before = snapshot(s);
    const { created } = s.db.transaction(() => runFour(s));
    expect(s.raw.inTransaction).toBe(false);
    const after = snapshot(s);
    expect(after.ledger_records.count).toBe(before.ledger_records.count + 2);
    expect(after.reconciliation_allocations.count).toBe(
      before.reconciliation_allocations.count + 1,
    );
    expect(after.contacts.count).toBe(before.contacts.count - 1);
    expect(after.audit_log.count).toBeGreaterThan(before.audit_log.count);
    expect(
      s.raw.query("SELECT 1 FROM ledger_records WHERE id=?").get(created.id),
    ).toBeTruthy();
    const changed = Object.keys(after).filter(
      (t) => after[t].digest !== before[t].digest,
    );
    console.log(
      `[nesting-spike] tables changed by the committed run: ${JSON.stringify(changed)}`,
    );
    if (sequencesBefore(before, after))
      console.log("[nesting-spike] app_sequences changed in the committed run");
  });

  it("keeps the outer transaction usable after an operation refuses", () => {
    const s = seed();
    const { ctx, bank, expense, existing } = s;
    resultValue(
      voidRecord(ctx, existing.id, {
        reason: VOID_REASON,
        expectedVersion: resultValue(prepareVoidRecord(ctx, existing.id))
          .version,
      }),
    );
    const before = snapshot(s);
    const ids = s.db.transaction(() => {
      const first = resultValue(
        createRecord(ctx, expenseInput(bank, expense, 7)),
      );
      const afterFirst = count(s, "ledger_records");

      // Refuses inside its own (immediate) transaction: already voided.
      const again = voidRecord(ctx, existing.id, {
        reason: VOID_REASON,
        expectedVersion: resultValue(prepareVoidRecord(ctx, existing.id))
          .version,
      });
      expect(again.ok).toBe(false);
      expect(s.raw.inTransaction).toBe(true);
      expect(count(s, "ledger_records")).toBe(afterFirst);

      // Writes a record, then throws inside its own transaction to roll it back.
      const dry = createRecord(ctx, expenseInput(bank, expense, 8), {
        dryRun: true,
      });
      expect(dry.ok).toBe(true);
      expect(s.raw.inTransaction).toBe(true);
      expect(count(s, "ledger_records")).toBe(afterFirst);

      const second = resultValue(
        createRecord(ctx, expenseInput(bank, expense, 9)),
      );
      return [first.record.id, second.record.id];
    });
    expect(s.raw.inTransaction).toBe(false);
    const after = snapshot(s);
    expect(after.ledger_records.count).toBe(before.ledger_records.count + 2);
    for (const id of ids)
      expect(
        s.raw.query("SELECT 1 FROM ledger_records WHERE id=?").get(id),
      ).toBeTruthy();
    const amounts = (
      s.raw
        .query("SELECT amount FROM ledger_records WHERE id > ? ORDER BY id")
        .all(existing.id) as { amount: number }[]
    ).map((r) => r.amount);
    // The earlier reversal (40), then 7 and 9; the dry run's 8 is gone.
    expect(amounts).not.toContain(8);
    expect(amounts).toEqual(expect.arrayContaining([7, 9]));
  });
});

function sequencesBefore(
  before: Record<string, { digest: string }>,
  after: Record<string, { digest: string }>,
) {
  return before.app_sequences?.digest !== after.app_sequences?.digest;
}
