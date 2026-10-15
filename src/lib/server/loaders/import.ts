import { redirect } from "@sveltejs/kit";
import { desc, eq } from "drizzle-orm";
import { DefaultAccountPurpose, ImportState } from "$lib/enums.js";
import {
  PROFILE_FILE_TYPE_LABELS,
  profileFileTypes,
} from "$lib/import-profile-schema.js";
import { ImportReadAs, profileReadAsValue } from "$lib/import-reading.js";
import { db } from "$lib/server/db/client.js";
import { importQueue } from "$lib/server/db/schema.js";
import {
  isImportIncomeTarget,
  isImportPurchaseSource,
  isImportTransactionAsset,
} from "$lib/server/import/account-policy.js";
import { categoryChoices } from "$lib/server/import/category-accounts.js";
import { jobEvents } from "$lib/server/import/group-state.js";
import {
  parseProfileSnapshot,
  snapshotSections,
} from "$lib/server/import/profile-snapshot.js";
import type { LedgerDb } from "$lib/server/ledger/types.js";
import { can } from "$lib/server/permissions.js";
import { getAccount, listAccounts } from "$lib/server/queries/accounts.js";
import { requireAccountDefault } from "$lib/server/services/account-defaults.js";
import { listGroupItems } from "$lib/server/services/import-items.js";
import { listImportProfiles } from "$lib/server/services/import-profiles.js";

/**
 * The loads behind `/import` (the queue) and `/import/[id]` (one document read
 * as several items, with its items).
 *
 * Split, as every feature's loaders are (CLAUDE.md "Loaders are split"): the
 * queue sends every job and none of their items, and a group's page sends one
 * job and all of its items. Neither has to load what the other shows.
 *
 * Both take the database as an argument with the real one as the default, so
 * a spec can run them against a temporary database.
 */

const LIST_PATH = "/import";

/**
 * The built-in "Read as" choices the upload offers, in order (006 FR-001). The
 * first is the default. The enabled profiles follow them; see
 * `readAsChoices`.
 */
export const READ_AS_CHOICES: { value: string; label: string }[] = [
  { value: ImportReadAs.Auto, label: "Auto-detect" },
  { value: ImportReadAs.Receipt, label: "Single record" },
  { value: ImportReadAs.SeveralItems, label: "Multiple records" },
];

/**
 * Every "Read as" choice the upload offers: the built-in ones, then each
 * enabled profile by name (FR-001 AS1, US6 AS5). A profile that reads one
 * kind of file says which, since it refuses the other (FR-057, FR-070): a
 * table read by code is in a spreadsheet only. A disabled or deleted profile
 * is not offered (US6 AS12), and the upload refuses it if it is named anyway.
 * Sent from the server, so the screen needs no rule of its own: a choice it
 * remembered that is no longer in this list is simply not restored.
 *
 * There is no other choice: a profile is read in its own import mode
 * (FR-002), so choosing the profile chooses the mode.
 */
export function readAsChoices(
  database: LedgerDb,
): { value: string; label: string }[] {
  const profiles = listImportProfiles(database, { enabledOnly: true }).map(
    (profile) => {
      const types = profileFileTypes(profile);
      return {
        value: profileReadAsValue(profile.id),
        label:
          types.length === 1
            ? `${profile.name} (${PROFILE_FILE_TYPE_LABELS[types[0]].only})`
            : profile.name,
      };
    },
  );
  return [...READ_AS_CHOICES, ...profiles];
}

/** The queue: every job, newest first, with each group's item counts. */
export function loadImportPage(locals: App.Locals, database: LedgerDb = db) {
  if (!can(locals, "import.read"))
    throw redirect(302, "/dashboard");

  // Shared ledger — show every job. Sent in the shape of a live update, without
  // the document text (no screen reads it, and it would be serialised into the
  // page for every row), and with each group's item counts.
  const jobs = jobEvents(
    database,
    database
      .select()
      .from(importQueue)
      .orderBy(desc(importQueue.createdAt))
      .all(),
  );

  return {
    jobs,
    readAsChoices: readAsChoices(database),
    perms: {
      change: can(locals, "import.update"),
      confirm: can(locals, "import.confirm"),
      readAgain: canReadAgain(locals),
    },
    ...reviewOptions(database),
  };
}

/**
 * One document read as several items, with every item, for `/import/[id]`.
 *
 * A group holds at most a thousand items and an item row keeps no document
 * text, so all of them are sent and the page pages and filters them itself, as
 * the Records screen does (006 FR-017).
 *
 * The page is for a group only. A job that is missing, or that is not a group
 * (a receipt, or a document whose reading has not finished), goes back to the
 * queue, which is where such a job is reviewed. There is no error page in the
 * app shell to land on instead.
 */
export function loadImportDetail(
  locals: App.Locals,
  id: string,
  database: LedgerDb = db,
) {
  if (!can(locals, "import.read"))
    throw redirect(302, "/dashboard");

  const row = database
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, id))
    .get();
  if (!row) throw redirect(302, LIST_PATH);

  const items = listGroupItems(database, id);
  // A finished group (every item confirmed or skipped) is no longer Grouped,
  // but its page still lists what became of each item.
  if (row.state !== ImportState.Grouped && items.length === 0) {
    throw redirect(302, LIST_PATH);
  }

  const [job] = jobEvents(database, [row]);
  const expenseCategories = categoryChoices(database, "expense").map(
    ({ id, name }) => ({ id, name }),
  );
  const incomeCategories = categoryChoices(database, "income").map(
    ({ id, name }) => ({ id, name }),
  );

  // The sections of the profile it was read with, as it was then, for the
  // section filter and each item's section name (FR-017). Empty for the
  // built-in reading, whose one section has no name of its own.
  const snapshot = parseProfileSnapshot(row.profileSnapshot);
  const sections = snapshot ? snapshotSections(snapshot) : [];

  return {
    job,
    items,
    sections,
    expenseCategories,
    incomeCategories,
    // The choices "Read again" offers: the same ones an upload offers.
    readAsChoices: readAsChoices(database),
    perms: {
      change: can(locals, "import.update"),
      confirm: can(locals, "import.confirm"),
      delete: can(locals, "import.delete"),
      readAgain: canReadAgain(locals),
    },
    ...reviewOptions(database),
  };
}

/**
 * Whether this user may use "Read again": the two abilities its route asks
 * for (`import.create` to read a document, `import.update` to replace what the
 * last reading proposed). The screens show the action only then; the route
 * checks again, so this only saves a refused request.
 */
function canReadAgain(locals: App.Locals): boolean {
  return can(locals, "import.create") && can(locals, "import.update");
}

/**
 * The accounts and defaults a review card needs, whether it reviews a receipt
 * on the queue or an item on a group's page. One function, so both offer the
 * same accounts.
 */
function reviewOptions(database: LedgerDb) {
  // Categories are accounts now (FR-006a); the review screen still picks one by
  // name, which is what the confirm step matches back to an account.
  const expenseChoices = categoryChoices(database, "expense");
  const incomeChoices = categoryChoices(database, "income");

  const allAccounts = listAccounts(database, {});

  // Accounts Payable is offered alongside the money pots for an expense job
  // only: picking it is how a reviewer says "I paid this personally, the
  // business owes me" rather than "it came out of the bank" (FR-008, FR-011).
  // Income has no equivalent — every income record is category → asset, with
  // no "not yet received" side to pick instead.
  const payable = requireAccountDefault(
    database,
    DefaultAccountPurpose.Payable,
  );
  const payableAccount = payable.ok
    ? getAccount(database, payable.value)
    : null;
  const receivable = requireAccountDefault(
    database,
    DefaultAccountPurpose.Receivable,
  );
  const receivableAccount = receivable.ok
    ? getAccount(database, receivable.value)
    : null;
  const transactionDefault = requireAccountDefault(
    database,
    DefaultAccountPurpose.EverydayTransaction,
  );
  const uncategorised = requireAccountDefault(
    database,
    DefaultAccountPurpose.UncategorisedExpense,
  );
  const uncategorisedIncome = requireAccountDefault(
    database,
    DefaultAccountPurpose.UncategorisedIncome,
  );

  const expensePaymentAccounts = allAccounts.filter((account) =>
    isImportPurchaseSource(account, payableAccount?.id ?? null),
  );
  const incomeReceiptAccounts = allAccounts.filter((account) =>
    isImportIncomeTarget(account, receivableAccount?.id ?? null),
  );
  // The accounts either side of a transfer can be (FR-058): the ones that
  // hold money. Sent from here so no screen copies the rule.
  const transferAccounts = allAccounts.filter(isImportTransactionAsset);
  const categoryIds = new Set(
    [...expenseChoices, ...incomeChoices].map((choice) => choice.id),
  );
  const categoryAccounts = allAccounts.filter((account) =>
    categoryIds.has(account.id),
  );

  return {
    categoryAccounts,
    allAccounts,
    accounts: incomeReceiptAccounts,
    expensePaymentAccounts,
    transferAccounts,
    payableAccountId: payableAccount?.id ?? null,
    receivableAccountId: receivableAccount?.id ?? null,
    uncategorisedAccountId: uncategorised.ok ? uncategorised.value : null,
    uncategorisedIncomeAccountId: uncategorisedIncome.ok
      ? uncategorisedIncome.value
      : null,
    defaultAccountId: transactionDefault.ok ? transactionDefault.value : null,
  };
}
