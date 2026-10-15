import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSubType,
  AccountType,
  DocumentType,
  ImportState,
  LedgerRecordKind,
} from "$lib/enums.js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import {
  accounts,
  importItems,
  importQueue,
  ledgerMovements,
  ledgerRecords,
  users,
} from "../db/schema.js";
import { createAccount } from "../services/accounts.js";
import { canonicalAccountId, openingBalanceFor } from "../queries/accounts.js";
import { getRecord, listRecords } from "../queries/ledger.js";
import { loadImportDetail } from "./import.js";

// The import loader is reached directly (see "import group detail" below), so
// the modules that would open the real book or read its settings are replaced:
// `db/client.js` hands out this spec's own in-memory database, and the storage
// paths point nowhere. Nothing here can touch `data/`.
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

/**
 * What the detail loaders promise, tested against the queries they are built
 * from rather than through the loaders themselves — `loaders/*.ts` import
 * `db/client.js`, which opens the real book on import (CLAUDE.md § Verification
 * Policy), so a spec must never reach them unmocked. The import loader is the
 * exception: it takes its database as an argument, and `db/client.js` is
 * mocked above, so it runs against this spec's own database.
 *
 * The case that matters most is the first one. Both `/records/[id]` and
 * `/accounts/[id]` used to be served by the *list* loader, which fetched the
 * newest 1000 rows and then refused anything it had not fetched:
 *
 *   if (openId !== null && !records.some((r) => r.id === openId))
 *     throw redirect(302, LIST_PATH);
 *
 * So a link to an older record redirected to the list — silently, and more often
 * the longer the book got. `getRecord(db, id)` has no such horizon.
 */

let sqlite: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "q@test", username: "q", passwordHash: "x" })
    .run();
  holder.db = db;
  holder.allow = () => true;
});
afterEach(() => {
  holder.db = null;
  sqlite.close();
});

/** A balanced two-sided record, the way the entry builder writes them. */
function writeRecord(
  fromAccountId: number,
  toAccountId: number,
  amountMinor: number,
  date = "2026-01-01",
  kind: number = LedgerRecordKind.Journal,
): number {
  const record = db
    .insert(ledgerRecords)
    .values({
      kind,
      date,
      description: "test",
      amount: amountMinor / 100,
      createdBy: 1,
      updatedBy: 1,
    })
    .returning()
    .get();
  db.insert(ledgerMovements)
    .values([
      {
        recordId: record.id,
        accountId: fromAccountId,
        amountMinor: -amountMinor,
        sortOrder: 0,
      },
      {
        recordId: record.id,
        accountId: toAccountId,
        amountMinor,
        sortOrder: 1,
      },
    ])
    .run();
  return record.id;
}

describe("record detail", () => {
  it("GetRecord_WhenOlderThanTheListPage_ShouldStillResolve", () => {
    const cash = createAccount(db, 1, { name: "Cash", type: AccountType.Asset, subType: AccountSubType.Cash });
    const fuel = createAccount(db, 1, {
      name: "Fuel",
      type: AccountType.Expense,
    });
    expect(cash.ok && fuel.ok).toBe(true);
    if (!cash.ok || !fuel.ok) return;

    // The first record written is the oldest, so it is the one a paged list
    // would drop first.
    const oldest = writeRecord(cash.value.id, fuel.value.id, 1000, "2020-01-01");
    for (let i = 0; i < 5; i++) {
      writeRecord(cash.value.id, fuel.value.id, 100, "2026-01-0" + (i + 1));
    }

    // What the list loader can see, with a page smaller than the book.
    const page = listRecords(db, { limit: 3 }).records;
    expect(page.some((r) => r.id === oldest)).toBe(false);

    // What the detail loader sees.
    expect(getRecord(db, oldest)?.id).toBe(oldest);
  });

  it("GetRecord_WhenIdIsUnknown_ShouldReturnNullSoTheLoaderCanRedirect", () => {
    expect(getRecord(db, 9999)).toBeNull();
  });

  it("GetRecord_ShouldCarryBothSides_SoThePageCanShowTheEntry", () => {
    const cash = createAccount(db, 1, { name: "Cash", type: AccountType.Asset, subType: AccountSubType.Cash });
    const fuel = createAccount(db, 1, {
      name: "Fuel",
      type: AccountType.Expense,
    });
    if (!cash.ok || !fuel.ok) return;
    const id = writeRecord(cash.value.id, fuel.value.id, 1240);

    const record = getRecord(db, id);
    expect(record?.movements).toHaveLength(2);
    // The invariant the entry block draws.
    expect(
      record?.movements.reduce((sum, m) => sum + m.amountMinor, 0),
    ).toBe(0);
  });
});

describe("account detail", () => {
  it("CanonicalAccountId_WhenMerged_ShouldNameTheSurvivor", () => {
    const survivor = createAccount(db, 1, {
      name: "Bank",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    const merged = createAccount(db, 1, {
      name: "Bank (old)",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    if (!survivor.ok || !merged.ok) return;

    db.update(accounts)
      .set({ mergedIntoAccountId: survivor.value.id, active: false })
      .where(eq(accounts.id, merged.value.id))
      .run();

    // `/accounts/<merged id>` must land on the survivor's page, not on an empty
    // one. The redirect lives in `loadAccountDetail` so there is one place that
    // decides which id is the real one.
    expect(canonicalAccountId(db, merged.value.id)).toBe(survivor.value.id);
    expect(canonicalAccountId(db, survivor.value.id)).toBe(survivor.value.id);
    expect(canonicalAccountId(db, 9999)).toBeNull();
  });

  it("OpeningBalanceFor_WhenNoneIsSet_ShouldBeNull", () => {
    const cash = createAccount(db, 1, { name: "Cash", type: AccountType.Asset, subType: AccountSubType.Cash });
    if (!cash.ok) return;
    expect(openingBalanceFor(db, cash.value.id)).toBeNull();
  });

  it("RecentMovements_ShouldBeNewestFirst_NotOldest", () => {
    const cash = createAccount(db, 1, { name: "Cash", type: AccountType.Asset, subType: AccountSubType.Cash });
    const fuel = createAccount(db, 1, {
      name: "Fuel",
      type: AccountType.Expense,
    });
    if (!cash.ok || !fuel.ok) return;
    writeRecord(cash.value.id, fuel.value.id, 100, "2020-01-01");
    writeRecord(cash.value.id, fuel.value.id, 200, "2026-08-01");

    // `accountHistory` orders oldest-first by design so its running balance can
    // accumulate; the page's "recent movements" card must not use it.
    const recent = listRecords(db, { accountId: cash.value.id, limit: 1 });
    expect(recent.records[0].date).toBe("2026-08-01");
    expect(recent.total).toBe(2);
  });
});

describe("import group detail", () => {
  const locals = { user: { id: 1 } } as unknown as App.Locals;

  /** What a loader threw: SvelteKit's redirect is thrown, not returned. */
  function thrown(run: () => unknown): unknown {
    try {
      run();
    } catch (caught) {
      return caught;
    }
    return undefined;
  }

  function queueRow(id: string, state: number, readAs: string | null) {
    db.insert(importQueue)
      .values({
        id,
        createdBy: 1,
        state,
        tempFilePath: `/dev/null/${id}.pdf`,
        originalFilename: `${id}.pdf`,
        readAs,
      })
      .run();
  }

  function item(jobId: string, id: string, position: number, state: number) {
    db.insert(importItems)
      .values({
        id,
        jobId,
        state,
        position,
        sectionKey: "items",
        documentType: DocumentType.Expense,
        itemName: `Fee ${position + 1}`,
        amount: 10,
        currency: "MYR",
      })
      .run();
  }

  it("LoadImportDetail_WhenIdIsUnknown_ShouldRedirectToTheQueue", () => {
    expect(thrown(() => loadImportDetail(locals, "no-such-job"))).toMatchObject(
      { status: 302, location: "/import" },
    );
  });

  it("LoadImportDetail_WithoutImportView_ShouldRedirectBeforeReadingAnything", () => {
    queueRow("group", ImportState.Grouped, "items");
    item("group", "a", 0, ImportState.PendingReview);
    const asked: string[] = [];
    holder.allow = (resource, action) => {
      asked.push(`${resource}.${action}`);
      return false;
    };

    expect(thrown(() => loadImportDetail(locals, "group"))).toMatchObject({
      status: 302,
      location: "/dashboard",
    });
    // The same ability the queue needs, and no new one (FR-045).
    expect(asked).toEqual(["import.view"]);
  });

  it("LoadImportDetail_WhenTheJobIsAReceipt_ShouldRedirectToTheQueue", () => {
    // A receipt is reviewed on the queue; it has no items and no page.
    queueRow("receipt", ImportState.PendingReview, "receipt");
    expect(thrown(() => loadImportDetail(locals, "receipt"))).toMatchObject({
      status: 302,
      location: "/import",
    });
  });

  it("LoadImportDetail_ForAGroup_ShouldSendTheJobWithoutTextAndEveryItemInOrder", () => {
    queueRow("group", ImportState.Grouped, "items");
    db.update(importQueue)
      .set({ extractedText: "the whole document" })
      .where(eq(importQueue.id, "group"))
      .run();
    item("group", "c", 2, ImportState.Skipped);
    item("group", "a", 0, ImportState.PendingReview);
    item("group", "b", 1, ImportState.Imported);
    holder.allow = (_resource, action) => action !== "delete";

    const loaded = loadImportDetail(locals, "group");

    expect(loaded.job.id).toBe("group");
    expect("extractedText" in loaded.job).toBe(false);
    expect(loaded.job.itemCounts).toMatchObject({ confirmed: 1, skipped: 1 });
    expect(loaded.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(loaded.perms).toEqual({
      change: true,
      confirm: true,
      delete: false,
      readAgain: true,
    });
  });

  it("LoadImportDetail_WhenEveryItemIsDone_ShouldStillOpenThePage", () => {
    // A finished group is Imported, not Grouped, and its page still says what
    // became of each item, each confirmed one linking to its record.
    queueRow("done", ImportState.Imported, "items");
    item("done", "a", 0, ImportState.Imported);
    expect(loadImportDetail(locals, "done").items).toHaveLength(1);
  });
});
