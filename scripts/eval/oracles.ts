import { reset } from "../../src/lib/server/rate-limit.js";
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
import type { AppContext } from "../../src/lib/server/application/context.js";
import { getRecord } from "../../src/lib/server/queries/ledger.js";
import { EVAL_INBOX } from "../../src/lib/server/mcp/__fixtures__/eval-book.js";
import type { EvalOracle, OracleContext } from "./tasks.ts";

/**
 * The evaluation's oracles: for each task, the fix a careful person would
 * make, written against `application/` functions only (never the MCP tools),
 * so it shows what the book should look like when the task is done.
 *
 * `run.ts --oracle` loads `ORACLES` (see `loadOracles` in `trial.ts`), applies
 * each oracle to the trial's book and verifies it, which proves a task can be
 * passed. A read-only task's oracle returns the expected final answer.
 * `eval-scenarios.spec.ts` checks every oracle against its verifier, and the
 * verifier against known-wrong fixes.
 *
 * This file must not import `vitest`, `db/client.ts` or anything that opens
 * the configured database: a trial process loads it under the eval preload.
 */

/** What a solution needs: the trial's book, the agent's own access, and the owner's. */
export type SolverContext = Pick<OracleContext, "book" | "agent" | "owner">;

export function must<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Matches a record's bank side to a statement line. */
export function match(trial: SolverContext, recordId: number, lineId: number) {
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

export function lineOf(trial: SolverContext, lineId: number) {
  return trial.book.raw
    .query("SELECT date, amount FROM bank_statement_lines WHERE id = ?")
    .get(lineId) as { date: string; amount: number };
}

export function voidIt(
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

/** The known-good solutions, one per task, written against `application/`. */
export const SOLUTIONS: Record<
  string,
  (trial: SolverContext) => Promise<string | void> | string | void
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

/** One oracle per task, each the task's solution above. */
export const ORACLES: Record<string, EvalOracle> = Object.fromEntries(
  Object.entries(SOLUTIONS).map(([id, solve]) => [
    id,
    ({ book, agent, owner }: OracleContext) => solve({ book, agent, owner }),
  ]),
);
