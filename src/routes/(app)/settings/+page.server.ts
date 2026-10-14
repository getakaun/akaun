import type {
  UpgradeReport,
  UpgradeState,
  VerifyResult,
} from "$lib/server/ledger/types.js";
import { AccountType } from "$lib/enums.js";
import type { PageServerLoad, Actions } from "./$types.js";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import {
  getSetting,
  setSetting,
  SETTING_KEYS,
  hasAnyDocuments,
} from "$lib/server/settings.js";
import {
  LAYOUT_CATALOG,
  DEFAULT_LAYOUT_KEY,
  isLayoutKey,
} from "$lib/pdf/layout-catalog.js";
import { DEFAULT_PDF_THEME_COLOR } from "$lib/pdf/theme-presets.js";
import { DEFAULT_PDF_HEADER, isPdfHeaderStyle } from "$lib/pdf/header-style.js";
import {
  documentDefaults,
  MAX_TERM_DAYS,
  termDaysInput,
} from "$lib/server/sales/defaults.js";
import { isMoneyPotAccount } from "$lib/server/ledger/account-type.js";
import { hasPermission } from "$lib/server/permissions.js";
import {
  defaultAccountId,
  listAccounts,
} from "$lib/server/queries/accounts.js";
import {
  saveCompanyImage,
  deleteFile,
  sniffAllowedType,
  MAX_LOGO_BYTES,
} from "$lib/server/file-storage.js";
import {
  DEFAULT_SEQUENCE_TEMPLATE,
  validateTemplate,
} from "$lib/sequence-template.js";
import {
  getAllProviders,
  insertProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
} from "$lib/server/llmProviders.js";
import { parseStoredCredentials } from "$lib/server/llm/chatgpt-oauth.js";
import {
  peekConnection,
  takeConnection,
  connectionModelAllowed,
} from "$lib/server/llm/chatgpt-sign-in.js";
import type { ProviderType } from "$lib/server/import/providers/index.js";
import { fail, type ActionFailure } from "@sveltejs/kit";
import { getAccountDefaults } from "$lib/server/services/account-defaults.js";
import {
  applyProfileSwitches,
  importProfileList,
  planProfileSwitches,
} from "$lib/server/loaders/import-profiles.js";

/** What the Company form asked for one company image (logo or letterhead). */
type CompanyImageChange =
  | { kind: "none" }
  | { kind: "remove" }
  | { kind: "replace"; buffer: Buffer; filename: string };

/**
 * Read and check one company image field without storing anything: a JPEG or
 * PNG of at most 5MB, or the matching remove flag.
 */
async function readCompanyImage(
  data: FormData,
  fileField: string,
  removeField: string,
  label: string,
): Promise<CompanyImageChange | { failure: ActionFailure<{ error: string }> }> {
  const file = data.get(fileField);
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LOGO_BYTES) {
      return {
        failure: fail(413, { error: `${label} image must be 5MB or smaller.` }),
      };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const type = sniffAllowedType(buffer);
    if (type !== "jpeg" && type !== "png") {
      return {
        failure: fail(415, { error: `${label} must be a JPEG or PNG image.` }),
      };
    }
    return { kind: "replace", buffer, filename: file.name };
  }
  return data.get(removeField) === "true"
    ? { kind: "remove" }
    : { kind: "none" };
}

/** Store a checked company image change and drop the file it replaces. */
function applyCompanyImage(change: CompanyImageChange, key: string) {
  if (change.kind === "none") return;
  const oldPath = getSetting(db, key);
  if (change.kind === "replace") {
    setSetting(db, key, saveCompanyImage(change.buffer, change.filename));
  } else if (oldPath) {
    setSetting(db, key, "");
  }
  if (oldPath) deleteFile(oldPath);
}

/**
 * A category IS an account (FR-006a) — the everyday word on screen, the chart of
 * accounts underneath. There is no second list and no mapping between the two,
 * so what Settings offers and what an expense screen offers can never drift.
 */
export const load: PageServerLoad = async ({ locals }) => {
  // Categories are accounts, and accounts are created, renamed and archived on
  // the Accounts screen. Settings no longer lists them (FR-019, FR-020); this
  // one ability is still read, because the default-account setting below writes
  // an account (FR-011).
  const canManageAccounts = hasPermission(locals, "accounts", "change");

  // Which account new records start with, and the accounts it may be (FR-011).
  // With one account there is nothing to ask, so the setting stays off screen.
  // Money pots only: equipment is an asset but nothing is ever paid from it.
  const moneyAccounts = listAccounts(db, { type: AccountType.Asset })
    .filter(isMoneyPotAccount)
    .map((a) => ({
      id: a.id,
      name: a.name,
    }));
  const ledgerDefaultAccountId = defaultAccountId(db);
  const accountDefaults = getAccountDefaults(db);
  const defaultAccountOptions = listAccounts(db).map((account) => ({
    id: account.id,
    code: account.code ?? account.id,
    name: account.name,
    type: account.type,
    subType: account.subType,
    active: account.active ?? false,
    postingEligible: account.postingEligible ?? false,
  }));

  // What the one-off update to the new way of recording did, and whether the
  // books balance. Only the part meant to be read is sent — the before/after
  // snapshot behind it is working data, not something to put on a screen.
  //
  // Read straight from the settings row now. The module that wrote it is
  // retired with the tables it converted (research.md R-06), but what it
  // recorded is still worth showing: it is the account of a one-off change to
  // this installation's own books, and nothing rewrites it.
  const canSeeBooks = hasPermission(locals, "reports", "view");
  const upgradeRaw = canSeeBooks
    ? getSetting(db, SETTING_KEYS.ledgerUpgradeState)
    : null;
  const emptyReport: UpgradeReport = {
    uncategorisedRecordIds: [],
    missingAttachments: [],
    roundingDifferences: [],
    payerAttributions: [],
    bankFallbackRecordIds: [],
    unrepointedAllocationIds: [],
  };
  let upgrade: {
    finishedAt: string | null;
    verify: VerifyResult | null;
    report: UpgradeReport;
  } | null = null;
  if (upgradeRaw) {
    try {
      const state = JSON.parse(upgradeRaw) as Partial<UpgradeState>;
      upgrade = {
        finishedAt: state.finishedAt ?? null,
        verify: state.verify ?? null,
        report: state.report ?? emptyReport,
      };
    } catch {
      // An unreadable row says nothing; the screen simply shows no notes.
      upgrade = null;
    }
  }

  const sequenceTemplate =
    getSetting(db, SETTING_KEYS.sequenceTemplate) ?? DEFAULT_SEQUENCE_TEMPLATE;
  const currency = getSetting(db, SETTING_KEYS.currencyCode) ?? "USD";
  const locked = hasAnyDocuments(db);
  const currencyLocked = locked;
  const sequenceTemplateLocked = locked;

  const autoImportParallelTasks = parseInt(
    getSetting(db, SETTING_KEYS.autoImportParallelTasks) ?? "3",
    10,
  );
  const autoImportCategoryHints =
    (getSetting(db, SETTING_KEYS.autoImportCategoryHints) ?? "true") === "true";
  const autoImportRateLimitMs = parseInt(
    getSetting(db, SETTING_KEYS.autoImportRateLimitMs) ?? "0",
    10,
  );
  const autoImportCustomInstructions =
    getSetting(db, SETTING_KEYS.autoImportCustomInstructions) ?? "";

  const companyName = getSetting(db, SETTING_KEYS.companyName) ?? "";
  const companyAddress = getSetting(db, SETTING_KEYS.companyAddress) ?? "";
  const companyRegistrationNo =
    getSetting(db, SETTING_KEYS.companyRegistrationNo) ?? "";
  const companyLogoPath = getSetting(db, SETTING_KEYS.companyLogoPath) ?? "";
  const companyLogoUrl = companyLogoPath
    ? `/api/files/${encodeURIComponent(companyLogoPath)}`
    : null;
  const companyLetterheadPath =
    getSetting(db, SETTING_KEYS.companyLetterheadPath) ?? "";
  const companyLetterheadUrl = companyLetterheadPath
    ? `/api/files/${encodeURIComponent(companyLetterheadPath)}`
    : null;

  const providers = getAllProviders(db).map(({ oauthCredentials, ...p }) => {
    // A `chatgpt` provider's tokens never leave the server either: the
    // browser is told only who signed in.
    const signIn = parseStoredCredentials(oauthCredentials);
    return {
      ...p,
      hasApiKey: p.apiKey.length > 0,
      apiKey: "", // never send actual key to browser
      chatgptAccount: signIn ? { email: signIn.email ?? null } : null,
    };
  });

  // Import profiles, listed beside the providers (006 US6 AS1). This loader
  // checks no permission, so the list checks its own: seeing it needs
  // import.view and changing it import.change (FR-045).
  const importProfiles = importProfileList(locals);

  const pdfInvoiceLayoutKey =
    getSetting(db, SETTING_KEYS.pdfInvoiceLayoutKey) ?? DEFAULT_LAYOUT_KEY;
  const pdfQuotationLayoutKey =
    getSetting(db, SETTING_KEYS.pdfQuotationLayoutKey) ?? DEFAULT_LAYOUT_KEY;
  const pdfThemeColor =
    getSetting(db, SETTING_KEYS.pdfThemeColor) ?? DEFAULT_PDF_THEME_COLOR;
  const storedPdfHeader = getSetting(db, SETTING_KEYS.pdfHeader);
  const pdfHeader = isPdfHeaderStyle(storedPdfHeader)
    ? storedPdfHeader
    : DEFAULT_PDF_HEADER;

  // The terms new documents start with, as the inputs show them: what
  // `documentDefaults` reads, so a never-saved setting shows the 30 it means,
  // and "none" shows blank.
  const terms = documentDefaults(db);
  const invoiceDueDays =
    terms.invoiceDueDays === null ? "" : String(terms.invoiceDueDays);
  const quotationValidDays =
    terms.quotationValidDays === null ? "" : String(terms.quotationValidDays);

  return {
    canManageAccounts,
    moneyAccounts,
    ledgerDefaultAccountId,
    accountDefaults,
    defaultAccountOptions,
    canSeeBooks,
    upgrade,
    sequenceTemplate,
    currency,
    currencyLocked,
    sequenceTemplateLocked,
    username: locals.user!.username,
    autoImportParallelTasks,
    autoImportCategoryHints,
    autoImportRateLimitMs,
    autoImportCustomInstructions,
    companyName,
    companyAddress,
    companyRegistrationNo,
    companyLogoUrl,
    companyLetterheadUrl,
    providers,
    importProfiles,
    layoutCatalog: LAYOUT_CATALOG,
    pdfInvoiceLayoutKey,
    pdfQuotationLayoutKey,
    pdfThemeColor,
    pdfHeader,
    invoiceDueDays,
    quotationValidDays,
  };
};

export const actions: Actions = {
  saveGeneral: async ({ locals, request }) => {
    const data = await request.formData();
    const code = String(data.get("currencyCode") ?? "")
      .trim()
      .toUpperCase();

    // Which account a new expense or income starts with (FR-011). Only sent
    // by the browser when there is more than one to choose between.
    const chosenAccount = String(data.get("defaultAccountId") ?? "").trim();
    if (chosenAccount) {
      if (!hasPermission(locals, "accounts", "change")) {
        return fail(403, { error: "Forbidden" });
      }
      const parsed = z.coerce
        .number()
        .int()
        .positive()
        .safeParse(chosenAccount);
      const known =
        parsed.success &&
        listAccounts(db, { type: AccountType.Asset }).some(
          (a) => a.id === parsed.data && isMoneyPotAccount(a),
        );
      if (!known) {
        return fail(400, { error: "Choose one of your own accounts." });
      }
      setSetting(db, SETTING_KEYS.ledgerDefaultAccountId, String(parsed.data));
    }

    if (code) {
      const currentCode = getSetting(db, SETTING_KEYS.currencyCode) ?? "USD";
      if (hasAnyDocuments(db)) {
        if (code !== currentCode) {
          return fail(400, {
            error:
              "Currency is locked once any document exists — changing it would corrupt historical amounts.",
          });
        }
      } else if (/^[A-Z]{3}$/.test(code)) {
        setSetting(db, SETTING_KEYS.currencyCode, code);
      }
    }

    return { success: true, action: "saveGeneral" };
  },

  saveCompany: async ({ request }) => {
    const data = await request.formData();
    const companyName = String(data.get("companyName") ?? "").trim();
    const companyAddress = String(data.get("companyAddress") ?? "").trim();
    const companyRegistrationNo = String(
      data.get("companyRegistrationNo") ?? "",
    ).trim();
    // Both images are checked before either is stored, so a rejected
    // letterhead does not leave a half-applied save behind.
    const logo = await readCompanyImage(
      data,
      "companyLogo",
      "removeLogo",
      "Logo",
    );
    if ("failure" in logo) return logo.failure;
    const letterhead = await readCompanyImage(
      data,
      "companyLetterhead",
      "removeLetterhead",
      "Letterhead",
    );
    if ("failure" in letterhead) return letterhead.failure;

    applyCompanyImage(logo, SETTING_KEYS.companyLogoPath);
    applyCompanyImage(letterhead, SETTING_KEYS.companyLetterheadPath);

    setSetting(db, SETTING_KEYS.companyName, companyName);
    setSetting(db, SETTING_KEYS.companyAddress, companyAddress);
    setSetting(db, SETTING_KEYS.companyRegistrationNo, companyRegistrationNo);

    return { success: true, action: "saveCompany" };
  },

  savePdfTemplate: async ({ request }) => {
    const data = await request.formData();
    const invoiceLayoutKey = String(data.get("invoiceLayoutKey") ?? "");
    const quotationLayoutKey = String(data.get("quotationLayoutKey") ?? "");
    const themeColor = String(data.get("themeColor") ?? "").trim();
    const pdfHeader = String(data.get("pdfHeader") ?? "");
    // Blank is a choice ("none"); a missing field is not, so it fails too.
    const invoiceDueDays = termDaysInput(
      String(data.get("invoiceDueDays") ?? "x"),
    );
    const quotationValidDays = termDaysInput(
      String(data.get("quotationValidDays") ?? "x"),
    );

    if (!isLayoutKey(invoiceLayoutKey) || !isLayoutKey(quotationLayoutKey)) {
      return fail(400, { error: "Choose a valid layout." });
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(themeColor)) {
      return fail(400, { error: "Choose a valid accent color." });
    }
    if (!isPdfHeaderStyle(pdfHeader)) {
      return fail(400, { error: "Choose a valid header." });
    }
    if (invoiceDueDays === null || quotationValidDays === null) {
      return fail(400, {
        error: `Enter the days as a whole number from 0 to ${MAX_TERM_DAYS}, or leave it blank for none.`,
      });
    }

    setSetting(db, SETTING_KEYS.pdfInvoiceLayoutKey, invoiceLayoutKey);
    setSetting(db, SETTING_KEYS.pdfQuotationLayoutKey, quotationLayoutKey);
    setSetting(db, SETTING_KEYS.pdfThemeColor, themeColor);
    setSetting(db, SETTING_KEYS.pdfHeader, pdfHeader);
    setSetting(db, SETTING_KEYS.invoiceDueDays, invoiceDueDays);
    setSetting(db, SETTING_KEYS.quotationValidDays, quotationValidDays);

    return { success: true, action: "savePdfTemplate" };
  },

  saveSequenceTemplate: async ({ request }) => {
    if (hasAnyDocuments(db)) {
      return fail(400, {
        error:
          "Sequence number format is locked once any document exists — changing it would break historical document numbering.",
      });
    }
    const data = await request.formData();
    const template = String(data.get("template") ?? "").trim();
    const err = validateTemplate(template);
    if (err) return fail(400, { error: err });
    setSetting(db, SETTING_KEYS.sequenceTemplate, template);
    return { success: true, action: "saveSequenceTemplate" };
  },

  updateProvider: async ({ locals, request }) => {
    const data = await request.formData();
    const id = String(data.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Provider ID is required" });

    const updates: Record<string, unknown> = {};
    const name = String(data.get("name") ?? "").trim();
    const apiKey = String(data.get("apiKey") ?? "").trim();
    const model = String(data.get("model") ?? "").trim();
    const baseUrlRaw = data.get("baseUrl");

    if (name) updates.name = name;
    if (model) updates.model = model;
    if (apiKey) updates.apiKey = apiKey;
    // A new sign-in on a saved `chatgpt` provider replaces its tokens; without
    // one, the saved sign-in stays.
    const connectionId = String(data.get("connectionId") ?? "").trim();
    if (connectionId) {
      const provider = getAllProviders(db).find((p) => p.id === id);
      if (provider?.type !== "chatgpt")
        return fail(400, {
          error: "Device sign-in is only available for ChatGPT providers.",
        });
      if (
        !locals.user ||
        !connectionModelAllowed(locals.user.id, connectionId, model)
      )
        return fail(400, {
          error:
            "Load the available ChatGPT models and select one before saving.",
        });
      const signIn =
        locals.user && takeConnection(locals.user.id, connectionId);
      if (!signIn)
        return fail(400, {
          error:
            "The ChatGPT sign-in expired before it was saved. Sign in again.",
        });
      updates.oauthCredentials = JSON.stringify(signIn);
    }
    if (baseUrlRaw !== null)
      updates.baseUrl = String(baseUrlRaw).trim() || null;

    updateProvider(db, id, updates as Parameters<typeof updateProvider>[2]);

    return { success: true, action: "updateProvider" };
  },

  deleteProvider: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Provider ID is required" });

    // Codex sessions are disconnected locally; upstream sessions are managed in ChatGPT.
    deleteProvider(db, id);

    return { success: true, action: "deleteProvider" };
  },

  saveIntelligence: async ({ locals, request }) => {
    const data = await request.formData();
    const raw = String(data.get("providers") ?? "[]");

    // The import profiles turned on or off in the list, staged like the
    // provider switches. Checked first, so a refusal saves nothing on the tab;
    // applied last, each one audited.
    const profileSwitches = planProfileSwitches(
      locals,
      data.get("importProfiles"),
    );
    if (!profileSwitches.ok) {
      return fail(profileSwitches.status, { error: profileSwitches.error });
    }

    type ExistingEntry = { id: string; enabled: boolean };
    type NewEntry = {
      isNew: true;
      tempId: string;
      type: string;
      name: string;
      apiKey: string;
      model: string;
      baseUrl: string | null;
      enabled: boolean;
      /** A `chatgpt` row's finished sign-in, waiting for this save. */
      connectionId: string;
    };

    const VALID_TYPES: ProviderType[] = [
      "openrouter",
      "google_ai_studio",
      "groq",
      "chatgpt",
    ];

    let entries: (ExistingEntry | NewEntry)[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not array");
      entries = parsed.map((e) => {
        if (e?.isNew) {
          const tempId = String(e.tempId ?? "");
          if (!tempId) throw new Error("missing tempId");
          return {
            isNew: true,
            tempId,
            type: String(e.type ?? "").trim(),
            name: String(e.name ?? "").trim(),
            apiKey: String(e.apiKey ?? "").trim(),
            model: String(e.model ?? "").trim(),
            baseUrl: String(e.baseUrl ?? "").trim() || null,
            enabled: Boolean(e.enabled),
            connectionId: String(e.connectionId ?? "").trim(),
          } satisfies NewEntry;
        }
        return { id: String(e?.id ?? ""), enabled: Boolean(e?.enabled) };
      });
      if (entries.some((e) => !("isNew" in e) && !e.id))
        throw new Error("missing id");
    } catch {
      return fail(400, { error: "Invalid provider list data" });
    }

    const userId = locals.user!.id;
    // Each new `chatgpt` row needs a sign-in that is still waiting. All of them
    // are checked before anything is created, so an expired one saves nothing.
    const usedConnections = new Set<string>();
    for (const e of entries) {
      if (!("isNew" in e) || e.type !== "chatgpt") continue;
      if (!peekConnection(userId, e.connectionId))
        return fail(400, {
          error: `The ChatGPT sign-in for ${e.name || "a new provider"} expired before it was saved. Open it and sign in again.`,
        });
      if (
        usedConnections.has(e.connectionId) ||
        !connectionModelAllowed(userId, e.connectionId, e.model)
      )
        return fail(400, {
          error:
            "Each new ChatGPT provider needs its own connection and a model selected from its available models.",
        });
      usedConnections.add(e.connectionId);
    }

    const tempIdToRealId = new Map<string, string>();
    for (const e of entries) {
      if (!("isNew" in e)) continue;
      if (!VALID_TYPES.includes(e.type as ProviderType))
        return fail(400, { error: "Invalid provider type" });
      if (!e.name) return fail(400, { error: "Name is required" });
      if (!e.model) return fail(400, { error: "Model is required" });

      const signIn =
        e.type === "chatgpt" ? takeConnection(userId, e.connectionId) : null;
      const created = insertProvider(db, {
        type: e.type as ProviderType,
        name: e.name,
        apiKey: e.type === "chatgpt" ? "" : e.apiKey,
        model: e.model,
        baseUrl: e.baseUrl ?? undefined,
        oauthCredentials: signIn ? JSON.stringify(signIn) : null,
      });
      tempIdToRealId.set(e.tempId, created.id);
    }

    const resolveId = (e: ExistingEntry | NewEntry) =>
      "isNew" in e ? tempIdToRealId.get(e.tempId)! : e.id;

    reorderProviders(db, entries.map(resolveId));

    const current = new Map(getAllProviders(db).map((p) => [p.id, p.enabled]));
    for (const e of entries) {
      const id = resolveId(e);
      if (current.get(id) !== e.enabled) {
        updateProvider(db, id, { enabled: e.enabled });
      }
    }

    const parallelTasks = Math.min(
      10,
      Math.max(1, parseInt(String(data.get("parallelTasks") ?? "3"), 10)),
    );
    const categoryHints = data.get("categoryHints") === "true";
    const rateLimitMs = Math.min(
      30000,
      Math.max(0, parseInt(String(data.get("rateLimitMs") ?? "0"), 10) || 0),
    );
    const customInstructions = String(data.get("customInstructions") ?? "")
      .trim()
      .slice(0, 2000);

    setSetting(db, SETTING_KEYS.autoImportParallelTasks, String(parallelTasks));
    setSetting(db, SETTING_KEYS.autoImportCategoryHints, String(categoryHints));
    setSetting(db, SETTING_KEYS.autoImportRateLimitMs, String(rateLimitMs));
    setSetting(
      db,
      SETTING_KEYS.autoImportCustomInstructions,
      customInstructions,
    );

    applyProfileSwitches(locals.user!.id, profileSwitches.switches);

    return { success: true, action: "saveIntelligence" };
  },
};
