import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  AccountSubType,
  AccountType,
  DocumentType,
  ImportState,
  LedgerRecordKind,
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import { parseChanges } from "../audit.js";
import { runInAuditScope, scopeFromLocals } from "../audit-context.js";
import { ledgerEvents } from "../ledger/events.js";
import type { LedgerDb } from "../ledger/types.js";
import { createServerV2 } from "../mcp/registry.js";
import { READ_TOOLS } from "../mcp/tools/reads/index.js";
import { WRITE_TOOLS } from "../mcp/tools/writes/index.js";
import { localsFor } from "../permissions/test-locals.js";
import {
  getRecord,
  insertRecord,
  updateRecord as queryUpdate,
} from "../queries/ledger.js";
import {
  expenseTaxReport,
  expenseTaxCsv,
} from "../queries/expense-tax-report.js";
import { balanceSheetReport, profitLossReport } from "../queries/reports.js";
import { createAccount } from "../services/accounts.js";
import { confirmImportRow } from "../services/import.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { updateAccount } from "./accounts.js";
import {
  closeMonth,
  closingPage,
  previewClosing,
  reopenMonths,
} from "./closing.js";
import type { AppContext } from "./context.js";
import { toResponse } from "./http.js";
import { deleteRecord, patchSchema, updateRecord } from "./records.js";
import type { AppResult } from "./result.js";
import { recordVersion } from "./version.js";

let sqlite: Database;
let db: LedgerDb;
let expense: number;
let bank: number;
const roots: string[] = [];
const boundary = "2026-01-31";
const ctx = (permissions: string[] = [...LEAF_PERMISSIONS]): AppContext => ({
  db,
  locals: localsFor(permissions, { userId: 1 }),
});
function value<T>(result: AppResult<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function entry(date = "2026-01-15") {
  return insertRecord(
    db,
    1,
    {
      kind: LedgerRecordKind.Journal,
      date,
      description: "Business expense",
      amount: 1000,
      currency: "MYR",
      exchangeRate: 1,
    },
    [
      {
        accountId: expense,
        amountMinor: 100000,
        sortOrder: 0,
        label: "Business use",
      },
      { accountId: bank, amountMinor: -100000, sortOrder: 1, label: null },
    ],
  );
}
function override(percentageBps = 2500) {
  return {
    accountId: expense,
    occurrence: 0,
    percentageBps,
    treatment: "partial" as const,
    reason: "Verified business use against receipt",
  };
}
function report() {
  return expenseTaxReport(db, "2026-01-01", boundary);
}
function financials() {
  return {
    pnl: profitLossReport(db, "2026-01-01", boundary),
    balance: balanceSheetReport(db, boundary),
  };
}
function snapshot() {
  return {
    records: db.select().from(schema.ledgerRecords).all(),
    movements: db.select().from(schema.ledgerMovements).all(),
    audit: db.select().from(schema.auditLog).all(),
    settings: db.select().from(schema.settings).all(),
    sequences: db.select().from(schema.appSequences).all(),
    imports: db.select().from(schema.importQueue).all(),
    contacts: db.select().from(schema.contacts).all(),
  };
}
function close() {
  const review = value(previewClosing(ctx(), { monthEnd: boundary }));
  return value(
    closeMonth(ctx(), { monthEnd: boundary, revision: review.revision }),
  );
}
function reopen(
  context = ctx(),
  reason = "Correct January classification against the original receipt",
) {
  return reopenMonths(context, {
    fromMonth: "2026-01",
    expectedClosedThrough: boundary,
    reason,
  });
}
function tax(id: number) {
  return getRecord(db, id)!.movements.find((m) => m.accountId === expense)!
    .taxClassification;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({
      id: 1,
      email: "tax-close@test",
      username: "tax-close",
      passwordHash: "x",
    })
    .run();
  const a = createAccount(db, 1, {
    name: "Business costs",
    type: AccountType.Expense,
    defaultTaxPercentageBps: 5000,
  });
  const b = createAccount(db, 1, {
    name: "Bank",
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  });
  if (!a.ok || !b.ok) throw new Error("Account fixture failed");
  expense = a.value.id;
  bank = b.value.id;
});
afterEach(() => {
  sqlite.close();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("phase 2 tax classification and audited month closing", () => {
  it("keeps January snapshots, report and CSV stable after a March default change", () => {
    const january = entry();
    const before = report();
    const csv = expenseTaxCsv(before);
    const books = financials();
    close();
    value(updateAccount(ctx(), expense, { defaultTaxPercentageBps: 10000 }));
    const march = entry("2026-03-15");
    expect(tax(january.id)?.percentageBps).toBe(5000);
    expect(tax(march.id)?.percentageBps).toBe(10000);
    expect(report()).toEqual(before);
    expect(expenseTaxCsv(report())).toEqual(csv);
    expect(financials()).toEqual(books);
    expect(report()).toMatchObject({
      expenseMinor: 100000,
      deductibleMinor: 50000,
      addBackMinor: 50000,
    });
  });

  it("retains override provenance and close/reopen/correct/re-close evidence without changing the journal amounts", () => {
    const row = entry();
    const context = ctx();
    runInAuditScope(
      scopeFromLocals(context.locals, "PATCH /api/records/:id"),
      () =>
        value(updateRecord(context, row.id, { taxOverrides: [override()] })),
    );
    const original = tax(row.id);
    const movements = getRecord(db, row.id)!.movements.map(
      ({ id, accountId, amountMinor }) => ({ id, accountId, amountMinor }),
    );
    const books = financials();
    close();
    expect(tax(row.id)).toEqual(original);
    const beforeDenied = snapshot();
    expect(reopen(ctx(["reports.read", "records.update"]))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(reopen(ctx(), "")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(snapshot()).toEqual(beforeDenied);
    const reason = "Correct business-use percentage from receipt evidence";
    value(reopen(context, reason));
    expect(getRecord(db, row.id)?.periodClosedThrough).toBeNull();
    runInAuditScope(
      scopeFromLocals(context.locals, "PATCH /api/records/:id"),
      () =>
        value(
          updateRecord(context, row.id, { taxOverrides: [override(7500)] }),
        ),
    );
    close();
    expect(tax(row.id)).toMatchObject({
      percentageBps: 7500,
      classifiedBy: 1,
      provenance: "line_override",
    });
    expect(getRecord(db, row.id)?.periodClosedThrough).toBe(boundary);
    expect(
      getRecord(db, row.id)!.movements.map(
        ({ id, accountId, amountMinor }) => ({ id, accountId, amountMinor }),
      ),
    ).toEqual(movements);
    expect(financials()).toEqual(books);
    expect(report()).toMatchObject({
      deductibleMinor: 75000,
      addBackMinor: 25000,
    });
    const history = value(closingPage(context)).history;
    expect(history.map((h) => h.action)).toEqual(["close", "reopen", "close"]);
    expect(history[1]).toMatchObject({ before: boundary, after: null, reason });
    const edits = db
      .select()
      .from(schema.auditLog)
      .all()
      .filter(
        (a) => a.recordType === "record" && a.recordId === String(row.id),
      );
    expect(edits).toHaveLength(2);
    expect(edits.every((a) => a.userId === 1 && a.via === "session")).toBe(
      true,
    );
    const changes = parseChanges(edits[1].changes)!;
    const changed = changes.find((c) => c.field === "movements")!;
    expect(JSON.stringify(changed.before)).toContain(JSON.stringify(original));
    expect(JSON.stringify(changed.after)).toContain("7500");
    expect(JSON.stringify(changed.after)).toContain(override().reason);
    expect(() =>
      queryUpdate(db, row.id, 1, { taxOverrides: [override()] }),
    ).toThrow("closed through");
  });

  it.each(["override", "empty", "move-to-open-month", "adopt-default"])(
    "refuses HTTP-shaped tax patches on closed entries atomically: %s",
    async (scenario) => {
      // This is the exact parser, operation and response adapter used by PATCH /api/records/[id].
      const row = entry();
      const patch = {
        ...(scenario === "move-to-open-month" ? { date: "2026-03-01" } : {}),
        taxOverrides:
          scenario === "empty"
            ? []
            : [
                scenario === "adopt-default"
                  ? {
                      ...override(),
                      source: "account_default" as const,
                      percentageBps: 5000,
                    }
                  : override(),
              ],
      };
      close();
      const before = snapshot();
      const version = recordVersion(db, row.id);
      const events: unknown[] = [];
      const listener = (event: unknown) => events.push(event);
      ledgerEvents.on("record-update", listener);
      try {
        const response = toResponse(
          updateRecord(ctx(), row.id, patchSchema.parse(patch)),
        );
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain(
          `closed through ${boundary}`,
        );
        expect(snapshot()).toEqual(before);
        expect(recordVersion(db, row.id)).toBe(version);
        expect(events).toEqual([]);
      } finally {
        ledgerEvents.off("record-update", listener);
      }
    },
  );

  it("refuses bulk deletion and low-level replacement of closed classified lines", () => {
    const rows = [entry(), entry()];
    close();
    const before = snapshot();
    for (const row of rows) {
      expect(deleteRecord(ctx(), row.id)).toMatchObject({
        ok: false,
        code: "REFUSED",
      });
      expect(() =>
        queryUpdate(db, row.id, 1, {}, [
          {
            accountId: expense,
            amountMinor: 100000,
            sortOrder: 0,
            label: "Changed label",
          },
          { accountId: bank, amountMinor: -100000, sortOrder: 1, label: null },
        ]),
      ).toThrow("closed through");
    }
    expect(snapshot()).toEqual(before);
  });

  it("refuses MCP tax overrides and adopting current defaults after a concurrent close", async () => {
    const row = entry();
    const version = recordVersion(db, row.id);
    const root = mkdtempSync(join(tmpdir(), "akaun-tax-mcp-"));
    roots.push(root);
    const server = createServerV2({
      ...ctx(),
      storageRoot: root,
      store: new LocalBlobStore(root),
      tools: { reads: READ_TOOLS, writes: WRITE_TOOLS },
    });
    const client = new Client({ name: "tax-close-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    close();
    const before = snapshot();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      // v2 sets a line's tax through akaun_change_records. It has no
      // per-line "adopt the account default" source: that is
      // akaun_change_accounts apply_tax_default, which leaves closed lines
      // alone. The second item is the other shape a line can take.
      for (const tax of [
        {
          treatment: "partial",
          percent: "25",
          reason: override().reason,
        },
        { treatment: "non_deductible", reason: override().reason },
      ]) {
        for (const dry_run of [true, false]) {
          const response = (await client.callTool({
            name: "akaun_change_records",
            arguments: {
              update: [
                {
                  record: row.id,
                  expected_version: version,
                  set: { tax: [{ line: 0, ...tax }] },
                  reason: "Verified business use against receipt",
                },
              ],
              dry_run,
            },
          })) as { isError?: boolean; content: { text?: string }[] };
          expect(response.isError).toBe(true);
          const error = JSON.parse(response.content[0].text!).error;
          // Refused before anything runs, naming the blocked field and
          // that a person must reopen the month.
          expect(error.code).toBe("REFUSED");
          expect(error.items[0].error).toMatchObject({
            code: "REFUSED",
            message: expect.stringContaining(`closed through ${boundary}`),
            blocked: [
              expect.objectContaining({
                field: "tax",
                fix: expect.stringMatching(/reopen that month in Akaun/),
              }),
            ],
          });
        }
      }
      expect(snapshot()).toEqual(before);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rolls back closed-date import confirmation, preserving existing snapshots, receipt and queue", () => {
    entry();
    const root = mkdtempSync(join(tmpdir(), "akaun-tax-import-"));
    roots.push(root);
    const jobId = crypto.randomUUID();
    const tempFilePath = `import/temp/${jobId}_receipt.pdf`;
    const source = join(root, tempFilePath);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "%PDF-1.4 receipt");
    db.insert(schema.importQueue)
      .values({
        id: jobId,
        createdBy: 1,
        state: ImportState.PendingReview,
        tempFilePath,
        originalFilename: "receipt.pdf",
        documentType: DocumentType.Expense,
      })
      .run();
    close();
    const before = snapshot();
    const totals = report();
    const result = confirmImportRow(
      db,
      { jobId, uploadedBy: 1, tempFilePath, extractedText: "Business expense" },
      {
        documentType: DocumentType.Expense,
        description: "Business expense",
        partyName: "New supplier",
        partyEdited: true,
        date: "2026-01-15",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        reference: "Receipt",
        category: "",
        categoryAccountId: expense,
        remark: "",
        accountId: null,
        sides: { fromAccountId: bank, toAccountId: expense },
        matchedContact: null,
      },
      { actingUserId: 1, storageRoot: root },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`closed through ${boundary}`),
    });
    expect(snapshot()).toEqual(before);
    expect(report()).toEqual(totals);
    expect(readFileSync(source, "utf8")).toBe("%PDF-1.4 receipt");
  });

  it("prevents a stale WAL reader from changing tax after another connection closes the month", () => {
    const root = mkdtempSync(join(tmpdir(), "akaun-tax-close-race-"));
    roots.push(root);
    const first = new Database(join(root, "book.db"));
    first.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0");
    const a = drizzle(first, { schema }) as LedgerDb;
    migrate(a, { migrationsFolder: "drizzle" });
    a.insert(schema.users).values(db.select().from(schema.users).all()).run();
    a.insert(schema.accounts)
      .values(db.select().from(schema.accounts).all())
      .run();
    const second = new Database(join(root, "book.db"));
    second.exec("PRAGMA busy_timeout = 0");
    const b = drizzle(second, { schema }) as LedgerDb;
    const memory = db;
    try {
      db = a;
      const row = entry();
      const saved = tax(row.id);
      const reader = ctx();
      first
        .transaction(() => {
          expect(getRecord(a, row.id)?.periodClosedThrough).toBeNull();
          db = b;
          close();
          expect(
            updateRecord(reader, row.id, { taxOverrides: [override()] }),
          ).toMatchObject({ ok: false, code: "CONFLICT" });
        })
        .deferred();
      expect(tax(row.id)).toEqual(saved);
      expect(
        updateRecord(reader, row.id, { taxOverrides: [override()] }),
      ).toMatchObject({ ok: false, code: "REFUSED" });
      expect(
        a
          .select()
          .from(schema.auditLog)
          .all()
          .filter((r) => r.recordType === "record"),
      ).toEqual([]);
    } finally {
      db = memory;
      second.close();
      first.close();
    }
  });
});
