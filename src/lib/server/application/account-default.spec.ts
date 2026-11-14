import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DefaultAccountPurpose,
  type AccountTypeCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountEvents } from "../ledger/events.js";
import { localsFor } from "../permissions/test-locals.js";
import {
  accountDefaultId,
  getAccountDefaults,
} from "../services/account-defaults.js";
import { createAccount } from "../services/accounts.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import { accountDefaultVersion, setAccountDefault } from "./accounts.js";

/**
 * `setAccountDefault`: one Settings › Default accounts row, against a migrated
 * in-memory book (`releaseBook`), never `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book;
let announced: unknown[];
const listener = (payload: unknown) => announced.push(payload);

function account(name: string, type: AccountTypeCode) {
  return resultValue(createAccount(book.db, 1, { name, type })).id;
}

beforeEach(() => {
  book = releaseBook();
  // The release book saves three defaults; Settings saves all seven.
  book.db
    .insert(schema.accountDefaults)
    .values([
      {
        purpose: DefaultAccountPurpose.SalesRevenue,
        accountId: account("Sales", AccountType.Revenue),
      },
      {
        purpose: DefaultAccountPurpose.UncategorisedExpense,
        accountId: account("Other expenses", AccountType.Expense),
      },
      {
        purpose: DefaultAccountPurpose.EverydayTransaction,
        accountId: book.bank,
      },
      {
        purpose: DefaultAccountPurpose.UncategorisedIncome,
        accountId: account("Other revenue", AccountType.Revenue),
      },
    ])
    .run();
  announced = [];
  accountEvents.on("accounts-refresh", listener);
});
afterEach(() => {
  accountEvents.off("accounts-refresh", listener);
  book.raw.close();
});

const saved = () =>
  getAccountDefaults(book.db).map((item) => [item.purpose, item.account?.id]);

/** The audit rows a saved-default change writes. */
const defaultAudits = () =>
  book.db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.recordType, "account"),
        like(schema.auditLog.changes, "%savedDefault:%"),
      ),
    )
    .all();

const UNCATEGORISED = DefaultAccountPurpose.UncategorisedExpense;

describe("setAccountDefault", () => {
  it("points one purpose at another account, audited and announced", () => {
    const dedicated = account("Uncategorised", AccountType.Expense);
    const before = accountDefaultId(book.db, UNCATEGORISED)!;
    const others = saved().filter(([purpose]) => purpose !== UNCATEGORISED);

    const result = setAccountDefault(
      book.ctx,
      { purpose: UNCATEGORISED, accountId: dedicated },
      accountDefaultVersion(book.db, UNCATEGORISED),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        purpose: UNCATEGORISED,
        accountId: dedicated,
        previousAccountId: before,
        version: accountDefaultVersion(book.db, UNCATEGORISED),
      },
    });
    expect(accountDefaultId(book.db, UNCATEGORISED)).toBe(dedicated);
    expect(saved().filter(([purpose]) => purpose !== UNCATEGORISED)).toEqual(
      others,
    );
    expect(getAccountDefaults(book.db).every((item) => item.valid)).toBe(true);

    const audits = defaultAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      recordId: String(dedicated),
      action: "update",
      userId: 1,
    });
    expect(JSON.parse(audits[0].changes!)).toEqual([
      { field: `savedDefault:${UNCATEGORISED}`, before, after: dedicated },
    ]);
    expect(announced).toEqual([{ reason: "defaults" }]);
  });

  it("refuses an account that does not suit the purpose, saving nothing", () => {
    const before = saved();
    const result = setAccountDefault(book.ctx, {
      purpose: DefaultAccountPurpose.Payable,
      accountId: book.bank,
    });
    expect(result).toMatchObject({ ok: false, code: "REFUSED" });
    if (result.ok) return;
    expect(result.reason).toMatch(
      /^Account \d+ Bank cannot be the Accounts payable default\. It needs an active liability account that suits that purpose\.$/,
    );
    expect(saved()).toEqual(before);
    expect(defaultAudits()).toHaveLength(0);
    expect(announced).toEqual([]);
  });

  it("refuses a caller without accounts.update", () => {
    const before = saved();
    const result = setAccountDefault(
      {
        db: book.db,
        locals: localsFor(["accounts.read", "settings.manage"]),
      },
      {
        purpose: UNCATEGORISED,
        accountId: account("Uncategorised", AccountType.Expense),
      },
    );
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(saved()).toEqual(before);
    expect(defaultAudits()).toHaveLength(0);
  });

  it("refuses a stale version with the current one", () => {
    const result = setAccountDefault(
      book.ctx,
      {
        purpose: UNCATEGORISED,
        accountId: account("Uncategorised", AccountType.Expense),
      },
      "stale",
    );
    expect(result).toMatchObject({
      ok: false,
      code: "CONFLICT",
      currentVersion: accountDefaultVersion(book.db, UNCATEGORISED),
    });
    expect(defaultAudits()).toHaveLength(0);
  });

  it("saves nothing when the purpose already names the account", () => {
    const current = accountDefaultId(book.db, UNCATEGORISED)!;
    expect(
      setAccountDefault(book.ctx, {
        purpose: UNCATEGORISED,
        accountId: current,
      }),
    ).toMatchObject({
      ok: true,
      value: { accountId: current, previousAccountId: current },
    });
    expect(defaultAudits()).toHaveLength(0);
    expect(announced).toEqual([]);
  });

  it("names another default that is not usable, and works once it is set", () => {
    book.db
      .delete(schema.accountDefaults)
      .where(
        eq(
          schema.accountDefaults.purpose,
          DefaultAccountPurpose.UncategorisedIncome,
        ),
      )
      .run();
    const dedicated = account("Uncategorised", AccountType.Expense);
    const blocked = setAccountDefault(book.ctx, {
      purpose: UNCATEGORISED,
      accountId: dedicated,
    });
    expect(blocked).toEqual({
      ok: false,
      code: "REFUSED",
      reason:
        "The Uncategorised income default names no usable account, and the defaults are saved together. Set the Uncategorised income default first.",
    });

    expect(
      setAccountDefault(book.ctx, {
        purpose: DefaultAccountPurpose.UncategorisedIncome,
        accountId: account("Uncategorised income", AccountType.Revenue),
      }),
    ).toMatchObject({ ok: true, value: { previousAccountId: null } });
    expect(
      setAccountDefault(book.ctx, {
        purpose: UNCATEGORISED,
        accountId: dedicated,
      }).ok,
    ).toBe(true);
  });

  it("refuses a purpose Settings does not offer, and an unknown account", () => {
    expect(
      setAccountDefault(book.ctx, {
        purpose: DefaultAccountPurpose.ReimbursementsPayable,
        accountId: book.bank,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      setAccountDefault(book.ctx, {
        purpose: UNCATEGORISED,
        accountId: 999_999,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
