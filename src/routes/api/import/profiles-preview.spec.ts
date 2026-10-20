import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdtempSync, rmSync } from "fs";
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
import type { ProfileDraftId } from "$lib/server/import/__fixtures__/profile-drafts.js";

/**
 * The profile editor's preview of a sample spreadsheet (006 S4.7, FR-053 to
 * FR-055): `POST /api/import/profiles/preview`.
 *
 * The route imports the singleton `db`, which opens DATABASE_PATH at import
 * time, so that module is mocked with a database file under `os.tmpdir()`,
 * migrated from `drizzle/`. The storage path is mocked to a folder there too,
 * which the tests check is never made: the preview stores nothing.
 * Permissions are mocked so each test can say what the caller may do. Every
 * workbook is built in memory with made-up values.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-profile-preview-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
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

const { profileDraft } =
  await import("$lib/server/import/__fixtures__/profile-drafts.js");
const { formFromDraft, payloadFromForm } =
  await import("$lib/import-profile-form.js");
const schema = await import("$lib/server/db/schema.js");
const { auditLog, importProfiles, importQueue, users } = schema;
const { walletWorkbook } =
  await import("$lib/server/import/__fixtures__/wallet-table.js");
const { setSetting, SETTING_KEYS } = await import("$lib/server/settings.js");
type LedgerDb = import("$lib/server/ledger/types.js").LedgerDb;

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
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

type Handler = (event: never) => Promise<Response> | Response;

/** The editor's payload for a draft, as it is before any field is filled in. */
function editorPayload(id: ProfileDraftId) {
  return payloadFromForm(formFromDraft(profileDraft(id)));
}

async function preview(
  file: { name: string; data: Buffer | string } | null,
  profile: unknown,
  extra: Record<string, string> = {},
  locals: unknown = { user: { id: 1 } },
) {
  const body = new FormData();
  if (file) {
    const part =
      typeof file.data === "string" ? file.data : new Uint8Array(file.data);
    body.set("file", new File([part], file.name));
  }
  body.set("profile", JSON.stringify(profile));
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  const { POST } = await import("./profiles/preview/+server.js");
  return (POST as Handler)({
    locals,
    request: new Request("http://test.local/api/import/profiles/preview", {
      method: "POST",
      body,
    }),
  } as never);
}

function storedNothing() {
  expect(db.select().from(importQueue).all()).toEqual([]);
  expect(db.select().from(importProfiles).all()).toEqual([]);
  expect(db.select().from(auditLog).all()).toEqual([]);
  expect(existsSync(holder.storageRoot)).toBe(false);
}

// A sample the size of the real report is read whole, twice, which is slow
// when the whole suite runs at once.
describe("POST /api/import/profiles/preview", { timeout: 30_000 }, () => {
  it("needs a signed-in user who may change imports", async () => {
    // Refused before the file is read, so any file will do.
    const file = { name: "wallet.csv", data: "Date\n" };
    const payload = editorPayload("wallet_withdrawals");
    expect((await preview(file, payload, {}, {})).status).toBe(401);

    holder.allow = (_resource, action) => action === "view";
    expect((await preview(file, payload)).status).toBe(403);
    storedNothing();
  });

  it("filters assigned rows in an unsaved profile and reports ignored rows", async () => {
    const report = walletWorkbook();
    const form = formFromDraft(profileDraft("wallet_withdrawals"));
    form.sections[0].rows!.filter = [
      {
        uid: "status-filter",
        column: "Status",
        op: "is",
        value: "Transaction Completed",
        valuesText: "",
      },
    ];
    const res = await preview(
      { name: "wallet.xlsx", data: report.xlsx },
      payloadFromForm(form),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ itemCount: 9, ignoredCount: 727 });
    storedNothing();
  });

  it("reads a sample with an unsaved profile, before its accounts are chosen, and stores nothing", async () => {
    const report = walletWorkbook();
    const res = await preview(
      { name: "wallet.xlsx", data: report.xlsx },
      editorPayload("wallet_withdrawals"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "every_transaction",
      sheet: "Transaction Report",
      headerRow: report.headerRow,
      rows: report.rows,
      sections: [
        {
          key: "withdrawals",
          name: "Withdrawals",
          kind: "transfer",
          count: 10,
        },
      ],
      itemCount: 10,
      ignoredCount: 726,
      statedTotalMinor: null,
      balance: { matches: true },
    });
    expect(body.items).toHaveLength(10);
    expect(body.items[0]).toMatchObject({
      section: "Withdrawals",
      kind: "transfer_out",
      reference: "",
    });
    // Excel's own row numbers, below the headings.
    expect(body.items[0].row).toBeGreaterThan(report.headerRow);
    expect(
      body.items.filter((item: { note: string | null }) => item.note),
    ).toHaveLength(0);
    storedNothing();
  });

  it("totals every transaction against the stated total", async () => {
    const report = walletWorkbook();
    const res = await preview(
      { name: "wallet.xlsx", data: report.xlsx },
      editorPayload("wallet_every_transaction"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemCount).toBe(report.rows);
    expect(body.items).toHaveLength(10);
    expect(body.statedTotalMinor).toBe(
      report.moneyInMinor + report.moneyOutMinor,
    );
    expect(body.itemsTotalMinor).toBe(body.statedTotalMinor);
    expect(
      body.sections
        .map((s: { count: number }) => s.count)
        .reduce((a: number, b: number) => a + b),
    ).toBe(report.rows);
  });

  it("names a layout or row-rule problem with its path", async () => {
    const payload = editorPayload("wallet_withdrawals") as {
      layout: { columns: { amount: string } };
    };
    payload.layout.columns.amount = "Total";
    const res = await preview(
      { name: "wallet.xlsx", data: walletWorkbook().xlsx },
      payload,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.map((e: { path: string }) => e.path)).toEqual([
      "layout.columns.amount",
    ]);
    storedNothing();
  });

  it("says when the table is not in the sample, as the reading would", async () => {
    const res = await preview(
      { name: "other.csv", data: "Date,Amount\n2026-03-01,5.00\n" },
      editorPayload("wallet_withdrawals"),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(
      /was not found in this spreadsheet/,
    );
  });

  it("refuses a file that is not a spreadsheet, or none", async () => {
    const pdf = await preview(
      { name: "statement.pdf", data: "%PDF-1.4\n%%EOF" },
      editorPayload("wallet_withdrawals"),
    );
    expect(pdf.status).toBe(400);
    expect((await pdf.json()).error).toMatch(/\.xlsx\) or a CSV file/);
    expect(
      (await preview(null, editorPayload("wallet_withdrawals"))).status,
    ).toBe(400);
    storedNothing();
  });

  it("reads in the profile's own mode, and does not read a mode field", async () => {
    const res = await preview(
      { name: "wallet.xlsx", data: walletWorkbook().xlsx },
      editorPayload("wallet_withdrawals"),
      { mode: "summary" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "every_transaction",
      itemCount: 10,
    });
  });

  it("refuses a section saved in the other mode until it is moved or kept (FR-032)", async () => {
    const payload = editorPayload("wallet_withdrawals") as {
      sections: Record<string, unknown>[];
    };
    // As a profile saved when each section had its own mode sends it.
    payload.sections[0].mode = "summary";
    const res = await preview(
      { name: "wallet.xlsx", data: walletWorkbook().xlsx },
      payload,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.map((e: { path: string }) => e.path)).toEqual([
      "sections[0].mode",
    ]);
    storedNothing();
  });
});
