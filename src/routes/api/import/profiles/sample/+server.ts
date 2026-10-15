import { json } from "@sveltejs/kit";
import { forbidden } from "$lib/server/api-response.js";
import { inspectSample } from "$lib/server/import/sample-inspect.js";
import { readSampleUpload } from "$lib/server/import/sample-upload.js";
import { can } from "$lib/server/permissions.js";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * A look at a sample spreadsheet, for building an import profile's table from
 * it (006 FR-053): where the table is, its first rows, the values in each
 * column and a guess at what each column holds.
 *
 * It is part of editing a profile, so it needs `import.change`, as saving one
 * does (FR-045). It **stores nothing** and reads no database: the sample is
 * read from the request and dropped.
 *
 * The body is a form: `file` (an `.xlsx` or `.csv`), and optionally `sheet`
 * and `headerRow` (the row number Excel shows) when the user has chosen
 * where the table is.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.profiles")) return forbidden();

  const form = await request.formData().catch(() => null);
  if (!form)
    return json({ error: "Send the sample as a form." }, { status: 400 });

  const sample = await readSampleUpload(
    form,
    "A table is read from a spreadsheet. Choose an Excel workbook (.xlsx) or a CSV file.",
  );
  if (!sample.ok) {
    return json({ error: sample.error }, { status: sample.status });
  }

  const sheet = form.get("sheet");
  const row = Number(form.get("headerRow"));
  const result = inspectSample(sample.bytes, sample.type, {
    sheet: typeof sheet === "string" && sheet ? sheet : null,
    headerRow: Number.isSafeInteger(row) && row > 0 ? row : null,
  });
  if (!result.ok) return json({ error: result.error }, { status: 422 });
  return json(result.sample);
};
