import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountDefaults, accounts, auditLog, users } from "../db/schema.js";
import { DefaultAccountPurpose } from "$lib/enums.js";
import { getAccount } from "../queries/accounts.js";
import { eq } from "drizzle-orm";
import { createAccount, patchAccount, removeAccount } from "./accounts.js";
import { accountEvents } from "../ledger/events.js";
import type { LedgerDb } from "../ledger/types.js";

let sqlite: Database;
let db: LedgerDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "owner@test", username: "owner", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

describe("account service", () => {
  it("Create_WhenFixedAsset_ShouldAllowPostingAccount", () => {
    const created = createAccount(db, 1, {
      name: "Production machine",
      type: AccountType.Asset,
      subType: AccountSubType.FixedAsset,
    });
    expect(created.ok).toBe(true);
    expect(created.ok && created.value.subType).toBe(AccountSubType.FixedAsset);
  });

  it("Create_WhenNamesRepeat_ShouldAssignDistinctLowestCodes", () => {
    const first = createAccount(db, 1, {
      name: "Savings",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    const second = createAccount(db, 1, {
      name: "Savings",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    expect(first.ok && first.value.code).toBe(1000);
    expect(second.ok && second.value.code).toBe(1001);
  });

  it("Create_WhenCodeIsExplicit_ShouldSaveItAndPreserveAutomaticAllocation", () => {
    const chosen = createAccount(db, 1, {
      name: "Savings",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
      code: 1234,
    });
    expect(chosen.ok && chosen.value.code).toBe(1234);
    const automatic = createAccount(db, 1, {
      name: "Cash",
      type: AccountType.Asset,
      subType: AccountSubType.Cash,
    });
    expect(automatic.ok && automatic.value.code).toBe(1000);
  });

  it("Create_WhenCodeIsUsedEvenByArchivedAccount_ShouldRefuseWithoutWrites", () => {
    const created = createAccount(db, 1, {
      name: "Old bank",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
      code: 1234,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.update(accounts)
      .set({ archivedAt: "2026-01-01" })
      .where(eq(accounts.id, created.value.id))
      .run();
    const auditsBefore = db.select().from(auditLog).all().length;
    expect(
      createAccount(db, 1, {
        name: "New bank",
        type: AccountType.Asset,
        subType: AccountSubType.Bank,
        code: 1234,
      }),
    ).toEqual({ ok: false, reason: "That code is already in use." });
    expect(db.select().from(accounts).all()).toHaveLength(1);
    expect(db.select().from(auditLog).all()).toHaveLength(auditsBefore);
  });

  it("Create_WhenCodeIsInvalidForSubmittedType_ShouldRefuseWithoutWrites", () => {
    for (const code of [999, 2000, 1234.5, NaN, Infinity]) {
      expect(
        createAccount(db, 1, {
          name: "Invalid",
          type: AccountType.Asset,
          subType: AccountSubType.Bank,
          code,
        }),
      ).toEqual({
        ok: false,
        reason: "Code must be between 1000 and 1999 for this account type.",
      });
    }
    // A code entered for Asset must be revalidated if the user submits Liability.
    expect(
      createAccount(db, 1, {
        name: "Loan",
        type: AccountType.Liability,
        subType: AccountSubType.ShortTermLoan,
        code: 1234,
      }).ok,
    ).toBe(false);
    expect(db.select().from(accounts).all()).toHaveLength(0);
    expect(db.select().from(auditLog).all()).toHaveLength(0);
  });

  it("Patch_WhenUnusedTypeChanges_ShouldAllocateInNewRange", () => {
    const created = createAccount(db, 1, {
      name: "Loan",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const changed = patchAccount(db, created.value.id, 1, {
      type: AccountType.Liability,
    });
    expect(changed.ok && changed.value.type).toBe(AccountType.Liability);
    expect(changed.ok && changed.value.code).toBe(2000);
  });

  it("Delete_WhenEventEmits_ShouldHaveCommittedAudit", () => {
    const created = createAccount(db, 1, {
      name: "Temporary",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let auditWasVisible = false;
    const onDeleted = ({ id }: { id: number }) => {
      if (id !== created.value.id) return;
      auditWasVisible = db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.recordId, String(id)))
        .all()
        .some((row: { action: string }) => row.action === "delete");
    };
    accountEvents.on("account-deleted", onDeleted);
    try {
      expect(removeAccount(db, created.value.id, 1).ok).toBe(true);
    } finally {
      accountEvents.off("account-deleted", onDeleted);
    }

    expect(auditWasVisible).toBe(true);
  });

  it("Archive_WhenSavedDefaultUsesAccount_ShouldRefuse", () => {
    const created = createAccount(db, 1, {
      name: "Bank",
      type: AccountType.Asset,
      subType: AccountSubType.Bank,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    db.insert(accountDefaults)
      .values({
        purpose: DefaultAccountPurpose.EverydayTransaction,
        accountId: created.value.id,
        updatedBy: 1,
      })
      .run();
    expect(patchAccount(db, created.value.id, 1, { active: false })).toEqual({
      ok: false,
      reason:
        "Choose a replacement saved default before deactivating this account.",
    });
  });

  it("CanonicalRead_WhenSourceWasMerged_ShouldResolveSurvivor", () => {
    const survivor = createAccount(db, 1, {
      name: "Sales",
      type: AccountType.Revenue,
    });
    const source = createAccount(db, 1, {
      name: "Old Sales",
      type: AccountType.Revenue,
    });
    if (!survivor.ok || !source.ok) return;
    db.update(accounts)
      .set({ mergedIntoAccountId: survivor.value.id, archivedAt: "2026-01-01" })
      .where(eq(accounts.id, source.value.id))
      .run();
    expect(getAccount(db, source.value.id)?.id).toBe(survivor.value.id);
  });
});
