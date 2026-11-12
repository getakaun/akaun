import {
  releaseBook,
  resultValue,
} from "../src/lib/server/application/__fixtures__/release-book.js";
import { fixedAssetRegister } from "../src/lib/server/queries/fixed-assets.js";
import { previewDepreciationMonth } from "../src/lib/server/application/depreciation.js";
import { previewClosing } from "../src/lib/server/application/closing.js";
import {
  captureTaxSources,
  taxHash,
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "../src/lib/server/queries/tax-worksheets.js";
import {
  createTaxWorksheet,
  readTaxWorksheet,
  saveTaxWorksheet,
} from "../src/lib/server/application/tax-worksheets.js";
import { toCsv } from "../src/lib/server/ledger/reports/csv.js";
import { assetDepreciationBasis } from "../src/lib/server/queries/depreciation.js";
import { cpus, totalmem } from "node:os";
import { saveAssetTaxScheme } from "../src/lib/server/application/asset-tax-schemes.js";
import {
  editorRows,
  editorPreview,
  editorSchemes,
} from "../src/lib/components/tax-worksheets/capital-editor.js";

// Synthetic in-memory books only. Never imports db/client or reads configuration.
const sizes = {
  small: [10000, 100, 3],
  medium: [100000, 1000, 5],
  stress: [1000000, 10000, 10],
} as const;
const size = process.argv[2] as keyof typeof sizes;
const samples = Number(process.argv[3] ?? 3);
if (
  !(size in sizes) ||
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 20
)
  throw Error(
    "Usage: bun --preload ./scripts/mcp-test-preload.ts scripts/release-benchmark.ts small|medium|stress [1..20 samples]",
  );
const [movements, assets, years] = sizes[size];
let queryCount = 0;
const book = releaseBook(":memory:", () => queryCount++);
const { raw, db, ctx } = book;
const metrics: {
  operation: string;
  coldMs: number;
  p95Ms: number;
  samples: number;
  queriesPerSample: number;
  peakRssMiB: number;
}[] = [];
function measure<T>(operation: string, fn: () => T, runs = samples): T {
  let output: T;
  const times: number[] = [];
  const beforeQueries = queryCount;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    output = fn();
    times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  metrics.push({
    operation,
    coldMs: Math.round(times[0]),
    p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    samples: runs,
    queriesPerSample: (queryCount - beforeQueries) / runs,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  });
  console.error(`${size}: ${operation}: ${metrics.at(-1)!.p95Ms}ms`);
  return output!;
}
try {
  const record = raw.query(
    "INSERT INTO ledger_records(id,kind,date,description,amount,currency) VALUES(?,1,'2025-01-01',?,?,'MYR')",
  );
  const line = raw.query(
    "INSERT INTO ledger_movements(id,record_id,account_id,amount_minor,sort_order,tax_classification) VALUES(?,?,?,?,?,?)",
  );
  const asset = raw.query(
    "INSERT INTO fixed_assets(id,name,asset_type,acquisition_date,in_service_date,asset_account_id,cost_minor,source_record_id,source_movement_id,source_sort_order,source_snapshot,created_by,updated_by) VALUES(?,?,'Equipment','2025-01-01','2025-01-01',?,1200000,?,?,0,?,1,1)",
  );
  const tax = JSON.stringify({
    percentageBps: 10000,
    treatment: "ordinary_deductible",
    source: "account_default",
    reason: null,
    classifiedBy: 1,
    classifiedAt: "2025-01-01",
    provenance: "record_creation",
  });
  raw.transaction(() => {
    for (let id = 1; id <= movements / 2; id++) {
      const capital = id <= assets;
      const amount = capital ? 1200000 : 10000;
      record.run(
        id,
        capital ? `Equipment ${id}` : `Expense ${id}`,
        amount / 100,
      );
      line.run(
        id * 2 - 1,
        id,
        capital ? book.cost : book.expense,
        amount,
        0,
        capital ? null : tax,
      );
      line.run(id * 2, id, book.bank, -amount, 1, null);
      if (capital)
        asset.run(
          id,
          `Equipment ${id}`,
          book.cost,
          id,
          id * 2 - 1,
          JSON.stringify({
            movementId: id * 2 - 1,
            recordId: id,
            sortOrder: 0,
            recordDate: "2025-01-01",
            accountId: book.cost,
            amountMinor: amount,
          }),
        );
    }
  })();
  // Directly seed valid retained metadata for empty old periods; setup time is
  // excluded. The populated current period exercises claim calculations below.
  for (let year = 2025 - years; year < 2025; year++) {
    const snapshot = captureTaxSources(db, `${year}-01-01`, `${year}-12-31`);
    const worksheet = raw
      .query(
        "INSERT INTO tax_worksheets(ya,date_from,date_to,request_key,created_at) VALUES(?,?,?,?,?) RETURNING id",
      )
      .get(
        year,
        `${year}-01-01`,
        `${year}-12-31`,
        crypto.randomUUID(),
        "2026-01-01",
      ) as { id: number };
    for (const revision of [1, 2])
      raw
        .query(
          "INSERT INTO tax_worksheet_revisions(worksheet_id,revision,status,snapshot,source_hash,captured_at,request_key,reviewed_at,finalised_at,amendment_reason) VALUES(?,?,'finalised',?,?,?,?,?,?,?)",
        )
        .run(
          worksheet.id,
          revision,
          JSON.stringify(snapshot),
          taxHash(snapshot),
          "2026-01-01",
          crypto.randomUUID(),
          "2026-01-01",
          "2026-01-01",
          revision === 2 ? "Synthetic retained amendment" : null,
        );
  }
  const source = measure("tax-source-capture", () =>
    captureTaxSources(db, "2025-01-01", "2025-12-31"),
  );
  if (source.expenseMinor !== (movements / 2 - assets) * 10000)
    throw Error("Expense reconciliation failed");
  const register = measure("asset-register", () =>
    fixedAssetRegister(db, "2025-12-31"),
  );
  if (
    register.assets.length !== assets ||
    register.assets.some((a) => a.reviewReason)
  )
    throw Error("Asset reconciliation failed");
  // Populate approved book schedules using the exact persisted basis format.
  const profile = raw.query(
    "INSERT INTO depreciation_profiles(asset_id,start_month,months,base_nbv_minor,residual_minor,expense_account_id,accumulated_account_id,mode,basis,approved_by,reason) VALUES(?,'2025-01',36,1200000,0,?,?,'review',?,1,'Synthetic approved policy')",
  );
  raw.transaction(() => {
    for (const a of register.assets)
      profile.run(
        a.id,
        book.depreciationExpense,
        book.accum,
        assetDepreciationBasis(a),
      );
  })();
  measure("depreciation-preview", () =>
    resultValue(previewDepreciationMonth(ctx, "2025-01")),
  );
  measure("closing-preview", () =>
    resultValue(previewClosing(ctx, { monthEnd: "2025-01-31" })),
  );
  const detail = resultValue(
    createTaxWorksheet(ctx, {
      ya: 2025,
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      requestKey: crypto.randomUUID(),
    }),
  );
  measure("worksheet-detail", () =>
    resultValue(readTaxWorksheet(ctx, detail.worksheet.id)),
  );
  let saved = measure("worksheet-save", () => {
    const current = resultValue(readTaxWorksheet(ctx, detail.worksheet.id));
    return resultValue(
      saveTaxWorksheet(ctx, detail.worksheet.id, {
        action: "save-worksheet",
        target: "draft",
        expectedVersion: current.revision.version,
        requestKey: crypto.randomUUID(),
        liveHash: current.liveHash,
        sourceHashes: {},
        adjustments: [],
        withdrawals: [],
      }),
    );
  });
  const scheme = resultValue(
    saveAssetTaxScheme(ctx, {
      familyKey: crypto.randomUUID(),
      expectedVersion: 0,
      requestKey: crypto.randomUUID(),
      definition: {
        name: "Synthetic 1% arithmetic fixture",
        jurisdiction: "MY",
        yearFrom: 2025,
        yearTo: null,
        method: "original_cost",
        firstYearRateBps: 0,
        regularRateBps: 100,
      },
    }),
  );
  const current = resultValue(readTaxWorksheet(ctx, saved.worksheet.id));
  const forms = editorRows(current.capital.schedule!, current.worksheet);
  for (const row of forms)
    Object.assign(row.form, {
      treatment: "claim",
      schemeId: String(scheme.id),
      firstYearMode: "auto",
    });
  const staged = editorPreview(
    current.capital.schedule!,
    forms,
    editorSchemes(current.capital.schemes),
    [],
    "",
    current.worksheet,
    current.capital.firstYearContexts,
    {
      ...current.capital.utilisationBasis!,
      snapshot: current.revision.snapshot,
      adjustments: current.adjustments,
    },
  );
  if (staged.errors.length) throw Error(staged.errors.join("; "));
  saved = measure(
    "worksheet-finalise-with-claims",
    () =>
      resultValue(
        saveTaxWorksheet(ctx, current.worksheet.id, {
          action: "save-worksheet",
          target: "finalised",
          expectedVersion: current.revision.version,
          requestKey: crypto.randomUUID(),
          liveHash: current.liveHash,
          sourceHashes: {},
          adjustments: [],
          withdrawals: [],
          capital: {
            input: staged.input,
            utilisationHash: current.capital.utilisationBasis?.hash,
            liveAssetHash: current.capital.liveAssetHash,
            rolloverHash: current.capital.rolloverHash,
            confirmFirstYearTreatments: true,
          },
        }),
      ),
    1,
  );
  if (saved.capital.totals?.allowanceMinor !== assets * 12000)
    throw Error("Allowance reconciliation failed");
  measure("csv-export", () => toCsv(taxWorksheetCsv(saved)));
  measure("html-export", () => taxWorksheetHtml(saved));
  if (raw.query("PRAGMA foreign_key_check").all().length)
    throw Error("Foreign key check failed");
  console.log(
    JSON.stringify(
      {
        size,
        movements,
        assets,
        years,
        runtime: Bun.version,
        cpu: cpus()[0]?.model,
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        database: "synthetic in-memory",
        snapshotBytes: Buffer.byteLength(JSON.stringify(source)),
        metrics,
      },
      null,
      2,
    ),
  );
} finally {
  raw.close();
}
