/**
 * media.test.mjs — MediaEngine seek mapping + poll logic (node-safe parts).
 *
 * The engine's browser half (Audio element, timers) is exercised by the
 * live demo; the load-bearing logic worth unit-testing is the word→
 * (chunk, offsetMs) mapping used by seek and the _poll scan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MediaEngine } from "../src/engines/media.js";
import { tokenize } from "../src/tokenizer.js";

function makeChunks() {
  const t1 = tokenize("First sentence.");
  const t2 = tokenize("Second sentence.");
  return [
    { tokens: t1.map((tok, i) => ({ ...tok, index: i })), start: 0, end: 15 },
    {
      tokens: t2.map((tok, i) => ({ ...tok, index: t1.length + i })),
      start: 16,
      end: 31,
    },
  ];
}

test("constructor is node-safe (no Audio element touched)", () => {
  const e = new MediaEngine({ manifest: { chunks: [] } });
  assert.equal(e._stopped, true);
  assert.equal(e._chunkIdx, -1);
});

test("speak maps a startWord to its chunk + word offset (observable via events)", () => {
  const chunks = makeChunks();
  const started = [];
  const e = new MediaEngine({ manifest: { chunks: [{ src: "a.mp3" }, { src: "b.mp3" }] } });
  e.setChunks(chunks);
  e.onChunkStart = (i) => started.push(i);
  // Stub the browser-only surface so seek mapping is observable in node.
  const audio = {
    src: null,
    play() {
      return Promise.resolve();
    },
    pause() {},
    addEventListener() {},
    removeAttribute() {},
    currentTime: 0,
  };
  e._audio = audio;
  e.speak(chunks, 2); // token 2 = "Second" → chunk 1; token 1 → chunk 0 slice
  assert.deepEqual(started, [1]);
  assert.equal(audio.src, "b.mp3");
  e.stop();
});

test("speak with startWord in chunk 1 seeks into chunk 1's word time", async () => {
  const chunks = makeChunks();
  const started = [];
  const e = new MediaEngine({ manifest: {
    chunks: [
      { src: "a.mp3", words: [[0, 0], [1, 120]] },
      { src: "b.mp3", words: [[2, 0], [3, 200]] },
    ],
  } });
  e.setChunks(chunks);
  e.onChunkStart = (i) => started.push(i);
  let seekedTo = null;
  e._audio = {
    set src(_v) {},
    play() {
      return Promise.resolve();
    },
    pause() {},
    addEventListener() {},
    removeAttribute() {},
    set currentTime(v) {
      seekedTo = v;
    },
    get currentTime() {
      return seekedTo ?? 0;
    },
  };
  e.speak(chunks, 3); // token 3 = "sentence." → chunk 1, word start 200ms
  assert.deepEqual(started, [1]);
  // offsetMs is applied asynchronously after play() resolves — flush.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seekedTo, 0.2);
  e.stop();
});

test("_poll scans sorted word timings and emits the reached token once", () => {
  const e = new MediaEngine({ manifest: { chunks: [] } });
  const seen = [];
  e.onToken = (i) => seen.push(i);
  e._stopped = false; // polls only run while playing
  const entry = { words: [[0, 0], [1, 200], [2, 400]] };
  e._audio = { currentTime: 0.1 }; // 100ms → token 0
  e._poll(entry);
  assert.deepEqual(seen, [0]);
  e._audio = { currentTime: 0.35 }; // 350ms → token 1, no re-emit
  e._poll(entry);
  assert.deepEqual(seen, [0, 1]);
  e._poll(entry);
  assert.deepEqual(seen, [0, 1]);
  // A manifest chunk with no words is highlight-off, not a crash.
  assert.doesNotThrow(() => e._poll({}));
});

test("missing manifest entry ends the read instead of throwing", () => {
  const e = new MediaEngine({ manifest: { chunks: [{ src: "a.mp3" }] } });
  const ends = [];
  e.onEnd = () => ends.push(1);
  e._stopped = false;
  e._playChunk(5); // out of range
  assert.equal(ends.length, 1);
});