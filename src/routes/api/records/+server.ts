import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { listRecords } from "$lib/server/queries/ledger.js";
import type { LedgerRecordKindCode } from "$lib/enums.js";
import {
  allocationShape,
  createFromSidesSchema,
  positiveId as accountId,
  recordFieldsShape as common,
  createRecord,
  type CreateInput,
} from "$lib/server/application/records.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * The one record store, over HTTP.
 *
 * The body describes what happened in the everyday terms of whichever screen
 * sent it. The API never asks a caller to construct movements — except for a
 * journal entry, which is the one shape that names its own sides and sits
 * behind its own permission (FR-020, FR-040).
 */

const createSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("expense"),
    categoryAccountId: accountId,
    // Null means someone else paid it, so it is owed to `contactId` (FR-008).
    paidFromAccountId: accountId.nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal("income"),
    categoryAccountId: accountId,
    receivedIntoAccountId: accountId,
  }),
  z.object({
    ...common,
    kind: z.literal("transfer"),
    fromAccountId: accountId,
    toAccountId: accountId,
  }),
  z.object({
    ...common,
    kind: z.literal("payment"),
    paidFromAccountId: accountId,
    // Null names no single contact — a payment that settles items across
    // several contacts at once (one bank transfer, several suppliers) is
    // allowed only when its settlements carry that attribution instead.
    // `entry-builder.ts`'s `validate()` is what actually refuses a null
    // contact with no settlements (FR-008); this is just what lets the shape
    // through to it.
    contactId: accountId.nullable(),
    direction: z.enum(["we-pay", "we-receive"]),
    settlements: z.array(allocationShape).default([]),
  }),
  z.object({
    ...common,
    kind: z.literal("journal"),
    movements: z
      .array(
        z.object({
          accountId,
          amountMinor: z.number().int(),
          /** This line's own name. Absent or null falls back to the record's description. */
          label: z.string().trim().max(200).nullable().optional(),
        }),
      )
      .min(2),
  }),
]);

/**
 * What the one form sends: two accounts and no kind.
 *
 * The five variants above stay exactly as they are. Auto Import posts
 * `expense` and `income`, and `services/invoices.ts`, `services/accounts.ts`
 * and reconciliation's transfer action construct `RecordCreateSides` in
 * process, so removing any of them would break a caller this feature does not
 * touch (FR-036).
 *
 * This shape carries no `kind` at all, which is what tells the two apart: the
 * union above is discriminated on `kind` and cannot match a body without one.
 */
const fromSidesSchema = createFromSidesSchema;

const bodySchema = z.union([createSchema, fromSidesSchema]);

/** A number that arrived as a query-string value. */
const numeric = z.coerce.number().finite().optional();

/** `true` / `false` as a query-string value. */
const flag = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

/**
 * Every filter the list accepts, in one place.
 *
 * `kind` takes a single value or a comma-separated list, because the Records
 * screen filters by more than one kind at a time and one store means one query
 * (FR-002).
 */
const querySchema = z.object({
  kind: z
    .string()
    .transform((raw) =>
      raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value)),
    )
    .pipe(z.array(z.number().int()).min(1))
    .optional(),
  accountId: numeric,
  contactId: numeric,
  categoryId: numeric,
  categoryAccountId: numeric,
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  amountMin: numeric,
  amountMax: numeric,
  paid: flag,
  /** FR-056 — every account, not just those with a statement. */
  cleared: flag,
  /** FR-043 — the running balance is only offered in date order. */
  sort: z.enum(["date", "amount"]).optional(),
  search: z.string().optional(),
  limit: numeric,
  offset: numeric,
});

export const GET: RequestHandler = async ({ locals, url }) => {
  // One store, one ability, asked once whether or not a kind is named.
  //
  // This used to check `expenses` and `income` when no kind was asked for, and
  // that was a live hole: a record entered by hand is a `journal` kind, so it
  // was never covered by either check, and anyone with expense view read it
  // (research.md R-11).
  if (!can(locals, "records.read")) return forbidden();

  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) return badRequest(parsed.error);
  const q = parsed.data;

  const kind = q.kind as LedgerRecordKindCode[] | undefined;

  return Response.json(
    listRecords(db, {
      // One value stays one value, so an existing caller asking for a single
      // kind is unchanged.
      kind: kind && kind.length === 1 ? kind[0] : kind,
      accountId: q.accountId,
      contactId: q.contactId,
      categoryAccountId: q.categoryId ?? q.categoryAccountId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      amountMin: q.amountMin,
      amountMax: q.amountMax,
      paid: q.paid,
      cleared: q.cleared,
      sort: q.sort,
      search: q.search,
      limit: q.limit,
      offset: q.offset,
    }),
  );
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  // Every rule — who may, the adjustments gate after the derivation, a payment
  // and its settlements kept together or not at all — lives in the one
  // operation the MCP tools call too (`application/records.ts`).
  return toResponse(
    createRecord({ db, locals }, parsed.data as CreateInput),
    201,
    (written) => written.record,
  );
};
