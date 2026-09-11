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

import { wordTimingsFromChunk } from "../src/timings.js";
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