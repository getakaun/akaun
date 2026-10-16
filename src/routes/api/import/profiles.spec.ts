import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
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
 * The import profile routes, and naming a profile at upload (006 S2: US6,
 * FR-001, FR-030, FR-035, FR-038, FR-045).
 *
 * The routes import the singleton `db`, which opens DATABASE_PATH at import
 * time, so that module is mocked with a database file under `os.tmpdir()`,
 * migrated from `drizzle/`. The storage path is mocked to a folder there too,
 * so an upload never writes under `data/`. Permissions are mocked so each test
 * can say what the caller may do; nothing else is mocked.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-import-profiles-routes-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
  // Which permissions the caller has; every one unless a test says otherwise.
  allow: (() => true) as (resource: string, action: string) => boolean,
}));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return holder.storageRoot;
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    return holder.db;
  },
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

const { profileDraft } =
  await import("$lib/server/import/__fixtures__/profile-drafts.js");
const schema = await import("$lib/server/db/schema.js");
const { auditLog, importProfiles, importQueue, users } = schema;
const { createImportProfile, setImportProfileEnabled, getImportProfile } =
  await import("$lib/server/services/import-profiles.js");
const { loadImportPage } = await import("$lib/server/loaders/import.js");
const { formFromDraft, payloadFromForm, setKind } =
  await import("$lib/import-profile-form.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;
type ProfileDraft = import("$lib/import-profile-schema.js").ImportProfileDraft;

let dir: string;
let sqlite: Database;
let db: LedgerDb;

beforeEach(() => {
  dir = mkdtempSync(join(sandbox, "case-"));
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  holder.db = db;
  holder.storageRoot = join(dir, "storage");
  holder.allow = () => true;
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const locals = { user: { id: 1 } } as never;
type Handler = (event: never) => Promise<Response> | Response;

function feeDocument(name = "Fee notice"): ProfileDraft {
  return { ...profileDraft("fee_document"), name };
}

/** The fee document, read as Every transaction instead (FR-032). */
function everyTransaction(name = "Fee rows"): ProfileDraft {
  return {
    ...feeDocument(name),
    kind: "transactions",
    mode: "every_transaction",
    statedTotalLabels: { every_transaction: "Total of the rows" },
  };
}

/** A profile saved straight through the service, for a route to act on. */
function saved(
  name = "Fee notice",
  enabled = true,
  make: (name: string) => ProfileDraft = feeDocument,
): number {
  const created = createImportProfile(db, 1, make(name));
  if (!created.ok) throw new Error(created.reason);
  if (!enabled) setImportProfileEnabled(db, 1, created.value.id, false);
  return created.value.id;
}

function jsonRequest(body: unknown, method = "POST") {
  return new Request("http://test.local/", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function profileRows() {
  return db.select().from(importProfiles).all();
}

function profileAudit() {
  return db
    .select()
    .from(auditLog)
    .all()
    .filter((entry) => entry.recordType === "import_profile");
}

function queueRows() {
  return db.select().from(importQueue).all();
}

function tempFiles(): string[] {
  const temp = join(holder.storageRoot, "import", "temp");
  return existsSync(temp) ? readdirSync(temp) : [];
}

const routes = {
  async list(query = "") {
    const { GET } = await import("./profiles/+server.js");
    return (GET as Handler)({
      locals,
      url: new URL(`http://test.local/api/import/profiles${query}`),
    } as never);
  },
  async create(body: unknown) {
    const { POST } = await import("./profiles/+server.js");
    return (POST as Handler)({ locals, request: jsonRequest(body) } as never);
  },
  async get(id: number | string) {
    const { GET } = await import("./profiles/[id]/+server.js");
    return (GET as Handler)({ locals, params: { id: String(id) } } as never);
  },
  async patch(id: number | string, body: unknown) {
    const { PATCH } = await import("./profiles/[id]/+server.js");
    return (PATCH as Handler)({
      locals,
      params: { id: String(id) },
      request: jsonRequest(body, "PATCH"),
    } as never);
  },
  async remove(id: number | string) {
    const { DELETE } = await import("./profiles/[id]/+server.js");
    return (DELETE as Handler)({ locals, params: { id: String(id) } } as never);
  },
  async upload(readAs?: string, importMode?: string) {
    const { POST } = await import("./+server.js");
    const form = new FormData();
    form.append(
      "file",
      new File(["%PDF-1.4 test"], "fees.pdf", { type: "application/pdf" }),
    );
    if (readAs !== undefined) form.append("readAs", readAs);
    if (importMode !== undefined) form.append("importMode", importMode);
    return (POST as Handler)({
      locals,
      request: new Request("http://test.local/api/import", {
        method: "POST",
        body: form,
      }),
    } as never);
  },
};

// ── Permissions ─────────────────────────────────────────────────────────────

describe("who may manage import profiles (FR-045)", () => {
  it("lists profiles with import.view alone", async () => {
    saved();
    holder.allow = (resource, action) =>
      resource === "import" && action === "view";
    const res = await routes.list();
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { name: string }[]).map((p) => p.name),
    ).toEqual(["Fee notice"]);
  });

  it("refuses to list profiles without import.view", async () => {
    holder.allow = (resource, action) =>
      !(resource === "import" && action === "view");
    expect((await routes.list()).status).toBe(403);
  });

  it("refuses every managing verb without import.change, and writes nothing", async () => {
    const id = saved();
    const before = profileAudit().length;
    // Every other permission, import.add and import.delete included: managing
    // profiles is import.change and nothing else.
    holder.allow = (resource, action) =>
      !(resource === "import" && action === "change");

    const replies = [
      await routes.create(feeDocument("Other")),
      await routes.patch(id, { enabled: false }),
      await routes.patch(id, feeDocument("Renamed")),
      await routes.remove(id),
    ];
    expect(replies.map((res) => res.status)).toEqual([403, 403, 403, 403]);
    expect(profileRows()).toHaveLength(1);
    expect(getImportProfile(db, id)).toMatchObject({
      name: "Fee notice",
      enabled: true,
    });
    expect(profileAudit()).toHaveLength(before);
  });

  it("reads one profile with import.view alone, as the list and the editor do", async () => {
    const id = saved();
    holder.allow = (resource, action) =>
      resource === "import" && action === "view";
    const res = await routes.get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "Fee notice" });

    holder.allow = (resource, action) =>
      !(resource === "import" && action === "view");
    expect((await routes.get(id)).status).toBe(403);
  });

  it("lets import.change manage profiles without import.add or import.delete", async () => {
    holder.allow = (resource, action) =>
      resource === "import" && action === "change";
    const created = await routes.create(feeDocument());
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    expect((await routes.patch(id, { enabled: false })).status).toBe(200);
    expect((await routes.remove(id)).status).toBe(204);
  });

  it("refuses a caller who is not signed in", async () => {
    const { POST } = await import("./profiles/+server.js");
    const res = await (POST as Handler)({
      locals: {},
      request: jsonRequest(feeDocument()),
    } as never);
    expect(res.status).toBe(401);
    expect(profileRows()).toHaveLength(0);
  });
});

// ── Adding and editing ──────────────────────────────────────────────────────

describe("adding a profile", () => {
  it("saves a valid profile, enabled and audited, and replies with it", async () => {
    const res = await routes.create(feeDocument());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; enabled: boolean };
    expect(body).toMatchObject({ name: "Fee notice", enabled: true });
    expect(profileRows().map((row) => row.id)).toEqual([body.id]);
    expect(profileAudit()).toMatchObject([
      { recordId: String(body.id), action: "create", userId: 1 },
    ]);
  });

  it("refuses a profile that breaks the rules with every path, and saves nothing", async () => {
    const draft = feeDocument() as unknown as Record<string, unknown>;
    const sections = structuredClone(draft.sections) as Record<
      string,
      unknown
    >[];
    sections[0].key = "Fees!";
    sections[0].extras = {
      type: "object",
      properties: {
        amount: { type: "number" },
        order: { type: "object" },
      },
    };
    const res = await routes.create({ ...draft, name: "", sections });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: { path: string; message: string }[];
    };
    const paths = body.errors.map((error) => error.path);
    expect(paths).toContain("name");
    expect(paths).toContain("sections[0].key");
    expect(paths.some((p) => p.startsWith("sections[0].extras"))).toBe(true);
    expect(body.error).toContain("name:");
    expect(profileRows()).toHaveLength(0);
    expect(profileAudit()).toHaveLength(0);
  });

  it("refuses a second profile with the same name", async () => {
    saved("Fee notice");
    const res = await routes.create(feeDocument("FEE NOTICE"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors.map((e) => e.path)).toEqual(["name"]);
    expect(profileRows()).toHaveLength(1);
  });

  it("refuses a body that is not an object, or not JSON", async () => {
    for (const body of [[1, 2], "not json", null]) {
      const res = await routes.create(body);
      expect(res.status).toBe(400);
    }
    expect(profileRows()).toHaveLength(0);
  });
});

describe("reading, editing and deleting one profile", () => {
  it("reads one profile, or 404 for an id that names none", async () => {
    const id = saved();
    const res = await routes.get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "Fee notice" });

    for (const missing of [id + 1, "0", "abc", "1.5", "builtin:items@1"]) {
      expect((await routes.get(missing)).status).toBe(404);
    }
  });

  it("saves the whole form, audited, ignoring fields the form does not have", async () => {
    const id = saved();
    const loaded = (await (await routes.get(id)).json()) as Record<
      string,
      unknown
    >;
    const res = await routes.patch(id, {
      ...loaded,
      name: "Ads invoice",
      createdAt: "1999-01-01",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      name: "Ads invoice",
      enabled: true,
    });
    expect(profileAudit().map((entry) => entry.action)).toEqual([
      "create",
      "update",
    ]);
  });

  it("refuses an invalid form with its paths and keeps the profile as it was", async () => {
    const id = saved();
    const res = await routes.patch(id, {
      ...feeDocument(),
      sections: [],
      enabled: false,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors.map((e) => e.path)).toEqual(["sections"]);
    // The switch sent with it is not applied either.
    expect(getImportProfile(db, id)).toMatchObject({
      name: "Fee notice",
      enabled: true,
    });
    expect(profileAudit()).toHaveLength(1);
  });

  it("refuses a form with a field left out, rather than keeping the old value", async () => {
    const id = saved();
    const res = await routes.patch(id, { name: "Only a name" });
    expect(res.status).toBe(400);
    expect(getImportProfile(db, id)?.name).toBe("Fee notice");
  });

  it("turns a profile off and on with enabled alone, audited", async () => {
    const id = saved();
    const off = await routes.patch(id, { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ id, enabled: false });
    expect(getImportProfile(db, id)?.enabled).toBe(false);

    expect((await routes.patch(id, { enabled: true })).status).toBe(200);
    expect(getImportProfile(db, id)?.enabled).toBe(true);
    expect(profileAudit().map((entry) => entry.action)).toEqual([
      "create",
      "update",
      "update",
    ]);
  });

  it("saves the form and the switch together", async () => {
    const id = saved();
    const res = await routes.patch(id, {
      ...feeDocument("Ads invoice"),
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(getImportProfile(db, id)).toMatchObject({
      name: "Ads invoice",
      enabled: false,
    });
  });

  it("refuses an empty PATCH, a switch that is not true or false, and a missing profile", async () => {
    const id = saved();
    expect((await routes.patch(id, {})).status).toBe(400);
    expect((await routes.patch(id, { enabled: "no" })).status).toBe(400);
    expect((await routes.patch(id + 1, { enabled: false })).status).toBe(404);
    expect((await routes.patch("x", { enabled: false })).status).toBe(404);
    expect(getImportProfile(db, id)?.enabled).toBe(true);
    expect(profileAudit()).toHaveLength(1);
  });

  it("deletes a profile, audited, and 404s after", async () => {
    const id = saved();
    expect((await routes.remove(id)).status).toBe(204);
    expect(profileRows()).toHaveLength(0);
    expect(profileAudit().map((entry) => entry.action)).toEqual([
      "create",
      "delete",
    ]);
    expect((await routes.remove(id)).status).toBe(404);
    expect((await routes.get(id)).status).toBe(404);
  });

  it("lists disabled profiles for the editor, and only enabled ones on request", async () => {
    saved("Alpha");
    saved("Beta", false);
    const all = (await (await routes.list()).json()) as { name: string }[];
    expect(all.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    const enabled = (await (await routes.list("?enabled=1")).json()) as {
      name: string;
    }[];
    expect(enabled.map((p) => p.name)).toEqual(["Alpha"]);
  });
});

// ── Naming a profile at upload ──────────────────────────────────────────────

describe("uploading with a profile (FR-001, FR-045)", () => {
  it("accepts an enabled profile with only the upload permission", async () => {
    const id = saved();
    holder.allow = (resource, action) =>
      resource === "import" && action === "add";

    const res = await routes.upload(`profile:${id}`);
    expect(res.status).toBe(202);
    const [row] = queueRows();
    expect(row).toMatchObject({
      readAs: "profile",
      readHow: "chosen",
      profileId: String(id),
      importMode: "summary",
    });
    // A copy that names the profile from the upload on, so the queue can say
    // how a waiting or failed document was to be read (FR-041). Reading
    // replaces it with the schema it sent.
    expect(JSON.parse(row.profileSnapshot ?? "null")).toMatchObject({
      version: 1,
      id,
      name: "Fee notice",
      mode: "summary",
      schemaId: "",
      profile: { name: "Fee notice" },
    });
    const { jobForEvent } = await import("$lib/server/import/job-event.js");
    expect(jobForEvent(row).profile).toEqual({
      name: "Fee notice",
      mode: "summary",
    });
    expect(tempFiles()).toHaveLength(1);
  });

  it("refuses an unknown profile id with a clear message, and stores nothing", async () => {
    const res = await routes.upload("profile:42");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "No import profile has the id 42; it may have been deleted. Choose another way to read this document.",
    );
    expect(queueRows()).toHaveLength(0);
    expect(tempFiles()).toHaveLength(0);
  });

  it("refuses a disabled or deleted profile, and stores nothing", async () => {
    const off = saved("Fee notice", false);
    const gone = saved("Old statement");
    expect((await routes.remove(gone)).status).toBe(204);

    const disabled = await routes.upload(`profile:${off}`);
    expect(disabled.status).toBe(400);
    expect(((await disabled.json()) as { error: string }).error).toContain(
      '"Fee notice" is turned off',
    );
    // A deleted profile is named, from its delete's audit entry (spec edge
    // case), not given by its number.
    const deleted = await routes.upload(`profile:${gone}`);
    expect(deleted.status).toBe(400);
    expect(((await deleted.json()) as { error: string }).error).toBe(
      'The import profile "Old statement" was deleted. Choose another way to read this document.',
    );
    expect(queueRows()).toHaveLength(0);
    expect(tempFiles()).toHaveLength(0);
  });

  it("stores the chosen profile's own mode, and its copy names it (FR-002)", async () => {
    const id = saved("Wallet rows", true, everyTransaction);
    expect((await routes.upload(`profile:${id}`)).status).toBe(202);
    const [row] = queueRows();
    expect(row.importMode).toBe("every_transaction");
    // The copy taken at upload names the mode, so the queue can say it.
    expect(JSON.parse(row.profileSnapshot ?? "null")).toMatchObject({
      id,
      mode: "every_transaction",
      profile: { mode: "every_transaction" },
    });
  });

  it("accepts an Import choice an older screen still sends, and does not read it", async () => {
    const summary = saved();
    const rows = saved("Wallet rows", true, everyTransaction);
    for (const sent of ["every_transaction", "summary", "everything", ""]) {
      expect((await routes.upload(`profile:${summary}`, sent)).status).toBe(
        202,
      );
      expect((await routes.upload(`profile:${rows}`, sent)).status).toBe(202);
      expect((await routes.upload("auto", sent)).status).toBe(202);
      expect((await routes.upload("receipt", sent)).status).toBe(202);
    }
    const modeOf = (readAs: string, profileId: string | null) =>
      new Set(
        queueRows()
          .filter((row) => row.readAs === readAs && row.profileId === profileId)
          .map((row) => row.importMode),
      );
    // Each profile is read in its own mode, whatever the field said.
    expect(modeOf("profile", String(summary))).toEqual(new Set(["summary"]));
    expect(modeOf("profile", String(rows))).toEqual(
      new Set(["every_transaction"]),
    );
    // Auto-detect stores a mode only once it finds a profile; a receipt
    // never has one.
    expect(modeOf("auto", null)).toEqual(new Set([null]));
    expect(modeOf("receipt", null)).toEqual(new Set([null]));
  });

  it("refuses the stored words as an upload choice", async () => {
    saved();
    for (const value of ["profile", "profile:builtin:items@1"]) {
      expect((await routes.upload(value)).status).toBe(400);
    }
    expect(queueRows()).toHaveLength(0);
  });

  it("still reads the built-in choices as before, with no profile and no mode", async () => {
    expect((await routes.upload("items")).status).toBe(202);
    expect((await routes.upload()).status).toBe(202);
    const rows = queueRows().sort((a, b) =>
      (a.readAs ?? "").localeCompare(b.readAs ?? ""),
    );
    expect(rows).toMatchObject([
      {
        readAs: "auto",
        readHow: "standard",
        profileId: null,
        importMode: null,
      },
      { readAs: "items", readHow: "chosen", profileId: null, importMode: null },
    ]);
  });
});

// ── The upload screen's "Read as" ───────────────────────────────────────────

describe("the Read as choices on the upload screen", () => {
  function choices() {
    return loadImportPage(locals, db).readAsChoices;
  }

  it("offers only the built-in choices when there is no profile", () => {
    expect(choices().map((c) => c.value)).toEqual(["auto", "receipt", "items"]);
  });

  it("offers each enabled profile by name, after the built-in ones (US6 AS5)", () => {
    const beta = saved("Beta statement");
    const alpha = saved("Alpha fees");
    expect(choices().slice(3)).toEqual([
      { value: `profile:${alpha}`, label: "Alpha fees" },
      { value: `profile:${beta}`, label: "Beta statement" },
    ]);
  });

  it("marks a profile that reads one kind of file, and none that reads both (FR-070)", () => {
    const both = saved("Both");
    const photos = saved("Photos", true, (name) => ({
      ...feeDocument(name),
      fileTypes: ["document"],
    }));
    const sheets = saved("Sheets", true, (name) => ({
      ...feeDocument(name),
      fileTypes: ["spreadsheet"],
    }));
    expect(choices().slice(3)).toEqual([
      { value: `profile:${both}`, label: "Both" },
      { value: `profile:${photos}`, label: "Photos (PDFs and photos only)" },
      { value: `profile:${sheets}`, label: "Sheets (spreadsheets only)" },
    ]);
  });

  it("does not offer a disabled or deleted profile (US6 AS12)", async () => {
    const kept = saved("Kept");
    const off = saved("Turned off");
    const gone = saved("Deleted");
    expect((await routes.patch(off, { enabled: false })).status).toBe(200);
    expect((await routes.remove(gone)).status).toBe(204);
    expect(choices().slice(3)).toEqual([
      { value: `profile:${kept}`, label: "Kept" },
    ]);
  });

  it("carries no mode with a profile: choosing it chooses its mode (FR-002)", () => {
    const id = saved("Wallet rows", true, everyTransaction);
    expect(choices().slice(3)).toEqual([
      { value: `profile:${id}`, label: "Wallet rows" },
    ]);
  });

  it("offers every choice it lists as one the upload accepts", async () => {
    saved("Accepted");
    for (const choice of choices()) {
      expect((await routes.upload(choice.value)).status).toBe(202);
    }
  });
});

// ── The profile's import mode (FR-002, FR-032) ──────────────────────────────

describe("the profile's import mode", () => {
  /**
   * A profile as it was saved when each section had its own mode: no mode in
   * its options, and each section with the mode given (none for undefined).
   */
  function legacy(
    name: string,
    modes: ("summary" | "every_transaction" | undefined)[],
  ): number {
    const [fees] = feeDocument().sections;
    const sections = modes.map((mode, index) => ({
      ...structuredClone(fees),
      key: `part_${index + 1}`,
      name: `Part ${index + 1}`,
      ...(mode ? { mode } : {}),
    }));
    return db
      .insert(importProfiles)
      .values({
        name,
        description: "A document saved before the mode was on the profile.",
        sectionsJson: JSON.stringify(sections),
        statedTotalLabelsJson: JSON.stringify({ summary: "Total" }),
        optionsJson: "{}",
        createdBy: 1,
        updatedBy: 1,
      })
      .returning()
      .get().id;
  }

  it("stores the mode in the profile's options, and no section carries one", async () => {
    const id = saved("Wallet rows", true, everyTransaction);
    const [row] = profileRows().filter((r) => r.id === id);
    expect(JSON.parse(row.optionsJson)).toMatchObject({
      mode: "every_transaction",
    });
    for (const section of JSON.parse(row.sectionsJson) as object[]) {
      expect(section).not.toHaveProperty("mode");
    }
    expect(getImportProfile(db, id)?.mode).toBe("every_transaction");
  });

  it("drops a section mode sent with the profile's own mode", async () => {
    const draft = everyTransaction("Wallet rows");
    const res = await routes.create({
      ...draft,
      sections: draft.sections.map((section) => ({
        ...section,
        mode: "every_transaction",
      })),
    });
    expect(res.status).toBe(201);
    const [row] = profileRows();
    for (const section of JSON.parse(row.sectionsJson) as object[]) {
      expect(section).not.toHaveProperty("mode");
    }
  });

  it("gives a profile saved before the mode existed the mode of its sections", () => {
    const rows = legacy("Wallet rows", [
      "every_transaction",
      "every_transaction",
    ]);
    const summary = legacy("Fee notice", ["summary"]);
    const unset = legacy("Older notice", [undefined, undefined]);
    expect(getImportProfile(db, rows)?.mode).toBe("every_transaction");
    expect(getImportProfile(db, summary)?.mode).toBe("summary");
    // A section with no mode was a Summary section.
    expect(getImportProfile(db, unset)?.mode).toBe("summary");
  });

  it("reads a profile with sections in both modes as Summary, and the editor cannot save it until it is fixed", async () => {
    const id = legacy("Statement", ["summary", "every_transaction"]);
    const view = getImportProfile(db, id)!;
    expect(view.mode).toBe("summary");

    // Saved back as the editor sends it: the Every transaction section is a
    // problem, at its own path, and nothing changes.
    const form = formFromDraft(view);
    expect(form.sections.map((section) => section.legacyMode)).toEqual([
      null,
      "every_transaction",
    ]);
    const refused = await routes.patch(id, payloadFromForm(form));
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      errors: { path: string; message: string }[];
    };
    expect(body.errors.map((error) => error.path)).toEqual([
      "sections[1].mode",
    ]);
    expect(body.errors[0].message).toContain("This profile now reads one way");
    expect(profileAudit()).toHaveLength(0);

    // Kept on purpose: it is read as Summary too, and the save goes through
    // with no section mode left.
    form.sections[1].legacyMode = null;
    const accepted = await routes.patch(id, payloadFromForm(form));
    expect(accepted.status).toBe(200);
    const [row] = profileRows().filter((r) => r.id === id);
    expect(JSON.parse(row.optionsJson)).toMatchObject({ mode: "summary" });
    for (const section of JSON.parse(row.sectionsJson) as object[]) {
      expect(section).not.toHaveProperty("mode");
    }
  });

  it("lets the mixed profile be changed to Every transaction instead", async () => {
    const id = legacy("Statement", ["summary", "every_transaction"]);
    const form = formFromDraft(getImportProfile(db, id)!);
    setKind(form, "transactions");
    const res = await routes.patch(id, payloadFromForm(form));
    expect(res.status).toBe(200);
    expect(getImportProfile(db, id)?.mode).toBe("every_transaction");
  });
});
