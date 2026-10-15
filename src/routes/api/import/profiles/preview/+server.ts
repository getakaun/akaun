import { json } from "@sveltejs/kit";
import { forbidden } from "$lib/server/api-response.js";
import { mainCurrencyCode } from "$lib/server/currency/form.js";
import { db } from "$lib/server/db/client.js";
import { readSampleUpload } from "$lib/server/import/sample-upload.js";
import { previewTable } from "$lib/server/import/table-preview.js";
import { can } from "$lib/server/permissions.js";
import type { RequestHandler } from "./$types.js";

/**
 * A preview of how the profile being edited reads a sample spreadsheet from
 * its columns (006 FR-053 to FR-055): the headings found, the first rows as
 * items, the count of each section and any reason the reading would fail.
 *
 * It is part of editing a profile, so it needs `import.change`, as saving one
 * does (FR-045). It **stores nothing**: the sample is read from the request
 * and dropped, the profile is never saved, and no queue row, file or audit
 * entry is made. The only read of the database is the main currency, which
 * an amount written in another currency's code is checked against, as an
 * upload is.
 *
 * The body is a form: `file` (an `.xlsx` or `.csv`) and `profile` (the
 * editor's payload, as JSON). The sample is read in the profile's own import
 * mode; a `mode` field an older editor still sends is not read.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.profiles")) return forbidden();

  const form = await request.formData().catch(() => null);
  if (!form)
    return json({ error: "Send the sample as a form." }, { status: 400 });
  let profile: unknown;
  try {
    profile = JSON.parse(String(form.get("profile") ?? ""));
  } catch {
    return json({ error: "The profile could not be read." }, { status: 400 });
  }

  const sample = await readSampleUpload(
    form,
    "A preview reads a spreadsheet by its columns. Choose an Excel workbook (.xlsx) or a CSV file.",
  );
  if (!sample.ok) {
    return json({ error: sample.error }, { status: sample.status });
  }

  const result = previewTable(
    profile,
    { bytes: sample.bytes, type: sample.type },
    {
      mainCurrency: mainCurrencyCode(db),
      today: new Date().toISOString().slice(0, 10),
    },
  );
  if (!result.ok) {
    return json(
      {
        error: result.error,
        ...(result.errors ? { errors: result.errors } : {}),
      },
      { status: 422 },
    );
  }
  return json(result.preview);
};
