/**
 * kokoro.test.mjs — char-proportional word timing distribution.
 *
 * The kokoro engine's public ONNX export has no word timestamps, so
 * timings are measured-duration-per-char. The distributor must:
 * tile the full chunk duration with no gaps, keep words in order, and
 * use the chunk's GLOBAL token indexes (so one manifest feeds both the
 * KokoroEngine and MediaEngine/ExternalEngine).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { wordTimingsFromChunk, toEngineManifest } from "../src/timings.js";
import { ExternalEngine } from "../src/engines/external.js";
import { tokenize } from "../src/tokenizer.js";

test("timings tile the chunk duration in order with no gaps", () => {
  const text = "Speak the words as they light up.";
  const toks = tokenize(text).map((t, i) => ({ ...t, index: i }));
  const chunk = { tokens: toks };
  const sampleRate = 24000;
  const samples = sampleRate * 2; // exactly 2.0s = 2000ms of samples
  const out = wordTimingsFromChunk(chunk, { samples: Float32Array.from({ length: samples }), sampleRate });
  assert.equal(out.length, toks.length);
  assert.equal(out[0].startMs, 0);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].startMs >= out[i - 1].endMs - 0.001);
    assert.ok(out[i].endMs > out[i].startMs);
  }
  // The last word's end lands on the full audio duration (the +1 joining
  // space after the final token is exactly cancelled by the -1 in endMs).
  assert.ok(Math.abs(out[out.length - 1].endMs - 2000) < 0.001);
});

test("token indexes pass through as the chunk's global indexes", () => {
  const toks = tokenize("one two three").map((t, i) => ({ ...t, index: i + 7 }));
  const out = wordTimingsFromChunk(
    { tokens: toks },
    { samples: new Float32Array(24000), sampleRate: 24000 }
  );
  assert.deepEqual(
    out.map((w) => w.tokenIndex),
    [7, 8, 9]
  );
});

test("zero-length audio yields zero-width timings (degenerate, not a crash)", () => {
  const out = wordTimingsFromChunk(
    { tokens: [{ text: "x", start: 0, end: 1, index: 0 }] },
    { samples: new Float32Array(0), sampleRate: 24000 }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].startMs, 0);
  assert.equal(out[0].endMs, 0);
});

test("no tokens yields no timings", () => {
  const out = wordTimingsFromChunk(
    { tokens: [] },
    { samples: new Float32Array(24000), sampleRate: 24000 }
  );
  assert.deepEqual(out, []);
});

test("longer word gets a longer slice than a short one", () => {
  const toks = [
    { text: "extraordinarily", start: 0, end: 15, index: 0 },
    { text: "a", start: 16, end: 17, index: 1 },
  ];
  const out = wordTimingsFromChunk(
    { tokens: toks },
    { samples: new Float32Array(24000), sampleRate: 24000 }
  );
  const a = out[0].endMs - out[0].startMs;
  const b = out[1].endMs - out[1].startMs;
  assert.ok(a > b * 2, `short word slice should be much smaller: ${a} vs ${b}`);
});
// -- the seam to the ENGINES, which nothing previously crossed ---------------

test('CRITICAL: wordTimingsFromChunk output can actually feed ExternalEngine', () => {
  // The header of timings.js promised it existed "so hosts can build
  // MediaEngine/ExternalEngine manifests" — and it handed them objects while
  // both engines require tuples. A host following that sentence crashed at
  // `words.find(([tok]) => ...)` with "object is not iterable".
  //
  // Nothing caught it because the only in-package consumer is kokoro.js, which
  // reads named fields. The seam was never crossed by a test or a demo. This
  // test crosses it, so the promise in the header is enforced.
  const toks = tokenize('one two three four five').map((t, i) => ({ ...t, index: i }));
  const chunk = { tokens: toks };
  const sampleRate = 24000;
  const out = wordTimingsFromChunk(chunk, {
    samples: Float32Array.from({ length: sampleRate * 2 }),
    sampleRate,
  });

  const manifest = toEngineManifest(out);

  // Shape: tuples, not objects.
  assert.ok(Array.isArray(manifest[0]), 'the manifest must be tuples');
  assert.equal(manifest[0].length, 3);
  assert.equal(typeof manifest[0][0], 'number', 'tokenIndex');

  // It must be sortable and iterable by the engine's own access pattern.
  for (const [tok, startMs, endMs] of manifest) {
    assert.equal(typeof tok, 'number');
    assert.ok(startMs <= endMs);
  }

  // And the engine must accept it without throwing.
  const engine = new ExternalEngine({ words: manifest });
  assert.equal(engine.words.length, toks.length, 'the engine took the manifest');
  // The engine sorts by index 1 on construction — verify it survived that.
  assert.deepEqual(engine.words[0].slice(0, 2), manifest[0].slice(0, 2));
});

test('toEngineManifest is idempotent on tuples and sorts by start time', () => {
  // A host may already hold tuples (a media manifest from JSON, a Piper bridge
  // output). Passing those through must be a copy, not a corruption.
  const tuples = [[2, 400, 500], [0, 0, 100], [1, 200, 300]];
  const out = toEngineManifest(tuples);
  assert.deepEqual(out, [[0, 0, 100], [1, 200, 300], [2, 400, 500]],
    'tuples pass through and are sorted by startMs');

  // Unsorted input is the dangerous case: MediaEngine walks the array assuming
  // ascending time, so an unsorted manifest reports the WRONG WORD rather than
  // failing. Sorting here is what makes that impossible rather than unlikely.
  const objects = [
    { tokenIndex: 1, startMs: 200, endMs: 300 },
    { tokenIndex: 0, startMs: 0, endMs: 100 },
  ];
  assert.deepEqual(toEngineManifest(objects), [[0, 0, 100], [1, 200, 300]]);
});

test('toEngineManifest tolerates nonsense rather than throwing', () => {
  assert.deepEqual(toEngineManifest(null), []);
  assert.deepEqual(toEngineManifest(undefined), []);
  assert.deepEqual(toEngineManifest('not an array'), []);
});
