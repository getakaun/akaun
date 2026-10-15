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

/**
 * The Settings › Intelligence save, as one action (006 US6 AS1, FR-045).
 *
 * The tab saves the providers, the reading settings and the import profile
 * switches together. A switch the user may not make is refused before
 * anything is written, so a refusal leaves the whole tab as it was, not only
 * the profiles. This calls the action itself, so that order is what is tested.
 *
 * The action imports the singleton `db`, which opens the real book on import,
 * so that module is mocked with a database file under `os.tmpdir()`, migrated
 * from `drizzle/`. The configured paths point nowhere. Permissions are mocked
 * so the test can say what the caller may do. Nothing here can touch `data/`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-save-intelligence-"));

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
const { auditLog, users } = schema;
const { profileDraft } =
  await import("$lib/server/import/__fixtures__/profile-drafts.js");
const { createImportProfile, getImportProfile } =
  await import("$lib/server/services/import-profiles.js");
const { getAllProviders, insertProvider } =
  await import("$lib/server/llmProviders.js");
const { getSetting, SETTING_KEYS } = await import("$lib/server/settings.js");
const { actions } = await import("./+page.server.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;

let dir: string;
let sqlite: Database;
let db: LedgerDb;
const locals = { user: { id: 1 } } as never;

beforeEach(() => {
  dir = mkdtempSync(join(sandbox, "case-"));
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
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
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

type Action = (event: never) => Promise<unknown>;

function saveIntelligence(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return (actions.saveIntelligence as unknown as Action)({
    locals,
    request: new Request("http://test.local/settings?/saveIntelligence", {
      method: "POST",
      body: form,
    }),
  } as never);
}

describe("saving the Intelligence tab", () => {
  it("refuses a user who may see settings but not change them", async () => {
    const provider = insertProvider(db, {
      type: "openrouter",
      name: "Main",
      apiKey: "k",
      model: "m",
    });
    holder.allow = (resource, action) =>
      !(resource === "settings" && action === "manage");
    const result = (await saveIntelligence({
      providers: JSON.stringify([{ id: provider.id, enabled: false }]),
      parallelTasks: "7",
    })) as { status?: number; data?: { error?: string } };
    expect(result.status).toBe(403);
    expect(result.data?.error).toContain("Settings › Manage");
  });

  it("saves nothing at all when a profile switch is refused with 403", async () => {
    const created = createImportProfile(db, 1, {
      ...profileDraft("fee_document"),
      name: "Fee notice",
    });
    if (!created.ok) throw new Error(created.reason);
    const profileId = created.value.id;
    const provider = insertProvider(db, {
      type: "openrouter",
      name: "Main",
      apiKey: "k",
      model: "m",
    });
    const auditBefore = db.select().from(auditLog).all().length;

    // May manage settings and see imports, but not manage import profiles:
    // the profile list comes back with a switch flipped, which only
    // import.profiles may do.
    holder.allow = (resource, action) =>
      resource === "settings" || (resource === "import" && action === "view");

    const result = (await saveIntelligence({
      providers: JSON.stringify([
        { id: provider.id, enabled: false },
        {
          isNew: true,
          tempId: "t1",
          type: "groq",
          name: "Second",
          apiKey: "k2",
          model: "m2",
          baseUrl: "",
          enabled: true,
        },
      ]),
      importProfiles: JSON.stringify([{ id: profileId, enabled: false }]),
      parallelTasks: "7",
      categoryHints: "true",
      rateLimitMs: "500",
      customInstructions: "Read every receipt as fuel.",
    })) as { status?: number; data?: { error?: string } };

    expect(result.status).toBe(403);
    expect(result.data?.error).toBe(
      "You do not have permission to turn import profiles on or off.",
    );

    // The profile, the providers, the settings and the audit trail are all as
    // they were.
    expect(getImportProfile(db, profileId)?.enabled).toBe(true);
    expect(
      getAllProviders(db).map(({ name, enabled }) => ({ name, enabled })),
    ).toEqual([{ name: "Main", enabled: true }]);
    for (const key of [
      SETTING_KEYS.autoImportParallelTasks,
      SETTING_KEYS.autoImportCategoryHints,
      SETTING_KEYS.autoImportRateLimitMs,
      SETTING_KEYS.autoImportCustomInstructions,
    ]) {
      expect(getSetting(db, key)).toBeNull();
    }
    expect(db.select().from(auditLog).all()).toHaveLength(auditBefore);
  });

  it("saves the tab and the switch together when the user may change imports", async () => {
    const created = createImportProfile(db, 1, {
      ...profileDraft("fee_document"),
      name: "Fee notice",
    });
    if (!created.ok) throw new Error(created.reason);
    const profileId = created.value.id;

    const result = (await saveIntelligence({
      providers: "[]",
      importProfiles: JSON.stringify([{ id: profileId, enabled: false }]),
      customInstructions: "Read every receipt as fuel.",
    })) as { success?: boolean };

    expect(result.success).toBe(true);
    expect(getImportProfile(db, profileId)?.enabled).toBe(false);
    expect(getSetting(db, SETTING_KEYS.autoImportCustomInstructions)).toBe(
      "Read every receipt as fuel.",
    );
  });
});
