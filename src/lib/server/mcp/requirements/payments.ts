import { either, write, writeTool } from "./define.js";

/** Payments: `record_payments` and `change_allocations`. */

export const RECORD_PAYMENTS = writeTool({
  // v1 `record_payment`.
  pay: write(["records:write"], ["records.create"]),
  // v1 `settle_payment`.
  allocate: write(["records:write"], ["records.create"]),
  // v1 `create_reimbursement`.
  reimburse: write(["records:write"], ["records.create"]),
});

export const CHANGE_ALLOCATIONS = writeTool({
  // v1 `correct_payment_allocations`: Correct allocations or the delete
  // route, plus `records.create` for the allocations it reapplies.
  reallocate: either(
    write(
      ["records:correction", "records:write"],
      ["records.correctAllocations", "records.create"],
    ),
    write(
      ["records:delete", "records:write"],
      ["records.delete", "records.create"],
    ),
  ),
});
