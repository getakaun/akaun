import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType, ImportState } from "$lib/enums.js";
import { monthEndFor, previousMonthEnd } from "$lib/closing.js";
import { LEAF_PERMISSIONS, isDelegable } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import {
  accounts,
  auditLog,
  importQueue,
  ledgerMovements,
  ledgerRecords,
  users,
} from "../db/schema.js";
import { localsFor } from "../permissions/test-locals.js";
import type { LedgerDb } from "../ledger/types.js";
import { recordAudit } from "../audit.js";
import { closingEvents } from "../closing/events.js";
import { setSetting } from "../settings.js";
import type { AppContext } from "./context.js";
import {
  closeMonth,
  closingPage,
  previewClosing,
  readClosingStatus,
  reopenMonths,
} from "./closing.js";

let sqlite: Database;
let db: LedgerDb;
function ctx(permissions: string[] = [...LEAF_PERMISSIONS]): AppContext {
  return { db, locals: localsFor(permissions) };
}
function preview(monthEnd = "2024-10-31") {
  const result = previewClosing(ctx(), { monthEnd });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function close(monthEnd = "2024-10-31") {
  const review = preview(monthEnd);
  return closeMonth(ctx(), {
    monthEnd,
    revision: review.revision,
  });
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "reviewer@test", username: "reviewer", passwordHash: "x" })
    .run();
});
afterEach(() => {
  sqlite.close();
  closingEvents.removeAllListeners();
});

describe("month closing", () => {
  it("does not offer a future record date as the start of an earlier close", () => {
    db.insert(ledgerRecords)
      .values({
        kind: 1,
        date: "2099-11-01",
        description: "Future history",
        amount: 5,
        currency: "USD",
        exchangeRate: 1,
      })
      .run();
    expect(preview().dateFrom).toBeNull();
  });
  it("keeps leap years and four-digit calendar boundaries exact", () => {
    expect(monthEndFor("2024-02")).toBe("2024-02-29");
    expect(monthEndFor("0001-02")).toBe("0001-02-28");
    expect(monthEndFor("9999-12")).toBe("9999-12-31");
    expect(monthEndFor("0000-01")).toBeNull();
    expect(monthEndFor("2024-13")).toBeNull();
    expect(previousMonthEnd("2024-03")).toBe("2024-02-29");
    expect(previousMonthEnd("0001-01")).toBeNull();
  });

  it("exposes only the boundary to an authenticated data-entry user", () => {
    setSetting(db, "accounting.closedThrough", "2024-09-30");
    expect(readClosingStatus(ctx(["records.create"]))).toEqual({
      ok: true,
      value: { closedThrough: "2024-09-30" },
    });
    expect(closingPage(ctx(["records.create"])).ok).toBe(false);
    const anonymous = ctx();
    anonymous.locals.user = null;
    expect(readClosingStatus(anonymous).ok).toBe(false);
  });
  it("requires reports access to prepare a review", () => {
    expect(
      previewClosing(ctx(["closing.close"]), { monthEnd: "2024-10-31" }).ok,
    ).toBe(false);
    expect(
      previewClosing(ctx(["reports.read"]), { monthEnd: "2024-10-31" }).ok,
    ).toBe(true);
  });
  it("validates real elapsed month ends", () => {
    for (const monthEnd of [
      "2024-10-30",
      "2023-02-29",
      "9999-12-31",
      "garbage",
    ]) {
      expect(previewClosing(ctx(), { monthEnd }).ok).toBe(false);
    }
    expect(previewClosing(ctx(), { monthEnd: "2024-02-29" }).ok).toBe(true);
  });
  it("closes after automatic checks without checklist or notice acknowledgments", () => {
    const review = preview();
    expect(review.warnings.some((w) => w.id === "first-close")).toBe(true);
    expect(
      closeMonth(ctx(), {
        monthEnd: review.monthEnd,
        revision: review.revision,
      }),
    ).toEqual({ ok: true, value: { closedThrough: review.monthEnd } });
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });
  it("records automated checks and notices from the server rather than user assertions", () => {
    db.insert(importQueue)
      .values({
        id: "notice",
        createdBy: 1,
        originalFilename: "receipt.pdf",
        tempFilePath: "unused",
        state: ImportState.PendingReview,
        date: "2024-10-15",
      })
      .run();
    const review = preview();
    expect(review.warnings.some((w) => w.id === "pending-imports")).toBe(true);
    expect(
      closeMonth(ctx(), {
        monthEnd: review.monthEnd,
        revision: review.revision,
      }).ok,
    ).toBe(true);
    const changes = JSON.parse(db.select().from(auditLog).get()!.changes!);
    expect(changes).toContainEqual({
      field: "automatedChecks",
      before: null,
      after: { completedMonth: true, ...review.integrity },
    });
    expect(changes).toContainEqual({
      field: "closingNotices",
      before: null,
      after: review.warnings,
    });
    expect(
      changes.some(
        (change: { field: string }) =>
          change.field === "reviewChecks" ||
          change.field === "acknowledgedWarnings",
      ),
    ).toBe(false);
  });
  it("closes once with an audit entry and emits only committed status", () => {
    const events: unknown[] = [];
    closingEvents.on("closing-changed", (value) => {
      expect(readClosingStatus(ctx())).toEqual({ ok: true, value });
      events.push(value);
    });
    expect(close().ok).toBe(true);
    expect(readClosingStatus(ctx())).toEqual({
      ok: true,
      value: { closedThrough: "2024-10-31" },
    });
    expect(events).toEqual([{ closedThrough: "2024-10-31" }]);
    const history = closingPage(ctx());
    expect(history.ok && history.value.history).toHaveLength(1);
    const audit = db.select().from(auditLog).all()[0];
    expect(audit.recordId).toBe("closing");
    expect(audit.changes).toContain("2024-10-31");
    expect(
      closeMonth(ctx(), {
        monthEnd: "2024-10-31",
        revision: "stale",
      }).ok,
    ).toBe(false);
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });
  it("rejects a stale review after another user changes the book", () => {
    const review = preview();
    recordAudit(db, {
      recordType: "settings",
      recordId: "general",
      userId: 1,
      action: "update",
      changes: [{ field: "name", before: null, after: "Changed" }],
    });
    const result = closeMonth(ctx(), {
      monthEnd: review.monthEnd,
      revision: review.revision,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("CONFLICT");
    expect(readClosingStatus(ctx())).toEqual({
      ok: true,
      value: { closedThrough: null },
    });
  });
  it("detects newly arrived pending imports even without an audit event", () => {
    const review = preview();
    db.insert(importQueue)
      .values({
        id: "pending",
        createdBy: 1,
        originalFilename: "receipt.pdf",
        tempFilePath: "unused",
        state: ImportState.PendingReview,
        date: "2024-10-15",
      })
      .run();
    expect(
      preview().warnings.find((w) => w.id === "pending-imports")?.items,
    ).toEqual([
      {
        key: "import-pending",
        label: "receipt.pdf",
        detail: "Waiting for review · dated 15 Oct 2024",
        ref: { kind: "import-queue" },
      },
    ]);
    expect(
      closeMonth(ctx(), {
        monthEnd: review.monthEnd,
        revision: review.revision,
      }).ok,
    ).toBe(false);
  });
  it("refuses closing when the automated ledger check fails", () => {
    db.insert(ledgerRecords)
      .values({
        kind: 1,
        date: "2024-10-01",
        description: "Broken",
        amount: 5,
        currency: "USD",
        exchangeRate: 1,
      })
      .run();
    const review = preview();
    expect(review.integrity.ok).toBe(false);
    expect(close()).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("integrity"),
    });
    expect(db.select().from(auditLog).all()).toHaveLength(0);
  });
  it("warns when account classification could leave closed reports incomplete", () => {
    const bank = db
      .insert(accounts)
      .values({
        name: "Bank",
        rank: "a",
        type: AccountType.Asset,
        role: 1,
        subType: AccountSubType.Bank,
        code: 1000,
      })
      .returning()
      .get();
    const category = db
      .insert(accounts)
      .values({
        name: "Unclassified expense",
        rank: "b",
        type: AccountType.Expense,
        role: 5,
        code: 6000,
      })
      .returning()
      .get();
    const record = db
      .insert(ledgerRecords)
      .values({
        kind: 1,
        date: "2024-10-01",
        description: "Expense",
        amount: 5,
        currency: "USD",
        exchangeRate: 1,
      })
      .returning()
      .get();
    db.insert(ledgerMovements)
      .values([
        { recordId: record.id, accountId: bank.id, amountMinor: -500 },
        { recordId: record.id, accountId: category.id, amountMinor: 500 },
      ])
      .run();
    expect(preview().integrity.ok).toBe(true);
    const warning = preview().warnings.find((w) => w.id === "classification");
    // The notice names the account, says how it reports today and links to it,
    // so a reviewer never has to search for it.
    expect(warning?.message).toBe(
      "1 account used on or before 31 Oct 2024 has no report classification",
    );
    expect(warning?.items).toEqual([
      {
        key: `account-${category.id}`,
        label: "6000 Unclassified expense",
        detail:
          "Expense · reported as Operating until you choose · 1 record, last on 1 Oct 2024",
        ref: { kind: "account", id: category.id },
      },
    ]);
    expect(warning?.total).toBeUndefined();
  });
  it("names each unbalanced record behind a failed integrity check", () => {
    const bank = db
      .insert(accounts)
      .values({
        name: "Bank",
        rank: "a",
        type: AccountType.Asset,
        role: 1,
        subType: AccountSubType.Bank,
        code: 1000,
      })
      .returning()
      .get();
    const record = db
      .insert(ledgerRecords)
      .values({
        kind: 1,
        date: "2024-10-02",
        recordNumber: "EX20241002-001",
        description: "One-sided",
        amount: 5,
        currency: "USD",
        exchangeRate: 1,
      })
      .returning()
      .get();
    db.insert(ledgerMovements)
      .values({ recordId: record.id, accountId: bank.id, amountMinor: -500 })
      .run();
    const { integrity } = preview();
    expect(integrity.ok).toBe(false);
    expect(integrity.problems).toHaveLength(1);
    expect(integrity.problems[0]).toMatchObject({
      label: "EX20241002-001",
      ref: { kind: "record", id: record.id },
    });
    expect(integrity.problems[0].detail).toContain("2 Oct 2024 · One-sided");
  });
  it("never grants closing controls to delegated credentials", () => {
    expect(isDelegable("closing.close")).toBe(false);
    expect(isDelegable("closing.reopen")).toBe(false);
    const request = ctx();
    request.locals.credential = { kind: "pat", tokenId: 1 };
    const review = preview();
    expect(
      closeMonth(request, {
        monthEnd: review.monthEnd,
        revision: review.revision,
      }).ok,
    ).toBe(false);
    expect(
      closeMonth(ctx(["reports.read", "records.update"]), {
        monthEnd: review.monthEnd,
        revision: review.revision,
      }).ok,
    ).toBe(false);
  });
  it("reopens later months together and requires the current boundary and reason", () => {
    db.insert(ledgerRecords)
      .values({
        kind: 1,
        date: "2024-01-01",
        description: "History",
        amount: 5,
        currency: "USD",
        exchangeRate: 1,
      })
      .run();
    setSetting(db, "accounting.closedThrough", "2024-12-31");
    expect(
      reopenMonths(ctx(), {
        fromMonth: "2024-10",
        expectedClosedThrough: "2024-11-30",
        reason: "Correct an October posting",
      }).ok,
    ).toBe(false);
    expect(
      reopenMonths(ctx(), {
        fromMonth: "2024-10",
        expectedClosedThrough: "2024-12-31",
        reason: "",
      }).ok,
    ).toBe(false);
    const reopened = reopenMonths(ctx(), {
      fromMonth: "2024-10",
      expectedClosedThrough: "2024-12-31",
      reason: "Correct an October posting",
    });
    expect(reopened).toEqual({
      ok: true,
      value: { closedThrough: "2024-09-30" },
    });
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });
  it("clears the boundary when reopening all recorded history", () => {
    setSetting(db, "accounting.closedThrough", "2024-12-31");
    expect(
      reopenMonths(ctx(), {
        fromMonth: "2024-01",
        expectedClosedThrough: "2024-12-31",
        reason: "Reopen all history for corrections",
      }),
    ).toEqual({ ok: true, value: { closedThrough: null } });
  });
  it("does not expose other settings history to a report reader", () => {
    recordAudit(db, {
      recordType: "settings",
      recordId: "general",
      userId: 1,
      action: "update",
      changes: [{ field: "company", before: null, after: "Private" }],
    });
    expect(close().ok).toBe(true);
    const page = closingPage(ctx(["reports.read"]));
    expect(page.ok && page.value.history).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("Private");
  });
});
