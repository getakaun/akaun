/** Plain-language names shared by generated postings and their presentation. */
export function reimbursementEntryLabel(role: string): string {
  if (role === "recipient") return "Reimbursement summary";
  if (role === "supplier") return "Included expenses";
  return "Full reimbursement reversal";
}

export function reimbursementEntryDescription(
  role: string,
  originalDescription: string,
): string {
  return `${reimbursementEntryLabel(role)}: ${originalDescription.trim() || "Reimbursement"}`;
}

/** Credit-only groups have no bank payment from which to read the original title. */
export function originalReimbursementDescription(description: string): string {
  const prefix = `${reimbursementEntryLabel("recipient")}: `;
  return description.startsWith(prefix)
    ? description.slice(prefix.length)
    : description;
}
