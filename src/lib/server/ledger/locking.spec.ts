import { describe, expect, it } from "vitest";
import {
  ALWAYS_EDITABLE_FIELDS,
  canDeleteRecord,
  canEditField,
  lockStateOf,
  LOCKED_FIELDS,
} from "./locking.js";

const FREE = { settled: false, reconciled: false };
const SETTLED = { settled: true, reconciled: false };
const RECONCILED = { settled: false, reconciled: true };
const BOTH = { settled: true, reconciled: true };

describe("a record nothing has happened to yet", () => {
  it("is not locked", () => {
    const result = lockStateOf(FREE);
    expect(result.locked).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.lockedFields).toEqual([]);
  });

  it("lets every field be edited", () => {
    for (const field of [...LOCKED_FIELDS, ...ALWAYS_EDITABLE_FIELDS]) {
      expect(canEditField(field, FREE), field).toBe(true);
    }
  });

  it("can be deleted", () => {
    expect(canDeleteRecord(FREE).ok).toBe(true);
  });
});

describe("what a settled or reconciled record refuses", () => {
  it.each([
    ["settled", SETTLED],
    ["reconciled", RECONCILED],
    ["both", BOTH],
  ])(
    "refuses the amount, the date and the money account while %s",
    (_label, state) => {
      expect(canEditField("amount", state)).toBe(false);
      expect(canEditField("date", state)).toBe(false);
      expect(canEditField("paidFromAccountId", state)).toBe(false);
      expect(canEditField("receivedIntoAccountId", state)).toBe(false);
      expect(canEditField("fromAccountId", state)).toBe(false);
      expect(canEditField("toAccountId", state)).toBe(false);
      expect(canEditField("exchangeRate", state)).toBe(false);
      expect(canEditField("currency", state)).toBe(false);
    },
  );

  it.each([
    ["settled", SETTLED],
    ["reconciled", RECONCILED],
    ["both", BOTH],
  ])(
    "still allows the description, contact, reference, remark and category while %s",
    (_label, state) => {
      expect(canEditField("description", state)).toBe(true);
      expect(canEditField("contactId", state)).toBe(true);
      expect(canEditField("reference", state)).toBe(true);
      expect(canEditField("remark", state)).toBe(true);
      // Attachments are supporting documents, not accounting data.
      expect(canEditField("attachments", state)).toBe(true);
      // A settlement or bank match never points at the category side, so
      // correcting what the record was for cannot make either one wrong.
      expect(canEditField("categoryAccountId", state)).toBe(true);
    },
  );

  it("reports every locked field so a screen can disable exactly those", () => {
    expect([...lockStateOf(SETTLED).lockedFields].sort()).toEqual(
      [...LOCKED_FIELDS].sort(),
    );
  });

  it("refuses deletion", () => {
    for (const state of [SETTLED, RECONCILED, BOTH]) {
      const result = canDeleteRecord(state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the refusal names what unlocks it", () => {
  it("tells a settled record's owner to undo the payment", () => {
    const reason = lockStateOf(SETTLED).reason ?? "";
    expect(reason).toMatch(/payment/i);
    expect(reason).toMatch(/undo|reverse/i);
    expect(reason).not.toMatch(/bank/i);
  });

  it("tells a reconciled record's owner to unmatch the bank line", () => {
    const reason = lockStateOf(RECONCILED).reason ?? "";
    expect(reason).toMatch(/bank/i);
    expect(reason).toMatch(/unmatch/i);
    expect(reason).not.toMatch(/undo the payment/i);
  });

  it("names both when both apply, so neither is a surprise after the first", () => {
    const reason = lockStateOf(BOTH).reason ?? "";
    expect(reason).toMatch(/payment/i);
    expect(reason).toMatch(/bank/i);
  });

  it("says the same thing when refusing a delete", () => {
    const deleteReason = canDeleteRecord(SETTLED);
    expect(deleteReason.ok).toBe(false);
    if (!deleteReason.ok) expect(deleteReason.reason).toMatch(/undo|reverse/i);
  });
});

describe("the two field lists do not overlap", () => {
  it("never calls the same field both locked and always editable", () => {
    const locked = new Set<string>(LOCKED_FIELDS);
    for (const field of ALWAYS_EDITABLE_FIELDS) {
      expect(locked.has(field), field).toBe(false);
    }
  });
});
