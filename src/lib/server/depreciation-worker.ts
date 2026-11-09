import type { LedgerDb } from "./ledger/types.js";
import { runAutomaticDepreciation } from "./application/depreciation.js";
import { runAsSystem } from "./audit-context.js";

let started = false;
/** Durable progress is in asset/month posting keys, not this process or its timer. */
export function startDepreciationWorker(db: LedgerDb) {
  if (started) return;
  started = true;
  const tick = () => {
    try {
      runAsSystem(() => {
        for (const item of runAutomaticDepreciation({ db }))
          if (!item.result.ok)
            console.error(
              "Depreciation catch-up refused",
              item.month,
              item.result.reason,
            );
      });
    } catch (error) {
      console.error("Depreciation catch-up failed", error);
    }
  };
  // Wait until application initialisation has completed; catch up after downtime.
  setTimeout(tick, 0).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
