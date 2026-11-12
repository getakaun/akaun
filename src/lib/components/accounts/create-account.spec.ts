import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema.js";
import type { LedgerDb } from "$lib/server/ledger/types.js";
import { localsFor } from "$lib/server/permissions/test-locals.js";
import { submitAccount, type AccountSender } from "./create-account.js";

// Vitest's own mock, hoisted above every import. This spec used `mock.module`
// from `bun:test`, which does nothing under Vitest: the route then imported
// the real `db/client.ts` and wrote to `data/akaun.db`.
const { holder, testDb } = vi.hoisted(() => {
  const holder = { db: null as LedgerDb | null };
  const testDb = new Proxy({} as LedgerDb, {
    get(_target, property) {
      const db = holder.db;
      if (!db) throw Error("Fixture not initialised");
      const item = Reflect.get(db, property, db);
      return typeof item === "function" ? item.bind(db) : item;
    },
  });
  return { holder, testDb };
});
vi.mock("$lib/server/db/client.js", () => ({ db: testDb }));
const { POST } = await import("../../../routes/api/accounts/+server.js");
let raw: Database;
beforeEach(() => {
  raw = new Database(":memory:");
  holder.db = drizzle(raw, { schema }) as LedgerDb;
  migrate(holder.db, { migrationsFolder: "drizzle" });
  holder.db
    .insert(schema.users)
    .values({ id: 1, username: "u", email: "u@test", passwordHash: "x" })
    .run();
});
afterEach(() => {
  holder.db = null;
  raw.close();
});
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: "test",
    type: "1",
    subType: "1",
    code: "",
    ...values,
  }))
    data.set(key, value);
  return data;
}
function send(permissions = ["accounts.create"]): AccountSender {
  return async (url, init) => {
    expect(String(url)).toBe("/api/accounts");
    return POST({
      request: new Request("http://akaun.test/api/accounts", init),
      locals: localsFor(permissions),
    } as Parameters<typeof POST>[0]);
  };
}
it("creates the reported Asset/Cash account with an automatically assigned code", async () => {
  const result = await submitAccount(form(), send());
  expect(result.ok).toBe(true);
  expect(holder.db!.select().from(schema.accounts).all()).toMatchObject([
    { name: "test", type: 1, subType: 1, code: 1000 },
  ]);
});
it("retains expense tax defaults and excludes stale tax fields from non-expense accounts", async () => {
  expect(
    (
      await submitAccount(
        form({
          name: "Depreciation",
          type: "5",
          subType: "16",
          defaultTaxTreatment: "non_deductible",
          defaultTaxPercentage: "0.00",
        }),
        send(),
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await submitAccount(
        form({ defaultTaxTreatment: "partial", defaultTaxPercentage: "" }),
        send(),
      )
    ).ok,
  ).toBe(true);
  const rows = holder.db!.select().from(schema.accounts).all();
  expect(rows.find((row) => row.type === 5)).toMatchObject({
    defaultTaxTreatment: "non_deductible",
    defaultTaxPercentageBps: 0,
  });
  expect(rows.find((row) => row.type === 1)).toMatchObject({
    defaultTaxTreatment: null,
    defaultTaxPercentageBps: null,
  });
});
it("returns actionable API validation, permission and duplicate-code failures", async () => {
  expect(await submitAccount(form({ name: "" }), send())).toMatchObject({
    ok: false,
    error: expect.any(String),
  });
  expect(await submitAccount(form(), send([]))).toMatchObject({
    ok: false,
    error: expect.any(String),
  });
  expect((await submitAccount(form(), send())).ok).toBe(true);
  expect(
    await submitAccount(form({ name: "Another", code: "1000" }), send()),
  ).toMatchObject({ ok: false, error: "That code is already in use." });
  expect(holder.db!.select().from(schema.accounts).all()).toHaveLength(1);
});
it("does not report success when the network or response cannot confirm creation", async () => {
  const offline: AccountSender = async () => {
    throw Error("offline");
  };
  const invalid: AccountSender = async () => Response.json({});
  expect(await submitAccount(form(), offline)).toMatchObject({
    ok: false,
    error: expect.stringContaining("could not be confirmed"),
  });
  expect(await submitAccount(form(), invalid)).toMatchObject({ ok: false });
});
