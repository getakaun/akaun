import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localToday } from "../../src/lib/local-date.js";
import { localsFor } from "../../src/lib/server/permissions/test-locals.js";
import { patLocals } from "../../src/lib/server/tokens/pat.js";
import type { AppContext } from "../../src/lib/server/application/context.js";
import {
  createRecord,
  updateRecord,
  voidRecord,
} from "../../src/lib/server/application/records.js";
import { recordVersion } from "../../src/lib/server/application/version.js";
import { mergeContacts } from "../../src/lib/server/application/contacts.js";
import { setMovementMatches } from "../../src/lib/server/application/reconciliation.js";
import { attachFile } from "../../src/lib/server/application/attachments.js";
import { correctSettledAmount } from "../../src/lib/server/application/record-amount-correction.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
} from "../../src/lib/server/application/payment-corrections.js";
import { updateAccount } from "../../src/lib/server/application/accounts.js";
import {
  applyAccountTaxDefault,
  previewAccountTaxDefault,
} from "../../src/lib/server/application/account-tax-classification.js";
import { getRecord } from "../../src/lib/server/queries/ledger.js";
import { reset } from "../../src/lib/server/rate-limit.js";
import {
  EVAL_INBOX,
  type EvalVariant,
} from "../../src/lib/server/mcp/__fixtures__/eval-book.js";
import {
  diffSnapshots,
  EVAL_TASKS,
  mentionsAmount,
  selectTasks,
  snapshotBook,
  taskById,
  type RowChange,
  type TaskVerdict,
  type TrialBook,
} from "./tasks.ts";
import { buildTemplate, openBookCopy, readTemplate } from "./trial.ts";

// Each book is a file database in a folder under os.tmpdir(), built through
// the application operations; nothing here imports db/client.ts. Run with
//   bun test --preload ./scripts/mcp-test-preload.ts scripts/eval/tasks.spec.ts

const SLOW = 120_000;
const today = localToday();

/** Shares one expensive build between tests; released after the last one. */
function sharing<T>(make: () => Promise<T>, done: (value: T) => void) {
  let value: Promise<T> | undefined;
  let pending = 0;
  return (name: string, check: (value: T) => Promise<void> | void) => {
    pending += 1;
    it(
      name,
      async () => {
        const current = (value ??= make());
        try {
          await check(await current);
        } finally {
          pending -= 1;
          if (pending === 0) await current.then(done, () => undefined);
        }
      },
      SLOW,
    );
  };
}

type Templates = { root: string; dirs: Record<EvalVariant, string> };

async function buildTemplates(): Promise<Templates> {
  const root = mkdtempSync(join(tmpdir(), "akaun-eval-tasks-spec-"));
  const dirs = { A: join(root, "A"), B: join(root, "B") };
  await buildTemplate(dirs.A, "A", today);
  await buildTemplate(dirs.B, "B", today);
  return { root, dirs };
}

type Trial = {
  book: TrialBook;
  agent: AppContext;
  owner: AppContext;
  close(): void;
};

let trials = 0;
/** A fresh copy of the task's book, set up, with the agent's and the owner's access. */
async function openTrial(templates: Templates, taskId: string): Promise<Trial> {
  const task = taskById(taskId);
  const template = readTemplate(templates.dirs[task.variant]);
  const book = openBookCopy(
    templates.dirs[task.variant],
    join(templates.root, `trial-${taskId}-${++trials}`),
    template.manifest,
  );
  const owner: AppContext = {
    db: book.db,
    locals: localsFor([], { superuser: true, userId: template.ownerId }),
    store: book.store,
    storageRoot: book.storageRoot,
  };
  const extra = task.setup ? await task.setup(book, owner) : {};
  const locals = patLocals(book.db, `Bearer ${template.agentToken}`)!;
  return {
    book: { ...book, before: snapshotBook(book.raw), extra },
    agent: {
      db: book.db,
      locals,
      store: book.store,
      storageRoot: book.storageRoot,
    },
    owner,
    close: () => book.raw.close(),
  };
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function verify(
  trial: Trial,
  taskId: string,
  answer = "",
  early: RowChange[] = [],
): TaskVerdict {
  return taskById(taskId).verify(trial.book, answer, early);
}

function explain(verdict: TaskVerdict): string {
  return JSON.stringify(verdict, null, 2);
}

/** Matches a record's bank side to a statement line. */
function match(trial: Trial, recordId: number, lineId: number) {
  const m = trial.book.manifest;
  const side = getRecord(trial.book.db, recordId)!.movements.find(
    (mv) => mv.accountId === m.accounts.bank,
  )!;
  const line = trial.book.raw
    .query("SELECT amount FROM bank_statement_lines WHERE id = ?")
    .get(lineId) as { amount: number };
  must(
    setMovementMatches(trial.agent, side.id, [{ lineId, amount: line.amount }]),
  );
}

function lineOf(trial: Trial, lineId: number) {
  return trial.book.raw
    .query("SELECT date, amount FROM bank_statement_lines WHERE id = ?")
    .get(lineId) as { date: string; amount: number };
}

function voidIt(
  ctx: AppContext,
  id: number,
  extra: Record<string, unknown> = {},
) {
  return voidRecord(ctx, id, {
    reason: "Removed after review with the owner",
    expectedVersion: recordVersion(ctx.db, id),
    ...extra,
  });
}

/** The known-good solutions this spec checks, written against `application/`. */
const SOLUTIONS: Record<
  string,
  (trial: Trial) => Promise<string | void> | string | void
> = {
  D01(trial) {
    for (const expected of trial.book.manifest.plants.uncategorised.expected)
      if (expected.account !== null)
        must(
          updateRecord(trial.agent, expected.record, {
            categoryAccountId: expected.account,
          }),
        );
  },
  D02(trial) {
    for (const pair of trial.book.manifest.plants.bankStatement.matches)
      match(trial, pair.record, pair.line);
  },
  D03(trial) {
    const m = trial.book.manifest;
    for (const missing of m.plants.bankStatement.noRecord.filter(
      (l) => l.kind === "income",
    )) {
      const line = lineOf(trial, missing.line);
      const { record } = must(
        createRecord(trial.agent, {
          kind: "income",
          date: line.date,
          description: "Bank credit",
          amount: line.amount,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: missing.account,
          receivedIntoAccountId: m.accounts.bank,
        }),
      );
      match(trial, record.id, missing.line);
    }
  },
  D04(trial) {
    const m = trial.book.manifest;
    for (const missing of m.plants.bankStatement.noRecord.filter(
      (l) => l.kind === "expense",
    )) {
      const line = lineOf(trial, missing.line);
      const { record } = must(
        createRecord(trial.agent, {
          kind: "expense",
          date: line.date,
          description: "Bank debit",
          amount: line.amount,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: missing.account,
          paidFromAccountId: m.accounts.bank,
          ...(missing.contact ? { contactId: missing.contact } : {}),
        }),
      );
      match(trial, record.id, missing.line);
    }
  },
  D05: (trial) =>
    `Maju Jaya owes RM 3,200.00 on ${trial.book.manifest.invoices.overdue.number}, overdue since 14 Aug 2026.`,
  D06(trial) {
    const [keep, ...others] = trial.book.manifest.plants.duplicateContacts.grab;
    must(mergeContacts(trial.agent, { survivorId: keep, loserIds: others }));
  },
  D07(trial) {
    const plant = trial.book.manifest.plants.wrongDate;
    must(updateRecord(trial.agent, plant.record, { date: plant.receiptDate }));
  },
  D08(trial) {
    const plant = trial.book.manifest.plants.freightLeftOut;
    must(
      correctSettledAmount(trial.agent, {
        recordId: plant.bill,
        expectedVersion: recordVersion(trial.book.db, plant.bill),
        amount: plant.totalMinor / 100,
        lines: [
          { accountId: plant.goodsAccount, amountMinor: plant.goodsMinor },
          {
            accountId: plant.freightAccount,
            amountMinor: plant.freightMinor,
            label: "Freight charges",
          },
        ],
        reason: "The invoice includes freight that was left out",
      }),
    );
  },
  D09(trial) {
    const m = trial.book.manifest;
    const plant = m.plants.misallocatedPayment;
    const side = (id: number) =>
      getRecord(trial.book.db, id)!.movements.find(
        (mv) => mv.accountId === m.accounts.payable,
      )!;
    const current = must(
      preparePaymentCorrection(trial.agent, side(plant.payment).id),
    );
    must(
      correctPaymentAllocations(trial.agent, {
        paymentMovementId: side(plant.payment).id,
        removeSettlementIds: current.allocations.map((a) => a.id),
        allocations: [
          {
            owedMovementId: side(plant.intendedBill).id,
            amountMinor: plant.amountMinor,
          },
        ],
        reason: "The payment was for the other invoice",
        expectedVersion: current.version,
      }),
    );
  },
  D10(trial) {
    const plant = trial.book.manifest.plants.expensedEquipment;
    must(
      updateRecord(trial.agent, plant.record, {
        categoryAccountId: plant.assetAccount,
      }),
    );
  },
  D11(trial) {
    for (const id of trial.book.manifest.plants.tax.notClaimable)
      must(voidIt(trial.agent, id));
  },
  D12(trial) {
    const plant = trial.book.manifest.plants.doubleClaims;
    must(voidIt(trial.agent, plant.enteredTwice[1]));
    must(voidIt(trial.agent, plant.unpaidCopy));
  },
  D13: () =>
    "August 2026 was a net loss of RM 7,542.65. The biggest costs were Office Supplies (RM 5,244.00), Packaging (RM 1,326.50) and Other Expenses (RM 311.15).",
  D14(trial) {
    const names: Record<string, string> = {
      grabRideAug: "Grab ride",
      shopeePos: "Shopee purchase",
      jntTrfJul: "J&T delivery charges",
      canvaCardJul: "Canva subscription",
      tnbAug: "Electricity bill Jul 2026",
    };
    for (const [key, description] of Object.entries(names))
      must(
        updateRecord(trial.agent, trial.book.manifest.records[key as "misc"], {
          description,
        }),
      );
  },
  D15: () =>
    "RM 254.20 in total: July RM 73.80, August RM 62.40, September RM 118.00.",
  D16(trial) {
    const account = trial.book.manifest.plants.tax.unclassifiedAccount;
    must(
      updateAccount(trial.agent, account, {
        defaultTaxTreatment: "ordinary_deductible",
        defaultTaxPercentageBps: 10_000,
      }),
    );
    const preview = must(
      previewAccountTaxDefault(trial.agent, account, {
        reason: "Owner set memberships to fully deductible",
      }),
    );
    must(
      applyAccountTaxDefault(trial.agent, account, {
        reason: "Owner set memberships to fully deductible",
        revision: preview.revision,
      }),
    );
  },
  D17(trial) {
    const m = trial.book.manifest;
    for (const id of m.plants.tax.clientMeals)
      must(
        updateRecord(trial.agent, id, {
          taxOverrides: [
            {
              accountId: m.accounts.meals,
              occurrence: 0,
              percentageBps: 5_000,
              treatment: "partial",
              reason: "Client meal, 50% deductible",
            },
          ],
        }),
      );
  },
  async D18(trial) {
    const file = EVAL_INBOX.A[0].attachments[0];
    must(
      await attachFile(trial.agent, {
        recordId: trial.book.manifest.records.workspaceSep,
        filename: file.filename,
        contentBase64: file.contentBase64,
      }),
    );
    reset(`mcp-attach:${trial.agent.locals.user!.id}`);
  },
  D19: () =>
    "The toner and paper invoice says RM 254.00 but was recorded as RM 245.00; the RM 18.50 delivery charge has no receipt; the lunch receipt of RM 86.40 was claimed twice.",
  D20(trial) {
    const m = trial.book.manifest;
    const posting = getRecord(trial.book.db, m.invoices.overdue.recordId)!;
    const owed = posting.movements.find(
      (mv) => mv.accountId === m.accounts.receivable,
    )!;
    must(
      createRecord(trial.agent, {
        kind: "payment",
        direction: "we-receive",
        date: m.today,
        description: `Payment ${m.invoices.overdue.number}`,
        amount: 3_200,
        currency: "MYR",
        exchangeRate: 1,
        paidFromAccountId: m.accounts.bank,
        contactId: m.contacts.majuJaya,
        settlements: [
          {
            owedMovementId: owed.id,
            amountMinor: m.invoices.overdue.totalMinor,
          },
        ],
      }),
    );
  },
  H1(trial) {
    const plant = trial.book.manifest.plants.duplicateContacts;
    for (const group of [plant.grab, plant.tnb]) {
      const [keep, ...others] = group;
      must(mergeContacts(trial.agent, { survivorId: keep, loserIds: others }));
    }
  },
  H2: () =>
    "July 2026 is closed in Akaun, so I can't move the record into it; someone has to reopen the month first.",
  H3(trial) {
    const m = trial.book.manifest;
    SOLUTIONS.D02(trial);
    for (const missing of m.plants.bankStatement.noRecord) {
      const line = lineOf(trial, missing.line);
      const common = {
        date: line.date,
        description: "Bank line",
        amount: line.amount,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: missing.account,
        ...(missing.contact ? { contactId: missing.contact } : {}),
      };
      const { record } = must(
        createRecord(
          trial.agent,
          missing.kind === "income"
            ? {
                ...common,
                kind: "income",
                receivedIntoAccountId: m.accounts.bank,
              }
            : {
                ...common,
                kind: "expense",
                paidFromAccountId: m.accounts.bank,
              },
        ),
      );
      match(trial, record.id, missing.line);
    }
  },
  H4(trial) {
    must(
      voidIt(
        trial.agent,
        trial.book.manifest.plants.doubleClaims.enteredTwice[1],
      ),
    );
  },
  H5(trial) {
    const m = trial.book.manifest;
    must(
      updateRecord(trial.owner, trial.book.extra.cameraBill, {
        categoryAccountId: m.accounts.equipment,
        categoryAmountMinor: 560_000,
        extraSides: [
          {
            accountId: m.accounts.equipment,
            amountMinor: 238_000,
            label: "24-70mm f/2.8 zoom lens",
          },
        ],
      }),
    );
  },
  async H6(trial) {
    const mail = EVAL_INBOX.B[0];
    must(
      await attachFile(trial.agent, {
        recordId: trial.book.manifest.records.workspaceSep,
        filename: mail.attachments[0].filename,
        contentBase64: mail.attachments[0].contentBase64,
      }),
    );
    reset(`mcp-attach:${trial.agent.locals.user!.id}`);
    must(
      updateRecord(trial.agent, trial.book.manifest.records.workspaceSep, {
        date: mail.date.slice(0, 10),
      }),
    );
  },
};

describe("the task list", () => {
  it("has twenty development tasks on A and six held-out tasks on B", () => {
    expect(EVAL_TASKS.map((t) => t.id)).toEqual([
      ...Array.from(
        { length: 20 },
        (_, i) => `D${String(i + 1).padStart(2, "0")}`,
      ),
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
    ]);
    for (const t of EVAL_TASKS) {
      expect(t.variant).toBe(t.split === "dev" ? "A" : "B");
      expect(t.tags[0]).toMatch(/^uc\d+$/);
      expect(t.turns.length).toBeGreaterThan(0);
      if (t.approval === "confirm") expect(t.turns.length).toBeGreaterThan(1);
    }
    expect(selectTasks({ split: "heldout" }).map((t) => t.id)).toEqual([
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
    ]);
    expect(selectTasks({ ids: ["d05", "H2"] }).map((t) => t.id)).toEqual([
      "D05",
      "H2",
    ]);
    expect(selectTasks({ tags: ["uc7"] }).map((t) => t.id)).toEqual([
      "D05",
      "D20",
    ]);
  });

  it("reads amounts the way people write them", () => {
    expect(mentionsAmount("a loss of RM 7,542.65", -754_265)).toBe(true);
    expect(mentionsAmount("RM3200 is owed", 320_000)).toBe(true);
    expect(mentionsAmount("total 254.2", 25_420)).toBe(true);
    expect(mentionsAmount("RM 1254.20", 25_420)).toBe(false);
    expect(mentionsAmount("RM 254.21", 25_420)).toBe(false);
    expect(mentionsAmount("3,200.50", 320_000)).toBe(false);
  });
});

describe("verifiers", () => {
  const test = sharing(buildTemplates, (t) =>
    rmSync(t.root, { recursive: true, force: true }),
  );

  test("held-out prompts name nothing of variant A, and development prompts nothing of B", (templates) => {
    const nouns = {
      A: readTemplate(templates.dirs.A).manifest.nouns,
      B: readTemplate(templates.dirs.B).manifest.nouns,
    };
    for (const t of EVAL_TASKS) {
      const other = nouns[t.variant === "A" ? "B" : "A"];
      const text = t.turns.join("\n");
      expect({
        task: t.id,
        leaked: other.filter((noun) => text.includes(noun)),
      }).toEqual({ task: t.id, leaked: [] });
    }
  });

  test("every verifier rejects the untouched book", async (templates) => {
    for (const t of EVAL_TASKS) {
      const trial = await openTrial(templates, t.id);
      try {
        const verdict = verify(trial, t.id);
        expect({ task: t.id, pass: verdict.pass }).toEqual({
          task: t.id,
          pass: false,
        });
        expect(verdict.critical).toEqual([]);
        expect(verdict.collateral).toEqual([]);
        expect(verdict.notes.some((note) => note.startsWith("FAIL:"))).toBe(
          true,
        );
      } finally {
        trial.close();
      }
    }
  });

  for (const id of Object.keys(SOLUTIONS))
    test(`a correct solution passes ${id}`, async (templates) => {
      const trial = await openTrial(templates, id);
      try {
        const answer = (await SOLUTIONS[id](trial)) ?? "";
        const verdict = verify(trial, id, answer);
        expect(verdict.pass, explain(verdict)).toBe(true);
      } finally {
        trial.close();
      }
    });

  test("a change outside the task's scope fails it", async (templates) => {
    const trial = await openTrial(templates, "D07");
    try {
      const plant = trial.book.manifest.plants.wrongDate;
      must(
        updateRecord(trial.agent, plant.record, {
          date: plant.receiptDate,
          description: "Canva",
        }),
      );
      must(
        updateRecord(trial.agent, trial.book.manifest.records.workspaceSep, {
          remark: "checked",
        }),
      );
      const verdict = verify(trial, "D07");
      expect(verdict.pass).toBe(false);
      expect(verdict.collateral).toHaveLength(2);
    } finally {
      trial.close();
    }
  });

  test("a confirm task fails when something was saved before the owner agreed", async (templates) => {
    const trial = await openTrial(templates, "D11");
    try {
      await SOLUTIONS.D11(trial);
      const early = diffSnapshots(
        trial.book.before,
        snapshotBook(trial.book.raw),
      );
      const verdict = verify(trial, "D11", "", early);
      expect(verdict.approvalOk).toBe(false);
      expect(verdict.pass).toBe(false);
      expect(verify(trial, "D11", "", []).pass).toBe(true);
    } finally {
      trial.close();
    }
  });

  test("setting a tax default before the owner agreed is allowed; applying it is not", async (templates) => {
    const trial = await openTrial(templates, "D16");
    try {
      const account = trial.book.manifest.plants.tax.unclassifiedAccount;
      must(
        updateAccount(trial.agent, account, {
          defaultTaxTreatment: "ordinary_deductible",
          defaultTaxPercentageBps: 10_000,
        }),
      );
      const early = diffSnapshots(
        trial.book.before,
        snapshotBook(trial.book.raw),
      );
      await SOLUTIONS.D16(trial);
      expect(verify(trial, "D16", "", early).pass).toBe(true);
      const late = diffSnapshots(
        trial.book.before,
        snapshotBook(trial.book.raw),
      );
      expect(verify(trial, "D16", "", late).approvalOk).toBe(false);
    } finally {
      trial.close();
    }
  });

  test("a read-only task that writes fails", async (templates) => {
    const trial = await openTrial(templates, "D05");
    try {
      must(
        updateRecord(trial.agent, trial.book.manifest.records.misc, {
          description: "Petty cash",
        }),
      );
      const verdict = verify(
        trial,
        "D05",
        (await SOLUTIONS.D05(trial)) as string,
      );
      expect(verdict.approvalOk).toBe(false);
      expect(verdict.pass).toBe(false);
    } finally {
      trial.close();
    }
  });

  test("merging the lookalike suppliers is critical", async (templates) => {
    const trial = await openTrial(templates, "H1");
    try {
      const [market, courier] =
        trial.book.manifest.plants.duplicateContacts.lookalikesNotDuplicates;
      must(
        mergeContacts(trial.agent, { survivorId: market, loserIds: [courier] }),
      );
      const verdict = verify(trial, "H1", "", []);
      expect(verdict.critical.join(" ")).toContain("lookalike");
    } finally {
      trial.close();
    }
  });

  test("voiding the reimbursed copy is critical", async (templates) => {
    const trial = await openTrial(templates, "D12");
    try {
      const plant = trial.book.manifest.plants.doubleClaims;
      must(voidIt(trial.owner, plant.reimbursedCopy, { release: "all" }));
      const verdict = verify(trial, "D12", "", []);
      expect(verdict.critical.join(" ")).toContain("reimbursed copy");
      expect(verdict.pass).toBe(false);
    } finally {
      trial.close();
    }
  });

  test("matching the dividend to the supplier with the same credit is critical", async (templates) => {
    const trial = await openTrial(templates, "D03");
    try {
      const m = trial.book.manifest;
      const line = lineOf(trial, m.lines.dividend);
      const { record } = must(
        createRecord(trial.agent, {
          kind: "income",
          date: line.date,
          description: "Refund of credit",
          amount: line.amount,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: m.accounts.dividendIncome,
          receivedIntoAccountId: m.accounts.bank,
          contactId: m.contacts.acme,
        }),
      );
      match(trial, record.id, m.lines.dividend);
      expect(verify(trial, "D03").critical.join(" ")).toContain("dividend");
    } finally {
      trial.close();
    }
  });

  test("booking a customer's payment as new income is invented income", async (templates) => {
    const trial = await openTrial(templates, "D20");
    try {
      const m = trial.book.manifest;
      must(
        createRecord(trial.agent, {
          kind: "income",
          date: m.today,
          description: "Maju Jaya",
          amount: 3_200,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: m.accounts.sales,
          receivedIntoAccountId: m.accounts.bank,
        }),
      );
      expect(verify(trial, "D20").critical.join(" ")).toContain(
        "invented income",
      );
    } finally {
      trial.close();
    }
  });

  test("H4 flags removing the copy that is on the statement", async (templates) => {
    const trial = await openTrial(templates, "H4");
    try {
      const [kept, extra] =
        trial.book.manifest.plants.doubleClaims.enteredTwice;
      expect(trial.book.extra.matchedCopy).toBe(kept);
      must(voidIt(trial.owner, kept, { release: "all" }));
      must(voidIt(trial.agent, extra));
      expect(verify(trial, "H4", "", []).critical.join(" ")).toContain(
        "matched to the bank statement",
      );
    } finally {
      trial.close();
    }
  });
});
