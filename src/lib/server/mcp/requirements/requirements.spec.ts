import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isDelegable, type LeafPermission } from "$lib/permissions/catalog.js";
import {
  expandScopes,
  OAUTH_SCOPES,
  READ_SCOPES,
  SCOPE_LABELS,
  SCOPE_PERMISSIONS,
  scopeTier,
  type OAuthScope,
} from "$lib/permissions/oauth-scopes.js";
import { localsFor } from "../../permissions/test-locals.js";
import { allowedScopes } from "../../oauth/scopes.js";
import { parseScopes } from "../../oauth/service.js";
import { ACCOUNT_TAX_PERMISSIONS } from "../../application/account-tax-classification.js";
import { DEPRECIATION_WRITE } from "../../application/depreciation.js";
import { ASSET_READ_PERMISSIONS } from "../../application/fixed-assets.js";
import type { LedgerDb } from "../../ledger/types.js";
import type { BlobStore } from "../../storage/blob-store.js";
import {
  inspectRpc,
  MAX_ATTACH_RPC_BYTES,
  MAX_RPC_BYTES,
} from "../oauth-challenge.js";
import { toolError } from "../envelope.js";
import {
  actionAllowed,
  defineWriteTool,
  requirementsMet,
  runTool,
  toolName,
  visibleTools,
  type NamingScheme,
  type ToolAccess,
  type ToolRequirements,
} from "../registry.js";
import {
  ACTION_REQUIREMENTS,
  actionRefusal,
  actionsInArguments,
  ANY_READ,
  CHANGE_ACCOUNTS,
  CHANGE_CONTACTS,
  CHANGE_RECORDS,
  GET_REPORT,
  LIST_ACCOUNTS,
  MANAGE_FIXED_ASSETS,
  missingForActions,
  requirementEntry,
  TOOL_REQUIREMENTS_V2,
  toolBaseOf,
  type RequirementEntry,
} from "./index.js";

/**
 * The v2 requirement tables, the any-of listing they give the registry, and
 * the step-up `inspectRpc` derives from a call's actions. No database: the
 * callers are built from permissions (`test-locals.ts`), as a request would
 * carry them.
 */

const ORIGIN = "https://books.example.com";

/** The plan's catalogue (the "Tool catalogue" section), in listing order. */
const READS = [
  "get_books_overview",
  "search_records",
  "get_record",
  "get_attachment",
  "get_bank_statement_file",
  "list_accounts",
  "find_contacts",
  "get_contact",
  "get_category_history",
  "get_report",
  "get_bank_reconciliation",
  "review_books",
  "get_sales_documents",
  "get_import_queue",
  "get_change_history",
];
/** Each write and its action arrays, from the catalogue's writes table. */
const WRITE_ACTIONS: Record<string, string[]> = {
  attach_file: [],
  create_records: ["records"],
  change_records: ["update", "void", "delete"],
  record_payments: ["pay", "allocate", "reimburse"],
  change_allocations: ["reallocate"],
  match_bank_lines: ["match", "create_from_lines", "auto_match"],
  unmatch_bank_lines: ["unmatch"],
  change_contacts: ["create", "update", "merge", "delete"],
  change_accounts: [
    "create",
    "update",
    "delete",
    "set_opening_balance",
    "set_default",
    "apply_tax_default",
  ],
  manage_fixed_assets: [
    "capitalise",
    "register",
    "update",
    "approve",
    "post_depreciation",
    "stop",
    "reverse_run",
  ],
  create_sales_documents: ["invoices", "quotations"],
  change_sales_documents: [
    "invoice_update",
    "invoice_issue",
    "invoice_void",
    "invoice_delete",
    "quotation_update",
    "quotation_status",
    "quotation_revise",
    "quotation_convert",
    "quotation_delete",
  ],
  review_imports: ["update_item", "confirm", "skip", "discard"],
};

const CORRECTION_PATHS = [
  "correct_record_date",
  "correct_expense_contact",
  "correct_payment_recipient",
  "correct_reimbursement_amount",
  "correct_settled_amount",
  "release_bank_matches",
  "records_adjust",
];
const VOID_PATHS = [
  "void_release_allocations",
  "void_release_all",
  "reverse_reimbursement",
];

/** Every route of an entry: the tool's own, each action's and each check's. */
function routesOf(entry: RequirementEntry): [string, ToolRequirements][] {
  return [
    ["(tool)", entry.requirements],
    ...Object.entries(entry.actions ?? {}),
    ...Object.entries(entry.checks ?? {}),
  ];
}

const plain = (requirements: ToolRequirements | ToolAccess[]) =>
  requirements.map(({ scopes, permissions }) => ({
    scopes: [...scopes],
    permissions: [...permissions],
  }));

/** An app: the user's role (everything, unless limited) ∩ these scopes. */
function app(
  scopes: OAuthScope[],
  role: { grants?: string[]; delegable?: string[] } = {},
): App.Locals {
  return {
    ...localsFor(role.grants ?? [], {
      superuser: role.grants === undefined,
      delegable: role.delegable,
      credential: expandScopes(scopes),
    }),
    credential: { kind: "oauth", grantId: "grant", clientId: "client" },
    oauth: {
      clientId: "client",
      grantId: "grant",
      resource: `${ORIGIN}/mcp`,
      scopes,
    },
  };
}

/** A personal access token with these permissions, for a user who has them all. */
const token = (permissions: string[]): App.Locals => ({
  ...localsFor([], { superuser: true, credential: permissions }),
  credential: { kind: "pat", tokenId: 1 },
});

function rpc(name: string, args?: unknown, padding = 0) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
      ...(padding ? { padding: "x".repeat(padding) } : {}),
    }),
  });
}

/** The scopes a call is challenged for, or null when it goes through. */
async function challenged(
  locals: App.Locals,
  name: string,
  args?: unknown,
  naming?: NamingScheme,
): Promise<string | null> {
  const inspection = await inspectRpc(
    rpc(name, args),
    locals,
    naming ? { naming } : undefined,
  );
  if (!inspection.response) return null;
  expect(inspection.response.status).toBe(403);
  const header = inspection.response.headers.get("WWW-Authenticate") ?? "";
  expect(header).toBe(
    `Bearer error="insufficient_scope", scope="${/scope="([^"]*)"/.exec(header)?.[1]}", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
  );
  return /scope="([^"]*)"/.exec(header)![1];
}

describe("the v2 requirement tables", () => {
  it("cover the catalogue's 28 tools, reads before writes", () => {
    expect(Object.keys(TOOL_REQUIREMENTS_V2)).toEqual([
      ...READS,
      ...Object.keys(WRITE_ACTIONS),
    ]);
    for (const base of READS)
      expect(TOOL_REQUIREMENTS_V2[base].kind, base).toBe("read");
    for (const base of Object.keys(WRITE_ACTIONS))
      expect(TOOL_REQUIREMENTS_V2[base].kind, base).toBe("write");
    expect(Object.keys(TOOL_REQUIREMENTS_V2)).toHaveLength(28);
  });

  it("give every write action the catalogue lists an entry", () => {
    for (const [base, actions] of Object.entries(WRITE_ACTIONS)) {
      expect(Object.keys(requirementEntry(base).actions ?? {}), base).toEqual(
        actions,
      );
      for (const action of actions)
        expect(
          requirementEntry(base).actions![action].length,
          `${base}.${action}`,
        ).toBeGreaterThan(0);
    }
    expect(Object.keys(ACTION_REQUIREMENTS)).toEqual(
      Object.keys(WRITE_ACTIONS).filter((b) => WRITE_ACTIONS[b].length),
    );
    expect(Object.keys(requirementEntry("create_records").checks!)).toEqual([
      "records_adjust",
    ]);
    expect(Object.keys(CHANGE_RECORDS.checks!)).toEqual([
      ...CORRECTION_PATHS,
      ...VOID_PATHS,
    ]);
  });

  it("never name a check like an action of the same tool", () => {
    for (const [base, entry] of Object.entries(TOOL_REQUIREMENTS_V2))
      for (const check of Object.keys(entry.checks ?? {}))
        expect(Object.keys(entry.actions ?? {}), base).not.toContain(check);
  });

  it("give every route scopes that stand for its permissions, all of them delegable", () => {
    for (const [base, entry] of Object.entries(TOOL_REQUIREMENTS_V2))
      for (const [part, requirements] of routesOf(entry)) {
        expect(requirements.length, `${base} ${part}`).toBeGreaterThan(0);
        for (const option of requirements) {
          expect(option.scopes.length, `${base} ${part}`).toBeGreaterThan(0);
          const covered = new Set(expandScopes(option.scopes));
          for (const permission of option.permissions) {
            expect(
              covered.has(permission),
              `${base} ${part}: ${permission}`,
            ).toBe(true);
            expect(isDelegable(permission), permission).toBe(true);
            if (permission.startsWith("reports."))
              expect(permission).toBe("reports.read");
          }
        }
      }
  });

  it("keep what a read tool lists and selects to read leaves", () => {
    for (const base of READS) {
      const entry = requirementEntry(base);
      for (const requirements of [
        entry.requirements,
        ...Object.values(entry.actions ?? {}),
      ])
        for (const option of requirements)
          for (const permission of option.permissions)
            expect(permission, base).toMatch(/\.read$/);
    }
  });

  it("ask what the operations ask where no v1 tool did the same", () => {
    const leaves = (r: ToolRequirements) => r.map((o) => [...o.permissions]);
    // mergeContacts
    expect(leaves(CHANGE_CONTACTS.actions!.merge)).toEqual([
      ["contacts.merge", "contacts.update", "contacts.delete"],
    ]);
    // ACCOUNT_TAX_PERMISSIONS: the overview, preview and apply
    expect(leaves(CHANGE_ACCOUNTS.actions!.apply_tax_default)).toEqual([
      [...ACCOUNT_TAX_PERMISSIONS],
    ]);
    expect(leaves(LIST_ACCOUNTS.checks!.tax_overview)).toEqual([
      [...ACCOUNT_TAX_PERMISSIONS],
    ]);
    // PUT /api/settings/account-defaults
    expect(leaves(CHANGE_ACCOUNTS.actions!.set_default)).toEqual([
      ["accounts.update"],
    ]);
    // fixed-assets.ts WRITE_PERMISSIONS and depreciation.ts DEPRECIATION_WRITE
    const assets = MANAGE_FIXED_ASSETS.actions!;
    for (const action of ["register", "update"])
      expect(leaves(assets[action])).toEqual([
        [...ASSET_READ_PERMISSIONS, "accounts.update"],
      ]);
    for (const action of ["approve", "post_depreciation", "stop"])
      expect(leaves(assets[action])).toEqual([[...DEPRECIATION_WRITE]]);
    expect(leaves(assets.reverse_run)).toEqual([
      [...DEPRECIATION_WRITE, "records.void"],
    ]);
    expect(leaves(assets.capitalise)).toEqual([
      [...ASSET_READ_PERMISSIONS, "accounts.update", "records.update"],
    ]);
    // readFixedAssets and outstandingAgeing, on top of reports.read
    expect(leaves(GET_REPORT.actions!.fixed_assets)).toEqual([
      ["reports.read", ...ASSET_READ_PERMISSIONS],
    ]);
    expect(leaves(GET_REPORT.actions!.aged_receivables)).toEqual([
      ["reports.read", "records.read"],
    ]);
    // correctSettledAmount: update and create, plus Correct allocations or delete
    expect(leaves(CHANGE_RECORDS.checks!.correct_settled_amount)).toEqual([
      ["records.update", "records.create", "records.correctAllocations"],
      ["records.update", "records.create", "records.delete"],
    ]);
  });

  it("make each change_records path a complete route that includes its action", () => {
    const includes = (option: ToolAccess, action: ToolAccess) =>
      action.scopes.every((s) => option.scopes.includes(s)) &&
      action.permissions.every((p) => option.permissions.includes(p));
    const [update] = CHANGE_RECORDS.actions!.update;
    const [voids] = CHANGE_RECORDS.actions!.void;
    for (const path of CORRECTION_PATHS)
      for (const option of CHANGE_RECORDS.checks![path])
        expect(includes(option, update), path).toBe(true);
    for (const path of VOID_PATHS)
      for (const option of CHANGE_RECORDS.checks![path])
        expect(includes(option, voids), path).toBe(true);
  });

  it("list a write tool when any one action is allowed, with no route another covers", () => {
    for (const [base, actions] of Object.entries(ACTION_REQUIREMENTS))
      for (const [action, requirements] of Object.entries(actions))
        for (const option of requirements) {
          for (const locals of [
            app([...option.scopes]),
            token([...option.permissions]),
          ]) {
            expect(requirementsMet(locals, actions[action]), base).toBe(true);
            expect(
              requirementsMet(locals, requirementEntry(base).requirements),
              `${base} via ${action}`,
            ).toBe(true);
          }
        }
    // update and set_default are one route; set_opening_balance and
    // apply_tax_default ask for more than update does.
    expect(plain(CHANGE_ACCOUNTS.requirements)).toEqual([
      { scopes: ["accounts:write"], permissions: ["accounts.create"] },
      { scopes: ["accounts:write"], permissions: ["accounts.update"] },
      { scopes: ["accounts:delete"], permissions: ["accounts.delete"] },
    ]);
    expect(
      requirementsMet(app(["contacts:read"]), CHANGE_RECORDS.requirements),
    ).toBe(false);
  });

  it("list the runtime-checked reads for any read scope, and only then", () => {
    for (const base of [
      "get_books_overview",
      "review_books",
      "get_change_history",
    ]) {
      expect(plain(requirementEntry(base).requirements)).toEqual(
        plain(ANY_READ),
      );
      for (const scope of READ_SCOPES)
        expect(
          requirementsMet(app([scope]), requirementEntry(base).requirements),
        ).toBe(true);
      expect(
        requirementsMet(
          app(["records:write"]),
          requirementEntry(base).requirements,
        ),
      ).toBe(false);
    }
  });
});

describe("finding and refusing actions", () => {
  it("finds the actions an argument holds, in declared order", () => {
    expect(
      actionsInArguments("change_records", {
        void: [{ record: "EXP-1" }],
        update: [{ record: "EXP-2" }],
        delete: [],
        dry_run: true,
      }),
    ).toEqual(["update", "void"]);
    expect(
      actionsInArguments("change_records", { update: null, void: false }),
    ).toEqual([]);
    expect(
      actionsInArguments("match_bank_lines", {
        auto_match: { account: "1000" },
      }),
    ).toEqual(["auto_match"]);
    expect(
      actionsInArguments("get_report", { report: "aged_payables" }),
    ).toEqual(["aged_payables"]);
    expect(
      actionsInArguments("get_sales_documents", { kind: "quotation" }),
    ).toEqual(["quotation"]);
    for (const args of [
      { report: "bogus" },
      { report: "constructor" },
      { report: ["aged_payables"] },
      null,
      [],
      "report",
    ])
      expect(actionsInArguments("get_report", args)).toEqual([]);
    expect(actionsInArguments("attach_file", { recordId: 1 })).toEqual([]);
    expect(actionsInArguments("get_record", { record: "EXP-1" })).toEqual([]);
    expect(() => actionsInArguments("constructor", {})).toThrow();
  });

  it("maps registered names back to bases, in the scheme served", () => {
    expect(toolBaseOf("akaun_change_records")).toBe("change_records");
    expect(toolBaseOf("akaun_records_change")).toBeNull();
    expect(toolBaseOf("akaun_records_change", "akaun_noun_verb")).toBe(
      "change_records",
    );
    expect(toolBaseOf("change_records")).toBeNull();
    expect(toolBaseOf("change_records", "plain")).toBe("change_records");
    // v1's names (the tools were removed) are not tools of any scheme.
    for (const v1Name of ["create_record", "void_record", "list_records"])
      expect(toolBaseOf(v1Name)).toBeNull();
    expect(toolBaseOf("akaun_constructor")).toBeNull();
    for (const base of Object.keys(TOOL_REQUIREMENTS_V2))
      expect(toolBaseOf(toolName(base))).toBe(base);
  });

  it("names what each refused action lacks, and nothing for allowed ones", () => {
    const voidOnly = app(["records:read", "records:void"]);
    expect(
      missingForActions(voidOnly, "change_records", ["void", "update"]),
    ).toEqual([
      {
        action: "update",
        missingScopes: ["records:write"],
        missingPermissions: ["records.update"],
      },
    ]);
    // A check is asked the same way, once the path is known.
    expect(
      missingForActions(app(["records:write"]), "create_records", [
        "records",
        "records_adjust",
      ]),
    ).toEqual([
      {
        action: "records_adjust",
        missingScopes: ["records:adjust"],
        missingPermissions: ["records.adjust"],
      },
    ]);
    // A token has no scopes: only permissions are named.
    expect(
      missingForActions(
        token(["records.read", "records.void"]),
        "change_records",
        ["delete"],
      ),
    ).toEqual([
      {
        action: "delete",
        missingScopes: [],
        missingPermissions: ["records.delete"],
      },
    ]);
    expect(() =>
      missingForActions(voidOnly, "change_records", ["undo"]),
    ).toThrow();
  });

  it("names the route the caller could be granted, else the first", () => {
    const writer = ["records.read", "records.create", "records.update"];
    // The role holds the grouped correction leaf and the delete leaf: the
    // narrow route comes first.
    expect(
      missingForActions(app(["records:write"]), "change_allocations", [
        "reallocate",
      ])[0].missingScopes,
    ).toEqual(["records:correction"]);
    // Without Correct allocations in the role, only legacy deletion is offered.
    expect(
      missingForActions(
        app(["records:write"], {
          grants: [...writer, "records.delete"],
        }),
        "change_allocations",
        ["reallocate"],
      )[0].missingScopes,
    ).toEqual(["records:delete"]);
    // Nor when the ceiling keeps Correct allocations from apps.
    expect(
      missingForActions(
        app(["records:write"], {
          grants: [...writer, "records.delete", "records.correctAllocations"],
          delegable: [...writer, "records.delete"],
        }),
        "change_allocations",
        ["reallocate"],
      )[0].missingScopes,
    ).toEqual(["records:delete"]);
  });

  it("words the refusal with each action and what to grant", () => {
    const refusal = actionRefusal("akaun_change_records", [
      {
        action: "update",
        missingScopes: ["records:write"],
        missingPermissions: ["records.update"],
      },
      {
        action: "delete",
        missingScopes: [],
        missingPermissions: ["records.delete"],
      },
    ]);
    expect(refusal).toEqual({
      code: "FORBIDDEN",
      message:
        "This connection may not use update, delete in akaun_change_records: update needs the OAuth scope records:write and the permission records.update; delete needs the permission records.delete.",
      fix: "Send the call without the update, delete items, or ask the person who runs Akaun to grant what is named (an app is reconnected to allow a scope; a token is replaced by one with the permission), then call again.",
    });
  });
});

describe("any-of listing through the registry", () => {
  const notUsed = new Proxy(
    {},
    {
      get() {
        throw new Error("This stand-in tool must not touch the book.");
      },
    },
  );
  /** The shape the real tool will have: the entry's actions, checked per call. */
  const changeRecords = defineWriteTool({
    base: "change_records",
    title: "Change records",
    description: "A stand-in that checks its actions as the real tool does.",
    input: z.object({
      update: z.array(z.object({})).optional(),
      void: z.array(z.object({})).optional(),
      delete: z.array(z.object({})).optional(),
    }),
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    requirements: CHANGE_RECORDS.requirements,
    actions: CHANGE_RECORDS.actions,
    handler: (ctx, args, meta) => {
      const shortfalls = missingForActions(
        ctx.locals,
        "change_records",
        actionsInArguments("change_records", args),
      );
      return shortfalls.length
        ? toolError(actionRefusal(meta.name, shortfalls))
        : { saved: true };
    },
  });
  const listed = (locals: App.Locals) =>
    visibleTools(locals, { reads: [], writes: [changeRecords] }).map(
      (t) => t.name,
    );

  it("lists change_records to an app that may only void, and refuses its update items", async () => {
    const voider = app(["records:read", "records:void"]);
    expect(listed(voider)).toEqual(["akaun_change_records"]);
    expect(actionAllowed(voider, changeRecords, "void")).toBe(true);
    expect(actionAllowed(voider, changeRecords, "update")).toBe(false);

    const run = (args: unknown) =>
      runTool(
        {
          db: notUsed as LedgerDb,
          store: notUsed as BlobStore,
          storageRoot: "/nonexistent",
          locals: voider,
        },
        changeRecords,
        { name: "akaun_change_records", nameOf: (base) => toolName(base) },
        args,
      );
    const refused = await run({ void: [{}], update: [{}] });
    expect(refused.isError).toBe(true);
    const { error } = JSON.parse(
      (refused.content[0] as { type: "text"; text: string }).text,
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain(
      "may not use update in akaun_change_records",
    );
    expect(error.message).toContain("records:write");
    expect(error.message).not.toContain("void needs");
    expect((await run({ void: [{}] })).isError).toBeFalsy();
  });

  it("does not list it to an app holding records:void alone, which voidRecord would refuse", () => {
    // voidRecord asks for records.read with records.void (v1 void_record).
    expect(listed(app(["records:void"]))).toEqual([]);
    expect(listed(app(["records:write"]))).toEqual(["akaun_change_records"]);
  });
});

describe("inspectRpc step-up for v2 tools", () => {
  const writer: OAuthScope[] = ["records:read", "records:write"];

  it("challenges a void for exactly the void route", async () => {
    const scope = await challenged(app(writer), "akaun_change_records", {
      void: [{ record: "EXP-1", reason: "Duplicate of EXP-2" }],
    });
    // As v1 does, the challenge names the whole route; records:void is the
    // one scope the app does not hold yet.
    expect(scope).toBe("records:read records:void");
    expect(
      scope!.split(" ").filter((s) => !writer.includes(s as OAuthScope)),
    ).toEqual(["records:void"]);
  });

  it("challenges a void and a delete for the union", async () => {
    expect(
      await challenged(app(writer), "akaun_change_records", {
        void: [{}],
        delete: [{}],
      }),
    ).toBe("records:read records:void records:delete");
  });

  it("keeps the scopes of the actions already allowed in the call", async () => {
    // A client that replaces its scopes with the challenge's must not lose
    // records:write, or the retried update would be refused in turn.
    expect(
      await challenged(app(writer), "akaun_change_records", {
        update: [{}],
        void: [{}],
      }),
    ).toBe("records:write records:read records:void");
  });

  it("lets an allowed call through, and ignores empty action arrays", async () => {
    expect(
      await challenged(
        app(["records:read", "records:void"]),
        "akaun_change_records",
        {
          void: [{}],
        },
      ),
    ).toBeNull();
    expect(
      await challenged(app(writer), "akaun_change_records", {
        update: [{}],
        void: [],
        delete: null,
      }),
    ).toBeNull();
  });

  it("does not challenge what the role or the ceiling can never grant", async () => {
    const grants = [
      "records.read",
      "records.create",
      "records.update",
      "records.delete",
    ];
    const noVoid = app(writer, { grants });
    expect(
      await challenged(noVoid, "akaun_change_records", { void: [{}] }),
    ).toBeNull();
    const ceiling = app(writer, {
      grants: [...grants, "records.void"],
      delegable: grants,
    });
    expect(
      await challenged(ceiling, "akaun_change_records", { void: [{}] }),
    ).toBeNull();
    // The batch is all-or-nothing: a grantable delete does not make the
    // ungrantable void worth a consent.
    expect(
      await challenged(noVoid, "akaun_change_records", {
        void: [{}],
        delete: [{}],
      }),
    ).toBeNull();
    expect(
      await challenged(noVoid, "akaun_change_records", { delete: [{}] }),
    ).toBe("records:delete");
  });

  it("steps up for the opt-in merge scope with the scopes a merge needs", async () => {
    expect(
      await challenged(
        app(["contacts:read", "contacts:write"]),
        "akaun_change_contacts",
        {
          merge: [{ keep: "Grab", merge: ["GrabCar"] }],
        },
      ),
    ).toBe("contacts:merge contacts:write contacts:delete");
  });

  it("challenges for the tool's cheapest route when the call names no action", async () => {
    expect(
      await challenged(app(["contacts:read"]), "akaun_change_contacts", {}),
    ).toBe("contacts:write");
    expect(
      await challenged(app(["contacts:write"]), "akaun_get_change_history", {}),
    ).toBe("records:read");
  });

  it("challenges a read for the value it asks for", async () => {
    expect(
      await challenged(app(["reports:read"]), "akaun_get_report", {
        report: "aged_receivables",
      }),
    ).toBe("reports:read records:read");
    expect(
      await challenged(app(["reports:read"]), "akaun_get_report", {
        report: "profit_loss",
      }),
    ).toBeNull();
    expect(
      await challenged(app(["contacts:read"]), "akaun_get_sales_documents", {
        kind: "quotation",
      }),
    ).toBe("quotations:read");
    expect(
      await challenged(app(["contacts:read"]), "akaun_get_record", {}),
    ).toBe("records:read");
  });

  it("reads names in the scheme served", async () => {
    const args = { void: [{}] };
    expect(
      await challenged(app(writer), "akaun_records_change", args),
    ).toBeNull();
    expect(
      await challenged(
        app(writer),
        "akaun_records_change",
        args,
        "akaun_noun_verb",
      ),
    ).toBe("records:read records:void");
  });

  it("never challenges a token, a removed v1 name or a prototype key", async () => {
    expect(
      await challenged(token(["records.read"]), "akaun_change_records", {
        void: [{}],
      }),
    ).toBeNull();
    // v1 was removed: its names are unknown tools, never challenged.
    expect(
      await challenged(app(writer), "void_record", { recordId: 1 }),
    ).toBeNull();
    expect(
      await challenged(app(writer), "create_record", { amount: 1 }),
    ).toBeNull();
    // A v2 base outside the plain scheme is not a tool either.
    expect(
      await challenged(app(writer), "change_records", { void: [{}] }),
    ).toBeNull();
    // Names are looked up as own keys only: no throw, so never a 500.
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "akaun_constructor",
      "akaun___proto__",
    ])
      for (const naming of [undefined, "plain"] as const)
        expect(
          await challenged(app(writer), name, { void: [{}] }, naming),
        ).toBeNull();
  });

  it("gives akaun_attach_file the attach allowance and every other v2 tool the ordinary one", async () => {
    const body = MAX_RPC_BYTES + 1024;
    const pat = token(["records.update"]);
    for (const [name, naming] of [
      ["akaun_attach_file", "akaun_verb_noun"],
      ["akaun_file_attach", "akaun_noun_verb"],
      ["attach_file", "plain"],
    ] as const) {
      const inspection = await inspectRpc(rpc(name, {}, body), pat, {
        naming,
      });
      expect(inspection.response).toBeNull();
      expect(
        inspection.response === null && inspection.maxRequestBodySize,
      ).toBe(MAX_ATTACH_RPC_BYTES);
    }
    // Only the name served gets it: v1's bare name under the default scheme
    // is held to the ordinary limit, like any other tool.
    for (const name of ["attach_file", "akaun_file_attach"])
      expect(
        (await inspectRpc(rpc(name, {}, body), pat)).response?.status,
      ).toBe(413);
    const other = await inspectRpc(rpc("akaun_change_records", {}, body), pat);
    expect(other.response?.status).toBe(413);
    const small = await inspectRpc(rpc("akaun_change_records", {}), pat);
    expect(small.response === null && small.maxRequestBodySize).toBe(
      MAX_RPC_BYTES,
    );
  });
});

describe("the contacts:merge scope", () => {
  it("stands for contacts.merge alone, and no other scope does", () => {
    expect(OAUTH_SCOPES).toContain("contacts:merge");
    expect(SCOPE_PERMISSIONS["contacts:merge"]).toEqual(["contacts.merge"]);
    for (const scope of OAUTH_SCOPES)
      if (scope !== "contacts:merge")
        expect(SCOPE_PERMISSIONS[scope], scope).not.toContain("contacts.merge");
    expect(isDelegable("contacts.merge")).toBe(true);
  });

  it("is opt-in: never a default scope, shown with the deletes", () => {
    expect(READ_SCOPES as readonly string[]).not.toContain("contacts:merge");
    expect(parseScopes(undefined)).not.toContain("contacts:merge");
    // The consent page pre-ticks reads only, and groups by tier.
    expect(scopeTier("contacts:merge")).toBe("delete");
    expect(SCOPE_LABELS["contacts:merge"]).toBe(
      "Merge duplicate contacts — moves every record of the merged contacts to the one kept and deletes the others. Cannot be undone.",
    );
  });

  it("is offered only to a user who may delegate contacts.merge", () => {
    expect(allowedScopes(app([]).role!)).toContain("contacts:merge");
    const keeper = app([], {
      grants: ["contacts.read", "contacts.update", "contacts.delete"],
    }).role!;
    expect(allowedScopes(keeper)).not.toContain("contacts:merge");
    const blocked = app([], {
      grants: ["contacts.read", "contacts.merge"],
      delegable: ["contacts.read"],
    }).role!;
    expect(allowedScopes(blocked)).not.toContain("contacts:merge");
  });

  it("is what a merge needs beyond writing and deleting contacts, and only a merge asks for it", () => {
    expect(
      missingForActions(
        app(["contacts:read", "contacts:write", "contacts:delete"]),
        "change_contacts",
        ["merge"],
      ),
    ).toEqual([
      {
        action: "merge",
        missingScopes: ["contacts:merge"],
        missingPermissions: ["contacts.merge"],
      },
    ]);
    expect(
      missingForActions(app(["contacts:merge"]), "change_contacts", [
        "merge",
      ])[0].missingScopes,
    ).toEqual(["contacts:write", "contacts:delete"]);
    for (const [base, entry] of Object.entries(TOOL_REQUIREMENTS_V2))
      for (const [part, requirements] of routesOf(entry)) {
        if (base === "change_contacts" && part === "merge") continue;
        for (const option of requirements) {
          expect(option.scopes, `${base} ${part}`).not.toContain(
            "contacts:merge",
          );
          expect(option.permissions, `${base} ${part}`).not.toContain(
            "contacts.merge" as LeafPermission,
          );
        }
      }
  });
});
