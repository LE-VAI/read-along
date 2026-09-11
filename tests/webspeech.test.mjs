/**
 * webspeech.test.mjs — the engine's pure helpers + node-safe constructor.
 *
 * WebSpeechEngine must be IMPORTABLE and CONSTRUCTIBLE outside a browser
 * (the component imports it unconditionally). In node, available=false and
 * the engine degrades to visual mode without touching speechSynthesis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WebSpeechEngine,
  chunkText,
  locateTokenChunk,
  tokenAtChar,
} from "../src/engines/webspeech.js";
import { tokenize } from "../src/tokenizer.js";

test("WebSpeechEngine.available is false in node", () => {
  assert.equal(WebSpeechEngine.available, false);
});

test("constructor is node-safe: no speechSynthesis deref, defaults set", () => {
  // Throws if the constructor touches speechSynthesis unguarded (node 24
  // has a navigator global, but never a speechSynthesis).
  const e = new WebSpeechEngine({ lang: "en-GB", rate: 1.25 });
  assert.equal(e.lang, "en-GB");
  assert.equal(e.rate, 1.25);
  assert.equal(e.available, undefined);
  assert.deepEqual(e._chunks, []);
  assert.equal(WebSpeechEngine.available, false);
});

test("speak() without speechSynthesis engages visual-only mode via onMode", () => {
  // rAF stub: node has no requestAnimationFrame; the visual-only karaoke
  // loop needs one to schedule word pacing.
  const queue = new Set();
  globalThis.requestAnimationFrame = (fn) => (queue.add(fn), queue.size);
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  const modes = [];
  const e = new WebSpeechEngine({ onMode: (m) => modes.push(m) });
  const chunks = [{ tokens: tokenize("First part."), start: 0, end: 11 }];
  e.speak(chunks);
  assert.deepEqual(modes, ["visual"]);
  assert.equal(e._visualOnly, true);
  // First word emits after one rAF generation.
  const seen = [];
  e.onToken = (i) => seen.push(i);
  for (const fn of [...queue]) { queue.delete(fn); fn(); }
  assert.ok(seen.length >= 1, "visual mode should emit a word token");
  e.stop();
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});

test("chunkText joins tokens with single spaces", () => {
  const toks = tokenize("One two. Three.");
  const chunk = { tokens: toks.slice(0, 2) };
  assert.equal(chunkText(chunk), "One two.");
});

test("locateTokenChunk finds the chunk owning a global token index", () => {
  const chunks = [
    { tokens: [{ index: 0 }, { index: 1 }, { index: 2 }] },
    { tokens: [{ index: 3 }, { index: 4 }] },
    { tokens: [{ index: 5 }] },
  ];
  assert.equal(locateTokenChunk(chunks, 0), 0);
  assert.equal(locateTokenChunk(chunks, 2), 0);
  assert.equal(locateTokenChunk(chunks, 3), 1);
  assert.equal(locateTokenChunk(chunks, 5), 2);
  assert.equal(locateTokenChunk(chunks, 9), -1);
});

test("tokenAtChar maps a chunk-local char offset to its token", () => {
  const chunk = {
    tokens: [
      { text: "ab", index: 0 },
      { text: "cd", index: 1 },
      { text: "efg", index: 2 },
    ],
  };
  assert.equal(tokenAtChar(chunk, 0).index, 0);
  assert.equal(tokenAtChar(chunk, 2).index, 0); // end offset belongs to this word
  assert.equal(tokenAtChar(chunk, 3).index, 1);
  assert.equal(tokenAtChar(chunk, 6).index, 2);
});

test("tokenAtChar clamps past-the-end to the last token", () => {
  const chunk = { tokens: [{ text: "hi", index: 0 }] };
  assert.equal(tokenAtChar(chunk, 999).index, 0);
  assert.equal(tokenAtChar({ tokens: [] }, 0), null);
});

test("seek path: speak() with startWord resolves without speechSynthesis", () => {
  // rAF stub for the visual-only loop (same as above).
  const queue = new Set();
  globalThis.requestAnimationFrame = (fn) => (queue.add(fn), queue.size);
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  const modes = [];
  const started = [];
  const e = new WebSpeechEngine({
    onMode: (m) => modes.push(m),
    onChunkStart: (i, chunk) => started.push({ i, first: chunk.tokens[0].index }),
  });
  const chunks = [
    { tokens: tokenize("First part."), start: 0, end: 11 },  // indexes 0,1
    { tokens: tokenize("Second part."), start: 12, end: 24 }, // indexes 2,3
  ];
  // Token 1 lives in chunk 0, so the visual loop starts at chunk 0 with a
  // mid-chunk slice (tokens from the seek word on). In node it must route
  // to visual mode WITHOUT throwing — the seek contract is "never throws".
  e.speak(chunks, 1);
  assert.deepEqual(modes, ["visual"]);
  assert.equal(e._chunkIdx, 0);
  // The one-shot slice is consumed by _chunkFor on the first visual chunk;
  // its first token is the seek target, keeping its GLOBAL index.
  assert.equal(e._pendingSlice, null);
  assert.deepEqual(started, [{ i: 0, first: 1 }]);
  e.stop();
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});