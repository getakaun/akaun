/**
 * Whether a document may be read again from the same file, and if not, why
 * (006 FR-023, US9 AS6-7).
 *
 * "Read again" throws away what the last reading proposed and reads the file
 * once more, the way the user now names. That is safe only while nothing the
 * last reading proposed has become a record:
 *
 * - a receipt or invoice still waiting for review (one card, no items);
 * - a group none of whose items is confirmed yet (skipped items are fine:
 *   they made nothing, and the new reading replaces them too);
 * - a document whose reading failed;
 * - a skipped document that made no record, while its file is still stored.
 *   Skipping a document releases its file when nothing else uses it, and a
 *   file that is gone cannot be read; the user must upload it again.
 *
 * Every other state is refused with a sentence the screen shows as it is.
 * The rule is written once, here: the job's live update carries its answer
 * (see `jobForEvent`), so no screen needs a copy, and the route asks the same
 * function again inside its write, with the counts as they are then.
 */

import { ImportState } from "$lib/enums.js";

/** Why a skipped document whose file was released cannot be read again. */
export const SKIPPED_FILE_GONE =
  "This document was skipped and its file is no longer stored, so it cannot be read again. Upload it again to read it.";

/**
 * Why this document cannot be read again, or null when it can.
 *
 * `confirmedItems` is how many of its items are confirmed or already
 * imported: the `confirmed` count of a group. A receipt has none.
 *
 * `fileStored` says whether the document's file is still kept. It is asked
 * only for a skipped document, the one state whose file may already be gone,
 * so the other states cost no look at the disk.
 */
export function readAgainRefusal(
  state: number,
  confirmedItems: number,
  fileStored: () => boolean,
): string | null {
  // A finished group is itself marked Imported, and its items are counted as
  // confirmed too. "Already imported" is the truer answer for it, so the
  // job's own state is asked first.
  if (state === ImportState.Imported) {
    return "This document is already imported, so it can no longer be read again.";
  }
  if (state === ImportState.Confirmed) {
    return "This document is being imported, so it can no longer be read again.";
  }
  if (confirmedItems > 0) {
    const counted =
      confirmedItems === 1
        ? "1 item is already confirmed"
        : `${confirmedItems} items are already confirmed`;
    return `${counted}, so this document can no longer be read again. Reading it again would replace items that are already posted to the ledger.`;
  }
  switch (state) {
    case ImportState.PendingReview:
    case ImportState.Grouped:
    case ImportState.Failed:
      return null;
    case ImportState.Queued:
    case ImportState.Extracting:
    case ImportState.Processing:
      return "This document is still being read. Wait until the reading has finished.";
    case ImportState.Skipped:
      // No item is confirmed (see above), so the skipped document made no
      // record. It can be read again if its file was not released.
      return fileStored() ? null : SKIPPED_FILE_GONE;
    default:
      return "This document cannot be read again.";
  }
}
