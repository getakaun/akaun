import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const sandbox = mkdtempSync(join(tmpdir(), "akaun-save-reimbursements-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  allow: (() => true) as (resource: string, action: string) => boolean,
}));

vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: "/dev/null",
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/permissions.js", async () => {
  // The fake answers in the old grid's terms; each leaf is asked as the
  // (resource, action) it came from.
  const { legacyPairOf } =
    await import("$lib/server/permissions/legacy-map.js");
  const allow = (resource: string, action: string) =>
    holder.allow(resource, action);
  return {
    can: (_locals: unknown, permission: string) =>
      allow(...legacyPairOf(permission)),
    canAll: (_locals: unknown, permissions: string[]) =>
      permissions.every((permission) => allow(...legacyPairOf(permission))),
  };
});

vi.mock("$lib/server/logger.js", () => {
  const silent = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return { createLogger: () => silent };
});

const schema = await import("$lib/server/db/schema.js");
const { auditLog, users, contacts } = schema;
const { getSetting, setSetting, SETTING_KEYS } =
  await import("$lib/server/settings.js");
const { actions } = await import("./+page.server.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;
let dir: string;
let sqlite: Database;
let db: LedgerDb;
const locals = { user: { id: 1 } } as never;
const key = SETTING_KEYS.reimbursementDefaultPayeeContactId;

beforeEach(() => {
  dir = mkdtempSync(join(sandbox, "case-"));
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  db.insert(contacts)
    .values([
      { id: 1, entityType: 1, legalName: "Employee" },
      { id: 2, entityType: 1, legalName: "Other employee" },
    ])
    .run();
  holder.db = db;
  holder.allow = () => true;
});
afterEach(() => {
  holder.db = null;
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function save(value: string) {
  const form = new FormData();
  form.set("defaultPayeeContactId", value);
  return actions.saveReimbursements!({
    locals,
    request: new Request("http://test.local/settings?/saveReimbursements", {
      method: "POST",
      body: form,
    }),
  } as never);
}

describe("saving the default reimbursement payee", () => {
  it("saves, changes and clears the ledger default with an audit trail", async () => {
    for (const value of ["1", "2", ""]) {
      expect(await save(value)).toEqual({
        success: true,
        action: "saveReimbursements",
      });
      expect(getSetting(db, key)).toBe(value);
    }
    const rows = db.select().from(auditLog).all();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      recordType: "settings",
      recordId: "ledger",
      recordLabel: "Ledger settings",
      userId: 1,
    });
    expect(JSON.parse(rows[0].changes!)).toContainEqual({
      field: key,
      before: null,
      after: "1",
    });
    expect(JSON.parse(rows[2].changes!)).toContainEqual({
      field: key,
      before: "2",
      after: "",
    });
    await save("");
    expect(db.select().from(auditLog).all()).toHaveLength(3);
  });

  it("refuses invalid and missing contacts without changing the default or audit", async () => {
    setSetting(db, key, "1");
    for (const value of ["999", "abc", "-1", "1.5", "0"]) {
      expect(await save(value)).toMatchObject({ status: 400 });
      expect(getSetting(db, key)).toBe("1");
    }
    expect(db.select().from(auditLog).all()).toHaveLength(0);
  });

  it("requires Settings Manage even when other permissions are available", async () => {
    holder.allow = (resource, action) =>
      !(resource === "settings" && action === "manage");
    expect(await save("1")).toMatchObject({ status: 403 });
    expect(getSetting(db, key)).toBeNull();
    expect(db.select().from(auditLog).all()).toHaveLength(0);
  });

  it("does not require account editing or report permissions to save the default", async () => {
    holder.allow = (resource) => resource === "settings";
    expect(await save("1")).toEqual({
      success: true,
      action: "saveReimbursements",
    });
    expect(getSetting(db, key)).toBe("1");
  });
});
