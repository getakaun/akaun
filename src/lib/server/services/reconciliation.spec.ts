import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType, LiabilitySubType } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { users } from "../db/schema.js";
import { createAccount, patchAccount } from "./accounts.js";
import { createStatement, ReconciliationError } from "./reconciliation.js";
import { localsFor } from "../permissions/test-locals.js";

let sqlite: Database; let db: any;
const locals = localsFor([], { superuser: true });
beforeEach(()=>{sqlite=new Database(":memory:");db=drizzle(sqlite,{schema});migrate(db,{migrationsFolder:"drizzle"});db.insert(users).values({email:"r@test",username:"r",passwordHash:"x"}).run();});
afterEach(()=>sqlite.close());

describe("statement account eligibility",()=>{
  it("Create_WhenLeafIsAnyFixedType_ShouldAcceptIt",()=>{
    for(const type of [AccountType.Asset,AccountType.Liability,AccountType.Equity,AccountType.Revenue,AccountType.Expense]){
      const subType=type===AccountType.Asset?AccountSubType.Bank:type===AccountType.Liability?LiabilitySubType.AccountsPayable:undefined;
      const account=createAccount(db,1,{name:`Type ${type}`,type,subType}); expect(account.ok).toBe(true); if(!account.ok)continue;
      expect(createStatement(db,locals,{originalFilename:`${type}.pdf`,storedFilePath:`${type}.pdf`,accountId:account.value.id}).accountId).toBe(account.value.id);
    }
  });
  it("Create_WhenAccountIsInactive_ShouldRefusePlainly",()=>{
    const account=createAccount(db,1,{name:"Old bank",type:AccountType.Asset,subType:AccountSubType.Bank}); expect(account.ok).toBe(true); if(!account.ok)return;
    expect(patchAccount(db,account.value.id,1,{active:false}).ok).toBe(true);
    expect(()=>createStatement(db,locals,{originalFilename:"x.pdf",storedFilePath:"x.pdf",accountId:account.value.id})).toThrowError(new ReconciliationError("Choose an active account for this statement.",409));
  });
});
