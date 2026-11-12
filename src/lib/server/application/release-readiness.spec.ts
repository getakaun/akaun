import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import {
  createTaxWorksheet,
  saveTaxWorksheet,
  readTaxWorksheet,
} from "./tax-worksheets.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { integrityInputs } from "../queries/ledger.js";
import { taxWorksheetCsv } from "../queries/tax-worksheets.js";
import { localsFor } from "../permissions/test-locals.js";
import { createRecord } from "./records.js";
import { Database } from "bun:sqlite";
import { applyMigrationRange } from "../db/auto-upgrade.js";

async function racer(path: string, action: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      "./scripts/mcp-test-preload.ts",
      join(import.meta.dir, "__fixtures__/release-racer.ts"),
      path,
      action,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  if (first.trim() !== "ready")
    throw Error(
      `Fixture did not reach barrier: ${first}\n${await new Response(child.stderr).text()}`,
    );
  return async (requestKey = crypto.randomUUID()) => {
    child.stdin.write(JSON.stringify({ requestKey }));
    child.stdin.end();
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    const code = await child.exited;
    if (code !== 0) throw Error(await new Response(child.stderr).text());
    return JSON.parse(text) as { ok: boolean; reason?: string };
  };
}

describe("combined release boundaries across independent processes", () => {
  it("rechecks migration receipts after competing startups acquire the writer lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-migration-race-"));
    const path = join(dir, "fixture.db");
    const raw = new Database(path);
    let locked = false;
    try {
      applyMigrationRange(raw, 0, 48);
      raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
      const run = await Promise.all([
        racer(path, "migrate"),
        racer(path, "migrate"),
      ]);
      raw.exec("BEGIN IMMEDIATE");
      locked = true;
      const pending = run.map((go) => go());
      await Bun.sleep(150);
      raw.exec("COMMIT");
      locked = false;
      expect((await Promise.all(pending)).every((r) => r.ok)).toBe(true);
      expect(
        raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
      ).toEqual({ n: 50 });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      if (locked) raw.exec("ROLLBACK");
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
  it("captures new sources and assets after both committed and failed tax transactions", () => {
    const book = releaseBook();
    try {
      const initial = resultValue(
        createTaxWorksheet(book.ctx, {
          ya: 2025,
          dateFrom: "2025-01-01",
          dateTo: "2025-12-31",
          requestKey: crypto.randomUUID(),
        }),
      );
      const save = (detail: typeof initial) =>
        saveTaxWorksheet(book.ctx, detail.worksheet.id, {
          action: "save-worksheet",
          target: "draft",
          expectedVersion: detail.revision.version,
          requestKey: crypto.randomUUID(),
          liveHash: detail.liveHash,
          sourceHashes: detail.sourceHashes,
          adjustments: [],
          withdrawals: [],
        });
      resultValue(save(initial));
      const current = resultValue(
        readTaxWorksheet(book.ctx, initial.worksheet.id),
      );
      book.raw.exec(
        "CREATE TEMP TRIGGER reject_tax_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='tax_worksheet' BEGIN SELECT RAISE(ABORT,'Injected tax audit failure'); END",
      );
      expect(() => save(current)).toThrow("Injected tax audit failure");
      book.raw.exec("DROP TRIGGER reject_tax_audit");
      resultValue(
        createRecord(book.ctx, {
          kind: "expense",
          date: "2025-01-02",
          amount: 100,
          currency: "MYR",
          exchangeRate: 1,
          description: "Source added after rollback",
          categoryAccountId: book.expense,
          paidFromAccountId: book.bank,
        }),
      );
      const asset = book.asset();
      const refreshed = resultValue(
        readTaxWorksheet(book.ctx, initial.worksheet.id),
      );
      expect(refreshed.liveHash).not.toBe(current.liveHash);
      const saved = resultValue(save(refreshed));
      expect(saved.savedRevision.snapshot.expenseMinor).toBe(10000);
      expect(saved.capital.candidates.map((a) => a.assetId)).toContain(
        asset.id,
      );
      expect(checkIntegrity(integrityInputs(book.db)).ok).toBe(true);
    } finally {
      book.raw.close();
    }
  });
  for (const actions of [
    ["post", "post"],
    ["post", "auto"],
    ["post", "close"],
  ])
    it(`serialises ${actions.join(" versus ")} against the same WAL book`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "akaun-release-race-"));
      const path = join(dir, "fixture.db");
      const book = releaseBook(path);
      try {
        book.asset(actions.includes("auto") ? "auto" : "review");
        book.raw.exec("PRAGMA journal_mode=WAL");
        const run = await Promise.all(
          actions.map((action) => racer(path, action)),
        );
        const outcomes = await Promise.all(run.map((go) => go()));
        expect(outcomes.some((o) => o.ok)).toBe(true);
        const january = book.raw
          .query("SELECT * FROM depreciation_postings WHERE month='2025-01'")
          .all();
        expect(january.length).toBeLessThanOrEqual(1);
        if (!actions.includes("close")) expect(january).toHaveLength(1);
        if (actions.includes("close")) {
          // A successful stale close cannot also accept an intervening posting.
          expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        }
        expect(checkIntegrity(integrityInputs(book.db)).ok).toBe(true);
        expect(book.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        book.raw.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20000);

  for (const sameKey of [false, true])
    it(`finalises through independent connections with same retry key=${sameKey}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "akaun-tax-race-"));
      const path = join(dir, "fixture.db");
      const book = releaseBook(path);
      try {
        resultValue(
          createTaxWorksheet(book.ctx, {
            ya: 2025,
            dateFrom: "2025-01-01",
            dateTo: "2025-12-31",
            requestKey: crypto.randomUUID(),
          }),
        );
        book.raw.exec("PRAGMA journal_mode=WAL");
        const run = await Promise.all([racer(path, "tax"), racer(path, "tax")]);
        const key = crypto.randomUUID();
        const results = await Promise.all(
          run.map((go) => go(sameKey ? key : crypto.randomUUID())),
        );
        expect(results.filter((o) => o.ok)).toHaveLength(sameKey ? 2 : 1);
        expect(
          book.raw
            .query("SELECT status,version FROM tax_worksheet_revisions")
            .get(),
        ).toMatchObject({ status: "finalised" });
        expect(
          book.raw
            .query("SELECT count(*) AS n FROM tax_capital_commands")
            .get(),
        ).toEqual({ n: 1 });
        const saved = resultValue(
          readTaxWorksheet(book.ctx, 1, undefined, false),
        );
        expect(saved.revision.finalisedBy).toBe(1);
        expect(checkIntegrity(integrityInputs(book.db)).ok).toBe(true);
      } finally {
        book.raw.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20000);

  it("denies combined completion to an OAuth context even when supplied broad locals", () => {
    const book = releaseBook();
    try {
      const detail = resultValue(
        createTaxWorksheet(book.ctx, {
          ya: 2025,
          dateFrom: "2025-01-01",
          dateTo: "2025-12-31",
          requestKey: crypto.randomUUID(),
        }),
      );
      const locals = localsFor([], { superuser: true });
      locals.oauth = {
        clientId: "fixture",
        grantId: "fixture",
        scopes: [],
        resource: "https://example.test/mcp",
      };
      const before = book.raw.serialize();
      const result = saveTaxWorksheet(
        { db: book.db, locals },
        detail.worksheet.id,
        {
          action: "save-worksheet",
          target: "finalised",
          expectedVersion: detail.revision.version,
          requestKey: crypto.randomUUID(),
          liveHash: detail.liveHash,
          sourceHashes: detail.sourceHashes,
          adjustments: [],
          withdrawals: [],
        },
      );
      expect(result.ok).toBe(false);
      expect(book.raw.serialize()).toEqual(before);
      expect(
        taxWorksheetCsv(
          resultValue(
            readTaxWorksheet(book.ctx, detail.worksheet.id, undefined, false),
          ),
        ),
      ).toEqual(taxWorksheetCsv(detail));
    } finally {
      book.raw.close();
    }
  });
});
