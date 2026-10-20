import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  LiabilitySubType,
  StatementDirection,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { users } from "../db/schema.js";
import { createAccount, patchAccount } from "./accounts.js";
import {
  autoMatchMovements,
  createStatement,
  replaceMovementAllocations,
  ReconciliationError,
} from "./reconciliation.js";
import type { ReconciliationDb } from "../queries/reconciliation.js";
import { localsFor } from "../permissions/test-locals.js";

let sqlite: Database;
let db: ReconciliationDb;
const locals = localsFor([], { superuser: true });
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "r@test", username: "r", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

describe("statement account eligibility", () => {
  it("Create_WhenLeafIsAnyFixedType_ShouldAcceptIt", () => {
    for (const type of [
      AccountType.Asset,
      AccountType.Liability,
      AccountType.Equity,
      AccountType.Revenue,
      AccountType.Expense,
    ]) {
      const subType =
        type === AccountType.Asset
          ? AccountSubType.Bank
          : type === AccountType.Liability
            ? LiabilitySubType.AccountsPayable
            : undefined;
      const account = createAccount(db, 1, {
        name: `Type ${type}`,
        type,
        subType,
      });
      expect(account.ok).toBe(true);
      if (!account.ok) continue;
      expect(
        createStatement(db, locals, {
          originalFilename: `${type}.pdf`,
          storedFilePath: `${type}.pdf`,
          accountId: account.value.id,
        }).accountId,
      ).toBe(account.value.id);
    }
  });
  it("Create_WhenAccountIsInactive_ShouldRefusePlainly", () => {
    const account = createAccount(db, 1, {
      name: "Old bank",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    expect(patchAccount(db, account.value.id, 1, { active: false }).ok).toBe(
      true,
    );
    expect(() =>
      createStatement(db, locals, {
        originalFilename: "x.pdf",
        storedFilePath: "x.pdf",
        accountId: account.value.id,
      }),
    ).toThrowError(
      new ReconciliationError(
        "Choose an active account for this statement.",
        409,
      ),
    );
  });
});

describe("automatic reconciliation", () => {
  function fixture() {
    const created = createAccount(db, 1, {
      name: "Bank",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    if (!created.ok) throw new Error("Account fixture failed");
    const accountId = created.value.id;
    function statement(date = "2026-01-30", amount = 1000) {
      const s = createStatement(db, locals, {
        accountId,
        originalFilename: "statement.pdf",
        storedFilePath: "test.pdf",
      });
      const l = db
        .insert(schema.bankStatementLines)
        .values({
          statementId: s.id,
          date,
          amount,
          direction: StatementDirection.In,
        })
        .returning()
        .get()!;
      return { statementId: s.id, lineId: l.id };
    }
    function movement(date = "2026-01-30", amount = 1000) {
      const record = db
        .insert(schema.ledgerRecords)
        .values({ kind: 1, date, amount })
        .returning()
        .get()!;
      return db
        .insert(schema.ledgerMovements)
        .values({
          recordId: record.id,
          accountId,
          amountMinor: Math.round(amount * 100),
        })
        .returning()
        .get()!.id;
    }
    return { statement, movement };
  }

  it("matches only the January record and leaves the dividend untouched", () => {
    const f = fixture();
    const { statementId, lineId } = f.statement();
    db.insert(schema.bankStatementLines)
      .values({
        statementId,
        date: "2026-01-31",
        amount: 0.22,
        direction: StatementDirection.In,
      })
      .run();
    const january = f.movement();
    const february = f.movement("2026-02-07");
    const august = f.movement("2026-08-29");
    expect(
      autoMatchMovements(db, locals, [august, february, january], statementId),
    ).toEqual({
      matched: 1,
      skipped: 2,
      matchedMovementIds: [january],
    });
    const allocations = db
      .select()
      .from(schema.reconciliationAllocations)
      .all();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      movementId: january,
      lineId,
      amount: 1000,
    });
  });

  it("skips both competitors even when only one is requested", () => {
    const f = fixture();
    const { statementId } = f.statement();
    const first = f.movement();
    const second = f.movement();
    for (const ids of [[first], [second], [second, first]]) {
      expect(autoMatchMovements(db, locals, ids, statementId).matched).toBe(0);
    }
    expect(
      db.select().from(schema.reconciliationAllocations).all(),
    ).toHaveLength(0);
  });

  it("limits automatic matches to the requested statement", () => {
    const f = fixture();
    const first = f.statement("2026-01-29");
    const second = f.statement();
    const id = f.movement();
    expect(
      autoMatchMovements(db, locals, [id], first.statementId).matched,
    ).toBe(0);
    expect(
      autoMatchMovements(db, locals, [id], second.statementId).matched,
    ).toBe(1);
  });

  it("keeps manual cross-date matching and preserves saved allocations", () => {
    const f = fixture();
    const { statementId, lineId } = f.statement();
    const id = f.movement("2026-02-07");
    replaceMovementAllocations(db, locals, id, [{ lineId, amount: 1000 }]);
    const before = db.select().from(schema.reconciliationAllocations).all();
    expect(autoMatchMovements(db, locals, [id], statementId).matched).toBe(0);
    expect(db.select().from(schema.reconciliationAllocations).all()).toEqual(
      before,
    );
  });

  it("uses available balances and skips already consumed lines", () => {
    const f = fixture();
    const { statementId, lineId } = f.statement();
    const saved = f.movement("2026-01-29");
    replaceMovementAllocations(db, locals, saved, [{ lineId, amount: 1000 }]);
    expect(
      autoMatchMovements(db, locals, [f.movement()], statementId).matched,
    ).toBe(0);
  });
});
