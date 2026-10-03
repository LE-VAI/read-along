/**
 * announce.js — the repeat-announcement rule, without the DOM.
 *
 * WHY THIS EXISTS. A live region announces a CHANGE. Assigning an identical
 * string produces no mutation, so a naive `live.textContent = "Paused"` twice
 * announces nothing the second time — a pause/resume cycle repeats "Paused",
 * and seeking to the same word repeats "Playing from word N". A user cannot
 * tell "the tool ignored me" from "the tool is broken."
 *
 * The fix has a trap in it. Clearing and re-setting in the SAME task is
 * coalesced by the browser into no net change. Measured 2026-10-02 with
 * Chrome 153 + NVDA 2026.2, using the Speech Viewer as the judge:
 *
 *   same-task clear+set  -> ONE announcement for two identical calls  (broken)
 *   ~60 ms split         -> TWO, in both test orders                   (correct)
 *
 * So this module owns the DECISION (should we clear? should we schedule?),
 * and the caller owns the DOM and the timer. That split is what lets every
 * branch below be tested in plain Node, where there is no live region to
 * observe.
 */

/** Default gap between the clear and the re-set. Long enough to be a separate
 * task and a separate accessibility event; short enough that a user hears one
 * message, not two. */
export const ANNOUNCE_REPEAT_DELAY_MS = 60;

/**
 * Decide how to announce `msg` given what the region currently shows.
 *
 * @param {string|null} current  the region's current text
 * @param {string} msg           the message to announce
 * @returns {{action: "set", text: string}
 *          | {action: "repeat", clearTo: string, thenSet: string, delayMs: number}}
 */
export function announcePlan(current, msg, delayMs = ANNOUNCE_REPEAT_DELAY_MS) {
  if (current === msg) {
    // Identical: the clear lands now, the set lands in a later task.
    return { action: "repeat", clearTo: "", thenSet: msg, delayMs };
  }
  return { action: "set", text: msg };
}

/**
 * Apply an announcement plan to a live-region-like object.
 *
 * `region` needs `textContent` and (for the repeat path) a way to schedule a
 * later write — `setTimeout` is injectable so tests can drive it.
 *
 * @param {{textContent: string}} region
 * @param {string} msg
 * @param {object} [opts]
 * @param {(fn: () => void, ms: number) => void} [opts.setTimeout]
 * @param {() => number} [opts.nextSeq]  monotonically increasing token; a
 *   pending repeat whose seq is stale is dropped, so a slow timer can never
 *   overwrite a message that arrived after it.
 * @param {number} [opts.delayMs]
 * @returns {number} the sequence number assigned to this call
 */
export function announceTo(region, msg, opts = {}) {
  const schedule = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const seq = opts.nextSeq ? opts.nextSeq() : 0;
  const plan = announcePlan(region.textContent, msg, opts.delayMs);
  if (plan.action === "set") {
    region.textContent = plan.text;
    return seq;
  }
  region.textContent = plan.clearTo;
  schedule(() => {
    if (opts.isCurrent && !opts.isCurrent(seq)) return;
    region.textContent = plan.thenSet;
  }, plan.delayMs);
  return seq;
}
