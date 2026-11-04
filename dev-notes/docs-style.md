# Akaun Guide — style guide

The rules for every page under `docs/docs/`. The guide is for people who keep the books.
It is not developer documentation.

## Language: ASD-STE100 (Simplified Technical English)

- **Procedures**: numbered steps. One instruction in each step. Use the imperative
  ("Click **Save record**."). Write 20 words or fewer in a sentence. If a condition applies,
  write the condition first ("If the record is locked, …").
- **Descriptions**: write 25 words or fewer in a sentence and 6 sentences or fewer in a
  paragraph. Give one topic in one sentence.
- Use the active voice.
- Do not use phrasal verbs. Write "prepare" or "configure", not "set up". Write "complete",
  not "fill in". Write "find", not "look up".
- Do not use an -ing form as a noun.
- Keep the articles ("the", "a").
- Use one word for one meaning. `docs/docs/10-help/glossary.md` is the approved term
  list. Always write "record", never "transaction" or "entry". Always write "contact", never
  "party" or "vendor". If you need a new term, add it to the glossary first.
- Put a warning or caution **before** the step it applies to, never after it.
- A UI label is a technical name, so the STE word rules do not apply to it. Quote it
  **exactly** and in bold: **New record**, **out of**, **Take this back**. Copy
  the label from the component source, not from memory.

## Page shape

1. One or two sentences: what this is for and when you use it.
2. The steps.
3. The result: what you see when it worked.
4. Notes and limits.

## Content rules

- Use plain language. Do not write "debit" or "credit" on a task page. One box in
  `02-concepts/how-an-entry-works.md` maps Akaun's words to accounting terms.
- Describe only what a user can do in the UI. Do not describe the features listed in
  `dev-notes/docs-gaps.md` as working.
- Admonitions: `:::tip` for a faster way, `:::caution` for an action you cannot undo
  (sending an invoice, merging contacts, deleting), and `:::info` for "needs the permission X".
- Text only. Add no screenshots and no image references for now.
- Link to other pages with relative file links (`../02-concepts/records.md`), so
  `onBrokenLinks: 'throw'` catches a broken link.
- Never copy wording from the README. Parts of it are out of date (Claims, "Settings →
  Providers").
