import { z, type ZodError } from "zod";

/**
 * The line items of a quotation or an invoice, as an endpoint accepts them.
 *
 * One schema for both documents and for both create and edit, so the two
 * POSTs and the two PATCHes cannot drift apart on what a valid line is. Unknown
 * keys are dropped: a line's total is always worked out on the server from its
 * quantity and price, never taken from the request.
 */
export const salesLineSchema = z.object({
  description: z
    .string({ error: "Every line needs a description." })
    .trim()
    .min(1, "Every line needs a description."),
  quantity: z
    .number({ error: "Every line needs a quantity." })
    .finite()
    .positive("A line's quantity must be more than zero."),
  unitPrice: z
    .number({ error: "Every line needs a unit price." })
    .finite()
    .min(0, "A line's unit price cannot be negative."),
  sortOrder: z.number().int().optional(),
});

export const salesLinesSchema = z
  .array(salesLineSchema, { error: "Add at least one line item." })
  .min(1, "Add at least one line item.");

/**
 * A document's exchange rate. A sent invoice posts `toMinor(total, rate)`, so a
 * negative rate would post it upside down — owed by us instead of to us.
 */
export const salesRateSchema = z
  .number({ error: "The exchange rate must be a number." })
  .finite()
  .positive("The exchange rate must be more than zero.");

export type SalesLineInput = z.infer<typeof salesLineSchema>;

/**
 * A 400 whose `error` is the first problem in words, the sentence the forms
 * show. `issues` keeps the full list for anything that wants it.
 */
export function invalidLines(error: ZodError): Response {
  return Response.json(
    {
      error: error.issues[0]?.message ?? "Some of what was sent is not valid.",
      issues: error.issues,
    },
    { status: 400 },
  );
}
