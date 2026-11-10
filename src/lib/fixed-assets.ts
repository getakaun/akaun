import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Choose a valid date.");
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const assetDetailsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  assetType: z.string().trim().min(1).max(100),
  serialNumber: z.string().trim().max(200).default(""),
  inServiceDate: date.nullable(),
  businessUseBps: z.number().int().min(0).max(10000).nullable().default(null),
  documentReference: z.string().trim().max(2000).default(""),
  bookMethod: z.literal("straight_line").nullable().default(null),
  usefulLifeMonths: z.number().int().min(1).max(1200).nullable().default(null),
  residualMinor: money.nullable().default(null),
  depreciationExpenseAccountId: id.nullable().default(null),
});

export const assetCreateSchema = assetDetailsSchema
  .extend({
    sourceMovementId: id.nullable(),
    // Required only for legacy assets; source-linked values are read from the ledger.
    acquisitionDate: date.optional(),
    assetAccountId: id.optional(),
    costMinor: money.positive().optional(),
    openingAsAt: date.optional(),
    broughtForwardDepMinor: money.default(0),
    accumulatedDepreciationAccountId: id.nullable().default(null),
    openingRecordId: id.nullable().default(null),
  })
  .strict();

export const assetUpdateSchema = assetDetailsSchema
  .extend({
    expectedVersion: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
    acknowledgeSource: z.boolean().default(false),
    expectedSourceVersion: z.string().optional(),
    accumulatedDepreciationAccountId: id.nullable().optional(),
    legacyOpening: z
      .object({
        acquisitionDate: date,
        assetAccountId: id,
        costMinor: money.positive(),
        openingAsAt: date,
        broughtForwardDepMinor: money,
        openingRecordId: id.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AssetDetails = z.infer<typeof assetDetailsSchema>;
export type AssetSourceSnapshot = {
  movementId: number;
  recordId: number;
  sortOrder: number;
  recordDate: string;
  accountId: number;
  amountMinor: number;
};

export const ASSET_TYPE_SUGGESTIONS = [
  "Computer equipment",
  "Office equipment",
  "Furniture",
  "Motor vehicle",
  "Machinery",
  "Buildings",
  "Other",
];

/** Parse entered money without floating point multiplication or rounding. */
export function assetMoneyMinor(input: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(input.trim())) return null;
  const [whole, decimal = ""] = input.trim().split(".");
  const result = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

export function assetNumber(id: number) {
  return `FA-${String(id).padStart(4, "0")}`;
}

export function assetReviewStatus(asset: {
  reviewReason: string | null;
  openingAsAt: string | null;
}): string {
  return asset.reviewReason
    ? "asset-review"
    : asset.openingAsAt
      ? "asset-opening"
      : "asset-linked";
}

export function assetMoneyInput(minor: number): string {
  const cents = BigInt(minor);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
