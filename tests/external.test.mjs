/**
 * external.test.mjs — the external-clock engine's full contract.
 *
 * The ExternalEngine is what the ReadAloudTTS daemon and any native bridge
 * ride on, so its clock semantics are the load-bearing logic of the whole
 * component: monotonic host ticks drive word emission; a silent host falls
 * back to real time; stop/pause freeze everything; a jump forward seeks.
 *
 * requestAnimationFrame does not exist in node — stubbed with a queue so
 * rAF arms are observable and drained deterministically.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ExternalEngine } from "../src/engines/external.js";

/** Minimal rAF harness: frames accumulate; drain() runs one generation. */
function installRafStub() {
  const queue = new Set();
  globalThis.requestAnimationFrame = (fn) => {
    queue.add(fn);
    return fn;
  };
  globalThis.cancelAnimationFrame = (fn) => queue.delete(fn);
  return {
    drain() {
      const fns = [...queue];
      queue.clear();
      for (const fn of fns) fn();
      return fns.length;
    },
    pending() {
      return queue.size;
    },
    clear() {
      queue.clear();
    },
  };
}

// Words: token index, startMs, endMs — the MediaEngine manifest shape.
const WORDS = [
  [0, 0, 300],
  [1, 300, 600],
  [2, 600, 900],
  [3, 900, 1200],
];

let raf;
beforeEach(() => {
  raf = installRafStub();
});

function makeEngine(overrides = {}) {
  const seen = { tokens: [], chunkStarts: [], chunkEnds: [], ends: 0 };
  const e = new ExternalEngine({
    words: WORDS,
    ...overrides,
    onToken: (i) => {
      seen.tokens.push(i);
      overrides.onToken?.(i);
    },
    onChunkStart: (a, b) => {
      seen.chunkStarts.push(a);
      overrides.onChunkStart?.(a, b);
    },
    onChunkEnd: (a, b) => {
      seen.chunkEnds.push(a);
      overrides.onChunkEnd?.(a, b);
    },
    onEnd: () => {
      seen.ends++;
      overrides.onEnd?.();
    },
  });
  return { e, seen };
}

test("speak() emits the first word immediately at clock 0", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  assert.deepEqual(seen.tokens, [0]);
  assert.equal(e.position, 0);
  e.stop();
});

test("host ticks drive word transitions in order", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  e.tick(350); // crosses into token 1
  e.tick(650); // token 2
  e.tick(1200); // token 3
  assert.deepEqual(seen.tokens, [0, 1, 2, 3]);
  e.stop();
});

test("ticks are monotonic-clamped: a smaller tick never rewinds", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  e.tick(800); // token 2
  e.tick(100); // host glitch — clock stays at 800, no re-emission
  assert.deepEqual(seen.tokens, [0, 2]);
  e.stop();
});

test("seek: speak(chunks, 2) starts the clock at that word", () => {
  const { e, seen } = makeEngine();
  e.speak([], 2);
  assert.equal(e.position, 2);
  assert.ok(seen.tokens.includes(2));
  e.stop();
});

test("past the last word + grace → engine ends itself", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  e.tick(300 + 250 + 5); // last end 300 (single-word view sorted) — see below
  // WORDS sorted by start; last word ends at 1200.
  e.tick(1200 + 250 + 5);
  assert.ok(seen.ends >= 1);
  assert.ok(e._stopped);
});

test("pause() freezes emission; tick during pause is ignored", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  e.pause();
  e.tick(1000);
  assert.deepEqual(seen.tokens, [0]); // tick after pause did nothing
  e.resume();
  e.tick(1000);
  assert.deepEqual(seen.tokens, [0, 3]);
  e.stop();
});

test("stop() fires onEnd exactly once and disarms rAF", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  raf.drain();
  e.stop();
  e.stop(); // idempotent
  assert.equal(seen.ends, 1);
  assert.equal(raf.pending(), 0);
});

test("silent host falls back to real time (rAF advances clock)", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  // Simulate: last host tick was >250ms ago.
  e._lastTickAt = performance.now() - 400;
  e._basePerf = performance.now() - 700; // pretend playback started 700ms ago
  raf.drain(); // one rAF step
  assert.deepEqual(seen.tokens, [0, 2]); // real-time clock reached ~700ms
  e.stop();
});

test("setWords late-arriving timings re-emit the current word", () => {
  const { e, seen } = makeEngine();
  e.setChunks([]);
  e.speak([], 0);
  // Host feeds only the first word at first…
  e.setWords([WORDS[0]]);
  e.tick(200);
  assert.deepEqual(seen.tokens, [0]);
  // …then the rest arrive while playing; clock is already at 350-ish.
  e.setWords(WORDS);
  e.tick(700);
  assert.ok(seen.tokens.includes(2));
  e.stop();
});

test("host silent → engine follows real time even with stale words", () => {
  const { e, seen } = makeEngine();
  e.speak([]);
  // Host dies: no more ticks. rAF must keep the karaoke moving.
  raf.drain(); // first frame: host still considered live → clock holds
  e._lastTickAt = performance.now() - 500;
  e._basePerf = performance.now() - 1000; // ~1000ms elapsed real time
  raf.drain();
  assert.deepEqual(seen.tokens, [0, 3]); // real-time clock (1000ms) reached word 3
  assert.ok(!e._stopped); // 1000 < last end (1200) + 250 grace — still playing
  // A later frame, host still silent, crosses end+grace → self-end.
  e._basePerf = performance.now() - 2000;
  raf.drain();
  assert.ok(e._stopped);
  assert.ok(seen.ends >= 1);
});

test("one producer, both engines: manifest shape matches words shape", () => {
  // Documented contract — timings [tokenIndex, startMs, endMs] feed
  // ExternalEngine.words AND MediaEngine manifest words.
  const { e } = makeEngine();
  assert.deepEqual(e.words, WORDS);
  e.stop();
});