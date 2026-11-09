import { AccountType } from "$lib/enums.js";
import { taxFormValues } from "$lib/expense-tax.js";

export type AccountSender = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** The drawer uses the shared accounts API, independently of page-action state. */
export async function submitAccount(
  data: FormData,
  send: AccountSender = fetch,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const type = Number(data.get("type"));
  const code = String(data.get("code") ?? "").trim();
  const subType = String(data.get("subType") ?? "").trim();
  const tax =
    type === AccountType.Expense
      ? taxFormValues(
          String(data.get("defaultTaxTreatment") ?? ""),
          String(data.get("defaultTaxPercentage") ?? ""),
        )
      : null;
  if (tax?.error) return { ok: false, error: tax.error };
  try {
    const response = await send("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(data.get("name") ?? "").trim(),
        type,
        ...(code ? { code: Number(code) } : {}),
        ...(subType ? { subType: Number(subType) } : {}),
        ...(tax
          ? {
              defaultTaxTreatment: tax.treatment,
              defaultTaxPercentageBps: tax.percentageBps,
            }
          : {}),
      }),
    });
    const body = await response.json();
    if (!response.ok)
      return {
        ok: false,
        error:
          body.issues?.[0]?.message ??
          body.error ??
          "Could not create the account.",
      };
    if (!Number.isSafeInteger(body.id) || body.id <= 0)
      throw Error("Missing created account");
    return { ok: true, id: body.id };
  } catch {
    return {
      ok: false,
      error:
        "The account creation result could not be confirmed. Check Accounts before retrying.",
    };
  }
}
