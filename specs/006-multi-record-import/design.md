> Update (2026-10-20): Profile-defined “Rows for review” rules (FR-061) have been removed. Legacy `flagWhen` and `flagNote` fields are ignored. References below to those rules describe the original design. Duplicate, overlap and extraction checks remain active.

# 006 Multi-record Import + Profiles — technical design

## Context

Today Auto Import turns one document into one record. The single-record assumption is hard-coded in the LLM schema (`import/providers/shared.ts:3-12`), in a silent `slice(0, 6000)` (`shared.ts:76`), in the flat review columns and the scalar `result_id` (`db/schema.ts:278-320`), in the one-row worker (`worker.ts:211-348`), in the inline confirm (`api/import/[jobId]/confirm/+server.ts:69-361`) and in four unconditional file deletes. The goal is for receipts, invoices and marketplace statements to produce N records: either Summary lines or Every transaction, never both, through user-defined **import profiles**, with the standard reading (today's receipt path) as the fallback. The requirements are already in `specs/006-multi-record-import/spec.md` (FR-001 to FR-049). An earlier brief (`plans/currently-the-auto-import-elegant-lecun.md`) was checked against the code by 6 agents. This plan keeps its direction and corrects it in the places listed under "Changes from the earlier brief".

**Decided with the user (2026-09-30):**

- A form writes the schema. Raw JSON is used only for extra fields.
- The router runs in code. There is no tool-calling loop.

## The answer to "JSON Schema or prompt?"

A schema makes the **shape** of the output deterministic. It does not decide **which lines** are picked or **what they mean**. Determinism therefore comes from three layers, and the schema is only one of them:

1. **Structure (code compiles the schema):**
   - The compiled schema holds only the sections of the chosen mode, so in Summary mode a transaction row has nowhere to go (FR-032).
   - Fee types are a string `enum`, **nullable**. Code drops lines where it is null and lists them under ignored lines. This is what makes FR-034 real: a strict enum without null would force a stray line into the closest type.
2. **Code after extraction:**
   - kind by sign
   - fee type → pinned category
   - control total in cents (`ledger/money.ts` `toMinor`)
   - contact match, FX, duplicate check
3. **Guidance (probabilistic, scoped):**
   - the profile's instructions and each section's and fee type's description, sent as schema `description`s
   - never a user-editable envelope

Users edit a profile on a **form**: sections, mode, kind, fixed category, fee types with pinned categories, and the stated-total label per mode. The server builds the schema from the form. "Advanced: extra fields" is a JSON Schema fragment (flat scalars only). The same whitelist validator parses it on the client and the server.

## The answer to "agentic loop?"

**There is no agent or tool loop to reuse.** The code has two copies of provider failover plus structured-call-with-text-fallback, one in `import/providers/index.ts:24-144` and one in `reconciliation/statement-llm.ts:15-207`. Reuse therefore means merging those two into one module.

The flow "identify → profile? → else legacy" is a **router that runs in code**:

```
route = explicitChoice
     ?? phraseMatch(text, enabledProfiles)          // exactly one profile matches all its phrases → no AI
     ?? (enabled.length ? detect(head 3k chars)      // one Output.object({profile: enum([...ids,'none'])})
                        : 'standard')
'standard' → today's receipt call, unchanged (FR-003/004/040)
else       → withProviderFailover(closure: header call + one structured call per piece → merge)
```

- **No tool loop.** It would resend up to 200k chars on every step. Tools combined with a structured response are weak on Gemini and Groq. `hasToolCall` also fires on an invalid submit. And document text would get to choose which tool runs (FR-042).
- **Later: one bounded, code-driven re-check.** Only if Phase 0 shows control-total mismatches are common: when the total disagrees, make one extra structured call that includes the difference.

## Changes from the earlier brief

| Brief                                                       | Now                                                                                                                                                                                                            | Why                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fan out into child `import_queue` rows                      | New **`import_items`** table (FK `job_id`, index `(job_id,state)`)                                                                                                                                             | The spec now wants a paged table of up to 1,000 items. With child rows, every queue reader, the SSE snapshot and `mergeServerJobs` would need to filter children out, and 4 routes would delete the file they share. |
| US1-3 on a separate `items[]` envelope, cards UI            | One section→schema compiler from the start. "Several items" is a **built-in profile**                                                                                                                          | The envelope, the separate prompt, the group cards and the Split fan-out would all be thrown away later.                                                                                                             |
| Merge pieces by de-duplicating on (date, ref, amount, desc) | **Each line belongs to one piece**: lines prefixed `L0412│`, each piece has an owned range plus ~15 lines of context, items carry `source_line`, and code keeps an item only if its line is in the owned range | The old dedupe merges genuinely identical rows, such as two 1.00 ad fees on one day. Uncertain cases near a boundary are flagged for the reviewer, never deleted.                                                    |
| `z.fromJSONSchema` to validate                              | Hand-written `FieldSpec[]` model with two outputs: the schema sent (`jsonSchema(wire, {validate})`) and a validator                                                                                            | `z.fromJSONSchema` is semi-experimental, no client file imports zod today, and the whitelist is small.                                                                                                               |
| Output.choice                                               | Output.object with an enum                                                                                                                                                                                     | `Output.choice` wraps its answer in `{result}`, so the text fallback would need a special case for it.                                                                                                               |
| Caps of 40k chars and 50 items                              | 200k chars and 1,000 items, read in pieces                                                                                                                                                                     | These are the numbers in the spec's Assumptions.                                                                                                                                                                     |

## Stages

### S0 — Foundations (no visible change)

- **Characterisation tests first** for `callLLMWithProviders`. It has none today.
- **New `src/lib/server/llm/structured-call.ts`:**
  - `extractJsonObject`: the quote-aware version from `statement-llm.ts:26-47`.
  - `callStructured(model, provider, spec)`:
    - `generateText` + `Output.object`, `temperature: 0`, throttled before **every** call.
    - The unsupported cache is keyed `type:model:schemaId`, and set only on a 400. That includes a 400 inside a `RetryError`.
    - A `NoObjectGeneratedError` falls back to text for this call only.
    - `NoOutputGeneratedError` becomes `OutputTruncatedError`.
  - `withProviderFailover(providers, closure)`.
- **Move both callers onto it**, then delete the dead `llm/retry.ts`. Rewrite `statement-llm.spec.ts` with `MockLanguageModelV4` (from `ai/test`).
- **Worker tick must not block** (`worker.ts:93` awaits the whole batch).
- **Emitted rows leave out the text columns.**
- **New `services/import.ts` `confirmImportRow(db, reviewFields, …)`:**
  - A conditional claim: `UPDATE … WHERE state=PendingReview RETURNING`.
  - One sync `db.transaction` covering the contact, `createRecord`, the attachment and Imported. This fixes the race at `confirm:81→276` and the orphan contact.
  - Events deferred until after commit. `createRecord` emits inside the transaction today (`services/ledger.ts:108-120`), so it needs a way to defer those emits.
- **`file-storage.ts`:**
  - a `root` param, so tests never touch `data/storage`
  - an idempotent move
  - `releaseIfUnreferenced`, used by the attachment DELETE, skip, discard and history clear
- **History row links to `/records/[id]`** (FR-021). `normalizeJob` needs to keep `resultId`.
- **Exit:** the receipt characterisation tests are unchanged, and the hash of `data/akaun.db` is unchanged.

### S0.5 — Phase 0 research (no product code)

A throwaway script imports only `document-text.ts` and `structured-call.ts`, **never `db/client.ts`**, and runs on copies of the maintainer's samples outside `data/`. It checks four things:

- whether the right lines are picked
- whether text-only reading scrambles the marketplace table (test `unpdf mergePages:false`)
- whether `Output.object` works with a compiled schema on OpenRouter, Google and Groq, including enum size
- how many output tokens 100 rows take

If the table comes out scrambled, US8 is blocked, so this must run before any UI is built.

### S1 — US1-3 and the core of US4/5

- **Migration `0022`** (additive):
  - `CREATE TABLE import_items`. Its review columns come from a shared `reviewColumns()` drizzle helper and one `ReviewFields` type, with `source_line`, `section_key`, `fee_type`, `kind` and `result_id` added.
  - `ALTER TABLE import_queue ADD` `read_as`, `profile_id`, `profile_snapshot`, `import_mode`, `read_how` (chosen/detected/standard), `extraction_notes` (stated total, ignored[]), `progress_done`, `progress_total`.
  - `ImportState.Grouped = 9`, append-only.
- **`import/profile-compiler.ts`:** built-in profiles written as `FieldSpec`. The compiled envelope is:
  ```
  { header{counterparty,date,reference,currency}, stated_total,
    sections{<slug>: Item[]}, ignored[] }
  ```
  where `Item = {description, amount (signed), date, reference, source_line, fee_type?, category_account_id?, extras?}`. All properties are required, nullable where optional, with `additionalProperties:false`. Unknown keys are **stripped** in validation, because Google drops `additionalProperties`.
- **Worker:**
  - Lift `worker.ts:249-348` into `buildReviewFields(db, item, ctx)`.
  - FX dates are de-duplicated.
  - Duplicate check per item runs with `extractedText: null`. Filename is off automatically, because there is no queue row with that `result_id`.
  - One transaction inserts the items and flips the parent to Grouped, after checking the parent still exists. 1 item → today's flat receipt columns. 0 items → Failed "No items found".
- **Parent hash stop before the LLM call** (FR-026): same hash on a Grouped parent that has an Imported item, or on an Imported receipt.
- **Records from items get `extracted_text` NULL.** A shared file is also not re-indexed. `attachments/+server.ts:88-94` and `search-rebuild/worker.ts:84-97` would otherwise put the full text back (FR-029).
- **Routes:**
  - `GET/PATCH /api/import/[jobId]/items`
  - a bulk route for confirm-all/selected (run **one after another** on the server), skip and set-category
  - a group Source account saved on the server
  - `DELETE` on a parent removes pending items only
  - events `item-update` / `item-deleted` with **no snapshot**, plus one parent summary emit
- **UI:**
  - The upload form gets "Read as" and "Import" selects, remembered in localStorage and Zod-validated in `POST /api/import`. ("Import" was later removed: each profile has one mode, see S4.3.)
  - The review card moves out of `import/+page.svelte:763-975` into `ImportReviewCard.svelte`.
  - New `/import/[id]` page on `DetailPage`, with loaders split into `loaders/import.ts` `loadImportPage`/`loadImportDetail`. It loads every slim item row (≤1,000) and pages and filters on the client, like `RecordsPage`. It reuses `BulkActionBar`, `FilterDropdown`, `StatusBadge`, `ImportSourceAccountSelect` and `ImportCategoryAccountSelect`. Row selection is copied from `RecordsPage.svelte:192,365-437`.
  - The queue card links with `row-link`. The rail shows the file, the control total and the ignored lines.

### S2 — US6-7: profiles

- **`import_profiles` table:** name, description, phrases JSON, instructions, sections JSON, stated-total label per mode, enabled.
- **Shared validator `src/lib/import-profile-schema.ts`** (the `sequence-template.ts:97` pattern):
  - the whitelist (`FRAGMENT_KEYWORDS` and `FIELD_KEYWORDS` in `src/lib/import-profile-schema.ts`): on the extra-fields object only `type`, `properties` and `required`; on each field only `type`, `description` and `enum` (text values, and only on a text field). A value that may be missing is written as a type list with `"null"`, such as `["string", "null"]`. The type is `string`, `number`, `integer` or `boolean`; nested values (`properties` or `items` on a field, or the type `object` or `array`) are refused. `items` is not on the list.
  - the "none" sentinel (`NONE_VALUE`): a list of choices that may be empty — a section's fee type, or a nullable extra field with an `enum` — is sent with `"none"` as one more choice, not with null. A strict provider (OpenAI, Groq) allows only the values `enum` names, and Google refuses a null inside an `enum`, so null cannot be said there. The reading turns `"none"` back into null, and the validator refuses `"none"` as a fee type key or as a choice.
  - caps: 20 sections, 50 fee types per section, 200 enum values in total, 20 extras
  - slug keys only, and canonical names are reserved
  - error messages name the path
- **Where to edit:**
  - The list lives in the Settings › Intelligence tab.
  - The editor is its own page, `/settings/import-profiles/[id|new]`, on `DetailPage`: stage the whole profile and save once.
  - `/api/import/profiles` writes are gated by `hasPermission('import','change')`; reading the list or one profile needs `import.view`, as the editor page does (read-only without `change`).
  - Add `recordAudit` with a new `'import_profile'` `RecordType`.
- **Review note (migration 0025, additive):** `review_note` on the review columns of the queue and of items. The reading writes it when a fee type's tied category is for the other kind of line (FR-034); while it is set, `itemAttention` returns it, and choosing a category clears it. The receipt card shows it too, for a one-item reading.
- **Two starters:** "Fee document" and "Marketplace statement summary" (the summary half only; the transactions half waits for US8).
- **FR-037:** a provider 400 on a profile schema **fails that document**, with no text fallback. Built-in schemas keep the fallback. `schemaId = profile:<id>:<sha256(wire)>`, and a snapshot of the profile is stored on the job (FR-038, Read again).

### S3 — US8-9

- **Pieces:** made from pages, owned ranges plus context, split in half on `OutputTruncatedError` (depth ≤2, then Failed with the limit named). Progress goes in the columns.
- **Header call:** first and last page plus the Summary sections.
- **Auto-detect:** the router above.
- **"Read again":** delete the pending items and requeue, guarded by "no item is Imported".

## S0.5 research results (2026-09-30)

Samples: a Shopee monthly Income Statement (3 pages), a Shopee ads e-invoice (2 lines plus tax), and a Shopify bill in USD. Model: `gemma-4-31b-it` on Google AI Studio (what the book uses). OpenRouter's `google/gemma-4-31b-it:free` returned 429 from the shared free pool for every attempt over 6 minutes, so it gave no results. The research script used only `unpdf` and the SDK, not app modules and not the database.

| Case                                                    | Result                                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ads invoice, several items                              | Exact: 732.87 and 1,080.00 (amounts including tax); stated total 1,812.87.                                                                                                                                                       |
| Shopee statement, Summary, 15 fee types                 | Exact: 15 of 15 leaf lines, each with a distinct fee type and none null; they sum to 13,732.56 to the cent, matching Total Payout Released. The 4 group subtotals were left out. 90 s, 7.3k tokens in, 0.9k out.                 |
| Shopify bill, standard                                  | Values correct, but Gemma wrapped the JSON in a ```fence, so strict parsing failed. The text fallback in`structured-call.ts` covers this.                                                                                        |
| Shopee daily payout table, page 1 (6 rows × 15 columns) | All 90 cells correct, including cells the PDF split across lines (`719.1` / `7`) and the U+2212 minus sign. **Every row total the model added up itself was wrong** (381.10 against the true 470.22). 88 s for 2k output tokens. |
| Same table, all 31 rows                                 | Stopped by Bun's default 300 s fetch timeout.                                                                                                                                                                                    |

**What this changes**

- **Code does all the arithmetic.** The model transcribes and code adds up. This is already true of the control total. Never ask the model for a derived figure.
- **Every transaction is not built for now** (user decision). The Shopee table is one row per day with 15 amount columns, not one transaction per line, so it would need one row to produce several records. Summary covers the real case exactly. US8 and FR-043 (pieces) are deferred. _(Taken up again in § S4 for one-transaction-per-line tables; this statement's day-by-column table is still out of scope.)_ FR-010 still applies: an over-long document fails with the limit named, and is never cut short.
- **Output speed is the limit, not input size.** About 10–20 tokens/s on this model. Any later piece plan must size pieces by expected output tokens and keep each call well under 300 s, because Bun's `fetch` times out at 300 s.
- **Text:** `unpdf` with `mergePages: true` returns the text on one line with no line breaks. Several-items and profile readings use `mergePages: false`, joined with line breaks and L-numbers. The receipt path is left as it is (FR-004).
- **The structured-to-text fallback is required, not optional,** for Gemma on Google.

**Revised S3:** auto-detect (recognition phrases, then one detect call) and Read again. The piece reader waits for a document type that needs it. _(It is built in § S4.6.)_

## S4 — spreadsheets, transfers and every-transaction reading

### Why S4 exists

S0–S3 are built and checked by the maintainer. Two needs were left:

- **Spreadsheets.** Some platforms export only Excel or CSV. Auto Import took only PDF, JPG and PNG.
- **Every transaction (US8) was deferred** (§ S0.5), because the first marketplace sample had a day-by-column table rather than one transaction per line.

The maintainer's second marketplace sample is a **wallet report** in `.xlsx`, and it does have one transaction per line. Its shape:

- a header block, then a "Total Money In" and a "Total Money Out" figure;
- 736 rows below the headings: 717 order income in, 2 order income out, 7 adjustments and 10 withdrawals to the bank, one of them still "Processing".

The sample itself stays outside the repository. Tests use a synthetic workbook of the same shape, never its values.

**Decided with the maintainer (2026-10-02):**

1. Accept `.xlsx` and `.csv` uploads.
2. A profile can map spreadsheet columns, so code reads the rows with **no AI**. A spreadsheet with no such profile is rendered to numbered text and read by the AI, like a PDF.
3. Build Every transaction now, for **both** spreadsheets (column mapping) and long PDFs (FR-043 piece reading).
4. Withdrawals become **Transfer** records from the wallet to the bank. Import items gain a transfer kind.

**The tradeoffs behind these choices**

- **Reading from columns, not by the AI.** A spreadsheet already says which cell is which, so the AI would only be transcribing it, which S0.5 showed is slow (10–20 output tokens per second) and gets derived figures wrong. Code is exact, free and the same every time, and it works without any AI provider. What is given up: someone has to describe the layout once, in the profile. A spreadsheet without a layout still works, through the AI.
- **Our own spreadsheet reader, not a library** (Constitution II). An `.xlsx` file is a zip of XML files, and only a small part of the format is needed: cell values, shared strings, and enough of the styles to tell a date from a number. The usual libraries are large, and some have a history of security problems with untrusted files. What is given up: an unusual workbook may hit something the reader does not handle; it then fails with a reason, never with a wrong number. If `node:zlib` decompression proves unreliable under Bun, `fflate` is added as a direct dependency.
- **A Transfer, not an expense or income.** A withdrawal is money moving between two of the business's own accounts. Booking it as income or an expense would make the profit wrong. The ledger already has a `transfer` kind (`entry-builder.ts`), so the item only has to say which two accounts.
- **The wallet report as a source document.** Nothing else the business receives proves a withdrawal, so the report is its evidence (spec Assumptions). It is still not a bank statement: it never makes statement lines, and the bank side of the same money is matched in Reconciliation against the transfer it made (FR-049 unchanged).

### Spec conflicts and how they were resolved

A plan agent checked the four decisions against the spec and the code. Each conflict below is now settled in `spec.md`.

| #   | Conflict                                                                                                | Resolution                                                                                                                                                                                                                 | Spec                                              |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| C1  | Out of Scope listed CSV import.                                                                         | Removed. A source document is a PDF, a photo, an `.xlsx` or a `.csv`. One row making several records stays out of scope.                                                                                                   | Update 2026-10-02, Glossary, FR-050, Out of Scope |
| C2  | Kinds were only Income and Expense.                                                                     | A third kind, Transfer. Control total: income +, expense −, transfer out −, transfer in +. A profile can name a "Money moves in" account (the wallet); its items start there instead of on Accounts payable or receivable. | Glossary, FR-008, FR-013, FR-058–060              |
| C3  | US8 was deferred.                                                                                       | Un-deferred, aimed at one-transaction-per-line tables. There is no long PDF sample yet, so only the spreadsheet path can be accepted against real data.                                                                    | US8, SC-017                                       |
| C4  | Is a wallet report a bank statement (FR-049)?                                                           | No. It is a source document for money that has no other one. It never makes statement lines.                                                                                                                               | Glossary, FR-049, Assumptions                     |
| C5  | The receipt reading cuts its text at 6,000 characters (`providers/shared.ts`), silently.                | A spreadsheet read as a receipt over 6,000 characters fails and names the limit. PDFs and images keep the cut, unchanged (FR-004).                                                                                         | FR-052                                            |
| C6  | Where does the table layout live?                                                                       | On the profile (header, columns, stated-total labels, other party, currency). Sections carry only row rules. Code checks each row belongs to at most one section.                                                          | FR-053–055                                        |
| C7  | An item falls back to the header's reference (`document-reader.ts`, item push).                         | In Every transaction mode an item takes no reference from the header.                                                                                                                                                      | FR-006, FR-062                                    |
| C8  | Same date, amount and contact flags a duplicate even when the references differ.                        | When an item has its own reference and a candidate has a different one, it is not a duplicate. Table readings, and Every transaction readings by the AI (in pieces or in one call).                                        | FR-063                                            |
| C9  | FR-033 relied only on the upload stop (FR-026), which two uploads made before either confirm both pass. | Confirm is refused when another job with the same file hash already made a record, checked inside the confirm transaction.                                                                                                 | FR-033, FR-064                                    |
| C10 | The "Processing" withdrawal.                                                                            | Imported but flagged ("check that this withdrawal completed"), not filtered out. Confirm all leaves it.                                                                                                                    | FR-061                                            |
| C11 | `createRecord` requires rate 1 for a transfer.                                                          | A transfer must be in the main currency; otherwise it needs attention.                                                                                                                                                     | FR-059                                            |
| C12 | Failover covered the whole document.                                                                    | Failover per piece: a failure on piece 20 does not read pieces 1–19 again.                                                                                                                                                 | FR-043                                            |

### Data model

One additive migration, **`0026`**: `ALTER TABLE … ADD` only, with a journal `when` later than `0025`. `0022`–`0025` are already applied to the real book and are never edited. If a later stage needs more columns, it adds `0027`; `0026` is never edited once committed.

- **`reviewColumns()`** (`db/schema.ts`) gains `counter_account_id`, a foreign key to `accounts` with `ON DELETE SET NULL`. It lands on both `import_items` and `import_queue`.
- **`import_profiles.options_json`** (text, default `'{}'`) holds `{ accountId, layout }`: the "Money moves in" account and the table layout.
- **`DocumentType`** (`src/lib/enums.ts`, append-only) gains `TransferOut: 3` and `TransferIn: 4`. An item's `accountId` is always the document's account (the wallet), and `counter_account_id` is the other side. Direction is in the type, so the amount stays unsigned as for income and expenses.
- **No migration for these, which go in existing JSON:**
  - `sections_json`: `kind: "transfer"`, `counterAccountId`, `rows { where, flagWhen, feeTypeColumn }` and `feeTypes[].values`;
  - `extraction_notes`: `ignoredCount` and `method` (`ai`, `ai_pieces` or `columns`).

### How a document is routed now

```
read as receipt (standard)   → today's receipt call; a spreadsheet over 6,000 chars fails (C5)
profile, every section of the
  chosen mode has row rules  → table-reader (code only; no AI provider needed)
profile, Every transaction,
  read by AI                 → piece-reader (header call + owned-range pieces, failover per piece)
otherwise                    → today's profile / several-items reading
auto-detect on a spreadsheet → fixed phrases across compatible profiles → layout headings
                               → AI detect (only when a provider exists) → standard
```

### Stages

Each stage is built, reviewed by a second agent, fixed and committed, as in S0–S3.

**S4.0 Spec and design.** C1–C12 applied to `spec.md`; this section. _Exit:_ the maintainer has read both.

**S4.1 Spreadsheet parser.** Hand-written, in `src/lib/server/extraction/spreadsheet/`.

- `zip.ts`: reads the central directory; stored and deflate entries through `node:zlib` `inflateRawSync` with `maxOutputLength`; refuses Zip64 and encrypted files; caps entry sizes and counts.
- `xml.ts`: a small tokenizer that drops namespace prefixes and decodes entities, and refuses any `<!DOCTYPE` (no entity tricks).
- `xlsx.ts`: workbook, relationships, shared strings (rich-text runs too), styles (to recognise date formats) and sheets; cell types `s`, `inlineStr`, `str`, `b`, `e`, `d`, `n`; 1900 and 1904 date serials; a formula's cached value, never evaluated; a row or cell with no position goes after the previous one; an old `.xls` or a password-protected workbook is named in the error.
- `csv.ts`: BOM (UTF-8, UTF-16), then UTF-8, then windows-1252; an Excel `sep=` line, else detect `, ; \t |`; RFC 4180 quoting, ragged rows allowed; caps on rows and cells.
- `render.ts`: one page per sheet as `Sheet: <name>`, cells joined by `|`, dates as `YYYY-MM-DD[ HH:MM:SS]`; the output feeds the existing L-numbering. `detectionText()` gives text for phrase matching.
- Tests build `.xlsx` files in memory, including a synthetic workbook shaped like the wallet report.
- _Exit:_ a throwaway script that never imports `db/client` reads the real report (outside the repo and `data/`): header at row 14, 736 rows, and the Money Out rows add up to the report's own Total Money Out.

**S4.2 Upload and extraction plumbing.**

- A new `sniffImportUpload` accepts pdf, jpeg, png, xlsx (a zip containing `xl/workbook.xml`) and csv. The shared `sniffAllowedType` is **not** widened, so Reconciliation and record attachments still refuse spreadsheets.
- `api/import/+server.ts`: the type checks and their messages. Client: `accept`, the drop-zone text and a "Spreadsheet" label on the upload page. The two file routes serve xlsx and csv as downloads.
- `document-text.ts`: `inferMimeType`, and `extractDocumentSource()` returning `{ plain, numbered, workbook? }`. `process-job.ts` gets the spreadsheet branches and the C5 guard.
- `attachment-text.ts` renders a one-record spreadsheet so it can be searched. Group files are still never indexed (FR-029).
- _Exit:_ an xlsx or csv uploaded as Several items is read by the AI; Reconciliation and record attachments still refuse xlsx; the receipt tests are unchanged.

**S4.3 Import mode (FR-002, FR-023, FR-033).**

> **Superseded 2026-10-02 by one mode per profile.** The upload-time "Import" select was redundant: a profile already says which part of a document it reads, and the fix pass had to override the select for every profile whose sections were all in one mode, which was every profile in use. The mode is now a field of the profile (`ImportProfileDraft.mode`, kept in `options_json` with no migration); sections have no mode of their own, and there is one stated total per profile and one label list per layout, still keyed by the profile's mode so older rows read. The Import select, its device memory, Retry's mode and Read again's mode radios are gone, and the server ignores an `importMode` an old tab still sends. `readingModeFor`, `profileModes`, `fixedModeOf`, `uploadImportMode` and `ProfileModeError` are removed. A profile saved before this gets the mode its sections share (`legacyProfileMode`), or Summary; one with sections in both reads Summary and the editor refuses to save it until the other-mode sections are moved or kept. `import_queue.import_mode` stays, written from the profile when it is read (chosen or detected) and cleared with the detected profile, so history, the repeat-file message and `describeReading` still name the mode. Reading one kind of document both ways takes two profiles, as the two wallet starters already do. The bullets below are what S4.3 first built.

- Validator: allow Every transaction sections and keep each section's own mode. Today the parsed mode is discarded in `import-profile-schema.ts`, which is a bug. Accept a stated-total label per mode.
- `import-profile-form.ts`: drop the Summary hard-coding.
- `upload-reading.ts` takes `importMode` (Summary when missing, 400 when unknown), stored for profile and auto readings.
- Upload page: an "Import" select, shown only when profiles exist and remembered on the device; Retry keeps the mode. Read again: the route body and `ReadAgainDialog` take the mode.
- Auto-detect uses the job's mode instead of the hard-coded one in `process-job.ts`, and `clearDetectedProfile` keeps it.
- A profile with sections in one mode only is read in that mode whatever the job asks (`readingModeFor` in `import-profile-schema.ts`, applied in `upload-reading.ts` and `profileForJob`), and the row stores it. Both wallet starters have Every transaction sections only, and an upload defaults to Summary, so without this the first try failed with "has no section for Summary". The upload and Read again show "Import" fixed for such a profile (`fixedModeOf`, from the modes `readAsChoices` sends), and `describeReading` always names the mode. `ProfileModeError` stays as a safety net and names the other mode.
- The C9 guard goes in `writeConfirmation`.

**S4.4 Transfer kind, end to end.** Tested with a PDF-profile transfer section, so it does not wait for spreadsheets.

- Profile check: `kind: "transfer"` requires `counterAccountId`; no fee types and no fixed category; both accounts different transaction-asset accounts (`checkAccounts` in `services/import-profiles.ts`).
- Reader (`document-reader.ts`): negative → TransferOut, positive → TransferIn; the control total signed as C2.
- Review fields (`build-review-fields.ts`): no contact or category for a transfer; its account is the profile's `accountId`. Income and expense items also take that account when it is set.
- Account policy (`account-policy.ts`): a new `validateTransferPair`. A receipt can never become a transfer.
- Confirm (`services/import.ts` `resolveSides` / `writeConfirmation`): `createRecord({ kind: 'transfer', from, to, exchangeRate: 1 })` with no contact; C11.
- Items service and group state: `import-items.ts` (`kindOf`, `storedOverrides`, `accountFits`, `setGroupItemsCategory` skips transfers, `itemChanges`) and `group-state.ts` (attention reasons, counts).
- Duplicates: `detectTransferDuplicate` checks existing Transfer records on amount, date ±7 days, the counter account and the wallet, so it also catches transfers made in Reconciliation (`services/reconciliation.ts`). Each existing transfer flags at most one item.
- UI: `review-card.ts`, `ImportGroupDetail.svelte` (kind chip, labels, filter), `ImportReviewCard.svelte` (a one-item transfer) and a new `ImportTransferAccountSelect.svelte`.

**S4.5 Table layout and the reader with no AI.**

- Shared types in `import-profile-schema.ts`: `TableLayout` (sheet, header names, date with format, description, amount, reference; optionally the direction column and its in/out values, decimal separator, CSV delimiter, other party, currency, document-date label, stated-total labels per mode); section `rows` (`where` and `flagWhen` with `is`, `is_not`, `is_one_of`, `contains`, empty, not empty; `feeTypeColumn`); `feeTypes[].values`.
- New `import/table-reader.ts`, pure code, workbook → `ReadEnvelope`:
  1. find the header row;
  2. data rows run to the first blank row;
  3. a row matching two sections fails the reading; a row matching none is ignored and counted;
  4. an unreadable date or amount fails, naming row and column; amounts parsed as decimal strings, `()` and U+2212 negative;
  5. an unlisted fee type is ignored; `flagWhen` adds a review note;
  6. the stated total is the number to the right of each label, summed in code;
  7. `source_line` is the rendered line number;
  8. then the existing `readingFromEnvelope`, with no header-reference fallback (C7); the item cap counted after filtering.
- Routing (`process-job.ts`): a profile whose sections in the chosen mode all have row rules uses the table reader **without an AI provider**, so the provider check moves into the AI branches. Auto-detect on a spreadsheet: fixed phrases on `detectionText` across every compatible profile, then a unique layout header match when no phrases match, then the AI detect call (only with providers), then standard. Multiple phrase matches restrict AI to those matches; otherwise multiple layout matches restrict AI to those layouts. Ambiguous matches with no provider fail naming the profiles (FR-039). The C8 veto goes in `detectDuplicate`. The group rail shows "Ignored N lines (20 shown)" and "read from columns" (FR-041).
- _Exit_ (synthetic workbook, then the real file by hand, both with no AI provider): a full profile gives 736 items, 726 income or expense and 10 transfers out, one flagged, with a matching control total; a withdrawals-only profile gives 10 transfers and "Ignored 726", with no control total.

**S4.6 PDF piece reading (FR-043).** New `import/piece-reader.ts`, for Every transaction readings done by the AI.

- Header call: the first and last page, for the header and the stated total.
- Pieces: owned line ranges cover every line exactly once, with ±15 lines of context. Size is set by expected output, about 1,500 tokens per call; the tokens-per-line estimate is corrected from real usage through a new `onUsage` hook in `structured-call.ts`. Each call is capped at `maxOutputTokens` 3,000 and 240 s, under Bun's 300 s fetch limit.
- Too big: on truncation or timeout the owned range is halved, to depth 3; past that the reading fails, naming the line range.
- Merging: keep an item whose line is in its piece's owned range; an item read from another piece's context is dropped if the owning piece listed it, else kept and flagged; an item with no line, or outside its piece's window, is kept and flagged; identical rows on different lines both stay.
- Failover per piece (C12). All or nothing for the document (FR-011); the job state is checked between pieces.
- Progress: `progress_done` / `progress_total` (there since `0022`) are emitted, and the queue shows "Reading part 3 of 25".
- _Exit:_ tests with a mock model. A real run waits for a PDF sample (C3).

_Decisions made while building S4.6:_

- **A short document is read in one call.** When the whole document fits one piece (about 37 lines at the first guess of 40 tokens a line), it is read with the whole schema in one call, under the same 3,000-token and 240 s caps as a piece. If that call is cut off or runs out of time on every provider, the document is read in pieces. Such a reading stores `method` "ai" (absent stays the Summary reading in one call, and every older row), and gets the FR-063 reference veto as a reading in pieces does: in Every transaction mode each item carries only its own reference (FR-062).
- **The header call** is shown at most 120 lines of the first page and 120 of the last, with one mark for the lines between. A printed page rarely has more; a spreadsheet's rows are all one page, so it is capped. A total printed further into a long first page is not seen, and the reading then has no control total.
- **Failover inside a call.** A call that runs out of time is tried on the next provider before the piece is split, because a hung provider looks the same as a piece that is too big. A piece of lines cut off at the output limit is split at once, since every provider writes to the same limit; the header call, which cannot be split, is tried on the next provider when cut off too. The provider that answered last reads the next call first.
- **Piece size** is the running average of the tokens the pieces wrote, a cut-off piece counting as the whole output limit. It is one figure among the others, not a floor, so a dense run of lines does not keep the pieces small for the rest of the document.
- **One copy of a missed row.** When a piece owns fewer lines than the context, a line can be in the context of two pieces. If its own piece missed it, only the first piece's copy is kept, flagged.
- **Ignored lines are counted** across the pieces (`ignoredCount`), as for a reading from columns, so the rail can say "Ignored 300 lines (20 shown)". A model that lists a context line as ignored, against its rules, makes the count a little high; it is a guide, as the list is (FR-012).
- **Progress** is told before each piece and once when all are read, not before the header call, which is not a part. The queue bar fills from where reading starts, so it never moves back. A job that enters a stage, or is moved on while it is read, has its count cleared.
- **Stopping.** Before each call and once after the last piece, the reading asks whether the job is still being read; if not, it stops, saves nothing and leaves the job as it is.

**S4.7 Guards, starters, editor.**

- Overlap guard: a section option `sameMoneyAs: [profileId]`. When records from that profile already exist for the same dates, income and expense items get a review note. This guards against the wallet report's order income repeating the income statement summary (FR-066).
- Starters: "Marketplace wallet report — withdrawals only" (recommended next to the income statement summary) and "Marketplace wallet report — every transaction", whose description carries the overlap warning. Both come with the wallet-report layout; the counter account must be chosen before saving.
- Editor: transfer kind and counter-account select, mode per section, layout and row-rule fields. `POST /api/import/profiles/preview` (`import.change`, stores nothing) shows, for an uploaded sample, the header found, the first 10 mapped rows, counts per section and any parse errors.
- Optional: a running-balance check on a balance column, reported as a note.
- Final audit: a completeness audit of all of spec 006, and a manual test script.

_Decisions made while building S4.7:_

- **The overlap guard works by month, not by day** (FR-066). An income statement's summary records all carry the statement's one date, while a wallet report's rows carry the day of each order, so the two never share a day even when they hold the same sales. An income or expense item of a section that names another profile is noted when an income or expense record made from a document read with that profile (chosen, or found by Auto-detect) is dated in the item's calendar month. Only records that exist count: a document read but not confirmed has made none, and a deleted record is gone. The check runs when the document is read, as the duplicate check does; a statement confirmed after the wallet report was read does not reach back. The note holds the item back from "Confirm all", which leaves it to be confirmed on its own. **No category choice clears it**: the obvious way through 700 order lines is to select them all, set one category and confirm all, and that must not wipe the warning. So an item keeps two notes apart: `review_note`, the FR-034 tied-category note, which choosing a category answers and clears; and `check_note` (migration 0027), the section's flag rule (FR-061) and this overlap note, which nothing but confirming the item on its own clears.
- **The guard finds a profile's records through `import_record_profiles`** (migration 0027), written when an item or card read with a saved profile is confirmed. The queue row and its items say the same, but clearing the import history deletes them while the records stay, and the guard would then stop seeing them. The queue and items are still asked, for records confirmed before 0027. Deleting a record deletes its row. The repeat-file guard (FR-026, FR-064) still asks the queue only and so still forgets a file once the history is cleared; that is unchanged here.
- **A section names the other profile by its id** (`sameMoneyAs: [profileId]`, at most 10). The server refuses one that does not exist or is the profile itself; a profile deleted later is passed over when a document is read, and the editor shows it as "Deleted profile" until it is removed. A transfer section names none.
- **The two wallet starters** carry the Shopee balance report's layout: eight headings, found wherever they are on the sheet (the real report's are on row 18), the direction column for the sign, the "To" label for the document's date, and "Balance After Transactions" as the running balance. Neither names an other party or a currency: the report prints none on its rows, so the amounts are taken to be in the main currency. Withdrawals only has no control total, since its rows are a few of those the report totals; every transaction adds "Total Money In" and "Total Money Out". Both leave the profile's account and the transfer's other account empty, and the shared check will not save them so.
- **The screen label of the "Money moves in" account is "Account"**, with the sub-line "The account this document lists, such as a marketplace wallet…". The transfer section's is "Other account". The direction values are "Inflow values" and "Outflow values": the cells say "Money In" and "Money Out", but Constitution VII rules those words out as labels.
- **The preview** (`POST /api/import/profiles/preview`, `import.change`) runs the reading itself (`readFromColumns`) on the uploaded sample with the profile as it is on the page, so what it shows is what an upload would give. It needs only the layout and the row rules to be complete: a missing name or account does not stop it, so a starter can be tried before its accounts are chosen. It writes nothing: no queue row, no file, no audit entry. It refuses a mode in which a section has no row rules, since that mode would be read by the AI.
- **The running-balance check** (`layout.balanceColumn`, optional) checks every row of the table, those no section takes too, since a missing row breaks the balance wherever it was. A report may list its rows newest first or oldest first; both orders are tried and the one that fits more rows is used. The result is a note on the group (and in the preview), never a reason to hold an item back or fail the reading; a balance it cannot read says it could not be checked. The real report's balance follows newest first, row to row.

### Reuse

- **Reading:** `readingFromEnvelope` (`document-reader.ts`), `numberDocumentLines` / `stripLineNumbers`, `callStructured` / `withProviderFailover`, `profile-detect.ts`, `readingForUpload`, `ReadAgainDialog`.
- **Records:** `confirmImportRow` / `writeConfirmation`, `buildReviewFields`, `createRecord` with entry-builder `case "transfer"`, `isImportTransactionAsset` (`account-policy.ts`).
- **Infrastructure:** `releaseIfUnreferenced`, the `progress_*` columns and `jobForEvent`.

### Verification

- **Server tests first,** in the `server` project under Bun, with a temporary SQLite database migrated from `drizzle/`, temporary storage roots, a mocked `db/client` and `MockLanguageModelV4` only. They cover every stage's exit criteria. Fixtures are synthetic: the real report's shape, never its values.
- **Migration:** `bun run db:generate`; confirm `0026` is `ALTER … ADD` only and its `when` is later than `0025`.
- **Checks:** `bun run check`, `bun run lint` (no new failures), `bun run test` including the client project before pushing.
- **Safety:** before every step, no `vite dev` process, and the `sha256sum` of `data/akaun.db`, `-wal` and `-shm` unchanged. Real samples stay outside the repository and outside `data/`.
- **The maintainer checks by hand:** the withdrawals-only profile on the real report (10 transfers, one flagged, then Confirm all); a transfer already made in Reconciliation is flagged as a possible duplicate; Read again from Summary to Every transaction; phone-width layout.
- **Not yet checkable:** a long one-row-per-transaction PDF, needed to try piece reading on real data.

### Left open by the plan

- **The screen label of the "Money moves in" account.** Constitution VII asks UI labels to use the accounting term and rules out "money in" / "money out" wording, so the editor's label is chosen when the editor is built (S4.7); the spec uses the working name in prose only. _Chosen in S4.7: "Account"._
- **FR-064 reaches documents read as several items or with a profile.** The plan says only "another job with the same file hash". A receipt read the standard way keeps today's behaviour (a possible-duplicate flag and "Import anyway"), so FR-004 holds.
- **A Transfer section needs the profile's "Money moves in" account.** Implied by "both accounts must be different", and written as a rule in FR-058.
- **The exact parser caps** (file size, zip entries, rows, cell length) are set in S4.1. The 200,000-character limit applies to what the AI reads, not to reading from columns.
- **The S4.5 item count.** The plan's exit said 723 income or expense items beside 10 transfers out of 736 rows; the row breakdown (717 + 2 + 7 order income and adjustments) gives 726, which is the figure used here and matches "Ignored 726" for the withdrawals-only profile. To be confirmed against the real file in S4.1.
- **Whether a reviewer can change both accounts of one transfer item.** FR-058 allows it within the same rule; S4.4 builds the select for the other account.

## Critical files

- **LLM:** `src/lib/server/llm/structured-call.ts` (new), `import/providers/{index,shared}.ts`, `reconciliation/statement-llm.ts`
- **Import server:** `import/worker.ts`, `import/duplicate-detector.ts`, new `import/profile-compiler.ts`, `services/import.ts`, `services/ledger.ts` (deferring emits)
- **Data and storage:** `db/schema.ts`, `drizzle/0022_*`, `src/lib/enums.ts`, `file-storage.ts`
- **Routes:** `src/routes/api/import/**`, `api/records/[id]/attachments/**`
- **UI:** `(app)/import/+page.svelte`, new `(app)/import/[id]`, `loaders/import.ts`
- **Shared validator:** `src/lib/import-profile-schema.ts`

## Spec changes made with this design

- **FR-035:** raw JSON covers extra fields only. The canonical fields are generated from the form.
- **FR-043:** how the pieces are merged (each line belongs to one piece). Uncertain rows near a boundary are flagged, never dropped.
- **FR-045:** kept as today. Confirm checks `import.change` only (`confirm:72`), not `records.add`; group confirm uses the same check.
- **Noted, not in scope:**
  - Settings actions and the Settings loader have no `hasPermission`, so the profile pages must gate themselves.
  - Clearing history removes the FR-026 evidence, for receipts too.

## Verification

- **Tests first, `server` project under Bun,** using a temp SQLite DB and `os.tmpdir()` storage roots:
  - `structured-call` (structured OK, 400 fallback, a custom-schema 400 does not poison other schemas, truncation)
  - receipt characterisation
  - compiler snapshot per starter, plus a round-trip check that every value the schema accepts passes the validator
  - null fee type ends up in ignored lines
  - by-sign
  - signed control total in cents
  - owned-range merge that keeps identical rows
  - 0/1/N items
  - parent hash stop
  - no filename or content false positive on last month's items
  - `confirmImportRow` rollback and double-confirm race
  - interrupted confirm-all run again
  - file refcount on the attachment delete, skip, discard and history clear paths
- **After schema edits:** `bun run db:generate`, then check that `0022` is `CREATE TABLE` plus `ALTER … ADD` only and that its `when` is later than `0021`.
- **Before finishing:** `bun run check` (with no dev tab open), `bun run lint`, `bun run test`.
- **Safety:** `ps aux | grep "vite dev"` first. `sha256sum data/akaun.db` before and after. No browser and no dev server.
- **The user checks by hand:** the S1 fee document, the S2 marketplace Summary, and the S3 300-row statement.

## Delivery

No spec-kit. S0 is implemented directly, tests first, one commit per piece. Stop at S0.5 for the maintainer's sample documents. S1, S2 and S3 follow in order, with a manual check after each.

### Table row filters

`SectionRows.filter?: RowCondition[]` adds keep-matching conditions independently of
`where` section assignment. Missing or empty filters keep all assigned rows. Section
eligibility is `where.every(...) && filter.every(...)`, evaluated before overlap checks
and date/amount parsing. The editor retains filters while rewriting assignment rules;
preview, import, snapshots, and portable profiles preserve them. Portable format v3
prevents older installations silently importing a profile without its filters.
