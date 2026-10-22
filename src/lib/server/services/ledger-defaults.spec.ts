import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultAccountPurpose } from "$lib/enums.js";

const mocks = vi.hoisted(() => ({
  accountRefs: vi.fn(),
  buildMovements: vi.fn(),
  getRecord: vi.fn(),
  insertRecord: vi.fn(),
  kindCodeFor: vi.fn(),
  recordAudit: vi.fn(),
  requireAccountDefault: vi.fn(),
  touchAccounts: vi.fn(),
}));

vi.mock("../audit.js", () => ({
  diffRecords: vi.fn(),
  recordAudit: mocks.recordAudit,
}));
vi.mock("../ledger/entry-builder.js", () => ({
  buildMovements: mocks.buildMovements,
}));
vi.mock("../queries/accounts.js", () => ({
  accountRefs: mocks.accountRefs,
  getAccount: vi.fn(),
}));
vi.mock("../queries/ledger.js", () => ({
  deleteRecord: vi.fn(),
  getRecord: mocks.getRecord,
  getRecordRow: vi.fn(),
  insertRecord: mocks.insertRecord,
  kindCodeFor: mocks.kindCodeFor,
  lockStateFor: vi.fn(),
  snapshotForAudit: vi.fn(),
  updateRecord: vi.fn(),
}));
vi.mock("./accounts.js", () => ({ touchAccounts: mocks.touchAccounts }));
vi.mock("./account-defaults.js", () => ({
  requireAccountDefault: mocks.requireAccountDefault,
  accountDefaultId: vi.fn(),
}));

import { createRecord } from "./ledger.js";

let sqlite: Database;
let db: LedgerDb;
afterEach(() => sqlite.close());

const input = {
  kind: "opening-balance" as const,
  accountId: 11,
  date: "2026-01-01",
  description: "Opening balance",
  amount: 125,
  currency: "MYR",
  exchangeRate: 1,
};

describe("opening-balance saved default integration", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
    migrate(db as never, { migrationsFolder: "drizzle" });
    vi.clearAllMocks();
    mocks.requireAccountDefault.mockReturnValue({ ok: true, value: 73 });
    mocks.accountRefs.mockReturnValue(
      new Map([
        [11, { id: 11, role: 1 }],
        [73, { id: 73, role: 8 }],
      ]),
    );
    mocks.buildMovements.mockImplementation((_input, context) => ({
      ok: true,
      value: [
        { accountId: 11, amountMinor: 12_500, sortOrder: 0 },
        {
          accountId: context.openingBalancesAccountId,
          amountMinor: -12_500,
          sortOrder: 1,
        },
      ],
    }));
    mocks.kindCodeFor.mockReturnValue(5);
    mocks.insertRecord.mockReturnValue({ id: 90 });
    mocks.getRecord.mockReturnValue({ id: 90, movements: [] });
  });

  it("uses the validated saved Opening Balances account for the offset side", () => {
    expect(createRecord(db, 7, input).ok).toBe(true);
    expect(mocks.requireAccountDefault).toHaveBeenCalledWith(
      expect.anything(),
      DefaultAccountPurpose.OpeningBalances,
    );
    expect(mocks.buildMovements).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "opening-balance", accountId: 11 }),
      expect.objectContaining({ openingBalancesAccountId: 73 }),
    );
    expect(mocks.insertRecord).toHaveBeenCalledWith(
      expect.anything(),
      7,
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ accountId: 73, amountMinor: -12_500 }),
      ]),
    );
  });

  it("refuses an invalid or missing saved default before inserting anything", () => {
    mocks.requireAccountDefault.mockReturnValue({
      ok: false,
      reason: "Choose a valid opening balances account.",
    });

    expect(createRecord(db, 7, input)).toEqual({
      ok: false,
      reason: "Choose a valid opening balances account.",
    });
    expect(mocks.buildMovements).not.toHaveBeenCalled();
    expect(mocks.insertRecord).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
