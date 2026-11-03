import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { ClosedPeriodError } from "../closing/policy.js";
import {
  withClosingRefusal,
  withAsyncClosingRefusal,
} from "./closing-refusal.js";
import { ok } from "./result.js";
import { updateContact, mergeContacts } from "./contacts.js";
import { localsFor } from "../permissions/test-locals.js";
import { contactEvents } from "../finance/events.js";

describe("closed-period application refusals", () => {
  it("converts the known failure only after the transaction rolls back", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: "drizzle" });
      const result = withClosingRefusal(() =>
        db.transaction(() => {
          db.insert(schema.settings)
            .values({ key: "must-rollback", value: "x" })
            .run();
          throw new ClosedPeriodError("2026-10-31");
        }),
      );
      expect(result).toMatchObject({ ok: false, code: "REFUSED" });
      expect(db.select().from(schema.settings).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps the actionable reason through a database cause", () => {
    const result = withClosingRefusal(() => {
      throw new Error("Query wrapper", {
        cause: new ClosedPeriodError("2026-10-31"),
      });
    });
    expect(result).toEqual({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("2026-10-31"),
    });
  });

  it("preserves successful results and unexpected failures", () => {
    expect(withClosingRefusal(() => ok({ id: 5 }))).toEqual(ok({ id: 5 }));
    expect(() =>
      withClosingRefusal(() => {
        throw new Error("unexpected");
      }),
    ).toThrow("unexpected");
  });

  it("handles an asynchronous import refusal after cleanup", async () => {
    let cleaned = false;
    const result = await withAsyncClosingRefusal(async () => {
      try {
        throw new ClosedPeriodError("2026-10-31");
      } finally {
        cleaned = true;
      }
    });
    expect(cleaned).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "REFUSED" });
  });

  it("reports a concurrent SQLite writer as a conflict without retrying it", () => {
    const result = withClosingRefusal(() => {
      throw new Error("Query wrapper", {
        cause: Object.assign(new Error("busy"), {
          code: "SQLITE_BUSY_SNAPSHOT",
        }),
      });
    });
    expect(result).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("validates and authorizes the contact merge boundary before writing", () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: "drizzle" });
      expect(
        mergeContacts(
          { db, locals: localsFor([]) },
          { survivorId: 1, loserIds: [2] },
        ),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(
        mergeContacts(
          {
            db,
            locals: localsFor([
              "contacts.merge",
              "contacts.update",
              "contacts.delete",
            ]),
          },
          { survivorId: 1, loserIds: [1] },
        ),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back a contact profile edit when its partner-role change is refused", () => {
    const sqlite = new Database(":memory:");
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    contactEvents.on("contact-update", listener);
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: "drizzle" });
      db.insert(schema.users)
        .values({
          id: 1,
          username: "reviewer",
          email: "reviewer@test",
          passwordHash: "x",
        })
        .run();
      db.insert(schema.contacts)
        .values({ id: 1, legalName: "Original", entityType: 1 })
        .run();
      db.insert(schema.ledgerRecords)
        .values({
          kind: 1,
          date: "2026-10-15",
          description: "Existing history",
          amount: 50,
          currency: "USD",
          exchangeRate: 1,
        })
        .run();
      db.insert(schema.settings)
        .values({ key: "accounting.closedThrough", value: "2026-10-31" })
        .run();
      const result = updateContact(
        { db, locals: localsFor(["contacts.update"], { userId: 1 }) },
        1,
        { legalName: "Must roll back", roles: [4] },
      );
      expect(result).toMatchObject({ ok: false, code: "REFUSED" });
      expect(db.select().from(schema.contacts).get()!.legalName).toBe(
        "Original",
      );
      expect(db.select().from(schema.auditLog).all()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      contactEvents.off("contact-update", listener);
      sqlite.close();
    }
  });
});
