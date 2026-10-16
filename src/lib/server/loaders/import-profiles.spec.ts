import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountType } from "$lib/enums.js";
import { profileDraft } from "$lib/server/import/__fixtures__/profile-drafts.js";

/**
 * The loads behind the import profile screens, and the Settings list's
 * on/off switches (006 US6 AS1, AS11, AS12, FR-030, FR-038, FR-045).
 *
 * The loaders import `db/client.js`, which opens the real book on import, so
 * that module is mocked and every function is handed this spec's own
 * in-memory database, migrated from `drizzle/`. The configured paths point
 * nowhere. Permissions are mocked so each test can say what the caller may
 * do. Nothing here can touch `data/`.
 */

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
  const { legacyPairOf } = await import("$lib/server/permissions/legacy-map.js");
  const allow = (resource: string, action: string) =>
    holder.allow(resource, action);
  return {
    can: (_locals: unknown, permission: string) =>
      allow(...legacyPairOf(permission)),
    canAll: (_locals: unknown, permissions: string[]) =>
      permissions.every((permission) => allow(...legacyPairOf(permission))),
  };
});

const schema = await import("../db/schema.js");
const { auditLog, users } = schema;
const { createAccount } = await import("../services/accounts.js");
const { createImportProfile, getImportProfile, setImportProfileEnabled } =
  await import("../services/import-profiles.js");
const {
  PROFILES_HOME,
  applyProfileSwitches,
  importProfileList,
  loadImportProfileDetail,
  loadImportProfileNew,
  planProfileSwitches,
} = await import("./import-profiles.js");
type LedgerDb = import("../ledger/types.js").LedgerDb;

let sqlite: Database;
let db: LedgerDb;
const locals = { user: { id: 1 } } as never;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  holder.db = db;
  holder.allow = () => true;
});

afterEach(() => {
  holder.db = null;
  sqlite.close();
});

/** Only import.view: may see imports, may not change them. */
const viewOnly = (resource: string, action: string) =>
  resource === "import" && action === "view";

function saved(name: string, enabled = true): number {
  const created = createImportProfile(db, 1, {
    ...profileDraft("fee_document"),
    name,
  });
  if (!created.ok) throw new Error(created.reason);
  if (!enabled) setImportProfileEnabled(db, 1, created.value.id, false);
  return created.value.id;
}

/** What a SvelteKit redirect thrown by a loader says. */
function redirectOf(run: () => unknown): { status: number; location: string } {
  try {
    run();
  } catch (thrown) {
    return thrown as { status: number; location: string };
  }
  throw new Error("expected a redirect");
}

function profileAudit() {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.recordType, "import_profile"))
    .all();
}

describe("the list on Settings › Intelligence", () => {
  it("lists every profile with its switch and its number of sections", () => {
    const fees = saved("Fee notice");
    const off = saved("Ads invoice", false);
    expect(importProfileList(locals, db)).toEqual({
      canView: true,
      canChange: true,
      profiles: [
        {
          id: off,
          name: "Ads invoice",
          enabled: false,
          sectionCount: 1,
          kind: "summary",
        },
        {
          id: fees,
          name: "Fee notice",
          enabled: true,
          sectionCount: 1,
          kind: "summary",
        },
      ],
    });
  });

  it("shows the list but no changes to a user with import.view alone", () => {
    saved("Fee notice");
    holder.allow = viewOnly;
    const list = importProfileList(locals, db);
    expect(list.canView).toBe(true);
    expect(list.canChange).toBe(false);
    expect(list.profiles).toHaveLength(1);
  });

  it("sends nothing to a user who may not see imports", () => {
    saved("Fee notice");
    holder.allow = () => false;
    expect(importProfileList(locals, db)).toEqual({
      canView: false,
      canChange: false,
      profiles: [],
    });
  });
});

describe("the editor for a new profile", () => {
  it("needs import.change, and sends anyone else back to the list", () => {
    holder.allow = viewOnly;
    expect(redirectOf(() => loadImportProfileNew(locals, db))).toEqual(
      expect.objectContaining({ status: 302, location: PROFILES_HOME }),
    );
  });

  it("offers the categories by kind, as the save checks them", () => {
    createAccount(db, 1, { name: "Ads Fees", type: AccountType.Expense });
    createAccount(db, 1, { name: "Online Sales", type: AccountType.Revenue });
    const data = loadImportProfileNew(locals, db);
    expect(data.expenseCategories.map((c) => c.name)).toContain("Ads Fees");
    expect(data.expenseCategories.map((c) => c.name)).not.toContain(
      "Online Sales",
    );
    expect(data.incomeCategories.map((c) => c.name)).toContain("Online Sales");
    for (const choice of data.expenseCategories) {
      expect(typeof choice.code).toBe("string");
    }
  });
});

describe("the editor for a saved profile", () => {
  it("sends the profile whole, with whether the user may change it", () => {
    const id = saved("Fee notice");
    const data = loadImportProfileDetail(locals, String(id), db);
    expect(data.profile).toEqual(getImportProfile(db, id));
    expect(data.perms.change).toBe(true);
  });

  it("is read only with import.view alone", () => {
    const id = saved("Fee notice");
    holder.allow = viewOnly;
    expect(loadImportProfileDetail(locals, String(id), db).perms.change).toBe(
      false,
    );
  });

  it("sends a user who may not see imports back to the list", () => {
    const id = saved("Fee notice");
    holder.allow = () => false;
    expect(
      redirectOf(() => loadImportProfileDetail(locals, String(id), db)),
    ).toEqual(
      expect.objectContaining({ status: 302, location: PROFILES_HOME }),
    );
  });

  it.each(["999", "0", "01", "abc", "builtin:items@1"])(
    "goes back to the list for an id that names no profile (%s)",
    (raw) => {
      saved("Fee notice");
      expect(
        redirectOf(() => loadImportProfileDetail(locals, raw, db)),
      ).toEqual(
        expect.objectContaining({ status: 302, location: PROFILES_HOME }),
      );
    },
  );
});

describe("turning profiles on and off from the list", () => {
  const field = (switches: unknown) => JSON.stringify(switches);

  it("keeps only the switches that change something", () => {
    const on = saved("Fee notice");
    const off = saved("Ads invoice", false);
    const plan = planProfileSwitches(
      locals,
      field([
        { id: on, enabled: true },
        { id: off, enabled: true },
      ]),
      db,
    );
    expect(plan).toEqual({ ok: true, switches: [{ id: off, enabled: true }] });
  });

  it("turns each one on or off and audits it", () => {
    const on = saved("Fee notice");
    const before = profileAudit().length;
    const plan = planProfileSwitches(
      locals,
      field([{ id: on, enabled: false }]),
      db,
    );
    if (!plan.ok) throw new Error(plan.error);
    applyProfileSwitches(1, plan.switches, db);
    expect(getImportProfile(db, on)?.enabled).toBe(false);
    const audit = profileAudit();
    expect(audit).toHaveLength(before + 1);
    expect(audit.at(-1)).toEqual(
      expect.objectContaining({ recordId: String(on), action: "update" }),
    );
  });

  it("refuses a change without import.change, before anything is written", () => {
    const on = saved("Fee notice");
    holder.allow = viewOnly;
    expect(
      planProfileSwitches(locals, field([{ id: on, enabled: false }]), db),
    ).toEqual(expect.objectContaining({ ok: false, status: 403 }));
    expect(getImportProfile(db, on)?.enabled).toBe(true);
  });

  it("lets a user without import.change save the tab when no switch moved", () => {
    const on = saved("Fee notice");
    holder.allow = viewOnly;
    expect(
      planProfileSwitches(locals, field([{ id: on, enabled: true }]), db),
    ).toEqual({ ok: true, switches: [] });
  });

  it("asks nothing when the list was not sent", () => {
    expect(planProfileSwitches(locals, null, db)).toEqual({
      ok: true,
      switches: [],
    });
  });

  it("passes over a profile deleted since the page loaded", () => {
    expect(
      planProfileSwitches(locals, field([{ id: 404, enabled: false }]), db),
    ).toEqual({ ok: true, switches: [] });
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", field({ id: 1, enabled: true })],
    ["an id that is not a number", field([{ id: "1", enabled: true }])],
    ["a switch that is not true or false", field([{ id: 1, enabled: "yes" }])],
  ])("refuses a list that is %s", (_what, raw) => {
    expect(planProfileSwitches(locals, raw, db)).toEqual(
      expect.objectContaining({ ok: false, status: 400 }),
    );
  });
});
