/**
 * announce.test.mjs — the repeat-announcement rule.
 *
 * This pins the behaviour that mattered in the field: two IDENTICAL calls in a
 * row must produce two announcements. The old implementation cleared and
 * re-set in the same task, which Chromium coalesces into no net change, and
 * NVDA stayed silent on the second one — measured 2026-10-02 with Chrome 153
 * + NVDA 2026.2 and the Speech Viewer as the judge. The rule now lives in
 * announce.js so this can be tested without a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { announcePlan, announceTo, ANNOUNCE_REPEAT_DELAY_MS } from "../src/announce.js";

/** A live-region stand-in that records EVERY write, so a coalesced pair is visible. */
function fakeRegion(initial = "") {
  const writes = [];
  let text = initial;
  return {
    get textContent() { return text; },
    set textContent(v) { text = v; writes.push(v); },
    writes,
  };
}

/** A controllable scheduler: nothing runs until you flush it. */
function fakeTimers() {
  const pending = [];
  return {
    setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    flush() { const p = pending.splice(0); p.forEach(({ fn }) => fn()); },
    get count() { return pending.length; },
  };
}

test("a different message is written immediately, with no timer", () => {
  const region = fakeRegion("Ready");
  const timers = fakeTimers();
  announceTo(region, "Playing, automated voice", { setTimeout: timers.setTimeout });
  assert.equal(region.textContent, "Playing, automated voice");
  assert.equal(timers.count, 0, "no scheduling for a fresh message");
});

test("the FIRST call after a clear is immediate", () => {
  const region = fakeRegion("");
  const timers = fakeTimers();
  announceTo(region, "Paused", { setTimeout: timers.setTimeout });
  assert.equal(region.textContent, "Paused");
  assert.equal(timers.count, 0);
});

test("an IDENTICAL repeat clears now and re-sets in a later task", () => {
  const region = fakeRegion("");
  const timers = fakeTimers();
  announceTo(region, "Paused", { setTimeout: timers.setTimeout });   // first
  timers.flush();                                                    // (nothing pending)
  announceTo(region, "Paused", { setTimeout: timers.setTimeout });   // identical
  // the clear landed in THIS task...
  assert.equal(region.textContent, "", "clear is synchronous");
  // ...and the set is still pending
  assert.equal(timers.count, 1, "the re-set is scheduled, not immediate");
  timers.flush();
  assert.equal(region.textContent, "Paused");
  // both writes are visible to a MutationObserver — which is the whole point
  assert.deepEqual(region.writes, ["Paused", "", "Paused"]);
});

test("two identical calls produce TWO distinct announcements (the field defect)", () => {
  const region = fakeRegion("");
  const timers = fakeTimers();
  const call = () => announceTo(region, "Paused", { setTimeout: timers.setTimeout });

  call(); timers.flush();
  call(); timers.flush();

  // A naive same-task clear+set shows up here as ["", "Paused"] with no
  // mutation between them; the fix must show the empty state as its own write.
  const mutations = region.writes.filter((w, i) => i === 0 || w !== region.writes[i - 1]);
  assert.equal(
    mutations.filter((w) => w === "Paused").length, 2,
    "the word must be written twice, separated by a real change",
  );
  assert.ok(region.writes.includes(""), "the clear must be observable");
});

test("three identical calls still announce three times", () => {
  const region = fakeRegion("");
  const timers = fakeTimers();
  const call = () => { announceTo(region, "Paused", { setTimeout: timers.setTimeout }); timers.flush(); };
  call(); call(); call();
  assert.equal(region.writes.filter((w) => w === "Paused").length, 3);
});

test("a newer message cancels a pending repeat (seq guard)", () => {
  const region = fakeRegion("");
  const timers = fakeTimers();
  let seq = 0;
  const opts = () => ({
    setTimeout: timers.setTimeout,
    nextSeq: () => ++seq,
    isCurrent: (s) => s === seq,
  });

  announceTo(region, "Paused", opts());                 // seq 1
  timers.flush();
  announceTo(region, "Paused", opts());                 // seq 2 — repeat, schedules
  assert.equal(timers.count, 1);
  announceTo(region, "Playing, automated voice", opts()); // seq 3 — newer message
  assert.equal(region.textContent, "Playing, automated voice");
  timers.flush();                                        // stale repeat fires
  assert.equal(
    region.textContent, "Playing, automated voice",
    "a stale repeat must not overwrite a newer message",
  );
});

test("announcePlan states the rule without touching a region", () => {
  assert.deepEqual(announcePlan("Ready", "Paused"), { action: "set", text: "Paused" });
  assert.deepEqual(announcePlan("Paused", "Paused"), {
    action: "repeat", clearTo: "", thenSet: "Paused", delayMs: ANNOUNCE_REPEAT_DELAY_MS,
  });
  // a custom delay is honoured
  assert.equal(announcePlan("X", "X", 120).delayMs, 120);
});

test("the repeat gap is short enough to read as one message", () => {
  // Under ~200 ms a screen reader user hears a single message; longer starts to
  // sound like two. The exact value is not sacred, the band is.
  assert.ok(ANNOUNCE_REPEAT_DELAY_MS >= 20, "too short to be a separate task");
  assert.ok(ANNOUNCE_REPEAT_DELAY_MS <= 200, "long enough to sound like two messages");
});
