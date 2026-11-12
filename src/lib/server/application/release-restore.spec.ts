import { utilisationContext } from "./__fixtures__/utilisation.js";
import { createAccount } from "../services/accounts.js";
import { AccountType, RevenueSubType } from "$lib/enums.js";
import { createRecord } from "./records.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { migrateBook } from "../db/migrate-book.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { integrityInputs } from "../queries/ledger.js";
import {
  balanceSheetReport,
  profitLossReport,
  cashFlowReport,
} from "../queries/reports.js";
import { fixedAssetRegister } from "../queries/fixed-assets.js";
import {
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "../queries/tax-worksheets.js";
import { toCsv } from "../ledger/reports/csv.js";
import {
  previewDepreciationMonth,
  postDepreciationMonth,
} from "./depreciation.js";
import {
  createTaxWorksheet,
  readTaxWorksheet,
  saveTaxWorksheet,
} from "./tax-worksheets.js";
import { saveAssetTaxScheme } from "./asset-tax-schemes.js";
import {
  editorRows,
  editorPreview,
  editorSchemes,
} from "$lib/components/tax-worksheets/capital-editor.js";

describe("stopped-book backup and restore rehearsal", () => {
  it("restores statements, posted depreciation, finalised scheme evidence, carry-forwards and receipt bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-release-restore-"));
    const source = join(dir, "source");
    const restored = join(dir, "restored");
    mkdirSync(join(source, "storage"), { recursive: true });
    const receipt = Buffer.from(
      "Synthetic receipt bytes for the release rehearsal",
    );
    writeFileSync(join(source, "storage", "receipt.bin"), receipt);
    const book = releaseBook(join(source, "book.db"));
    let stopped = false;
    let recovery: Database | undefined;
    try {
      const asset = book.asset();
      book.db
        .insert(schema.recordAttachments)
        .values({
          recordId: asset.sourceRecordId!,
          filename: "receipt.bin",
          displayName: "Synthetic receipt",
        })
        .run();
      const preview = resultValue(
        previewDepreciationMonth(book.ctx, "2025-01"),
      );
      resultValue(
        postDepreciationMonth(book.ctx, {
          month: "2025-01",
          expectedVersion: preview.version,
        }),
      );
      const sales = resultValue(
        createAccount(book.db, 1, {
          name: "Trading sales",
          type: AccountType.Revenue,
          subType: RevenueSubType.OperatingRevenue,
        }),
      ).id;
      resultValue(
        createRecord(book.ctx, {
          kind: "income",
          date: "2025-03-01",
          amount: 1000,
          currency: "MYR",
          exchangeRate: 1,
          description: "Synthetic trading income",
          categoryAccountId: sales,
          receivedIntoAccountId: book.bank,
        }),
      );
      const scheme = resultValue(
        saveAssetTaxScheme(book.ctx, {
          familyKey: crypto.randomUUID(),
          expectedVersion: 0,
          requestKey: crypto.randomUUID(),
          definition: {
            name: "Synthetic calculation only",
            jurisdiction: "MY",
            yearFrom: 2025,
            yearTo: null,
            method: "original_cost",
            firstYearRateBps: 2000,
            regularRateBps: 1000,
          },
        }),
      );
      const detail = resultValue(
        createTaxWorksheet(book.ctx, {
          ya: 2025,
          dateFrom: "2025-01-01",
          dateTo: "2025-12-31",
          requestKey: crypto.randomUUID(),
        }),
      );
      const rows = editorRows(detail.capital.schedule!, detail.worksheet);
      Object.assign(rows[0].form, {
        treatment: "claim",
        schemeId: String(scheme.id),
        firstYearMode: "auto",
      });
      const staged = editorPreview(
        detail.capital.schedule!,
        rows,
        editorSchemes(detail.capital.schemes),
        [
          {
            source: "Main business",
            origin: "2025",
            balance: "0.00",
            used: "1000.00",
          },
        ],
        "",
        detail.worksheet,
        detail.capital.firstYearContexts,
        utilisationContext(detail),
      );
      expect(staged.errors).toEqual([]);
      const financial = (db: LedgerDb) => ({
        pl: profitLossReport(db, "2025-01-01", "2025-12-31"),
        bs: balanceSheetReport(db, "2025-12-31"),
        cf: cashFlowReport(db, "2025-01-01", "2025-12-31"),
        assets: fixedAssetRegister(db, "2025-12-31"),
      });
      const beforeTax = financial(book.db);
      const saved = resultValue(
        saveTaxWorksheet(book.ctx, detail.worksheet.id, {
          action: "save-worksheet",
          target: "finalised",
          expectedVersion: detail.revision.version,
          requestKey: crypto.randomUUID(),
          liveHash: detail.liveHash,
          sourceHashes: detail.sourceHashes,
          adjustments: [],
          withdrawals: [],
          capital: {
            input: staged.input,
            utilisationHash: detail.capital.utilisationBasis?.hash,
            liveAssetHash: detail.capital.liveAssetHash,
            rolloverHash: detail.capital.rolloverHash,
            confirmFirstYearTreatments: true,
          },
        }),
      );
      expect(financial(book.db)).toEqual(beforeTax);
      expect(saved.capital.totals).toMatchObject({
        allowanceMinor: 360000,
        usedMinor: 100000,
      });
      const next = resultValue(
        createTaxWorksheet(book.ctx, {
          ya: 2026,
          dateFrom: "2026-01-01",
          dateTo: "2026-12-31",
          requestKey: crypto.randomUUID(),
        }),
      );
      expect(next.capital.schedule!.rows[0].openingResidualMinor).toBe(840000);
      expect(next.capital.schedule!.utilisation[0].balanceMinor).toBe(260000);
      const exports = {
        csv: toCsv(taxWorksheetCsv(saved)),
        html: taxWorksheetHtml(saved),
      };
      const tables = [
        "ledger_records",
        "ledger_movements",
        "record_attachments",
        "depreciation_runs",
        "depreciation_postings",
        "tax_worksheet_revisions",
        "tax_capital_schedules",
        "tax_capital_commands",
        "audit_log",
      ];
      const evidence = tables.map((t) =>
        book.raw.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
      );
      book.raw.close();
      stopped = true;
      cpSync(source, restored, { recursive: true });
      recovery = new Database(join(restored, "book.db"));
      migrateBook(recovery);
      const db = drizzle(recovery, { schema }) as LedgerDb;
      const ctx = { ...book.ctx, db };
      expect(
        tables.map((t) =>
          recovery!.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
        ),
      ).toEqual(evidence);
      expect(financial(db)).toEqual(beforeTax);
      const retained = resultValue(
        readTaxWorksheet(ctx, saved.worksheet.id, undefined, false),
      );
      expect({
        csv: toCsv(taxWorksheetCsv(retained)),
        html: taxWorksheetHtml(retained),
      }).toEqual(exports);
      expect(readFileSync(join(restored, "storage", "receipt.bin"))).toEqual(
        receipt,
      );
      expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
      expect(recovery.query("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(recovery.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      if (!stopped) book.raw.close();
      recovery?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
