import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as enums from "$lib/enums.js";
import {
  closestMatch,
  enumCode,
  enumCodec,
  enumInput,
  enumLabel,
  money,
  moneyInput,
  parsePeriod,
  parsePeriodText,
  periodShape,
  snakeCase,
  type EnumMap,
} from "./format.js";

/** Every exported `*Labels` map in `$lib/enums.ts`, wire and display alike. */
const LABEL_MAPS = Object.entries(enums).filter(
  (entry): entry is [string, EnumMap] =>
    entry[0].endsWith("Labels") &&
    typeof entry[1] === "object" &&
    entry[1] !== null,
);

describe("enum codec", () => {
  it("finds every label map", () => {
    expect(LABEL_MAPS.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "EntityTypeLabels",
        "RoleLabels",
        "ImportStateLabels",
        "LedgerRecordKindLabels",
        "AccountSubTypeLabels",
        "AccountRoleDisplayLabels",
      ]),
    );
    expect(LABEL_MAPS.length).toBeGreaterThanOrEqual(25);
  });

  it.each(LABEL_MAPS)(
    "%s round-trips every code through a snake_case label",
    (_, map) => {
      const codec = enumCodec(map);
      const codes = Object.keys(map).map(Number);
      expect(codec.labels).toHaveLength(codes.length);
      for (const code of codes) {
        const label = enumLabel(map, code)!;
        expect(label).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
        const back = enumCode(map, label);
        expect(back).toEqual({ ok: true, value: code });
      }
    },
  );

  it("matches the existing wire labels exactly where they are already snake_case", () => {
    expect(
      enumLabel(enums.ImportStateLabels, enums.ImportState.PendingReview),
    ).toBe("pending_review");
    expect(
      enumLabel(
        enums.LedgerRecordKindLabels,
        enums.LedgerRecordKind.OpeningBalance,
      ),
    ).toBe("opening_balance");
    expect(enumLabel(enums.RoleLabels, enums.Role.Supplier)).toBe("supplier");
    expect(
      enumLabel(enums.AccountRoleDisplayLabels, enums.AccountRole.Receivable),
    ).toBe("accounts_receivable");
  });

  it("drops null and unknown codes", () => {
    expect(enumLabel(enums.RoleLabels, null)).toBeUndefined();
    expect(enumLabel(enums.RoleLabels, 999)).toBeUndefined();
  });

  it("accepts a label in another case or spacing", () => {
    expect(enumCode(enums.ImportStateLabels, "Pending Review")).toEqual({
      ok: true,
      value: enums.ImportState.PendingReview,
    });
  });

  it("refuses an unknown label with the allowed labels and a near match", () => {
    const result = enumCode(enums.LedgerRecordKindLabels, "expence", "kind");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "INVALID_INPUT", path: "kind" });
    expect(result.error.message).toContain('Did you mean "expense"?');
    expect(result.error.fix).toBe(
      "Use one of: expense, income, transfer, payment, opening_balance, invoice_issue, journal, reversal.",
    );
  });

  it("builds a zod enum of the labels", () => {
    const schema = enumInput(enums.InvoiceStatusLabels);
    expect(schema.options).toEqual(enumCodec(enums.InvoiceStatusLabels).labels);
    expect(
      schema.safeParse(enumCodec(enums.InvoiceStatusLabels).labels[0]).success,
    ).toBe(true);
  });

  it("snake_cases display names", () => {
    expect(snakeCase("Short-term loan")).toBe("short_term_loan");
    expect(snakeCase("Prepaid/debit card")).toBe("prepaid_debit_card");
    expect(snakeCase("pending_review")).toBe("pending_review");
    expect(snakeCase("OpeningBalance")).toBe("opening_balance");
  });
});

describe("money", () => {
  it("formats minor units as a decimal string", () => {
    expect(money(128500)).toBe("1285.00");
    expect(money(-50)).toBe("-0.50");
  });

  it("parses an input amount to minor units, refusing three decimals", () => {
    expect(moneyInput.parse("12.50")).toBe(1250);
    expect(moneyInput.parse(12.5)).toBe(1250);
    const bad = moneyInput.safeParse("12.505");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toMatch(/3 decimal places/);
  });

  it("shows string | number in the input JSON schema", () => {
    const json = z.toJSONSchema(z.object({ amount: moneyInput }), {
      io: "input",
    }) as unknown as {
      properties: { amount: { anyOf: { type: string }[] } };
    };
    expect(json.properties.amount.anyOf.map((s) => s.type)).toEqual([
      "string",
      "number",
    ]);
  });
});

describe("periods", () => {
  const range = (text: string) => {
    const result = parsePeriodText(text);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  it("reads a month, a quarter and a year", () => {
    expect(range("2026-03")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(range("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(range("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(range("2026-Q1")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(range("2026-q2")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(range("2026-Q4")).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(range("2026")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("reads a range, whose ends may be any period", () => {
    expect(range("2026-01-05..2026-02-10")).toEqual({
      from: "2026-01-05",
      to: "2026-02-10",
    });
    expect(range("2026-01..2026-Q2")).toEqual({
      from: "2026-01-01",
      to: "2026-06-30",
    });
    expect(range("2026-03-31..2026-03-31")).toEqual({
      from: "2026-03-31",
      to: "2026-03-31",
    });
  });

  it("refuses what it does not understand, with the forms as the fix", () => {
    for (const text of [
      "2026-13",
      "2026-Q5",
      "March 2026",
      "2026-02-30",
      "2026-03..",
      "a..b..c",
    ]) {
      const result = parsePeriodText(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
        expect(result.error.fix).toContain('"2026-Q1"');
      }
    }
    const backwards = parsePeriodText("2026-03-01..2026-02-01");
    expect(!backwards.ok && backwards.error.message).toMatch(
      /before it starts/,
    );
  });

  it("takes as_at alone as a date from the start of the books", () => {
    expect(parsePeriod({ as_at: "2026-03-31" })).toEqual({
      ok: true,
      value: { from: null, to: "2026-03-31" },
    });
    expect(parsePeriod({})).toEqual({ ok: true, value: null });
    expect(parsePeriod({ period: "2026-Q1" })).toEqual({
      ok: true,
      value: { from: "2026-01-01", to: "2026-03-31" },
    });
  });

  it("refuses a bad as_at, and period with as_at", () => {
    expect(parsePeriod({ as_at: "2026-03" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", path: "as_at" },
    });
    expect(parsePeriod({ period: "2026", as_at: "2026-03-31" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("gives tools a period shape to spread", () => {
    const schema = z.object(periodShape).strict();
    expect(schema.parse({ period: "2026-Q1" })).toEqual({ period: "2026-Q1" });
  });
});

describe("closestMatch", () => {
  it("finds a typo or a prefix, and nothing when far off", () => {
    expect(closestMatch("ammount", ["amount", "account"])).toBe("amount");
    expect(closestMatch("descr", ["description", "date"])).toBe("description");
    expect(closestMatch("zzz", ["amount", "date"])).toBeUndefined();
  });
});
